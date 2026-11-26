import { GITHUB_API_URL, USER_AGENT, WorkGithubError, parseRepoCoords } from './core.js';

export async function ensureRoomIssue({ username, token, repo = 'dsh-work-vault', roomName, signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const cleanToken = token.trim();
  const targetTitle = `[Work Channel] #${roomName.trim().toLowerCase()}`;
  const headers = { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };

  const listRes = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/issues?state=all&per_page=100`, { method: 'GET', headers, signal });
  if (listRes.ok) {
    const issues = await listRes.json();
    const existing = issues.find(i => i.title === targetTitle);
    if (existing) return { issueNumber: existing.number, title: existing.title };
  }

  const createRes = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/issues`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: targetTitle, body: `Realtime messaging & collaboration bus for channel #${roomName} (Work 3-Tier Core).` }),
    signal,
  });
  if (!createRes.ok) {
    let msg = createRes.statusText;
    try { const b = await createRes.json(); msg = b.message || msg; } catch {}
    throw new WorkGithubError(`Failed to ensure channel issue #${roomName}: ${msg}`, createRes.status, 'ISSUE_CREATE_FAILED');
  }
  const created = await createRes.json();
  return { issueNumber: created.number, title: created.title };
}

export async function postRoomComment({ username, token, repo = 'dsh-work-vault', issueNumber, payload, signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const res = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ body: JSON.stringify(payload) }),
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const b = await res.json(); msg = b.message || msg; } catch {}
    throw new WorkGithubError(`Failed to post message comment: ${msg}`, res.status, 'COMMENT_POST_FAILED');
  }
  const comment = await res.json();
  return { commentId: comment.id, created_at: comment.created_at };
}

export async function fetchRoomCommentsDelta({ username, token, repo = 'dsh-work-vault', issueNumber, lastEtag = null, since = null, signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  let url = `${GITHUB_API_URL}/repos/${owner}/${repoName}/issues/${issueNumber}/comments?per_page=100`;
  if (since) url += `&since=${encodeURIComponent(since)}`;
  const headers = { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  if (lastEtag) headers['If-None-Match'] = lastEtag;

  const res = await fetch(url, { method: 'GET', headers, signal });
  if (res.status === 304) return { notModified: true, etag: lastEtag, comments: [] };
  if (!res.ok) {
    let msg = res.statusText;
    try { const b = await res.json(); msg = b.message || msg; } catch {}
    throw new WorkGithubError(`Failed to fetch room comments: ${msg}`, res.status, 'COMMENTS_FETCH_FAILED');
  }

  const newEtag = res.headers.get('etag');
  const rawList = await res.json();
  const parsed = [];
  const deletedIds = [];
  for (const item of rawList) {
    try {
      const msgObj = JSON.parse(item.body);
      if (msgObj?.__workTombstone && msgObj.deletedId) {
        deletedIds.push(msgObj.deletedId);
        continue;
      }
      parsed.push({ ...msgObj, commentId: item.id, githubAuthor: item.user?.login || null, created_at: item.created_at || msgObj.created_at });
    } catch {
      parsed.push({ id: `gh-comment-${item.id}`, content: item.body, sender: item.user?.login || 'GitHub User', created_at: item.created_at, commentId: item.id });
    }
  }
  return { notModified: false, etag: newEtag, comments: parsed, deletedIds };
}

export async function deleteRoomComment({ username, token, repo = 'dsh-work-vault', issueNumber = null, commentId = null, messageId = null, signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const headers = { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  let targetCommentId = commentId;
  if (!targetCommentId && issueNumber && messageId) {
    const listRes = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/issues/${issueNumber}/comments?per_page=100`, { method: 'GET', headers, signal }).catch(() => null);
    if (listRes?.ok) {
      const list = await listRes.json().catch(() => []);
      for (const item of list) {
        try {
          const obj = JSON.parse(item.body);
          if (obj?.id === messageId) { targetCommentId = item.id; break; }
        } catch {}
      }
    }
  }
  if (!targetCommentId) return { deleted: false };
  const res = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/issues/comments/${targetCommentId}`, {
    method: 'DELETE',
    headers,
    signal,
  });
  return { deleted: res.ok || res.status === 204 || res.status === 404, commentId: targetCommentId };
}
