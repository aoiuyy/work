export const GITHUB_API_URL = 'https://api.github.com';
export const USER_AGENT = 'DSH-Work-Plugin/3.0';
const DEFAULT_GITHUB_CLIENT_ID = '178c6fc778ccc68e1d6a';

export function parseRepoCoords(username, repo = 'dsh-work-vault') {
  const cleanRepo = (repo || 'dsh-work-vault').trim();
  if (cleanRepo.includes('/')) {
    const parts = cleanRepo.split('/');
    return {
      owner: parts[0].trim(),
      repo: parts[1].trim(),
      fullName: `${parts[0].trim()}/${parts[1].trim()}`,
    };
  }
  const cleanUser = (username || '').trim();
  return {
    owner: cleanUser,
    repo: cleanRepo,
    fullName: cleanUser ? `${cleanUser}/${cleanRepo}` : cleanRepo,
  };
}

export class WorkGithubError extends Error {
  constructor(message, status = 500, code = 'GITHUB_ERROR', details = {}) {
    super(message);
    this.name = 'WorkGithubError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function findCollaboratorVaults({ token, signal }) {
  const cleanToken = token.trim();
  const res = await fetch(`${GITHUB_API_URL}/user/repos?affiliation=collaborator&per_page=100`, {
    headers: {
      Authorization: `Bearer ${cleanToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
    signal,
  });
  if (!res.ok) return [];
  const repos = await res.json();
  return repos
    .filter(r => r.name === 'dsh-work-vault' || (r.description && r.description.includes('DSH Work')))
    .map(r => ({
      owner: r.owner?.login,
      name: r.name,
      fullName: r.full_name,
      description: r.description,
      permissions: r.permissions,
    }));
}

export async function verifyGithubAuth({ username, token, signal }) {
  if (!token) throw new WorkGithubError('GitHub token is required', 400, 'INVALID_ARGUMENTS');
  const cleanToken = token.trim();
  let response;
  try {
    response = await fetch(`${GITHUB_API_URL}/user`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal,
    });
  } catch (err) {
    throw new WorkGithubError(`Failed to connect to GitHub API: ${err.message}`, 502, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    let msg = response.statusText;
    try { const body = await response.json(); msg = body.message || msg; } catch {}
    throw new WorkGithubError(`GitHub authentication failed: ${msg}`, response.status, 'AUTH_FAILED');
  }

  const data = await response.json();
  if (username && username.trim() && data.login.toLowerCase() !== username.trim().toLowerCase()) {
    throw new WorkGithubError(
      `Token belongs to user "${data.login}", but username was specified as "${username}".`,
      400,
      'USER_MISMATCH'
    );
  }

  return {
    valid: true,
    user: {
      login: data.login,
      name: data.name || data.login,
      avatarUrl: data.avatar_url,
      publicRepos: data.public_repos,
      totalPrivateRepos: data.total_private_repos,
    },
  };
}

export async function ensureWorkVaultRepo({ username, token, repo = 'dsh-work-vault', signal }) {
  const { owner, repo: repoName, fullName } = parseRepoCoords(username, repo);
  const cleanUser = (username || '').trim();
  const cleanToken = token.trim();

  const checkRes = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal,
  });

  if (checkRes.ok) {
    const data = await checkRes.json();
    return { fullName: data.full_name, private: data.private, created: false };
  }

  if (checkRes.status === 404 && owner.toLowerCase() === cleanUser.toLowerCase()) {
    const createRes = await fetch(`${GITHUB_API_URL}/user/repos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        name: repoName,
        description: 'DSH Work Storage Vault - Private Repository for Repositories and Mesh Chat',
        private: true,
        auto_init: true,
      }),
      signal,
    });

    if (!createRes.ok) {
      let msg = createRes.statusText;
      try { const body = await createRes.json(); msg = body.message || msg; } catch {}
      throw new WorkGithubError(`Failed to create vault repository on GitHub: ${msg}`, createRes.status, 'REPO_CREATE_FAILED');
    }

    const createdData = await createRes.json();
    return { fullName: createdData.full_name, private: true, created: true };
  }

  throw new WorkGithubError(`Repository ${fullName} inaccessible or not found: ${checkRes.statusText}`, checkRes.status, 'REPO_CHECK_FAILED');
}

