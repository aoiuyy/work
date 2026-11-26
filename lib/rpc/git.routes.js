import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Git collaboration, Vault sharing, merge conflict resolution, and patch RPC handlers.
 */
export function createGitRoutes({
  cfg,
  getStoredGithubAuth,
  ensureMachineProfile,
  gitEngine,
  githubClient,
  vault,
  messageCache,
  publisher,
  validateRoomId,
  realtimeRelay = null,
}) {
  async function gitVaultOptions(args, signal, ensure = false) {
    const auth = await getStoredGithubAuth();
    if (!auth?.token) throw new Error('Authenticated Git Vault required');
    const verified = await githubClient.verifyGithubAuth({ ...auth, signal });
    const username = verified.user.login;
    const coords = githubClient.parseRepoCoords(username, cfg.vaultRepo);
    const vaultOwner = args.vaultOwner || coords.owner;
    const vaultRepo = args.vaultRepo || coords.repo;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(vaultOwner) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(vaultRepo) || vaultRepo.includes('..')) {
      throw new Error('Invalid Vault coordinates');
    }
    if (!ensure && args.vaultOwner && args.vaultRepo) {
      const invitations = await githubClient.checkUserRepoInvitations({ token: auth.token, signal });
      for (const invitation of invitations) {
        if (invitation.repoFullName?.toLowerCase() === `${vaultOwner}/${vaultRepo}`.toLowerCase()) {
          if (!await githubClient.acceptUserRepoInvitation({ token: auth.token, invitationId: invitation.id, signal })) {
            throw new Error('Vault invitation acceptance failed; retry with repository invitation permission');
          }
        }
      }
    }
    if (ensure) await githubClient.ensureWorkVaultRepo({ username, token: auth.token, repo: `${vaultOwner}/${vaultRepo}`, signal });
    return {
      username,
      token: auth.token,
      vaultOwner,
      vaultRepo,
      peerUsername: args.peerUsername,
      repoId: args.repoId,
      branch: args.branch,
      hash: args.hash || args.commitHash,
    };
  }

  const commit = async (args) => ({
    ok: true,
    value: await gitEngine.stageAndCommit(args.repoPath, { message: args.message, files: args.files, stageAll: Boolean(args.stageAll) }),
  });

  const syncOrPush = (action) => async (args, signal) => {
    const options = await gitVaultOptions(args, signal, true);
    const res = action === 'syncGitRepository'
      ? await gitEngine.syncGitRepository(args.repoPath, options)
      : await gitEngine.pushCollabBranch(args.repoPath, options);
    return { ok: true, value: res };
  };

  return {
    getGitStatus: async (args) => ({ ok: true, value: await gitEngine.getRepoStatus(args.repoPath) }),
    commitRepository: commit,
    commitChanges: commit,
    getGitDiff: async (args) => ({ ok: true, value: await gitEngine.getDiff(args.repoPath, args.targetRef || 'HEAD') }),
    syncGitRepository: syncOrPush('syncGitRepository'),
    pushCollabBranch: syncOrPush('pushCollabBranch'),

    shareRepository: async (args, signal) => {
      const roomId = args.roomId || 'sync';
      validateRoomId(roomId);
      const options = await gitVaultOptions(args, signal, true);
      const links = (args.peerToken || args.recipientUsernames?.length) ? await vault.readPeerLinks().catch(() => []) : [];
      const linked = args.peerToken ? links?.find(link => link.peerToken?.toUpperCase() === String(args.peerToken).toUpperCase()) : null;
      const singleRecipient = args.recipientUsername || linked?.username || args.peerUsername;
      if (args.peerToken && !singleRecipient) throw new Error('Selected peer needs a verified GitHub username for automatic Vault access');
      const rawRecipients = [
        ...(Array.isArray(args.recipientUsernames) ? args.recipientUsernames : []),
        ...(singleRecipient ? [singleRecipient] : []),
      ];
      const recipients = [...new Set(rawRecipients.map(r => String(r || '').trim().replace(/^@+/, '')).filter(Boolean))];
      for (const recipient of recipients) {
        if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(recipient)) throw new Error(`Invalid recipient GitHub username: ${recipient}`);
      }
      const invitedRecipients = [];
      for (const recipient of recipients) {
        if (recipient.toLowerCase() === options.username.toLowerCase()) continue;
        const permission = await fetch(`https://api.github.com/repos/${options.vaultOwner}/${options.vaultRepo}/collaborators/${recipient}/permission`, {
          headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'DSH-Work-Plugin/4.6' },
          signal,
        });
        const access = permission.ok ? await permission.json() : null;
        if (!['admin', 'maintain', 'write'].includes(access?.permission) && !access?.user?.permissions?.push) {
          const invitation = await githubClient.inviteVaultCollaborator({
            username: options.username,
            token: options.token,
            repo: `${options.vaultOwner}/${options.vaultRepo}`,
            collaborator: recipient,
            permission: 'push',
            signal,
          });
          if (!invitation.ok) throw new Error(`Cannot grant @${recipient} Vault access (${invitation.status}); Vault owner/admin and collaborator permission are required`);
          invitedRecipients.push(recipient);
        }
      }
      const diff = await gitEngine.getDiff(args.repoPath, 'HEAD', { committed: true });
      if (!diff.audit.safe || diff.truncated) throw new Error('Security Shield blocked unsafe or oversized repository preview');
      const pushed = await gitEngine.pushCollabBranch(args.repoPath, options);
      const repoName = path.basename(path.resolve(args.repoPath));
      const card = {
        repoId: pushed.repoId,
        repoName,
        senderUsername: options.username,
        peerUsername: options.username,
        branch: pushed.branch,
        hash: pushed.hash,
        commitHash: pushed.hash,
        vaultOwner: options.vaultOwner,
        vaultRepo: options.vaultRepo,
        transport: 'git-vault',
        diffPreview: diff.diffText,
        diffSummary: { files: diff.totalChanges, additions: diff.totalAdditions, deletions: diff.totalDeletions },
        diff,
      };
      const cache = await messageCache.loadPersistentCache();
      cache.rooms ||= {};
      const room = cache.rooms[roomId] ||= { issueNumber: null, messages: [] };
      const issue = await githubClient.ensureRoomIssue({
        username: options.username,
        token: options.token,
        repo: `${options.vaultOwner}/${options.vaultRepo}`,
        roomName: roomId,
        signal,
      });
      const profile = await ensureMachineProfile();
      const message = {
        id: `repo-${randomUUID()}`,
        roomId,
        sender: profile.machineToken,
        senderName: options.username,
        content: repoName,
        type: 'repo-card',
        fileMeta: card,
        repoMeta: card,
        created_at: new Date().toISOString(),
      };
      const posted = await githubClient.postRoomComment({
        username: options.username,
        token: options.token,
        repo: `${options.vaultOwner}/${options.vaultRepo}`,
        issueNumber: issue.issueNumber,
        payload: message,
        signal,
      });
      message.commentId = posted.commentId;
      room.issueNumber = issue.issueNumber;
      room.vaultRepo = `${options.vaultOwner}/${options.vaultRepo}`;
      room.messages.push(message);
      await messageCache.savePersistentCache(cache);
      if (realtimeRelay) {
        const relaySecret = `${options.vaultOwner}/${options.vaultRepo}`;
        realtimeRelay.publishRoomEvent(roomId, relaySecret, { type: 'chat-event', action: 'repo-card', message, vaultRepo: relaySecret }).catch(() => {});
      }
      return { ok: true, value: { ...card, message, delivery: { transport: 'git-vault+relay', status: 'delivered' } } };
    },

    getRepoOverview: async (args) => ({ ok: true, value: await gitEngine.getWorkspaceGitOverview(args.repoPath) }),
    stageGitFiles: async (args) => ({ ok: true, value: await gitEngine.stageGitFiles(args.repoPath, args.files) }),
    unstageGitFiles: async (args) => ({ ok: true, value: await gitEngine.unstageGitFiles(args.repoPath, args.files) }),
    discardGitFile: async (args) => ({ ok: true, value: await gitEngine.discardFileChanges(args.repoPath, args.filePath) }),
    switchGitBranch: async (args) => ({ ok: true, value: await gitEngine.switchGitBranch(args.repoPath, args.branch, { create: Boolean(args.create) }) }),

    publishToGithub: async (args, signal) => {
      const auth = await getStoredGithubAuth();
      if (!auth?.token) throw new Error('Connect GitHub Personal Vault in Settings first');
      const status = await gitEngine.getWorkspaceGitOverview(args.repoPath);
      if (!status.isGit) throw new Error('Open a Git repository folder first');
      if (status.totalChanges > 0) {
        const msg = (args.commitMessage || '').trim() || `chore: publish ${path.basename(args.repoPath)}`;
        await gitEngine.stageAndCommit(args.repoPath, { message: msg });
      }
      let remoteUrl = status.remoteUrl;
      let githubRemote = status.githubRemote;
      let created = null;
      if (!githubRemote) {
        const repoName = (args.name || path.basename(path.resolve(args.repoPath))).trim();
        created = await githubClient.createGithubRepo({
          token: auth.token,
          name: repoName,
          description: args.description || 'Published from DSH Work',
          isPrivate: args.isPrivate !== false,
          signal,
        });
        remoteUrl = created.cloneUrl;
        await gitEngine.ensureOriginRemote(args.repoPath, remoteUrl);
        githubRemote = gitEngine.parseGithubRemote(remoteUrl);
      }
      const pushed = await gitEngine.pushOriginBranch(args.repoPath, { token: auth.token, remoteUrl, branch: args.branch });
      return { ok: true, value: { ...pushed, created: Boolean(created), htmlUrl: created?.htmlUrl || githubRemote?.htmlUrl } };
    },

    pushToOrigin: async (args) => {
      const auth = await getStoredGithubAuth();
      if (!auth?.token) throw new Error('Connect GitHub Personal Vault in Settings first');
      const status = await gitEngine.getWorkspaceGitOverview(args.repoPath);
      if (args.commitMessage?.trim() && status.totalChanges > 0) {
        await gitEngine.stageAndCommit(args.repoPath, { message: args.commitMessage.trim() });
      }
      return { ok: true, value: await gitEngine.pushOriginBranch(args.repoPath, { token: auth.token, branch: args.branch }) };
    },

    getRepoDeployments: async (args, signal) => {
      const auth = await getStoredGithubAuth();
      if (!auth?.token) return { ok: true, value: [] };
      const status = await gitEngine.getWorkspaceGitOverview(args.repoPath);
      if (!status.githubRemote) return { ok: true, value: [] };
      const deployments = await githubClient.listRepoDeployments({
        owner: status.githubRemote.owner,
        repo: status.githubRemote.repo,
        token: auth.token,
        signal,
      });
      return { ok: true, value: deployments };
    },

    cloneSharedRepository: async (args, signal) => {
      const options = await gitVaultOptions(args, signal);
      return { ok: true, value: await gitEngine.cloneSharedRepository(args.parentDir, args.repoName, options) };
    },

    fetchCollabBranch: async (args, signal) => {
      const options = await gitVaultOptions(args, signal);
      return { ok: true, value: await gitEngine.fetchCollabBranch(args.repoPath, options) };
    },

    mergeCollabBranch: async (args, signal) => {
      const options = await gitVaultOptions(args, signal);
      return { ok: true, value: await gitEngine.mergeCollabBranch(args.repoPath, args.peerUsername, options) };
    },

    getMergeConflicts: async (args) => ({ ok: true, value: await gitEngine.getMergeConflicts(args.repoPath) }),

    resolveMergeConflict: async (args) => ({
      ok: true,
      value: await gitEngine.resolveMergeConflict(args.repoPath, {
        filePath: args.filePath,
        strategy: args.strategy,
        manualContent: args.manualContent,
      }),
    }),

    completeMerge: async (args) => ({ ok: true, value: await gitEngine.completeMerge(args.repoPath, args.message) }),

    abortMerge: async (args) => ({ ok: true, value: await gitEngine.abortMerge(args.repoPath) }),

    generateGitPatch: async (args) => {
      const result = await publisher.generateGitPatch({ cwd: args.targetPath, baseSha: args.baseSha });
      return result.ok
        ? { ok: true, value: result }
        : { ok: false, error: { code: 'GIT_PATCH_FAILED', message: result.error, details: {} } };
    },

    applyGitPatch: async (args) => {
      const result = await publisher.applyGitPatch({ targetDir: args.targetDir, patchContent: args.patchContent });
      return result.ok
        ? { ok: true, value: result }
        : { ok: false, error: { code: 'GIT_PATCH_FAILED', message: result.error, details: {} } };
    },
  };
}
