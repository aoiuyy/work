import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractZipSafely } from './zip-extractor.js';
import { uploadToolToGithub, downloadToolFromGithub } from './github-client.js';
import { packagePluginSelf } from './publisher.js';

export const RELEASE_REPO = 'aoiuyy/work';
const [HOST, RELEASE_REPO_NAME] = RELEASE_REPO.split('/');
const VERSION = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const MAX_UPDATE_BYTES = 20 * 1024 * 1024;
const UPDATE_PATH = /^(?:[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:js|json|md|yml|ps1|cmd|svg)|(?:README|AGENTS(?:_INSTALL)?)\.md|docs|lib|ui|scripts|locale)$/;
const tagVersion = /^work-v(.+)$/;

export function isNewerVersion(candidate, current) {
  const a = VERSION.exec(candidate);
  const b = VERSION.exec(current);
  if (!a || !b) return false;
  for (let i = 1; i < a.length; ++i) {
    if (+a[i] !== +b[i]) return +a[i] > +b[i];
  }
  return false;
}
const newer = isNewerVersion;

async function installedPackage(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
}

export async function findWorkUpdate(root, auth, signal) {
  const { version: currentVersion } = await installedPackage(root);
  if (!auth?.token) return { hasUpdate: false, currentVersion, reason: 'login_required' };
  const response = await fetch('https://api.github.com/repos/' + RELEASE_REPO + '/releases?per_page=100', {
    headers: { Authorization: 'Bearer ' + auth.token, Accept: 'application/vnd.github+json' },
    signal,
  });
  if (!response.ok) throw new Error('Could not check Work releases (' + response.status + ')');
  let best;
  for (const release of await response.json()) {
    if (release.draft || release.prerelease || release.author?.login?.toLowerCase() !== HOST) continue;
    const version = tagVersion.exec(release.tag_name)?.[1];
    if (!version || !newer(version, best?.latestVersion || currentVersion)) continue;
    const asset = release.assets?.find(item => item.name === 'work-v' + version + '.zip' &&
      item.state === 'uploaded' && item.uploader?.login?.toLowerCase() === HOST &&
      Number.isSafeInteger(item.id) && item.size > 0 && item.size <= MAX_UPDATE_BYTES &&
      /^sha256:[a-f0-9]{64}$/i.test(item.digest || ''));
    if (asset) best = { hasUpdate: true, currentVersion, latestVersion: version, assetId: asset.id, digest: asset.digest.toLowerCase() };
  }
  return best || { hasUpdate: false, currentVersion };
}

export async function publishWorkUpdate(root, auth, signal) {
  if (auth?.username?.toLowerCase() !== HOST) throw new Error('Only @' + HOST + ' can publish Work updates');
  const { version } = await installedPackage(root);
  if (!VERSION.test(version)) throw new Error('Use a stable version in package.json');
  const bundle = await packagePluginSelf({ pluginDir: root });
  return uploadToolToGithub({
    ...auth, repo: RELEASE_REPO_NAME, toolName: 'work', tag: 'work-v' + version,
    assetName: 'work-v' + version + '.zip', zipBuffer: bundle.zipBuffer,
    sha256: bundle.sha256, preserveExisting: true, signal,
  });
}

async function listFiles(root, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!/^[a-z0-9._-]+$/i.test(entry.name) || /^\./.test(entry.name)) throw new Error('Invalid update filename');
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, next));
    else if (entry.isFile()) files.push(next);
    else throw new Error('Invalid update file type');
  }
  return files;
}

async function existingFile(root, file) {
  let cursor = root;
  for (const segment of file.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Update destination contains a symbolic link');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return fs.readFile(cursor);
}

export async function applyWorkUpdate(root, auth, { version, assetId }, signal) {
  const update = await findWorkUpdate(root, auth, signal);
  if (!update.hasUpdate || version !== update.latestVersion || assetId !== update.assetId) {
    throw new Error('Update changed. Check for updates again.');
  }
  const { buffer } = await downloadToolFromGithub({ username: HOST, token: auth.token, repo: RELEASE_REPO_NAME,
    assetId: update.assetId, maxBytes: MAX_UPDATE_BYTES, signal });
  if ('sha256:' + createHash('sha256').update(buffer).digest('hex') !== update.digest) {
    throw new Error('Work update failed its SHA-256 check');
  }

  const stage = await fs.mkdtemp(path.join(root, '.work-update-'));
  try {
    const source = path.join(stage, 'package');
    await extractZipSafely(buffer, source, { conflictResolution: 'fail', maxTotalBytes: MAX_UPDATE_BYTES });
    const installed = await installedPackage(root);
    const pkg = await installedPackage(source);
    if (pkg.name !== installed.name || pkg.version !== version || !Array.isArray(pkg.files) ||
      !['index.js', 'client.js', 'cordis.patch.yml'].every(file => pkg.files.includes(file))) {
      throw new Error('Unexpected Work package manifest');
    }
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const pairs = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
      if (pairs(pkg[key]) !== pairs(installed[key])) throw new Error('Update requires a fresh plugin install');
    }
    const approved = new Set(['package.json', 'package-lock.json', ...pkg.files]);
    const files = await listFiles(source);
    for (const entry of pkg.files) {
      if (typeof entry !== 'string' || !UPDATE_PATH.test(entry) || entry === 'data' || entry === 'node_modules' ||
          !files.some(file => file === entry || file.startsWith(entry + path.sep))) {
        throw new Error('Invalid package file list');
      }
    }
    if (files.some(file => !approved.has(file.split(path.sep)[0]))) throw new Error('Archive contains undeclared files');

    const backups = new Map();
    for (const file of files) backups.set(file, await existingFile(root, file));
    const replaced = [];
    try {
      const manifestLast = files.filter(file => file !== 'package.json').concat('package.json');
      for (const file of manifestLast) {
        const target = path.join(root, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(path.join(source, file), target);
        replaced.push(file);
      }
    } catch (error) {
      const failures = [];
      for (const file of replaced.reverse()) {
        const target = path.join(root, file);
        try {
          const contents = backups.get(file);
          if (contents === null) await fs.unlink(target);
          else await fs.writeFile(target, contents);
        } catch (restoreError) {
          failures.push(restoreError);
        }
      }
      if (failures.length) throw new Error('Work update rollback could not restore all files', { cause: error });
      throw error;
    }
    return { updated: true, version, updatedFiles: replaced.length, restartRequired: true };
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
