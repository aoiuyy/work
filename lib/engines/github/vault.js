import { GITHUB_API_URL, USER_AGENT, WorkGithubError, ensureWorkVaultRepo, parseRepoCoords } from './core.js';

export async function getRepoFileContent({ username, token, repo = 'dsh-work-vault', path, branch = 'main', signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const cleanToken = token.trim();
  const cleanPath = path.replace(/^\/+/, '');
  const res = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal,
  });
  if (res.status === 404) return { content: null, sha: null, exists: false };
  if (!res.ok) {
    let msg = res.statusText;
    try { const body = await res.json(); msg = body.message || msg; } catch {}
    throw new WorkGithubError(`Failed to read file ${cleanPath}: ${msg}`, res.status, 'FILE_READ_FAILED');
  }
  const data = await res.json();
  return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha, exists: true };
}

export async function putRepoFileContent({ username, token, repo = 'dsh-work-vault', path, content, message = 'Update file', sha = null, ensureRepo = true, branch = 'main', signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const cleanToken = token.trim();
  const cleanPath = path.replace(/^\/+/, '');
  if (ensureRepo) await ensureWorkVaultRepo({ username, token: cleanToken, repo, signal });
  const bodyPayload = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch };
  if (sha) bodyPayload.sha = sha;
  const res = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/contents/${cleanPath}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(bodyPayload),
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const body = await res.json(); msg = body.message || msg; } catch {}
    throw new WorkGithubError(`Failed to save file ${cleanPath}: ${msg}`, res.status, 'FILE_WRITE_FAILED');
  }
  const data = await res.json();
  return { ok: true, sha: data.content?.sha };
}

export async function listRepoFiles({ username, token, repo = 'dsh-work-vault', path = '', branch = 'main', signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const cleanToken = token.trim();
  const cleanPath = path.replace(/^\/+/, '');
  const res = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal,
  });
  if (res.status === 404 || !res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(item => ({ name: item.name, path: item.path, type: item.type, size: item.size, sha: item.sha }));
}

export async function registerMachineInVault({ username, token, repo = 'dsh-work-vault', machineToken, machineName, signal }) {
  const filePath = `machines/${machineToken}.json`;
  const content = JSON.stringify({ machineToken, machineName, githubUsername: username, workVersion: '2.0.0', lastSeen: Date.now(), updatedAt: new Date().toISOString() }, null, 2);
  const existing = await getRepoFileContent({ username, token, repo, path: filePath, signal });
  return await putRepoFileContent({ username, token, repo, path: filePath, content, message: `Heartbeat: ${machineToken}`, sha: existing.sha, signal });
}

export async function listMachinesInVault({ username, token, repo = 'dsh-work-vault', signal }) {
  const files = await listRepoFiles({ username, token, repo, path: 'machines', signal });
  const machines = [];
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue;
    const res = await getRepoFileContent({ username, token, repo, path: f.path, signal });
    if (res.content) {
      try { machines.push(JSON.parse(res.content)); } catch {}
    }
  }
  return machines;
}

export async function listVaultCollaborators({ username, token, repo = 'dsh-work-vault', signal }) {
  if (!token) return [];
  try {
    const res = await fetch(`${GITHUB_API_URL}/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo)}/collaborators`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
      signal,
    });
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    return list.map(u => ({ username: u.login, name: u.name || u.login, avatarUrl: u.avatar_url }));
  } catch {
    return [];
  }
}

export async function inviteVaultCollaborator({ username, token, repo = 'dsh-work-vault', collaborator, permission = 'push', signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const cleanCollab = collaborator.replace(/^@/, '').trim();
  const res = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/collaborators/${cleanCollab}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ permission }),
    signal,
  });
  if (res.status === 204) return { ok: true, status: 204, alreadyCollaborator: true };
  if (res.status === 201) return { ok: true, status: 201, invitation: await res.json() };
  let errMsg = res.statusText;
  try { const err = await res.json(); errMsg = err.message || errMsg; } catch {}
  return { ok: false, status: res.status, error: errMsg };
}

export async function checkUserRepoInvitations({ token, signal }) {
  const res = await fetch('https://api.github.com/user/repository_invitations', {
    headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal,
  });
  if (!res.ok) return [];
  const list = await res.json();
  return list.map(inv => ({ id: inv.id, repoName: inv.repository?.name, repoFullName: inv.repository?.full_name, owner: inv.inviter?.login, htmlUrl: inv.html_url, createdAt: inv.created_at }));
}

export async function acceptUserRepoInvitation({ token, invitationId, signal }) {
  const res = await fetch(`https://api.github.com/user/repository_invitations/${invitationId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal,
  });
  return res.ok || res.status === 204;
}
