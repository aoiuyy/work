import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as archiverModule from 'archiver';
import ignore from 'ignore';
import { uploadToolToGithub, deleteToolFromGithub } from './github-client.js';

function createZipArchive(options) {
  if (archiverModule.ZipArchive) {
    return new archiverModule.ZipArchive(options);
  }
  const fn = archiverModule.default || archiverModule;
  return fn('zip', options);
}

export const MAX_BYTES = 500 * 1024 * 1024; // 500MB
const EXCLUDED = [
  '.git',
  'node_modules',
  '.dsh',
  '.agent-teams',
  '.workignore',
  'build',
  'dist',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.vscode',
  '.idea',
];

const SECRET = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|[^/]*credentials?[^/]*|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx))$/i;

export function stableMachineId() {
  return createHash('sha256').update(`${hostname()}\0${userInfo().username}`).digest('hex').slice(0, 32);
}

/**
 * List files using git if available or recursive filesystem walk.
 */
export async function listCandidateFiles(cwd, trackedOnly = false) {
  // 1. Try git ls-files if inside a git repository
  const isGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' });
  if (isGit.status === 0) {
    const args = trackedOnly ? ['ls-files', '--cached', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
    const result = spawnSync('git', args, { cwd, encoding: 'buffer' });
    if (result.status === 0) {
      return result.stdout.toString().split('\0').filter(Boolean);
    }
  }

  // 2. Fallback: recursive directory scan
  const relPaths = [];
  const root = path.resolve(cwd);

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replaceAll('\\', '/');
      const normLower = rel.toLowerCase();

      if (EXCLUDED.some(x => normLower === x || normLower.startsWith(`${x}/`) || normLower.includes(`/${x}/`))) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        relPaths.push(rel);
      }
    }
  }

  await walk(root);
  return relPaths;
}

/**
 * Filter candidates with secret patterns, .workignore, symlinks, and path safety.
 */
