/**
 * Lazy-initializes and coordinates the LAN discovery engine with local cache and vault links.
 */
export function createLanBridge({
  cfg,
  ensureMachineProfile,
  attachmentStore,
  messageCache,
  vault,
  LanDiscoveryEngine,
  validateRoomId,
}) {
  let isDisposed = false;
  let lanEngine = null;
  let lanInitPromise = null;
  let latestLanUpdate = null;

  async function onPeerMessage(msg) {
    if (msg?.type === 'peer_paired' && msg.peerToken) {
      try {
        const links = await vault.readPeerLinks().catch(() => []);
        const cleanToken = msg.peerToken.trim().toUpperCase();
        const cleanAlias = msg.peerName || 'LAN Peer';
        const existingIdx = links.findIndex(l => l.peerToken === cleanToken);
        if (existingIdx !== -1) {
          links[existingIdx].alias = cleanAlias;
          links[existingIdx].updatedAt = Date.now();
        } else {
          links.push({ peerToken: cleanToken, alias: cleanAlias, linkedAt: Date.now() });
        }
        await vault.writePeerLinks(links);
      } catch {}
    } else if (msg?.type === 'chat' && msg.message) {
      const m = { ...msg.message, fileMeta: msg.message.fileMeta ? { ...msg.message.fileMeta } : null };
      const rId = validateRoomId(m.roomId);
      if (m.fileMeta) {
        const raw = m.fileMeta.rawBase64;
        delete m.fileMeta.filePath;
        delete m.fileMeta.storedLocally;
        delete m.fileMeta.audioUrl;
        delete m.fileMeta.dataUrl;
        delete m.fileMeta.rawBase64;
        if (raw) {
          m.fileMeta = await attachmentStore.storeAttachment(
            m.fileMeta,
            attachmentStore.decodeAttachment(raw),
            m.type
          );
        }
      }
      const cache = await messageCache.loadPersistentCache();
      if (!cache.rooms) cache.rooms = {};
      if (!cache.rooms[rId]) cache.rooms[rId] = { issueNumber: null, lastEtag: null, since: null, messages: [] };
      if (!cache.rooms[rId].messages.some(x => x.id === m.id)) {
        cache.rooms[rId].messages.push(m);
        await messageCache.savePersistentCache(cache);
      }
    } else if (msg?.type === 'chat-delete' && msg.roomId && msg.messageId) {
      const rId = validateRoomId(msg.roomId);
      const cache = await messageCache.loadPersistentCache();
      const room = cache.rooms?.[rId];
      if (room) {
        const target = (room.messages || []).find(x => x.id === msg.messageId);
        room.messages = (room.messages || []).filter(x => x.id !== msg.messageId);
        room.deletedIds = [...new Set([...(room.deletedIds || []), msg.messageId])].slice(-200);
        await messageCache.savePersistentCache(cache);
        if (target?.fileMeta?.filePath) {
          try { await attachmentStore.deleteAttachment?.(target.fileMeta.filePath); } catch {}
        }
      }
    } else if (msg?.type === 'work_update_available') {
      latestLanUpdate = {
        version: msg.version,
        assetId: msg.assetId,
        downloadUrl: msg.downloadUrl,
        publishedAt: msg.publishedAt,
        sender: msg.sender,
      };
    }
  }

  async function getLanEngine() {
    if (isDisposed) return null;
    if (!lanEngine) {
      if (!lanInitPromise) {
        lanInitPromise = (async () => {
          const profile = await ensureMachineProfile();
          if (isDisposed) return null;
          const engine = new LanDiscoveryEngine({
            machineToken: profile.machineToken,
            machineName: profile.machineName,
            defaultParent: cfg.defaultParent,
            onPeerMessage,
          });
          await engine.start().catch((err) => {
            console.warn('[Work] LAN discovery init notice:', err.message);
          });
          if (isDisposed) {
            await engine.stop().catch(() => {});
            return null;
          }
          lanEngine = engine;
          return engine;
        })();
      }
      return await lanInitPromise;
    }
    return lanEngine;
  }

  async function stop() {
    isDisposed = true;
    if (lanInitPromise) {
      try {
        const l = await lanInitPromise;
        if (l) await l.stop().catch(() => {});
      } catch {}
    }
    if (lanEngine) {
      await lanEngine.stop().catch(() => {});
      lanEngine = null;
    }
  }

  return {
    getLanEngine,
    stop,
    getLatestUpdate: () => latestLanUpdate,
  };
}
