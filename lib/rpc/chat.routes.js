import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Chat messages, slash commands, attachments, and WebRTC signaling RPC handlers.
 */
export function createChatRoutes({
  cfg,
  getStoredGithubAuth,
  ensureMachineProfile,
  messageCache,
  attachmentStore,
  getLanEngine,
  githubClient,
  gitEngine,
  publisher,
  parseChatCommand,
  validateRoomId,
  realtimeRelay = null,
  dirtyRoomsFromRelay = null,
  masterVault = 'aoiuyy/dsh-work-vault',
}) {
  const lastRoomSyncAt = new Map();
  const relaySecretFor = () => (cfg?.vaultRepo && cfg.vaultRepo.includes('/') ? cfg.vaultRepo : (masterVault || cfg?.vaultRepo || 'dsh-work-relay'));

  async function ensureAndSyncVaultRoom(ghAuth, roomId, roomRecord, signal) {
    const explicit = cfg?.vaultRepo && cfg.vaultRepo.includes('/') ? cfg.vaultRepo : null;
    const candidates = [...new Set([roomRecord.vaultRepo, explicit, masterVault, cfg?.vaultRepo].filter(Boolean))];
    for (const targetRepo of candidates) {
      try {
        if (!roomRecord.issueNumber || (roomRecord.vaultRepo && roomRecord.vaultRepo !== targetRepo)) {
          const issueInfo = await githubClient.ensureRoomIssue({
            username: ghAuth.username,
            token: ghAuth.token,
            repo: targetRepo,
            roomName: roomId,
            signal,
          });
          roomRecord.issueNumber = issueInfo.issueNumber;
          roomRecord.vaultRepo = targetRepo;
        }
        return targetRepo;
      } catch {}
    }
    return null;
  }

  const mutateMessage = (action) => async (args, signal) => {
    validateRoomId(args.roomId);
    const cache = await messageCache.loadPersistentCache();
    const room = cache.rooms?.[args.roomId];
    const index = room?.messages.findIndex(m => m.id === args.messageId) ?? -1;
    if (index < 0) return { ok: false, error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found in this room' } };
    const original = room.messages[index];
    const profile = await ensureMachineProfile();
    const ghAuth = await getStoredGithubAuth();
    const isOwner = original.sender === profile.machineToken || (ghAuth?.username && original.senderGithub?.toLowerCase() === ghAuth.username.toLowerCase());
    if ((action === 'editChatMessage' || action === 'deleteChatMessage') && !isOwner) {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'Only your own messages can be changed' } };
    }
    const updated = { ...original };
    if (action === 'editChatMessage') {
      if (typeof args.newContent !== 'string' || !args.newContent.trim() || args.newContent.length > 100000) {
        throw new Error('Nonempty newContent required (maximum 100000 characters)');
      }
      updated.content = args.newContent;
      updated.isEdited = true;
      updated.editedAt = new Date().toISOString();
    } else if (action === 'pinChatMessage') {
      if (typeof args.isPinned !== 'boolean') throw new Error('Boolean isPinned required');
      updated.isPinned = args.isPinned;
    } else if (action === 'reactChatMessage') {
      if (args.reaction !== 'fire') throw new Error('Unsupported reaction');
      updated.reactions = { ...original.reactions };
      const tokens = Array.isArray(updated.reactions[args.reaction]) ? updated.reactions[args.reaction] : [];
      const actorToken = ghAuth?.username || profile.machineToken;
      updated.reactions[args.reaction] = tokens.includes(actorToken)
        ? tokens.filter(t => t !== actorToken)
        : [...tokens, actorToken];
    }
    const messages = room.messages;
    if (action === 'deleteChatMessage') {
      room.messages = messages.filter((_, i) => i !== index);
      room.deletedIds = [...new Set([...(room.deletedIds || []), original.id])].slice(-200);
    } else {
      room.messages = messages.map((m, i) => i === index ? updated : m);
    }
    try {
      await messageCache.savePersistentCache(cache);
    } catch (error) {
      room.messages = messages;
      throw error;
    }
    const resultObj = action === 'deleteChatMessage' ? { deleted: true, id: original.id, messageId: original.id } : updated;
    if (action === 'deleteChatMessage') {
      if (original.fileMeta?.filePath) {
        try {
          const safePath = await attachmentStore.confinedAttachment(original.fileMeta.filePath);
          await fs.unlink(safePath).catch(() => {});
        } catch {}
      }
      if (ghAuth?.token) {
        try {
          const targetRepo = await ensureAndSyncVaultRoom(ghAuth, args.roomId, room, signal);
          if (targetRepo) {
            await githubClient.deleteRoomComment?.({
              username: ghAuth.username,
              token: ghAuth.token,
              repo: targetRepo,
              issueNumber: room.issueNumber,
              commentId: original.commentId || null,
              messageId: original.id,
              signal,
            }).catch(() => {});
            if (original.fileMeta?.assetId) {
              await githubClient.deleteVaultAsset?.({
                username: ghAuth.username,
                token: ghAuth.token,
                repo: masterVault || cfg.vaultRepo,
                assetId: original.fileMeta.assetId,
                signal,
              }).catch(() => {});
            }
            if (room.issueNumber) {
              await githubClient.postRoomComment?.({
                username: ghAuth.username,
                token: ghAuth.token,
                repo: targetRepo,
                issueNumber: room.issueNumber,
                payload: { __workTombstone: true, deletedId: original.id, deletedAt: new Date().toISOString() },
                signal,
              }).catch(() => {});
            }
          }
        } catch {}
      }
      const lan = await getLanEngine().catch(() => null);
      const isMachineDm = args.roomId.startsWith('dm-') && args.roomId.slice(3).split('--').every(p => /^WK-[A-Z0-9-]+$/i.test(p));
      if (lan && (!args.roomId.startsWith('dm-') || isMachineDm)) {
        lan.sendChatToPeers({ type: 'chat-delete', roomId: args.roomId, messageId: original.id }).catch(() => {});
      }
    }
    if (realtimeRelay) {
      realtimeRelay.publishRoomEvent(args.roomId, relaySecretFor(), {
        type: 'chat-event',
        action,
        message: resultObj,
      }).catch(() => {});
    }
    return { ok: true, value: resultObj };
  };

  return {
    executeChatCommand: async (args) => {
      const command = parseChatCommand(args.text);
      const metadata = await gitEngine.getRepoMetadata(args.repoDir);
      if (command.kind === 'commit') {
        const auth = await getStoredGithubAuth();
        const profile = await ensureMachineProfile();
        const commit = await gitEngine.commitOnCollabBranch(args.repoDir, auth?.username || profile.machineToken, command.message);
        return { ok: true, value: { kind: 'commit', ...await gitEngine.getRepoMetadata(args.repoDir), transport: 'local-git', commit } };
      }
      if (command.kind === 'diff') {
        const diff = await gitEngine.getDiff(args.repoDir);
        return { ok: true, value: { kind: 'diff', ...metadata, transport: 'local-git', diff } };
      }
      if (!args.peerToken || String(args.peerToken).startsWith('channel:')) {
        return { ok: false, error: { code: 'PEER_REQUIRED', message: 'Select one securely paired LAN peer to share a repository' } };
      }
      const lan = await getLanEngine();
      if (!lan?.pairSecrets.has(args.peerToken)) {
        return { ok: false, error: { code: 'UNPAIRED_PEER', message: 'Secure LAN pairing required' } };
      }
      const packaged = await publisher.packageProjectToBuffer(args.repoDir, { sanitize: true, trackedOnly: false, bundle: true });
      const transferred = await lan.streamRepoToPeer(args.peerToken, metadata.repoName, packaged.zipBuffer);
      if (!transferred.ok) throw new Error(transferred.error || 'Repository transfer failed');
      return { ok: true, value: { kind: 'repo', ...metadata, transport: 'paired-lan-http', targetDir: transferred.targetDir } };
    },

    getChatMessages: async (args, signal) => {
      const { roomId = 'sync' } = args;
      validateRoomId(roomId);
      const cache = await messageCache.loadPersistentCache();
      if (!cache.rooms) cache.rooms = {};
      if (!cache.rooms[roomId]) {
        cache.rooms[roomId] = { issueNumber: null, lastEtag: null, since: null, messages: [] };
      }

      const roomRecord = cache.rooms[roomId];
      const ghAuth = await getStoredGithubAuth();
      if (ghAuth?.token) {
        if (realtimeRelay) realtimeRelay.subscribeRoom(roomId, relaySecretFor());
        try {
          const invTarget = roomRecord.vaultRepo || githubClient.parseRepoCoords(ghAuth.username, cfg.vaultRepo).fullName;
          const invitations = await githubClient.checkUserRepoInvitations({ token: ghAuth.token, signal });
          for (const invitation of invitations) {
            if (invitation.repoFullName?.toLowerCase() === invTarget.toLowerCase() &&
              !await githubClient.acceptUserRepoInvitation({ token: ghAuth.token, invitationId: invitation.id, signal })) {
              throw new Error('Vault invitation acceptance failed');
            }
          }
        } catch {}

        const now = Date.now();
        const prevSync = lastRoomSyncAt.get(roomId) || 0;
        const dirty = Boolean(dirtyRoomsFromRelay?.has(roomId) || args.force);
        if (dirty || now - prevSync >= 4000) {
          lastRoomSyncAt.set(roomId, now);
          dirtyRoomsFromRelay?.delete(roomId);
          try {
            const targetRepo = await ensureAndSyncVaultRoom(ghAuth, roomId, roomRecord, signal);
            if (targetRepo && roomRecord.issueNumber) {
              const delta = await githubClient.fetchRoomCommentsDelta({
                username: ghAuth.username,
                token: ghAuth.token,
                repo: targetRepo,
                issueNumber: roomRecord.issueNumber,
                lastEtag: roomRecord.lastEtag,
                since: roomRecord.since,
                signal,
              });
              if (!delta.notModified) {
                let hasChanges = false;
                const deletedSet = new Set([...(roomRecord.deletedIds || []), ...(delta.deletedIds || [])]);
                if (Array.isArray(delta.deletedIds) && delta.deletedIds.length > 0) {
                  for (const msg of roomRecord.messages) {
                    if (deletedSet.has(msg.id) && msg.fileMeta?.filePath) {
                      try {
                        const safePath = await attachmentStore.confinedAttachment(msg.fileMeta.filePath);
                        await fs.unlink(safePath).catch(() => {});
                      } catch {}
                    }
                  }
                  const beforeLen = roomRecord.messages.length;
                  roomRecord.messages = roomRecord.messages.filter(m => !deletedSet.has(m.id));
                  if (roomRecord.messages.length !== beforeLen) hasChanges = true;
                  roomRecord.deletedIds = [...deletedSet].slice(-200);
                }
                if (Array.isArray(delta.comments) && delta.comments.length > 0) {
                  for (const c of delta.comments) {
                    if (c && c.id && !deletedSet.has(c.id) && !roomRecord.messages.some(m => m.id === c.id)) {
                      roomRecord.messages.push(c);
                      hasChanges = true;
                    }
                  }
                }
                roomRecord.lastEtag = delta.etag;
                roomRecord.since = new Date().toISOString();
                if (hasChanges) {
                  roomRecord.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                  await messageCache.savePersistentCache(cache);
                }
              }
            }
          } catch (syncErr) {
            console.warn('[Work] Room delta sync notice:', syncErr.message);
          }
        }
      }

      return { ok: true, value: roomRecord.messages };
    },

    readAttachmentFile: async (args) => {
      const filePath = await attachmentStore.confinedAttachment(args.filePath);
      const cache = await messageCache.loadPersistentCache();
      const meta = Object.values(cache.rooms || {}).flatMap(r => r.messages || []).find(m => m.fileMeta?.filePath === filePath)?.fileMeta;
      const rawBase64 = (await fs.readFile(filePath)).toString('base64');
      return { ok: true, value: { rawBase64, mimeType: meta?.mimeType || 'application/octet-stream', name: meta?.name || path.basename(filePath) } };
    },

    deleteAttachmentFile: async (args) => {
      const filePath = await attachmentStore.confinedAttachment(args.filePath);
      await fs.unlink(filePath);
      const cache = await messageCache.loadPersistentCache();
      for (const room of Object.values(cache.rooms || {})) {
        for (const message of room.messages || []) {
          if (message.fileMeta?.filePath === filePath) message.fileMeta = { ...message.fileMeta, deletedAt: new Date().toISOString() };
        }
      }
      await messageCache.savePersistentCache(cache);
      return { ok: true, value: { deleted: true } };
    },

    editChatMessage: mutateMessage('editChatMessage'),
    deleteChatMessage: mutateMessage('deleteChatMessage'),
    pinChatMessage: mutateMessage('pinChatMessage'),
    reactChatMessage: mutateMessage('reactChatMessage'),

    sendChatMessage: async (args, signal) => {
      const { roomId = 'sync', content, type = 'text', fileMeta = null, rawBase64 = null } = args;
      if (!content && !fileMeta) {
        return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'content or fileMeta is required' } };
      }

      validateRoomId(roomId);
      const profile = await ensureMachineProfile();
      const ghAuth = await getStoredGithubAuth();
      let effectiveFileMeta = fileMeta ? { ...fileMeta } : null;
      const base64Data = rawBase64 || fileMeta?.rawBase64 || (fileMeta?.audioUrl?.startsWith('data:') ? fileMeta.audioUrl : null) || (fileMeta?.dataUrl?.startsWith('data:') ? fileMeta.dataUrl : null);
      let attachmentBytes = null;
      if (base64Data) {
        attachmentBytes = attachmentStore.decodeAttachment(base64Data);
        effectiveFileMeta = await attachmentStore.storeAttachment(effectiveFileMeta, attachmentBytes, type);
        if (ghAuth?.token) {
          try {
            const uploaded = await githubClient.uploadVaultAsset({
              username: ghAuth.username,
              token: ghAuth.token,
              repo: masterVault || cfg.vaultRepo,
              buffer: attachmentBytes,
              filename: path.basename(effectiveFileMeta.filePath),
              contentType: effectiveFileMeta.mimeType || 'application/octet-stream',
              signal,
            });
            effectiveFileMeta.assetId = uploaded.assetId;
            effectiveFileMeta.downloadUrl = uploaded.downloadUrl;
          } catch {}
        }
      } else if (effectiveFileMeta?.filePath) {
        const localPath = await attachmentStore.confinedAttachment(effectiveFileMeta.filePath);
        attachmentBytes = await fs.readFile(localPath);
      } else if (type === 'voice') {
        throw new Error('Voice attachment bytes required for local persistence');
      }

      const cache = await messageCache.loadPersistentCache();
      let replyTo = null;
      if (args.replyTo != null) {
        const replyId = typeof args.replyTo === 'string' ? args.replyTo : args.replyTo.id || args.replyTo.messageId;
        const target = cache.rooms?.[roomId]?.messages.find(m => m.id === replyId);
        if (!target) throw new Error('Reply target must exist in this room');
        replyTo = {
          id: target.id,
          sender: target.sender,
          senderName: target.senderName,
          content: String(target.content || '').slice(0, 2000),
          type: target.type,
        };
      }

      const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const messageObj = {
        id: messageId,
        roomId,
        sender: profile.machineToken,
        senderGithub: ghAuth?.username || null,
        senderName: ghAuth?.username ? `@${ghAuth.username}` : profile.machineName,
        content: content || '',
        type,
        fileMeta: effectiveFileMeta,
        replyTo,
        created_at: new Date().toISOString(),
      };

      if (!cache.rooms) cache.rooms = {};
      if (!cache.rooms[roomId]) {
        cache.rooms[roomId] = { issueNumber: null, lastEtag: null, since: null, messages: [] };
      }
      const roomRecord = cache.rooms[roomId];
      roomRecord.messages.push(messageObj);
      try {
        await messageCache.savePersistentCache(cache);
      } catch (error) {
        roomRecord.messages = roomRecord.messages.filter(m => m !== messageObj);
        throw error;
      }

      let vaultSynced = false;
      if (ghAuth?.token) {
        try {
          const targetRepo = await ensureAndSyncVaultRoom(ghAuth, roomId, roomRecord, signal);
          if (targetRepo && roomRecord.issueNumber) {
            const posted = await githubClient.postRoomComment({
              username: ghAuth.username,
              token: ghAuth.token,
              repo: targetRepo,
              issueNumber: roomRecord.issueNumber,
              payload: messageObj,
              signal,
            });
            messageObj.commentId = posted.commentId;
            roomRecord.since = new Date().toISOString();
            await messageCache.savePersistentCache(cache);
            vaultSynced = true;
          }
        } catch (commentErr) {
          console.warn('[Work] GitHub comment post notice:', commentErr.message);
        }
      }

      const lan = await getLanEngine().catch(() => null);
      const outbound = { ...messageObj, fileMeta: effectiveFileMeta ? { ...effectiveFileMeta } : null };
      if (outbound.fileMeta) {
        delete outbound.fileMeta.filePath;
        delete outbound.fileMeta.storedLocally;
        delete outbound.fileMeta.audioUrl;
        if (attachmentBytes && attachmentBytes.length <= 120 * 1024) outbound.fileMeta.rawBase64 = attachmentBytes.toString('base64');
      }
      let relayResult = { sentRelays: 0 };
      if (realtimeRelay && ghAuth?.token) {
        const serializedLen = Buffer.byteLength(JSON.stringify(outbound));
        const relayEvent = serializedLen <= 140 * 1024
          ? { type: 'chat-event', action: 'sendChatMessage', message: outbound }
          : { type: 'sync-hint', messageId: messageObj.id };
        relayResult = await realtimeRelay.publishRoomEvent(roomId, relaySecretFor(), relayEvent).catch(() => ({ sentRelays: 0 }));
      }
      const isMachineDm = roomId.startsWith('dm-') && roomId.slice(3).split('--').every(p => /^WK-[A-Z0-9-]+$/i.test(p));
      const deliveries = (lan && (!roomId.startsWith('dm-') || isMachineDm))
        ? await lan.sendChatToPeers({ ...outbound, fileMeta: outbound.fileMeta ? { ...outbound.fileMeta, ...(attachmentBytes ? { rawBase64: attachmentBytes.toString('base64') } : {}) } : null }).catch(() => [])
        : [];
      const transport = relayResult.sentRelays > 0
        ? (vaultSynced ? 'e2ee-relay+vault' : 'e2ee-relay')
        : (vaultSynced ? 'git-vault' : (deliveries.length ? 'paired-lan-http' : 'local-cached'));

      messageObj.delivery = {
        transport,
        status: (relayResult.sentRelays > 0 || vaultSynced || deliveries.some(d => d.ok)) ? 'delivered' : 'cached_offline',
        relays: relayResult.sentRelays,
      };

      return { ok: true, value: messageObj };
    },

    searchChatMessages: async (args) => {
      const query = String(args?.query || '').trim().toLowerCase();
      if (!query) return { ok: true, value: [] };
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || 20));
      const cache = await messageCache.loadPersistentCache();
      const matches = [];
      for (const [roomId, room] of Object.entries(cache.rooms || {})) {
        const deleted = new Set(room.deletedIds || []);
        for (const m of room.messages || []) {
          if (deleted.has(m.id)) continue;
          const text = String(m.content || '');
          const file = String(m.fileMeta?.name || '');
          if (text.toLowerCase().includes(query) || file.toLowerCase().includes(query)) {
            matches.push({
              id: m.id,
              roomId,
              senderName: m.senderName || 'Collaborator',
              content: text || file || 'Attachment',
              created_at: m.created_at,
            });
          }
        }
      }
      matches.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return { ok: true, value: matches.slice(0, limit) };
    },

    deleteChatRoom: async (args, signal) => {
      const { roomId } = args;
      validateRoomId(roomId);
      const cache = await messageCache.loadPersistentCache();
      const room = cache.rooms?.[roomId];
      if (!room) return { ok: true, value: { deleted: true, removedCount: 0 } };
      const existing = [...(room.messages || [])];
      const deletedIds = [...new Set([...(room.deletedIds || []), ...existing.map(m => m.id).filter(Boolean)])].slice(-400);
      room.messages = [];
      room.deletedIds = deletedIds;
      await messageCache.savePersistentCache(cache);
      const ghAuth = await getStoredGithubAuth();
      const lan = await getLanEngine().catch(() => null);
      const isMachineDm = roomId.startsWith('dm-') && roomId.slice(3).split('--').every(p => /^WK-[A-Z0-9-]+$/i.test(p));
      for (const msg of existing) {
        if (msg.fileMeta?.filePath) {
          try {
            const safePath = await attachmentStore.confinedAttachment(msg.fileMeta.filePath);
            await fs.unlink(safePath).catch(() => {});
          } catch {}
        }
        if (ghAuth?.token) {
          try {
            const targetRepo = await ensureAndSyncVaultRoom(ghAuth, roomId, room, signal);
            if (targetRepo) {
              await githubClient.deleteRoomComment?.({
                username: ghAuth.username,
                token: ghAuth.token,
                repo: targetRepo,
                issueNumber: room.issueNumber,
                commentId: msg.commentId || null,
                messageId: msg.id,
                signal,
              }).catch(() => {});
              if (msg.fileMeta?.assetId) {
                await githubClient.deleteVaultAsset?.({
                  username: ghAuth.username,
                  token: ghAuth.token,
                  repo: masterVault || cfg.vaultRepo,
                  assetId: msg.fileMeta.assetId,
                  signal,
                }).catch(() => {});
              }
              if (room.issueNumber) {
                await githubClient.postRoomComment?.({
                  username: ghAuth.username,
                  token: ghAuth.token,
                  repo: targetRepo,
                  issueNumber: room.issueNumber,
                  payload: { __workTombstone: true, deletedId: msg.id, deletedAt: new Date().toISOString() },
                  signal,
                }).catch(() => {});
              }
            }
          } catch {}
        }
        if (lan && (!roomId.startsWith('dm-') || isMachineDm)) {
          lan.sendChatToPeers({ type: 'chat-delete', roomId, messageId: msg.id }).catch(() => {});
        }
        if (realtimeRelay) {
          realtimeRelay.publishRoomEvent(roomId, relaySecretFor(), {
            type: 'chat-event',
            action: 'deleteChatMessage',
            message: { deleted: true, id: msg.id, messageId: msg.id },
          }).catch(() => {});
        }
      }
      return { ok: true, value: { deleted: true, removedCount: existing.length } };
    },
  };
}
