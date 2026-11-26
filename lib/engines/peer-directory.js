import {
  acceptUserRepoInvitation, checkUserRepoInvitations, ensureWorkVaultRepo, getRepoFileContent, putRepoFileContent,
} from './github-client.js';

export const MASTER_VAULT = 'aoiuyy/dsh-work-vault';
export const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const DIRECTORY_PATH = 'registry/users.json';
const ONLINE_MS = 5 * 60_000;

export function directRoom(username, peer) {
  const users = [username, peer];
  if (!users.every(user => typeof user === 'string' && GITHUB_LOGIN.test(user))) {
    throw new Error('A GitHub peer is required');
  }
  if (username.toLowerCase() === peer.toLowerCase()) throw new Error('Select another GitHub account');
  return 'dm-' + users.map(user => user.toLowerCase()).sort().join('--');
}

async function tryPrivateVaultAccess(repoFullName, auth, signal) {
  const access = await fetch('https://api.github.com/repos/' + repoFullName, {
    headers: { Authorization: 'Bearer ' + auth.token, Accept: 'application/vnd.github+json' },
    signal,
  });
  if (!access.ok) return null;
  const vault = await access.json();
  if (!vault.private || !vault.permissions?.push) return null;
  return { vaultRepo: repoFullName, branch: vault.default_branch || 'main' };
}

export async function joinMasterVault(auth, signal, configuredVault = '') {
  const cleanCfg = String(configuredVault || '').trim();
  const explicitFull = cleanCfg.includes('/') ? cleanCfg : null;
  const targetRepoName = cleanCfg && !cleanCfg.includes('/') ? cleanCfg : 'dsh-work-vault';

  // 1. If user explicitly configured owner/repo in Settings, respect it first (auto-accepting invite if pending)
  if (explicitFull && explicitFull.toLowerCase() !== MASTER_VAULT) {
    const invites = await checkUserRepoInvitations({ token: auth.token, signal }).catch(() => []);
    const invite = invites.find(item => item.repoFullName?.toLowerCase() === explicitFull.toLowerCase());
    if (invite) await acceptUserRepoInvitation({ token: auth.token, invitationId: invite.id, signal }).catch(() => false);
    const hit = await tryPrivateVaultAccess(explicitFull, auth, signal);
    if (hit) return hit;
  }

  // 2. Check master team vault (aoiuyy/dsh-work-vault): auto-accept invite if invited by host
  if (auth.username.toLowerCase() !== 'aoiuyy') {
    const invites = await checkUserRepoInvitations({ token: auth.token, signal }).catch(() => []);
    const invite = invites.find(item => item.repoFullName?.toLowerCase() === MASTER_VAULT);
    if (invite && !await acceptUserRepoInvitation({ token: auth.token, invitationId: invite.id, signal })) {
      throw new Error('Could not accept the Work vault invitation');
    }
  }
  const masterHit = await tryPrivateVaultAccess(MASTER_VAULT, auth, signal);
  if (masterHit) return masterHit;

  // 3. External/public user not in master vault: auto-create/use their own private <username>/dsh-work-vault
  const personalVault = `${auth.username}/${targetRepoName}`;
  await ensureWorkVaultRepo({ username: auth.username, token: auth.token, repo: personalVault, signal });
  const personalHit = await tryPrivateVaultAccess(personalVault, auth, signal);
  if (personalHit) return personalHit;
  throw new Error('Work requires write access to a private vault repository');
}

function decodeRegistry(content) {
  if (content === null) return { version: '1.0.0', users: [] };
  const registry = JSON.parse(content);
  if (!Array.isArray(registry.users)) throw new Error('Invalid Work directory');
  return registry;
}

export function createPeerDirectory() {
  let cache;
  let pending;
  async function refresh(auth, profile, signal, configuredVault = '') {
    const now = Date.now();
    const key = auth.username.toLowerCase() + ':' + profile.machineId + ':' + String(configuredVault || '');
    if (cache?.key === key && now - cache.at < 30_000) return cache.users;
    if (pending?.key === key) return pending.promise;

    const promise = (async () => {
      const joined = cache?.key === key
        ? { vaultRepo: cache.vaultRepo, branch: cache.branch }
        : await joinMasterVault(auth, signal, configuredVault);
      const { vaultRepo, branch } = joined;
      const params = { ...auth, repo: vaultRepo, branch, path: DIRECTORY_PATH, signal };
      const username = auth.username.toLowerCase();
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await getRepoFileContent(params);
        const registry = decodeRegistry(current.content);
        const own = registry.users.find(item =>
          item.username?.toLowerCase() === username && item.machineId === profile.machineId);
        if (!own || now - Number(own.lastSeen || 0) >= 120_000) {
          const entry = {
            username, name: auth.name || own?.name || username,
            avatar: 'https://github.com/' + username + '.png?size=64',
            machineId: profile.machineId, machineToken: profile.machineToken,
            status: 'online', lastSeen: now,
          };
          const users = registry.users.filter(item =>
            item.username?.toLowerCase() !== username || item.machineId !== profile.machineId);
          users.push(entry);
          try {
            await putRepoFileContent({ ...params, ensureRepo: false, content: JSON.stringify({ ...registry, updatedAt: now, users }, null, 2),
              sha: current.sha, message: 'Update Work presence' });
          } catch (error) {
            if (![409, 422].includes(error.status) || attempt === 4) throw error;
            await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1) + Math.random() * 100));
            continue;
          }
          registry.users = users;
        }

        const byUser = new Map();
        for (const item of registry.users) {
          if (!GITHUB_LOGIN.test(item.username || '') || item.username.toLowerCase() === username) continue;
          const login = item.username.toLowerCase();
          const lastSeen = Number(item.lastSeen) || 0;
          if ((byUser.get(login)?.lastSeen ?? -1) >= lastSeen) continue;
          byUser.set(login, {
            username: login, alias: login, name: String(item.name || login).slice(0, 120),
            avatarUrl: 'https://github.com/' + login + '.png?size=64',
            peerToken: login, machineToken: item.machineToken,
            lastSeen, status: lastSeen > now - ONLINE_MS && lastSeen < now + ONLINE_MS ? 'online' : 'offline',
          });
        }
        const users = [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
        cache = { key, at: now, users, branch, vaultRepo };
        return users;
      }
    })();
    pending = { key, promise };
    try {
      return await promise;
    } finally {
      if (pending?.promise === promise) pending = null;
    }
  }
  return { refresh, clear() { cache = null; } };
}
