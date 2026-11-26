import { GITHUB_API_URL, USER_AGENT, WorkGithubError, ensureWorkVaultRepo, parseRepoCoords } from './core.js';

export async function uploadToolToGithub({
  username,
  token,
  repo = 'dsh-work-vault',
  toolName,
  notes = '',
  tag,
  zipBuffer,
  digestText = '',
  sha256,
  hasGitBundle = false,
  assetName,
  preserveExisting = false,
  signal,
}) {
  const cleanUser = username.trim();
  const cleanToken = token.trim();
  const repoName = repo.trim();

  await ensureWorkVaultRepo({ username: cleanUser, token: cleanToken, repo: repoName, signal });

  const cleanToolName = toolName.trim().replace(/[\\/:*?"<>|\s]/g, '-').toLowerCase();
  const releaseTag = tag || `v-${cleanToolName}-${Date.now()}`;
  const releaseTitle = `${toolName} (${releaseTag})`;
  const releaseNotes = `### ${toolName}\n${notes ? `**Notes:** ${notes}\n\n` : ''}- **SHA-256:** \`${sha256}\`\n- **Git Bundle:** ${hasGitBundle ? 'Yes' : 'No'}\n- **Published:** ${new Date().toISOString()}`;

  const relRes = await fetch(`${GITHUB_API_URL}/repos/${cleanUser}/${repoName}/releases`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cleanToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ tag_name: releaseTag, name: releaseTitle, body: releaseNotes, draft: false, prerelease: false }),
    signal,
  });

  let releaseData = null;
  if (!relRes.ok) {
    if (relRes.status === 422) {
      const existingRes = await fetch(`${GITHUB_API_URL}/repos/${cleanUser}/${repoName}/releases/tags/${encodeURIComponent(releaseTag)}`, {
        headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
        signal,
      });
      if (existingRes.ok) releaseData = await existingRes.json();
    }
    if (!releaseData) {
      let msg = relRes.statusText;
      try { const body = await relRes.json(); msg = body.message || msg; } catch {}
      throw new WorkGithubError(`Failed to create release on GitHub: ${msg}`, relRes.status, 'RELEASE_CREATE_FAILED');
    }
  } else {
    releaseData = await relRes.json();
  }

  const releaseId = releaseData.id;
  const assetFileName = assetName || (releaseTag.startsWith(cleanToolName) ? `${releaseTag}.zip` : `${cleanToolName}-${releaseTag}.zip`);
  const existingAsset = (releaseData.assets || []).find(a => a.name === assetFileName);
  if (existingAsset?.id && preserveExisting) throw new Error('This Work version is already published');
  if (existingAsset?.id) {
    await fetch(`${GITHUB_API_URL}/repos/${cleanUser}/${repoName}/releases/assets/${existingAsset.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
      signal,
    }).catch(() => {});
  }

  const uploadUrl = `https://uploads.github.com/repos/${cleanUser}/${repoName}/releases/${releaseId}/assets?name=${encodeURIComponent(assetFileName)}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cleanToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/zip',
      'Content-Length': String(zipBuffer.length),
      'User-Agent': USER_AGENT,
    },
    body: zipBuffer,
    signal,
  });

  if (!uploadRes.ok) {
    let msg = uploadRes.statusText;
    try { const body = await uploadRes.json(); msg = body.message || msg; } catch {}
    await fetch(`${GITHUB_API_URL}/repos/${cleanUser}/${repoName}/releases/${releaseId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cleanToken}`, 'User-Agent': USER_AGENT },
    }).catch(() => {});
    throw new WorkGithubError(`Failed to upload tool asset to GitHub: ${msg}`, uploadRes.status, 'ASSET_UPLOAD_FAILED');
  }

  const assetData = await uploadRes.json();
  let digestAsset = null;
  if (digestText && typeof digestText === 'string') {
    const digestBuf = Buffer.from(digestText, 'utf8');
    const digestName = `${cleanToolName}-${releaseTag}-digest.md`;
    const digestUploadUrl = `https://uploads.github.com/repos/${cleanUser}/${repoName}/releases/${releaseId}/assets?name=${encodeURIComponent(digestName)}`;
    const dRes = await fetch(digestUploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'text/markdown',
        'Content-Length': String(digestBuf.length),
        'User-Agent': USER_AGENT,
      },
      body: digestBuf,
      signal,
    }).catch(() => null);
    if (dRes?.ok) digestAsset = await dRes.json().catch(() => null);
  }

  return {
    releaseId,
    releaseTag,
    assetId: assetData.id,
    assetName: assetData.name,
    fileSize: assetData.size,
    downloadUrl: assetData.browser_download_url,
    digestAssetId: digestAsset?.id || null,
  };
}

