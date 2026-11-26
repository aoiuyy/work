import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { assembleClientBundle } from '../../scripts/build-ui.mjs';

/**
 * Auth, config, peer links, Vault packages, pickers, quick commands, and self-update RPC handlers.
 */
export function createSystemRoutes({
  ctx,
  cfg,
  pluginDir,
  getStoredGithubAuth,
  ensureMachineProfile,
  githubClient,
  vault,
  publisher,
  zipExtractor,
  workUpdates,
  quickRunner,
  pickNativePathWindows,
  getLanEngine,
  getLatestLanUpdate,
  getLatestRelayUpdate = () => null,
  masterVault = 'aoiuyy/dsh-work-vault',
  realtimeRelay = null,
}) {
  return {
    getRealtimeStatus: async () => ({
      ok: true,
      value: realtimeRelay ? realtimeRelay.getStatus() : { enabled: false, connectedRelays: 0, urls: [] },
    }),
    requestDeviceLogin: async (args, signal) => ({
      ok: true,
      value: await githubClient.requestGithubDeviceCode({ clientId: args?.clientId, signal }),
    }),

    pollDeviceLogin: async (args, signal) => {
      const { deviceCode, clientId, repo } = args;
      if (!deviceCode) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'deviceCode required' } };
      const pollRes = await githubClient.pollGithubDeviceToken({ deviceCode, clientId, signal });
      if (pollRes.status !== 'success' || !pollRes.token) {
        return { ok: true, value: { status: pollRes.status, authenticated: false } };
      }
      const verify = await githubClient.verifyGithubAuth({ token: pollRes.token, signal });
      const userLogin = verify.user.login;
      if (process.platform === 'win32') {
        await vault.writeGithubAuth({ username: userLogin, token: pollRes.token.trim() });
      } else {
        process.env.GITHUB_USERNAME = userLogin;
        process.env.GITHUB_TOKEN = pollRes.token.trim();
      }
      if (repo) cfg.vaultRepo = repo.trim();
      return { ok: true, value: { status: 'success', authenticated: true, user: verify.user } };
    },

    getConfig: async () => {
      const ghAuth = await getStoredGithubAuth();
      const profile = await ensureMachineProfile();
      return {
        ok: true,
        value: {
          defaultParent: cfg.defaultParent,
          vaultRepo: cfg.vaultRepo,
          showBubble: cfg.showBubble !== false,
          githubUsername: ghAuth?.username || null,
          hasGithubToken: Boolean(ghAuth?.token),
          machineToken: profile?.machineToken || null,
          machineName: profile?.machineName || cfg.machineName,
          machineId: profile?.machineId || null,
        },
      };
    },

    setConfig: async (args) => {
      if (typeof args.defaultParent === 'string') cfg.defaultParent = args.defaultParent.trim();
      if (typeof args.vaultRepo === 'string') cfg.vaultRepo = args.vaultRepo.trim();
      if (typeof args.showBubble === 'boolean') cfg.showBubble = args.showBubble;
      if (typeof args.machineName === 'string') {
        cfg.machineName = args.machineName.trim();
        const profile = await ensureMachineProfile();
        profile.machineName = cfg.machineName;
        await vault.writeMachineProfile(profile).catch(() => {});
      }
      await vault.writeWorkConfig(cfg).catch(() => {});
      return {
        ok: true,
        value: { defaultParent: cfg.defaultParent, vaultRepo: cfg.vaultRepo, machineName: cfg.machineName, showBubble: cfg.showBubble !== false },
      };
    },

    getGithubAuth: async () => {
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: true, value: { connected: false, user: null, maskedToken: null } };
      const maskedToken = ghAuth.token.length > 8 ? `${ghAuth.token.slice(0, 4)}...${ghAuth.token.slice(-4)}` : '****';
      return {
        ok: true,
        value: {
          connected: true,
          user: { login: ghAuth.username },
          maskedToken,
          isDpapiProtected: process.platform === 'win32',
        },
      };
    },

    setGithubAuth: async (args, signal) => {
      const { token, username, repo } = args;
      if (!token || typeof token !== 'string') {
        return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Token is required' } };
      }
      const verify = await githubClient.verifyGithubAuth({ username, token, signal });
      const userLogin = verify.user.login;
      if (process.platform === 'win32') {
        await vault.writeGithubAuth({ username: userLogin, token: token.trim() });
      } else {
        process.env.GITHUB_USERNAME = userLogin;
        process.env.GITHUB_TOKEN = token.trim();
      }
      if (repo) cfg.vaultRepo = repo.trim();
      const maskedToken = token.length > 8 ? `${token.slice(0, 4)}...${token.slice(-4)}` : '****';
      return {
        ok: true,
        value: {
          login: userLogin,
          name: verify.user.name,
          avatarUrl: verify.user.avatarUrl,
          maskedToken,
          isDpapiProtected: process.platform === 'win32',
        },
      };
    },

    disconnectGithub: async () => {
      if (process.platform === 'win32') await vault.deleteGithubAuth();
      else {
        delete process.env.GITHUB_USERNAME;
        delete process.env.GITHUB_TOKEN;
      }
      return { ok: true, value: { disconnected: true } };
    },

    getMachineProfile: async () => {
      const profile = await ensureMachineProfile();
      const ghAuth = await getStoredGithubAuth();
      return { ok: true, value: { ...profile, githubUsername: ghAuth?.username || null } };
    },

    getPeerLinks: async () => ({ ok: true, value: await vault.readPeerLinks().catch(() => []) }),

    savePeerLink: async (args) => {
      const { peerToken, alias, customAlias = undefined, avatarUrl = null, status = 'online', username = null, workVersion = null } = args;
      if (!peerToken) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Token is required' } };
      const links = await vault.readPeerLinks().catch(() => []);
      const cleanToken = peerToken.trim().toUpperCase();
      const cleanUser = username ? username.replace(/^@/, '').trim() : null;
      const cleanCustom = typeof customAlias === 'string' ? customAlias.trim() : undefined;
      const effectiveAlias = cleanCustom !== undefined
        ? (cleanCustom || (cleanUser ? `@${cleanUser}` : cleanToken))
        : (alias ? alias.trim() : (cleanUser ? `@${cleanUser}` : cleanToken));
      const existingIdx = links.findIndex(l => l.peerToken === cleanToken);
      const linkData = {
        peerToken: cleanToken,
        alias: effectiveAlias,
        customAlias: cleanCustom !== undefined ? (cleanCustom || null) : (links[existingIdx]?.customAlias || null),
        avatarUrl: avatarUrl || (cleanUser ? `https://github.com/${cleanUser}.png` : null),
        status: status || 'online',
        username: cleanUser || (effectiveAlias.startsWith('@') ? effectiveAlias.slice(1) : links[existingIdx]?.username || null),
        workVersion: workVersion || null,
        updatedAt: Date.now(),
      };
      if (existingIdx !== -1) links[existingIdx] = { ...links[existingIdx], ...linkData };
      else links.push({ ...linkData, linkedAt: Date.now() });
      await vault.writePeerLinks(links);
      return { ok: true, value: links };
    },

    removePeerLink: async (args) => {
      const links = await vault.readPeerLinks().catch(() => []);
      const cleanToken = String(args.peerToken || '').trim().toUpperCase();
      const cleanUser = String(args.username || '').replace(/^@+/, '').trim().toLowerCase();
      const filtered = links.filter(l => {
        const tokMatch = cleanToken && String(l.peerToken || '').toUpperCase() === cleanToken;
        const userMatch = cleanUser && String(l.username || '').replace(/^@+/, '').toLowerCase() === cleanUser;
        return !(tokMatch || userMatch);
      });
      await vault.writePeerLinks(filtered);
      return { ok: true, value: filtered };
    },

    publishTool: async (args, signal) => {
      const { targetPath, toolName, notes = '', tag = null, bundle = true, trackedOnly = false, sanitize = true } = args;
      if (!targetPath) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'targetPath is required' } };
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: false, error: { code: 'GITHUB_AUTH_REQUIRED', message: 'Connect GitHub token first' } };
      const profile = await ensureMachineProfile();
      const published = await publisher.publishToolToGithub({
        targetPath,
        toolName,
        notes,
        tag,
        bundle,
        trackedOnly,
        sanitize,
        githubUsername: ghAuth.username,
        githubToken: ghAuth.token,
        githubRepo: cfg.vaultRepo,
        machineToken: profile.machineToken,
        signal,
      });
      return { ok: true, value: published };
    },

    packageRepo: async (args) => {
      const { targetPath, sanitize = true, bundle = true } = args;
      if (!targetPath) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'targetPath is required' } };
      const packaged = await publisher.packageProjectToBuffer(targetPath, { sanitize, bundle });
      return {
        ok: true,
        value: {
          toolName: path.basename(path.resolve(targetPath)),
          size: packaged.size,
          sha256: packaged.sha256,
          meta: packaged.meta,
          tokenCount: packaged.tokenCount,
          filesCount: Array.isArray(packaged.files) ? packaged.files.length : 1,
          digestText: packaged.digestText,
        },
      };
    },

    listMyTools: async (_args, signal) => {
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: true, value: [] };
      return {
        ok: true,
        value: await githubClient.listReleasesFromGithub({ username: ghAuth.username, token: ghAuth.token, repo: cfg.vaultRepo, signal }),
      };
    },

    deleteTool: async (args, signal) => {
      const { releaseId, releaseTag } = args;
      if (!releaseId && !releaseTag) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'releaseId or releaseTag required' } };
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: false, error: { code: 'GITHUB_AUTH_REQUIRED', message: 'Connect GitHub token first' } };
      await githubClient.deleteToolFromGithub({
        username: ghAuth.username,
        token: ghAuth.token,
        repo: cfg.vaultRepo,
        releaseId,
        releaseTag,
        signal,
      });
      return { ok: true, value: { deleted: true } };
    },

    downloadTool: async (args, signal) => {
      const { assetId, toolName = 'downloaded-repo', targetParent = cfg.defaultParent, folderName, conflictResolution = 'auto-rename' } = args;
      if (!assetId) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'assetId is required' } };
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: false, error: { code: 'GITHUB_AUTH_REQUIRED', message: 'Connect GitHub token first' } };
      const destinationDir = path.resolve(targetParent || process.cwd(), (folderName || toolName).replace(/[\\/:*?"<>|]/g, '_'));
      const downloaded = await githubClient.downloadToolFromGithub({
        username: ghAuth.username,
        token: ghAuth.token,
        repo: cfg.vaultRepo,
        assetId,
        signal,
      });
      const extraction = await zipExtractor.extractZipSafely(downloaded.buffer, destinationDir, { conflictResolution });
      return { ok: true, value: { targetDir: extraction.targetDir, extractedCount: extraction.extractedCount, meta: extraction.meta } };
    },

    extractZipBuffer: async (args) => {
      const { base64Data, toolName = 'transferred-repo', targetParent = cfg.defaultParent, folderName, conflictResolution = 'auto-rename' } = args;
      if (!base64Data) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'base64Data is required' } };
      const destinationDir = path.resolve(targetParent || process.cwd(), (folderName || toolName).replace(/[\\/:*?"<>|]/g, '_'));
      const extraction = await zipExtractor.extractZipSafely(Buffer.from(base64Data, 'base64'), destinationDir, { conflictResolution });
      return { ok: true, value: { targetDir: extraction.targetDir, extractedCount: extraction.extractedCount, meta: extraction.meta } };
    },

    syncMachineHeartbeat: async (_args, signal) => {
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: true, value: { registered: false } };
      if (!cfg.vaultRepo.includes('/') && ghAuth.username) {
        try {
          const collabVaults = await githubClient.findCollaboratorVaults({ token: ghAuth.token, signal });
          if (collabVaults.length > 0) {
            cfg.vaultRepo = collabVaults[0].fullName;
            await vault.writeWorkConfig({ ...cfg, vaultRepo: cfg.vaultRepo }).catch(() => {});
          }
        } catch (e) {
          console.warn('[Work] Collab vault auto-discover warning:', e.message);
        }
      }
      const profile = await ensureMachineProfile();
      await githubClient.registerMachineInVault({
        username: ghAuth.username,
        token: ghAuth.token,
        repo: cfg.vaultRepo,
        machineToken: profile.machineToken,
        machineName: profile.machineName,
        signal,
      });
      return { ok: true, value: { registered: true, machineToken: profile.machineToken, vaultRepo: cfg.vaultRepo } };
    },

    listDiscoveredMachines: async (_args, signal) => {
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: true, value: [] };
      return {
        ok: true,
        value: await githubClient.listMachinesInVault({ username: ghAuth.username, token: ghAuth.token, repo: cfg.vaultRepo, signal }),
      };
    },

    getSuggestedPeers: async (_args, signal) => {
      const ghAuth = await getStoredGithubAuth();
      const peerLinks = await vault.readPeerLinks().catch(() => []);
      const suggestions = { online: [], offline: [], not_installed: [] };
      const seenTokens = new Set();
      const seenUsers = new Set();

      if (ghAuth?.token) {
        try {
          const machines = await githubClient.listMachinesInVault({ username: ghAuth.username, token: ghAuth.token, repo: cfg.vaultRepo, signal });
          for (const m of machines) {
            if (!m.machineToken) continue;
            seenTokens.add(m.machineToken.toUpperCase());
            const isOnline = m.lastSeen && (Date.now() - m.lastSeen < 5 * 60 * 1000);
            const item = {
              machineToken: m.machineToken,
              machineName: m.machineName || 'Workstation',
              username: m.githubUsername || ghAuth.username,
              alias: m.machineName || m.machineToken,
              workVersion: m.workVersion || '2.0.0',
              lastSeen: m.lastSeen || null,
              status: isOnline ? 'online' : 'offline',
              avatarUrl: `https://github.com/${m.githubUsername || ghAuth.username}.png`,
              isVaultMachine: true,
            };
            suggestions[isOnline ? 'online' : 'offline'].push(item);
          }
        } catch (err) {
          console.warn('[Work]', `listMachinesInVault failed: ${err.message}`);
        }

        try {
          const collabs = await githubClient.listVaultCollaborators({ username: ghAuth.username, token: ghAuth.token, repo: cfg.vaultRepo, signal });
          for (const c of collabs) {
            if (c.username.toLowerCase() === ghAuth.username.toLowerCase()) continue;
            seenUsers.add(c.username.toLowerCase());
            const exists = [...suggestions.online, ...suggestions.offline].some(o => o.username?.toLowerCase() === c.username.toLowerCase());
            if (!exists) {
              suggestions.not_installed.push({
                machineToken: `USER-${c.username.toUpperCase()}`,
                machineName: c.name || c.username,
                username: c.username,
                alias: `@${c.username}`,
                workVersion: null,
                lastSeen: null,
                status: 'not_installed',
                avatarUrl: c.avatarUrl || `https://github.com/${c.username}.png`,
                isVaultMachine: false,
              });
            }
          }
        } catch (err) {
          console.warn('[Work]', `listVaultCollaborators failed: ${err.message}`);
        }
      }

      for (const link of peerLinks) {
        const cleanToken = link.peerToken ? link.peerToken.toUpperCase() : '';
        if (cleanToken && seenTokens.has(cleanToken)) continue;
        const isUserHandle = link.alias?.startsWith('@') || link.peerToken?.startsWith('USER-');
        const cleanUser = link.alias ? link.alias.replace(/^@/, '') : '';
        if (isUserHandle && cleanUser && seenUsers.has(cleanUser.toLowerCase())) continue;
        const status = link.status || (link.lastSeen && (Date.now() - link.lastSeen < 300000) ? 'online' : (link.lastSeen ? 'offline' : 'not_installed'));
        const peerItem = {
          machineToken: link.peerToken,
          machineName: link.alias,
          username: cleanUser || null,
          alias: link.alias,
          workVersion: link.workVersion || null,
          lastSeen: link.lastSeen || null,
          status,
          avatarUrl: link.avatarUrl || (cleanUser ? `https://github.com/${cleanUser}.png` : null),
          isVaultMachine: false,
        };
        suggestions[status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'not_installed'].push(peerItem);
      }

      return { ok: true, value: suggestions };
    },

    searchGithubUsers: async (args, signal) => {
      const ghAuth = await getStoredGithubAuth();
      return { ok: true, value: await githubClient.searchGithubUsers({ query: args.query, token: ghAuth?.token || null, signal }) };
    },

    verifyPeerUser: async (args, signal) => {
      const { username } = args;
      if (!username) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Username is required' } };
      const ghAuth = await getStoredGithubAuth();
      const profile = await githubClient.fetchGithubUserProfile({ username, token: ghAuth?.token || null, signal });
      if (!profile.exists) return { ok: true, value: { exists: false, username } };

      let presenceStatus = 'not_installed';
      let machineInfo = null;
      if (ghAuth?.token) {
        try {
          let targetRepo = cfg.vaultRepo;
          let machines = await githubClient.listMachinesInVault({ username: ghAuth.username, token: ghAuth.token, repo: targetRepo, signal }).catch(() => []);
          if (!machines.some(m => m.githubUsername?.toLowerCase() === profile.username.toLowerCase())) {
            const targetVault = `${profile.username}/dsh-work-vault`;
            const altMachines = await githubClient.listMachinesInVault({ username: ghAuth.username, token: ghAuth.token, repo: targetVault, signal }).catch(() => []);
            if (altMachines.length > 0) {
              machines = altMachines;
              cfg.vaultRepo = targetVault;
              await vault.writeWorkConfig(cfg).catch(() => {});
            }
          }
          const match = machines.find(m =>
            (m.githubUsername && m.githubUsername.toLowerCase() === profile.username.toLowerCase()) ||
            (m.machineName && m.machineName.toLowerCase() === profile.username.toLowerCase())
          );
          if (match) {
            machineInfo = match;
            presenceStatus = (match.lastSeen && Date.now() - match.lastSeen < 300000) ? 'online' : 'offline';
          }
        } catch {}
      }

      return {
        ok: true,
        value: {
          exists: true,
          profile: {
            username: profile.username,
            name: profile.name,
            avatarUrl: profile.avatarUrl,
            bio: profile.bio,
            status: presenceStatus,
            machineToken: machineInfo?.machineToken || `USER-${profile.username.toUpperCase()}`,
            machineName: machineInfo?.machineName || profile.name || profile.username,
            lastSeen: machineInfo?.lastSeen || null,
            workVersion: machineInfo?.workVersion || null,
          },
        },
      };
    },

    generatePeerInviteTicket: async (args, signal) => {
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: false, error: { code: 'NOT_AUTHENTICATED', message: 'GitHub login required' } };
      const cleanUser = (args.username || '').replace(/^@/, '').trim();
      let collaboratorStatus = 'skipped';
      if (cleanUser && cleanUser.toLowerCase() !== ghAuth.username.toLowerCase()) {
        try {
          const inviteRes = await githubClient.inviteVaultCollaborator({
            username: ghAuth.username,
            token: ghAuth.token,
            repo: cfg.vaultRepo,
            collaborator: cleanUser,
            signal,
          });
          collaboratorStatus = inviteRes.status === 204 ? 'already_collaborator' : 'invited';
        } catch (e) {
          console.warn('[Work] Collaborator invite warning:', e.message);
          collaboratorStatus = 'failed: ' + e.message;
        }
      }

      try {
        const linkPath = `links/link-${ghAuth.username}-${cleanUser}.json`;
        const existingLink = await githubClient.getRepoFileContent({
          username: ghAuth.username,
          token: ghAuth.token,
          repo: cfg.vaultRepo,
          path: linkPath,
          signal,
        }).catch(() => null);
        await githubClient.putRepoFileContent({
          username: ghAuth.username,
          token: ghAuth.token,
          repo: cfg.vaultRepo,
          path: linkPath,
          content: JSON.stringify({ initiator: ghAuth.username, peer: cleanUser, linkedAt: new Date().toISOString(), status: 'linked' }, null, 2),
          message: `Link peer @${cleanUser}`,
          sha: existingLink?.sha,
          signal,
        }).catch(() => {});
      } catch {}

      const ticketRes = await githubClient.getVaultAssetSignedUrl({
        username: ghAuth.username,
        token: ghAuth.token,
        repo: cfg.vaultRepo,
        filename: 'work-v2-dist.zip',
        signal,
      });
      const signedUrl = ticketRes.signedUrl;
      const inviteUrl = `https://github.com/${ghAuth.username}/${cfg.vaultRepo}/invitations`;
      const psCommand = `irm "${signedUrl}" -OutFile work.zip; Expand-Archive work.zip -DestinationPath plugins/work-v2 -Force; Remove-Item work.zip`;
      const curlCommand = `curl.exe -sL "${signedUrl}" -o work.zip && tar -xf work.zip -C plugins/work-v2 && del work.zip`;
      const inviteText = `[Work] Connect with @${ghAuth.username}:\n1. Accept Invite: ${inviteUrl}\n2. Install (PowerShell):\n${psCommand}`;

      return { ok: true, value: { username: cleanUser, collaboratorStatus, inviteUrl, signedUrl, psCommand, curlCommand, inviteText } };
    },

    checkPendingVaultInvitations: async (_args, signal) => {
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: true, value: [] };
      try {
        return { ok: true, value: await githubClient.checkUserRepoInvitations({ token: ghAuth.token, signal }) };
      } catch {
        return { ok: true, value: [] };
      }
    },

    acceptVaultInvitation: async (args, signal) => {
      const { invitationId, vaultRepo } = args;
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: false, error: { code: 'NOT_AUTHENTICATED', message: 'GitHub login required' } };
      if (!invitationId) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'invitationId is required' } };
      await githubClient.acceptUserRepoInvitation({ token: ghAuth.token, invitationId, signal });
      if (vaultRepo) {
        const cleanVault = vaultRepo.includes('/') ? vaultRepo.split('/')[1] : vaultRepo;
        cfg.vaultRepo = cleanVault;
        await vault.writeWorkConfig({ ...cfg, vaultRepo: cleanVault }).catch(() => {});
      }
      return { ok: true, value: { accepted: true } };
    },

    runQuickCommand: (args) => quickRunner.runQuickCommand(args),
    stopQuickCommand: (args) => quickRunner.stopQuickCommand(args),

    pickDirectory: async (args, signal) => {
      if (process.platform === 'win32') {
        const picked = await pickNativePathWindows({ mode: 'folder', title: args?.title || 'Select project directory' });
        if (picked) return { ok: true, value: picked };
      }
      const controller = ctx.get?.('directoryPickerController');
      if (controller) {
        try {
          const picked = typeof controller.browse === 'function' ? await controller.browse(signal)
            : typeof controller.pick === 'function' ? await controller.pick(signal) : null;
          if (picked) return { ok: true, value: picked };
        } catch {}
      }
      return { ok: false, error: { code: 'NOT_SUPPORTED', message: 'Directory picker not available' } };
    },

    pickFile: async (args, signal) => {
      if (process.platform === 'win32') {
        const picked = await pickNativePathWindows({ mode: 'file', title: args?.title || 'Select file or archive' });
        if (picked) return { ok: true, value: picked };
      }
      const controller = ctx.get?.('filePickerController');
      if (controller) {
        try {
          const picked = typeof controller.browse === 'function' ? await controller.browse(signal)
            : typeof controller.pick === 'function' ? await controller.pick(signal) : null;
          if (picked) return { ok: true, value: picked };
        } catch {}
      }
      return { ok: false, error: { code: 'NOT_SUPPORTED', message: 'Picker service not available' } };
    },

    publishWorkUpdate: async (args, signal) => {
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: false, error: { code: 'AUTH_REQUIRED', message: 'GitHub account must be connected to publish updates' } };
      if ((ghAuth.username || '').toLowerCase() !== 'aoiuyy') {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Only @aoiuyy can publish Work updates' } };
      }
      const pkgPath = path.join(pluginDir, 'package.json');
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      let targetVersion = args?.newVersion;
      if (!targetVersion) {
        const parts = (pkg.version || '2.0.1').split('.');
        if (parts.length === 3 && !isNaN(Number(parts[2]))) {
          parts[2] = String(Number(parts[2]) + 1);
          targetVersion = parts.join('.');
        } else {
          targetVersion = `${pkg.version || '2.0.1'}-1`;
        }
      }
      pkg.version = targetVersion;
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      try {
        const builtClient = await assembleClientBundle(pluginDir);
        await fs.writeFile(path.join(pluginDir, 'client.js'), builtClient, 'utf8');
      } catch {}
      const selfPkg = await publisher.packagePluginSelf({ pluginDir });
      const releaseRepo = 'work';
      const releaseMeta = await githubClient.uploadToolToGithub({
        username: ghAuth.username,
        token: ghAuth.token,
        repo: releaseRepo,
        toolName: 'work',
        notes: `Work v${selfPkg.version}`,
        tag: `work-v${selfPkg.version}`,
        assetName: `work-v${selfPkg.version}.zip`,
        zipBuffer: selfPkg.zipBuffer,
        digestText: `# Work v${selfPkg.version}`,
        sha256: selfPkg.sha256,
        preserveExisting: true,
        signal,
      });

      const updateMsg = {
        type: 'work_update_available',
        version: selfPkg.version,
        assetId: releaseMeta?.assetId,
        downloadUrl: releaseMeta?.downloadUrl,
        publishedAt: new Date().toISOString(),
      };
      const lan = await getLanEngine().catch(() => null);
      if (lan) {
        if (typeof lan.broadcastUpdate === 'function') lan.broadcastUpdate(updateMsg);
        if (typeof lan.sendChatToPeers === 'function') lan.sendChatToPeers(updateMsg).catch(() => {});
      }
      if (realtimeRelay && typeof realtimeRelay.publishRoomEvent === 'function') {
        realtimeRelay.publishRoomEvent('work-updates', 'aoiuyy/work', {
          type: 'work-update',
          version: selfPkg.version,
          assetId: releaseMeta?.assetId || null,
          downloadUrl: releaseMeta?.downloadUrl || null,
        }).catch(() => {});
      }

      return { ok: true, value: { version: selfPkg.version, size: selfPkg.size, assetId: releaseMeta?.assetId, downloadUrl: releaseMeta?.downloadUrl } };
    },

    checkForWorkUpdates: async (_args, signal) => {
      const ghAuth = await getStoredGithubAuth();
      const result = await workUpdates.findWorkUpdate(pluginDir, ghAuth, signal);
      const isNewer = typeof workUpdates.isNewerVersion === 'function'
        ? workUpdates.isNewerVersion
        : (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true }) > 0;
      const baseVer = result?.latestVersion || result?.currentVersion || '0.0.0';
      const candidates = [
        { src: 'lan', data: getLatestLanUpdate?.() },
        { src: 'relay', data: getLatestRelayUpdate?.() },
      ].filter(c => c.data?.version && isNewer(c.data.version, baseVer));
      if (candidates.length > 0 && !result?.hasUpdate) {
        const best = candidates[0];
        return {
          ok: true,
          value: {
            hasUpdate: true,
            currentVersion: result?.currentVersion || '2.0.1',
            latestVersion: best.data.version,
            assetId: best.data.assetId || null,
            downloadUrl: best.data.downloadUrl || null,
            source: best.src,
          },
        };
      }
      return { ok: true, value: result };
    },

    applyWorkUpdate: async (args, signal) => {
      const ghAuth = await getStoredGithubAuth();
      if (!ghAuth?.token) return { ok: false, error: { code: 'AUTH_REQUIRED', message: 'GitHub login required' } };
      return {
        ok: true,
        value: await workUpdates.applyWorkUpdate(pluginDir, ghAuth, { version: args.version, assetId: args.assetId }, signal),
      };
    },

    restartDshDesktop: async () => {
      if (process.platform !== 'win32') {
        return { ok: true, value: { restarting: false, manualRestartRequired: true } };
      }
      const candidates = [
        path.resolve(pluginDir, '..', '..', 'scripts', 'Restart-DSH-Desktop.ps1'),
        'C:\\DSH\\scripts\\Restart-DSH-Desktop.ps1',
      ];
      let scriptPath = null;
      for (const candidate of candidates) {
        try {
          await fs.access(candidate);
          scriptPath = candidate;
          break;
        } catch {}
      }
      if (!scriptPath) {
        return { ok: true, value: { restarting: false, manualRestartRequired: true } };
      }
      const child = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-WindowStyle', 'Hidden', '-File', scriptPath], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.unref();
      return { ok: true, value: { restarting: true, manualRestartRequired: false } };
    },
  };
}