export async function selectedFiles(cwd, { trackedOnly = false, sanitize = true } = {}) {
  const ig = ignore();
  try {
    ig.add(await readFile(path.join(cwd, '.workignore'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const root = path.resolve(cwd) + path.sep;
  const rawList = await listCandidateFiles(cwd, trackedOnly);
  const files = [];

  for (const rel of rawList) {
    const normalized = rel.replaceAll('\\', '/');
    if (sanitize) {
      if (
        EXCLUDED.some(x => normalized.toLowerCase() === x || normalized.toLowerCase().startsWith(`${x.toLowerCase()}/`) || normalized.toLowerCase().includes(`/${x.toLowerCase()}/`)) ||
        SECRET.test(normalized) ||
        ig.ignores(normalized)
      ) {
        continue;
      }
    }

    const full = path.resolve(cwd, rel);
    if (!full.startsWith(root)) continue;

    try {
      let parent = path.resolve(cwd);
      let unsafe = false;
      for (const part of normalized.split('/').slice(0, -1)) {
        parent = path.join(parent, part);
        const parentInfo = await lstat(parent);
        if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
          unsafe = true;
          break;
        }
      }
      if (unsafe) continue;

      const info = await lstat(full);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      files.push({ rel: normalized, full, size: info.size });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Detect framework and commands like Vercel (Next, Vite, React, Vue, Python, Rust, Static).
 */
export async function detectVercelProjectMeta(cwd) {
  let pkg = null;
  try {
    const pkgRaw = await readFile(path.join(cwd, 'package.json'), 'utf8');
    pkg = JSON.parse(pkgRaw);
  } catch {}

  const meta = {
    name: pkg?.name || path.basename(path.resolve(cwd)),
    framework: 'static',
    installCommand: 'npm install',
    devCommand: 'npm start',
    buildCommand: 'npm run build',
    entry: 'index.html',
  };

  if (pkg) {
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    if (allDeps['next']) {
      meta.framework = 'nextjs';
      meta.devCommand = 'npx next dev';
      meta.buildCommand = 'npx next build';
    } else if (allDeps['vite']) {
      meta.framework = 'vite';
      meta.devCommand = 'npx vite';
      meta.buildCommand = 'npx vite build';
    } else if (allDeps['react']) {
      meta.framework = 'react';
    } else if (allDeps['vue']) {
      meta.framework = 'vue';
    } else if (allDeps['svelte']) {
      meta.framework = 'svelte';
    } else if (allDeps['astro']) {
      meta.framework = 'astro';
      meta.devCommand = 'npx astro dev';
    }

    if (pkg.scripts) {
      if (pkg.scripts.dev) meta.devCommand = 'npm run dev';
      else if (pkg.scripts.start) meta.devCommand = 'npm start';
      if (pkg.scripts.build) meta.buildCommand = 'npm run build';
    }

    if (pkg.main) meta.entry = pkg.main;
  } else {
    // Check python
    const hasPy = spawnSync('python', ['--version'], { encoding: 'utf8' });
    try {
      await lstat(path.join(cwd, 'requirements.txt'));
      meta.framework = 'python';
      meta.installCommand = 'pip install -r requirements.txt';
      meta.devCommand = 'python main.py';
    } catch {}

    // Check rust
    try {
      await lstat(path.join(cwd, 'Cargo.toml'));
      meta.framework = 'rust';
      meta.installCommand = 'cargo check';
      meta.devCommand = 'cargo run';
      meta.buildCommand = 'cargo build --release';
    } catch {}
  }

  return meta;
}

/**
 * Build ASCII directory tree for Gitingest digest.
 */
export function buildAsciiTree(relPaths) {
  const tree = {};
  for (const rel of relPaths) {
    const parts = rel.split('/');
    let curr = tree;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === parts.length - 1) {
        curr[p] = null;
      } else {
        if (!curr[p]) curr[p] = {};
        curr = curr[p];
      }
    }
  }

  const lines = ['Directory Structure:'];
  function render(node, prefix = '') {
    const keys = Object.keys(node).sort();
    keys.forEach((key, index) => {
      const isLast = index === keys.length - 1;
      const marker = isLast ? '└── ' : '├── ';
      const subPrefix = isLast ? '    ' : '│   ';
      lines.push(`${prefix}${marker}${key}`);
      if (node[key] !== null) {
        render(node[key], `${prefix}${subPrefix}`);
      }
    });
  }

  render(tree);
  return lines.join('\n');
}

/**
 * Generate Gitingest Markdown digest capped at maxTokens (100k tokens safety guard).
 */
export async function generateGitingestDigest(cwd, files, options = {}) {
  const maxTokens = options.maxTokens || 100000;
  const relPaths = files.map(f => f.rel);
  const asciiTree = buildAsciiTree(relPaths);

  const digestHeader = [
    `# Gitingest Digest`,
    `- Total Files: ${files.length}`,
    `- Repository Path: \`${path.basename(path.resolve(cwd))}\``,
    `- Generated: ${new Date().toISOString()}`,
    ``,
    '```',
    asciiTree,
    '```',
    ``,
    `## Source Code Contents`,
    ``,
  ].join('\n');

  let fullText = digestHeader;
  let totalChars = fullText.length;
  let estimatedTokens = Math.ceil(totalChars / 4);

  const textExtensions = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md',
    '.html', '.css', '.scss', '.yaml', '.yml', '.py', '.rs', '.go',
    '.c', '.cpp', '.h', '.java', '.sh', '.ps1', '.bat', '.sql', '.toml'
  ]);

  for (const file of files) {
    const ext = path.extname(file.rel).toLowerCase();
    if (!textExtensions.has(ext) && file.size > 20000) continue; // Skip non-text or large binaries

    try {
      const content = await readFile(file.full, 'utf8');
      const fileSection = [
        `================================================`,
        `File: ${file.rel} (${file.size} bytes)`,
        `================================================`,
        '```' + ext.replace('.', ''),
        content,
        '```',
        '',
      ].join('\n');

      const sectionTokens = Math.ceil(fileSection.length / 4);
      if (estimatedTokens + sectionTokens > maxTokens) {
        fullText += `\n> [!NOTE]\n> Digest truncated at ${estimatedTokens} tokens to prevent LLM memory overflow.\n`;
        break;
      }

      fullText += fileSection;
      estimatedTokens += sectionTokens;
    } catch {
      // Skip binary read errors
    }
  }

  return {
    digestText: fullText,
    tokenCount: estimatedTokens,
    fileCount: files.length,
    asciiTree,
  };
}

/**
 * Create compressed ZIP archive of selected files with Gitingest digest & Vercel meta.
 */
export async function createArchive(cwd, output, options = {}) {
  const { trackedOnly = false, bundle = false, sanitize = true } = options;
  const files = await selectedFiles(cwd, { trackedOnly, sanitize });

  if (!files.length && !bundle) {
    throw new Error('No eligible files found in folder to publish.');
  }

  for (const file of files) {
    const current = await lstat(file.full);
    if (!current.isFile() || current.isSymbolicLink() || current.size !== file.size) {
      throw new Error(`File changed or is no longer a regular file: ${file.rel}`);
    }
  }

  let totalSize = files.reduce((sum, f) => sum + f.size, 0);

  // Git bundle packaging if requested
  let bundleTmpFile = null;
  let bundleGuide = null;
  if (bundle) {
    const isGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' });
    if (isGit.status === 0) {
      const hasCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
      if (hasCommit.status === 0) {
        bundleTmpFile = path.join(tmpdir(), `work-bundle-${randomUUID()}.bundle`);
        const bundleRes = spawnSync('git', ['bundle', 'create', bundleTmpFile, '--all'], { cwd, encoding: 'utf8' });
        if (bundleRes.status === 0) {
          const bInfo = await lstat(bundleTmpFile);
          totalSize += bInfo.size;
          bundleGuide = `# Git Bundle Restoration Guide\n\nThis archive contains a full Git bundle (\`work.bundle\`) preserving all commits, branches, and tags.\n\n### To unpack on a receiving machine:\n\`\`\`bash\ngit clone work.bundle <destination_directory>\n\`\`\`\n`;
        }
      }
    }
  }

  if (totalSize > MAX_BYTES) {
    if (bundleTmpFile) await rm(bundleTmpFile, { force: true }).catch(() => {});
    throw new Error(`Total size exceeds maximum of 500MB (${totalSize} bytes)`);
  }

  // 1. Generate Gitingest digest
  const gitingest = await generateGitingestDigest(cwd, files, options);

  // 2. Generate Vercel project metadata
  const vercelMeta = await detectVercelProjectMeta(cwd);

  const archive = createZipArchive({ zlib: { level: 6 } });
  const outputStream = createWriteStream(output);
  const hash = createHash('sha256');
  let size = 0;

  const meter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        callback(new Error(`Archive exceeded maximum size of 500MB`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    for (const file of files) {
      archive.file(file.full, {
        name: file.rel,
        date: new Date('2000-01-01T00:00:00.000Z'),
        mode: 0o100644,
      });
    }

    if (bundleTmpFile) {
      archive.file(bundleTmpFile, {
        name: 'work.bundle',
        date: new Date('2000-01-01T00:00:00.000Z'),
        mode: 0o100644,
      });
      if (bundleGuide) {
        archive.append(bundleGuide, {
          name: 'GIT_BUNDLE_README.md',
          date: new Date('2000-01-01T00:00:00.000Z'),
          mode: 0o100644,
        });
      }
    }

    // Embed Gitingest digest into archive root
    archive.append(gitingest.digestText, {
      name: 'gitingest_digest.md',
      date: new Date('2000-01-01T00:00:00.000Z'),
      mode: 0o100644,
    });

    // Embed Vercel metadata into archive root
    archive.append(JSON.stringify(vercelMeta, null, 2), {
      name: 'work.meta.json',
      date: new Date('2000-01-01T00:00:00.000Z'),
      mode: 0o100644,
    });

    const manifest = {
      version: 2,
      created: new Date().toISOString(),
      hasGitBundle: Boolean(bundleTmpFile),
      filesCount: files.length,
      tokenCount: gitingest.tokenCount,
      framework: vercelMeta.framework,
    };
    archive.append(JSON.stringify(manifest, null, 2), {
      name: 'manifest.json',
      date: new Date('2000-01-01T00:00:00.000Z'),
      mode: 0o100644,
    });

    const done = pipeline(archive, meter, outputStream);
    await archive.finalize();
    await done;

    return {
      size,
      sha256: hash.digest('hex'),
      files,
      hasGitBundle: Boolean(bundleTmpFile),
      digestText: gitingest.digestText,
      tokenCount: gitingest.tokenCount,
      meta: vercelMeta,
    };
  } finally {
    if (bundleTmpFile) {
      await rm(bundleTmpFile, { force: true }).catch(() => {});
    }
  }
}

/**
 * Universal archive creator: handles either a folder or a single file.
 */
export async function createArchiveFromPath(targetPath, outputZipPath, options = {}) {
  const resolved = path.resolve(targetPath);
  const info = await lstat(resolved);

  if (info.isDirectory()) {
    return await createArchive(resolved, outputZipPath, options);
  }

  if (info.isFile()) {
    const fileName = path.basename(resolved);
    const archive = createZipArchive({ zlib: { level: 6 } });
    const outputStream = createWriteStream(outputZipPath);
    const hash = createHash('sha256');
    let size = 0;

    const meter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > MAX_BYTES) {
          callback(new Error(`Archive exceeded maximum size of 500MB`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    archive.file(resolved, {
      name: fileName,
      date: new Date('2000-01-01T00:00:00.000Z'),
      mode: 0o100644,
    });

    const manifest = {
      version: 2,
      type: 'single-file',
      name: fileName,
      files: [{ path: fileName, size: info.size }],
      created: new Date().toISOString(),
    };
    archive.append(JSON.stringify(manifest, null, 2), {
      name: 'manifest.json',
      date: new Date('2000-01-01T00:00:00.000Z'),
      mode: 0o100644,
    });

    const done = pipeline(archive, meter, outputStream);
    await archive.finalize();
    await done;

    return {
      size,
      sha256: hash.digest('hex'),
      files: [fileName],
      hasGitBundle: false,
      digestText: `# Single File: ${fileName}\nSize: ${info.size} bytes\n`,
      tokenCount: Math.ceil(info.size / 4),
      meta: { framework: 'file', entry: fileName },
    };
  }

  throw new Error(`Path is neither a file nor a directory: ${resolved}`);
}

/**
 * Package project to an in-memory buffer with metadata, Gitingest summary and Vercel detection.
 */
export async function packageProjectToBuffer(targetPath, options = {}) {
  const resolved = path.resolve(targetPath);
  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-work-buf-'));
  const zipFile = path.join(tmp, 'archive.zip');
  try {
    const archiveInfo = await createArchiveFromPath(resolved, zipFile, options);
    const zipBuffer = await readFile(zipFile);
    return {
      zipBuffer,
      size: archiveInfo.size,
      sha256: archiveInfo.sha256,
      meta: archiveInfo.meta,
      tokenCount: archiveInfo.tokenCount,
      files: archiveInfo.files,
      digestText: archiveInfo.digestText,
      hasGitBundle: archiveInfo.hasGitBundle,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Publish a Tool or Repo directly to GitHub Private Storage Vault.
 */
export async function publishToolToGithub({
  targetPath,
  toolName,
  notes = '',
  tag = null,
  bundle = true,
  trackedOnly = false,
  sanitize = true,
  githubUsername,
  githubToken,
  githubRepo = 'dsh-work-vault',
  machineToken,
  signal,
}) {
  if (!targetPath) throw new Error('Target path is required');
  if (!githubUsername || !githubToken) throw new Error('GitHub username and token are required to publish');

  const resolved = path.resolve(targetPath);
  const finalToolName = (toolName || path.basename(resolved) || 'unnamed-repo').trim();

  // Create temporary zip archive
  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-work-publish-'));
  const zipFile = path.join(tmp, 'archive.zip');

  let githubRelease = null;

  try {
    const archive = await createArchiveFromPath(resolved, zipFile, { trackedOnly, bundle, sanitize });
    const zipBuffer = await readFile(zipFile);

    // Upload to GitHub Private Vault
    githubRelease = await uploadToolToGithub({
      username: githubUsername,
      token: githubToken,
      repo: githubRepo,
      toolName: finalToolName,
      notes: notes || `Published from ${machineToken || 'workstation'}`,
      tag,
      zipBuffer,
      digestText: archive.digestText,
      sha256: archive.sha256,
      hasGitBundle: archive.hasGitBundle,
      signal,
    });

    return {
      id: githubRelease.releaseId,
      tool_name: finalToolName,
      notes,
      releaseTag: githubRelease.releaseTag,
      assetId: githubRelease.assetId,
      assetName: githubRelease.assetName,
      file_size: archive.size,
      sha256: archive.sha256,
      has_git_bundle: archive.hasGitBundle,
      downloadUrl: githubRelease.downloadUrl,
      digestAssetId: githubRelease.digestAssetId,
      tokenCount: archive.tokenCount,
      meta: archive.meta,
      filesCount: Array.isArray(archive.files) ? archive.files.length : 1,
    };
  } catch (error) {
    if (githubRelease && githubRelease.releaseId) {
      await deleteToolFromGithub({
        username: githubUsername,
        token: githubToken,
        repo: githubRepo,
        releaseId: githubRelease.releaseId,
        releaseTag: githubRelease.releaseTag,
      }).catch(() => {});
    }
    throw error;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Generate an incremental Git diff/patch for low-latency P2P synchronization.
 */
export async function generateGitPatch({ cwd, baseSha } = {}) {
  const isGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' });
  if (isGit.status !== 0) {
    return { ok: false, isGit: false, error: 'Directory is not a Git repository' };
  }

  const headRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const headSha = headRes.status === 0 ? headRes.stdout.trim() : 'HEAD';

  // 1. Try uncommitted changes (working tree vs HEAD)
  let diffRes = spawnSync('git', ['diff', 'HEAD'], { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  let patch = diffRes.status === 0 ? diffRes.stdout : '';
  let isUncommitted = true;

  // 2. If baseSha is provided, diff from baseSha to HEAD + uncommitted
  if (baseSha && baseSha !== headSha) {
    const rangeRes = spawnSync('git', ['diff', `${baseSha}..HEAD`], { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (rangeRes.status === 0 && rangeRes.stdout) {
      patch = rangeRes.stdout + (patch ? '\n' + patch : '');
      isUncommitted = false;
    }
  }

  // 3. If still empty, grab the latest commit patch
  if (!patch.trim()) {
    const lastCommitRes = spawnSync('git', ['format-patch', '-1', 'HEAD', '--stdout'], { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (lastCommitRes.status === 0 && lastCommitRes.stdout) {
      patch = lastCommitRes.stdout;
      isUncommitted = false;
    }
  }

  // Short stat
  const statRes = spawnSync('git', ['diff', '--stat', 'HEAD'], { cwd, encoding: 'utf8' });
  const stat = statRes.status === 0 ? statRes.stdout.trim() : '';

  return {
    ok: true,
    isGit: true,
    headSha,
    patch,
    stat: stat || '1 commit diff',
    bytes: Buffer.byteLength(patch, 'utf8'),
    isUncommitted,
  };
}

/**
 * Apply a Git patch into an existing workspace.
 */
export async function applyGitPatch({ targetDir, patchContent } = {}) {
  if (!targetDir || !patchContent) {
    return { ok: false, error: 'targetDir and patchContent are required' };
  }

  const isGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: targetDir, encoding: 'utf8' });
  if (isGit.status !== 0) {
    return { ok: false, error: 'Target directory is not a Git repository' };
  }

  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-git-patch-'));
  const patchFile = path.join(tmp, 'change.patch');

  try {
    await writeFile(patchFile, patchContent, 'utf8');

    // 1. Try git apply with whitespace fix
    let applyRes = spawnSync('git', ['apply', '--whitespace=fix', patchFile], { cwd: targetDir, encoding: 'utf8' });
    if (applyRes.status === 0) {
      return { ok: true, applied: true, method: 'clean' };
    }

    // 2. Fallback to 3-way merge apply
    applyRes = spawnSync('git', ['apply', '--3way', patchFile], { cwd: targetDir, encoding: 'utf8' });
    if (applyRes.status === 0) {
      return { ok: true, applied: true, method: '3way' };
    }

    return {
      ok: false,
      error: `git apply failed: ${applyRes.stderr || applyRes.stdout || 'Conflict detected'}`,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Package the Work plugin itself cleanly for self-updating (strictly package.json + declared pkg.files).
 */
export async function packagePluginSelf({ pluginDir } = {}) {
  const defaultDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dir = path.resolve(pluginDir || defaultDir);
  const pkgPath = path.join(dir, 'package.json');
  const pkgRaw = await readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const version = pkg.version || '2.0.1';
  const declared = [...new Set(['package.json', ...(Array.isArray(pkg.files) ? pkg.files : [])])];

  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-work-self-'));
  const zipPath = path.join(tmp, `work-v${version}.zip`);

  async function collectDeclared(relEntry, out) {
    const full = path.join(dir, relEntry);
    const st = await lstat(full).catch(() => null);
    if (!st || st.isSymbolicLink()) return;
    if (st.isFile()) {
      out.push(relEntry.replaceAll('\\', '/'));
    } else if (st.isDirectory()) {
      for (const entry of await readdir(full, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await collectDeclared(path.join(relEntry, entry.name), out);
      }
    }
  }

  try {
    const files = [];
    for (const entry of declared) await collectDeclared(entry, files);
    const outStream = createWriteStream(zipPath);
    const archive = createZipArchive({ zlib: { level: 9 } });
    const done = new Promise((resolve, reject) => {
      outStream.on('close', resolve);
      archive.on('error', reject);
    });
    archive.pipe(outStream);
    for (const rel of files) {
      archive.file(path.join(dir, rel), { name: rel });
    }
    await archive.finalize();
    await done;
    const zipBuffer = await readFile(zipPath);
    const sha256 = createHash('sha256').update(zipBuffer).digest('hex');
    return {
      ok: true,
      version,
      zipBuffer,
      size: zipBuffer.length,
      sha256,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