export async function listReleasesFromGithub({ username, token, repo = 'dsh-work-vault', signal }) {
  const cleanUser = username.trim();
  const cleanToken = token.trim();
  const repoName = repo.trim();
  const response = await fetch(`${GITHUB_API_URL}/repos/${cleanUser}/${repoName}/releases?per_page=100`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal,
  });
  if (response.status === 404) return [];
  if (!response.ok) {
    let msg = response.statusText;
    try { const body = await response.json(); msg = body.message || msg; } catch {}
    throw new WorkGithubError(`Failed to list releases: ${msg}`, response.status, 'LIST_RELEASES_FAILED');
  }

  const releases = await response.json();
  return releases.map(rel => {
    const zipAsset = rel.assets.find(a => a.name.endsWith('.zip')) || rel.assets[0];
    const digestAsset = rel.assets.find(a => a.name.endsWith('-digest.md'));
    const shaMatch = rel.body?.match(/SHA-256:\s*`([a-f0-9]{64})`/i);
    const bundleMatch = rel.body?.match(/Git Bundle:\s*Yes/i);
    return {
      id: rel.id,
      tool_name: rel.name ? rel.name.replace(/\s*\(v-.*?\)$/, '') : rel.tag_name,
      releaseId: rel.id,
      releaseTag: rel.tag_name,
      notes: rel.body || '',
      assetId: zipAsset?.id || null,
      assetName: zipAsset?.name || '',
      file_size: zipAsset?.size || 0,
      sha256: shaMatch ? shaMatch[1] : null,
      has_git_bundle: Boolean(bundleMatch),
      downloadUrl: zipAsset?.browser_download_url || null,
      digestAssetId: digestAsset?.id || null,
      created_at: rel.created_at,
    };
  });
}