export async function fetchGithubUserProfile({ username, token, signal }) {
  if (!username) return { exists: false };
  const clean = username.replace(/^@/, '').trim();
  if (!clean) return { exists: false };

  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  if (token) headers.Authorization = `Bearer ${token.trim()}`;

  try {
    const res = await fetch(`${GITHUB_API_URL}/users/${encodeURIComponent(clean)}`, { method: 'GET', headers, signal });
    if (res.status === 404) return { exists: false, username: clean };
    if (!res.ok) return { exists: false, username: clean, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { exists: true, username: data.login, name: data.name || data.login, avatarUrl: data.avatar_url, bio: data.bio || '', htmlUrl: data.html_url };
  } catch (err) {
    return { exists: false, username: clean, error: err.message };
  }
}

export async function searchGithubUsers({ query, token, signal }) {
  if (!query) return [];
  const clean = query.replace(/^@+/, '').trim();
  if (!clean || clean.length < 1) return [];
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  if (token) headers.Authorization = `Bearer ${token.trim()}`;
  let items = [];
  try {
    const res = await fetch(`${GITHUB_API_URL}/search/users?q=${encodeURIComponent(clean)}&per_page=6`, { method: 'GET', headers, signal });
    if (res.ok) {
      const data = await res.json();
      items = (data.items || []).map(u => ({ username: u.login, avatarUrl: u.avatar_url, htmlUrl: u.html_url }));
    }
  } catch (_) {}
  if (!items.some(u => u.username.toLowerCase() === clean.toLowerCase()) && /^[a-zA-Z0-9-]{1,39}$/.test(clean)) {
    const exact = await fetchGithubUserProfile({ username: clean, token, signal }).catch(() => null);
    if (exact?.exists && exact.username) {
      items = [{ username: exact.username, avatarUrl: exact.avatarUrl, htmlUrl: exact.htmlUrl }, ...items.filter(u => u.username.toLowerCase() !== exact.username.toLowerCase())].slice(0, 6);
    }
  }
  return items;
}

export async function requestGithubDeviceCode({ clientId = DEFAULT_GITHUB_CLIENT_ID, signal } = {}) {
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: clientId, scope: 'repo,read:user' }),
    signal,
  });
  if (!response.ok) throw new WorkGithubError(`Failed to request device code: ${response.statusText}`, response.status, 'DEVICE_CODE_FAILED');
  const data = await response.json();
  const userCode = data.user_code;
  const verificationUri = data.verification_uri || 'https://github.com/login/device';
  const verificationUriComplete = data.verification_uri_complete || `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;
  return { deviceCode: data.device_code, userCode, verificationUri, verificationUriComplete, expiresIn: data.expires_in, interval: data.interval || 5 };
}

export async function pollGithubDeviceToken({ clientId = DEFAULT_GITHUB_CLIENT_ID, deviceCode, signal }) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    signal,
  });
  if (!response.ok) throw new WorkGithubError(`Device token poll failed: ${response.statusText}`, response.status, 'DEVICE_POLL_FAILED');
  const data = await response.json();
  if (data.error) return { status: data.error, token: null };
  return { status: 'success', token: data.access_token, tokenType: data.token_type, scope: data.scope };
}

export async function createGithubRepo({ token, name, description = '', isPrivate = true, signal }) {
  if (!token || !name) throw new WorkGithubError('Token and repository name required', 400, 'INVALID_ARGUMENTS');
  const cleanName = String(name).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(cleanName)) throw new WorkGithubError('Invalid repository name', 400, 'INVALID_REPO_NAME');
  const res = await fetch(`${GITHUB_API_URL}/user/repos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ name: cleanName, description, private: Boolean(isPrivate), auto_init: false }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new WorkGithubError(body.message || `GitHub repo creation failed (${res.status})`, res.status, 'REPO_CREATE_FAILED');
  return {
    fullName: body.full_name,
    cloneUrl: body.clone_url,
    htmlUrl: body.html_url,
    private: Boolean(body.private),
    defaultBranch: body.default_branch || 'main',
  };
}

export async function listRepoDeployments({ owner, repo, token, signal }) {
  if (!owner || !repo || !token) return [];
  const headers = { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  try {
    const res = await fetch(`${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments?per_page=5`, { headers, signal });
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return [];
    const enriched = await Promise.all(list.slice(0, 4).map(async (dep) => {
      try {
        const sRes = await fetch(`${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments/${dep.id}/statuses?per_page=1`, { headers, signal });
        const statuses = sRes.ok ? await sRes.json() : [];
        const latest = Array.isArray(statuses) ? statuses[0] : null;
        return {
          id: dep.id,
          environment: dep.environment || 'production',
          ref: dep.ref || '',
          creator: dep.creator?.login || '',
          state: latest?.state || 'pending',
          targetUrl: latest?.environment_url || latest?.target_url || '',
          createdAt: dep.created_at,
        };
      } catch {
        return { id: dep.id, environment: dep.environment || 'production', ref: dep.ref || '', state: 'unknown', targetUrl: '', createdAt: dep.created_at };
      }
    }));
    return enriched;
  } catch {
    return [];
  }
}
