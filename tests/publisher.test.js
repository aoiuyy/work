import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  stableMachineId,
  selectedFiles,
  createArchive,
  detectVercelProjectMeta,
  generateGitingestDigest,
  publishToolToGithub,
  generateGitPatch,
  applyGitPatch,
  packagePluginSelf,
} from '../lib/engines/publisher.js';

test('stableMachineId returns 32-char hex string', () => {
  const id = stableMachineId();
  assert.equal(typeof id, 'string');
  assert.equal(id.length, 32);
});

test('selectedFiles excludes .git, node_modules, secrets and honors .workignore', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-work-pub-test-'));
  try {
    // Normal files
    await writeFile(path.join(tmp, 'index.js'), 'console.log("hello");');
    await mkdir(path.join(tmp, 'src'));
    await writeFile(path.join(tmp, 'src', 'app.js'), 'export default {};');

    // Excluded folders
    await mkdir(path.join(tmp, 'node_modules'));
    await writeFile(path.join(tmp, 'node_modules', 'dep.js'), 'bad');
    await mkdir(path.join(tmp, '.git'));
    await writeFile(path.join(tmp, '.git', 'config'), 'git');

    // Secret files
    await writeFile(path.join(tmp, '.env'), 'SECRET=123');
    await writeFile(path.join(tmp, '.env.local'), 'SECRET=123');
    await writeFile(path.join(tmp, 'private.key'), 'PRIVATE');

    // .workignore
    await writeFile(path.join(tmp, '.workignore'), 'ignore-me.txt\n*.log\n');
    await writeFile(path.join(tmp, 'ignore-me.txt'), 'ignore');
    await writeFile(path.join(tmp, 'debug.log'), 'log');

    const files = await selectedFiles(tmp);
    const rels = files.map(f => f.rel);

    assert.ok(rels.includes('index.js'));
    assert.ok(rels.includes('src/app.js'));
    assert.ok(!rels.includes('.env'));
    assert.ok(!rels.includes('.env.local'));
    assert.ok(!rels.includes('private.key'));
    assert.ok(!rels.includes('node_modules/dep.js'));
    assert.ok(!rels.includes('.git/config'));
    assert.ok(!rels.includes('ignore-me.txt'));
    assert.ok(!rels.includes('debug.log'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('detectVercelProjectMeta identifies Vite and package scripts', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-vercel-meta-test-'));
  try {
    const pkg = {
      name: 'awesome-vite-app',
      dependencies: { vite: '^5.0.0', react: '^18.0.0' },
      scripts: { dev: 'vite', build: 'vite build' },
    };
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify(pkg));

    const meta = await detectVercelProjectMeta(tmp);
    assert.equal(meta.name, 'awesome-vite-app');
    assert.equal(meta.framework, 'vite');
    assert.equal(meta.devCommand, 'npm run dev');
    assert.equal(meta.buildCommand, 'npm run build');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('generateGitingestDigest builds ASCII tree and caps tokens', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-gitingest-test-'));
  try {
    const f1 = path.join(tmp, 'main.js');
    await writeFile(f1, 'console.log("hello world");');
    const files = [{ rel: 'main.js', full: f1, size: 28 }];

    const digest = await generateGitingestDigest(tmp, files, { maxTokens: 1000 });
    assert.ok(digest.digestText.includes('Directory Structure:'));
    assert.ok(digest.digestText.includes('main.js'));
    assert.ok(digest.tokenCount > 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('createArchive packages directory with Gitingest digest and Vercel meta', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-work-archive-test-'));
  const zipOut = path.join(tmpdir(), `test-out-${Date.now()}.zip`);
  try {
    await writeFile(path.join(tmp, 'hello.txt'), 'Hello, Work Plugin!');
    await mkdir(path.join(tmp, 'sub'));
    await writeFile(path.join(tmp, 'sub', 'nested.txt'), 'Nested content');

    const result = await createArchive(tmp, zipOut, { bundle: false });

    assert.ok(result.size > 0);
    assert.equal(typeof result.sha256, 'string');
    assert.equal(result.sha256.length, 64);
    assert.ok(result.digestText.includes('Directory Structure:'));
    assert.ok(result.meta.framework);
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(zipOut, { force: true }).catch(() => {});
  }
});

test('publishToolToGithub uploads archive and returns release metadata', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-work-pub-e2e-'));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  try {
    await writeFile(path.join(tmp, 'app.js'), 'console.log("ready");');

    globalThis.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/repos/testuser/dsh-work-vault')) {
        return new Response(JSON.stringify({ full_name: 'testuser/dsh-work-vault', private: true }), { status: 200 });
      }
      if (urlStr.includes('/releases') && !urlStr.includes('/assets')) {
        return new Response(JSON.stringify({ id: 999, tag_name: 'v-tool-1', name: 'Test Tool' }), { status: 201 });
      }
      if (urlStr.includes('uploads.github.com')) {
        return new Response(JSON.stringify({ id: 888, name: 'archive.zip', size: 500, browser_download_url: 'https://mock/archive.zip' }), { status: 201 });
      }
      return new Response('Not Found', { status: 404 });
    };

    const res = await publishToolToGithub({
      targetPath: tmp,
      toolName: 'my-test-tool',
      githubUsername: 'testuser',
      githubToken: 'ghp_secret',
      machineToken: 'WK-AAAA-BBBB',
    });

    assert.equal(res.id, 999);
    assert.equal(res.tool_name, 'my-test-tool');
    assert.equal(res.downloadUrl, 'https://mock/archive.zip');
    assert.ok(res.meta);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('generateGitPatch and applyGitPatch roundtrip successfully', async () => {
  const { spawnSync } = await import('node:child_process');
  const tmpRepo1 = await mkdtemp(path.join(tmpdir(), 'dsh-patch-repo1-'));
  const tmpRepo2 = await mkdtemp(path.join(tmpdir(), 'dsh-patch-repo2-'));

  try {
    // Setup git repo 1
    spawnSync('git', ['init', '-b', 'main'], { cwd: tmpRepo1 });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo1 });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpRepo1 });
    await writeFile(path.join(tmpRepo1, 'file.txt'), 'version 1\n');
    spawnSync('git', ['add', '.'], { cwd: tmpRepo1 });
    spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpRepo1 });

    // Setup git repo 2 (clone from repo 1)
    spawnSync('git', ['clone', tmpRepo1, tmpRepo2]);

    // Make an uncommitted change in repo 1
    await writeFile(path.join(tmpRepo1, 'file.txt'), 'version 2 with incremental changes\n');

    // Generate git patch
    const patchRes = await generateGitPatch({ cwd: tmpRepo1 });
    assert.equal(patchRes.ok, true);
    assert.equal(patchRes.isGit, true);
    assert.ok(patchRes.patch.includes('version 2 with incremental changes'));
    assert.ok(patchRes.bytes > 0);

    // Apply patch to repo 2
    const applyRes = await applyGitPatch({ targetDir: tmpRepo2, patchContent: patchRes.patch });
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.applied, true);

    // Verify file content in repo 2 matches repo 1
    const { readFile: readF } = await import('node:fs/promises');
    const updatedContent = await readF(path.join(tmpRepo2, 'file.txt'), 'utf8');
    assert.equal(updatedContent.replace(/\r\n/g, '\n'), 'version 2 with incremental changes\n');
  } finally {
    await rm(tmpRepo1, { recursive: true, force: true }).catch(() => {});
    await rm(tmpRepo2, { recursive: true, force: true }).catch(() => {});
  }
});

test('packagePluginSelf packages plugin with version', async () => {
  const res = await packagePluginSelf();
  assert.equal(res.ok, true);
  assert.ok(typeof res.version === 'string');
  assert.ok(Buffer.isBuffer(res.zipBuffer));
  assert.ok(res.size > 0);
});