export async function downloadToolFromGithub({ username, token, repo = 'dsh-work-vault', assetId, maxBytes, signal }) {
  const cleanUser = username.trim();
  const cleanToken = token.trim();
  const repoName = repo.trim();
  const response = await fetch(`${GITHUB_API_URL}/repos/${cleanUser}/${repoName}/releases/assets/${assetId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/octet-stream', 'User-Agent': USER_AGENT },
    redirect: 'follow',
    signal,
  });
  if (!response.ok) {
    let msg = response.statusText;
    try { const body = await response.json(); msg = body.message || msg; } catch {}
    throw new WorkGithubError(`Failed to download tool asset from GitHub: ${msg}`, response.status, 'DOWNLOAD_FAILED');
  }
  if (maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error('Release asset exceeds the size limit');
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks, size), size };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, size: buffer.length };
}

export async function deleteToolFromGithub({ username, token, repo = 'dsh-work-vault', releaseId, releaseTag, signal }) {
  const cleanUser = username.trim();
  const cleanToken = token.trim();
  const repoName = repo.trim();
  const headers = { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  if (releaseId) await fetch(`${GITHUB_API_URL}/repos/${cleanUser}/${repoName}/releases/${releaseId}`, { method: 'DELETE', headers, signal }).catch(() => {});
  if (releaseTag) await fetch(`${GITHUB_API_URL}/repos/${cleanUser}/${repoName}/git/refs/tags/${releaseTag}`, { method: 'DELETE', headers, signal }).catch(() => {});
  return { ok: true };
}

export async function ensureVaultAssetsRelease({ username, token, repo = 'dsh-work-vault', signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const cleanToken = token.trim();
  const tag = 'work-vault-assets';
  const headers = { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };

  const getRes = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/releases/tags/${tag}`, { headers, signal });
  if (getRes.ok) {
    const data = await getRes.json();
    return { releaseId: data.id, tag: data.tag_name, uploadUrl: data.upload_url };
  }
  if (getRes.status === 404) {
    const createRes = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/releases`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: 'Work Vault Static Assets & Binaries', body: 'Dedicated fixed release hosting binary files, voice recordings, and project archives.', draft: false, prerelease: false }),
      signal,
    });
    if (!createRes.ok) {
      let msg = createRes.statusText;
      try { const b = await createRes.json(); msg = b.message || msg; } catch {}
      throw new WorkGithubError(`Failed to create assets release: ${msg}`, createRes.status, 'RELEASE_CREATE_FAILED');
    }
    const created = await createRes.json();
    return { releaseId: created.id, tag: created.tag_name, uploadUrl: created.upload_url };
  }
  throw new WorkGithubError(`Failed to query assets release: ${getRes.statusText}`, getRes.status, 'RELEASE_QUERY_FAILED');
}

export async function uploadVaultAsset({ username, token, repo = 'dsh-work-vault', buffer, filename, contentType = 'application/octet-stream', signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const cleanToken = token.trim();
  const { releaseId } = await ensureVaultAssetsRelease({ username, token: cleanToken, repo, signal });
  const cleanFilename = (filename || `asset-${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
  const uploadUrl = `https://uploads.github.com/repos/${owner}/${repoName}/releases/${releaseId}/assets?name=${encodeURIComponent(cleanFilename)}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'Content-Type': contentType, 'Content-Length': String(buffer.length), 'User-Agent': USER_AGENT },
    body: buffer,
    signal,
  });
  if (!uploadRes.ok) {
    let msg = uploadRes.statusText;
    try { const b = await uploadRes.json(); msg = b.message || msg; } catch {}
    throw new WorkGithubError(`Failed to upload asset ${cleanFilename}: ${msg}`, uploadRes.status, 'ASSET_UPLOAD_FAILED');
  }
  const asset = await uploadRes.json();
  return { assetId: asset.id, name: asset.name, size: asset.size, downloadUrl: asset.browser_download_url };
}

export async function getVaultAssetSignedUrl({ username, token, repo = 'dsh-work-vault', filename = 'work-v2-dist.zip', signal }) {
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const cleanToken = token.trim();
  const relRes = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/releases/tags/work-vault-assets`, {
    headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal,
  });
  if (!relRes.ok) throw new WorkGithubError('Release work-vault-assets not found', relRes.status, 'RELEASE_NOT_FOUND');
  const relData = await relRes.json();
  const asset = (relData.assets || []).find(a => a.name === filename);
  if (!asset) throw new WorkGithubError(`Asset ${filename} not found in release`, 404, 'ASSET_NOT_FOUND');

  const redirectRes = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/releases/assets/${asset.id}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/octet-stream', 'User-Agent': USER_AGENT },
    redirect: 'manual',
    signal,
  });
  const signedUrl = redirectRes.headers.get('location');
  if (!signedUrl) throw new WorkGithubError('Failed to obtain pre-signed ticket location', redirectRes.status, 'NO_SIGNED_LOCATION');
  return { ok: true, assetId: asset.id, filename: asset.name, size: asset.size, signedUrl };
}

export async function deleteVaultAsset({ username, token, repo = 'dsh-work-vault', assetId, signal }) {
  if (!assetId) return { deleted: false };
  const { owner, repo: repoName } = parseRepoCoords(username, repo);
  const res = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repoName}/releases/assets/${assetId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal,
  });
  return { deleted: res.ok || res.status === 204 || res.status === 404 };
}
