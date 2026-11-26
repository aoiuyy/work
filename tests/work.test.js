import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../index.js';
import { auditChangeset, inspectFilePath, scanContentSecrets } from '../lib/engines/security-shield.js';
import { sanitizeEntryPath, ZipSecurityError } from '../lib/engines/zip-extractor.js';
import { extractVideoId, isYouTubeUrl, extractBalancedJsonObject } from '../lib/engines/brave-player.js';
import { runGit, getRepoStatus, stageAndCommit, getDiff, getMergeConflicts, resolveMergeConflict, completeMerge } from '../lib/engines/git-engine.js';
import { LanDiscoveryEngine } from '../lib/engines/lan-discovery.js';

test('Cordis RPC registration registers unique /api/work/* endpoints and validates envelopes', async () => {
  const routes = new Map();
  const disposers = [];
  const mockCtx = {
    on(event, fn) { if (event === 'dispose') disposers.push(fn); },
    get() { return null; },
    connection: {
      fetch: {
        register(route) {
          assert.equal(routes.has(route.path), false, `Duplicate route registered: ${route.path}`);
          routes.set(route.path, route);
        },
      },
    },
  };

  apply(mockCtx, { machineName: 'TestNode' });

  assert.ok(routes.has('/api/work/getDiscoveredLanPeers'));
  assert.ok(routes.has('/api/work/getGitDiff'));
  assert.ok(routes.has('/api/work/getMergeConflicts'));
  assert.ok(routes.has('/api/work/musicState'));

  // Validate envelope check & transparent fallback when Rust binary is absent
  const lanRoute = routes.get('/api/work/getDiscoveredLanPeers');
  const badRes = await lanRoute.fetch(new Request('http://127.0.0.1/api/work/getDiscoveredLanPeers', {
    method: 'POST', body: JSON.stringify({ type: 'invalid' }),
  }));
  assert.equal(badRes.status, 400);

  const okRes = await lanRoute.fetch(new Request('http://127.0.0.1/api/work/getDiscoveredLanPeers', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'work/getDiscoveredLanPeers', payload: { args: {} } }),
  }));
  assert.equal(okRes.status, 200);
  const body = await okRes.json();
  assert.equal(body.result.ok, true);
  assert.ok(Array.isArray(body.result.value));

  for (const fn of disposers) await fn();
});

test('Security shield blocks secrets, git hooks, traversal, and quarantines executables', () => {
  assert.equal(inspectFilePath('.env.local').allowed, false);
  assert.equal(inspectFilePath('.git/hooks/pre-commit').allowed, false);
  assert.equal(inspectFilePath('../escape.txt').allowed, false);
  assert.equal(inspectFilePath('tool.exe').quarantine, true);

  const secrets = scanContentSecrets('token=' + 'ghp_' + '1234567890abcdef1234567890abcdef1234');
  assert.ok(secrets.includes('GitHub Personal Access Token'));

  const audit = auditChangeset(['src/app.js', '.env'], '');
  assert.equal(audit.safe, false);
  assert.equal(audit.rejectedFiles.length, 1);
});

test('ZIP path sanitizer rejects traversal, UNC, and drive letters', () => {
  assert.equal(sanitizeEntryPath('src/index.js'), 'src/index.js');
  assert.throws(() => sanitizeEntryPath('../evil.txt'), ZipSecurityError);
  assert.throws(() => sanitizeEntryPath('\\\\server\\share\\file'), ZipSecurityError);
  assert.throws(() => sanitizeEntryPath('C:\\Windows\\win.ini'), ZipSecurityError);
});

test('BravePlayer URL parsing and balanced JSON extractor handle standard & live URLs', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/live/jfKfPfyJRdk'), true);
  assert.equal(extractVideoId('https://www.youtube.com/live/jfKfPfyJRdk'), 'jfKfPfyJRdk');
  assert.equal(extractVideoId('https://youtu.be/v9EgFdRUVc4?t=10'), 'v9EgFdRUVc4');

  const html = 'var ytInitialData = {"title":"Lo-Fi; Beats {Live}", "nested":{"a":1}}; var next=2;';
  const start = html.indexOf('{');
  const extracted = extractBalancedJsonObject(html, start);
  const parsed = JSON.parse(extracted);
  assert.equal(parsed.title, 'Lo-Fi; Beats {Live}');
  assert.equal(parsed.nested.a, 1);
});

test('Git engine supports status, diff, conflict inspection, and 3-way resolution', async () => {
  const repoDir = await fs.mkdtemp(path.join(tmpdir(), 'work-git-test-'));
  try {
    await runGit(['init', '-b', 'main'], repoDir);
    await runGit(['config', 'user.email', 'test@dsh.local'], repoDir);
    await runGit(['config', 'user.name', 'DSH Test'], repoDir);

    await fs.writeFile(path.join(repoDir, 'app.txt'), 'line 1\n', 'utf8');
    await stageAndCommit(repoDir, { message: 'init' });

    await runGit(['checkout', '-b', 'peer'], repoDir);
    await fs.writeFile(path.join(repoDir, 'app.txt'), 'peer change\n', 'utf8');
    await stageAndCommit(repoDir, { message: 'peer edit' });

    await runGit(['checkout', 'main'], repoDir);
    await fs.writeFile(path.join(repoDir, 'app.txt'), 'main change\n', 'utf8');
    await stageAndCommit(repoDir, { message: 'main edit' });

    const mergeAttempt = await runGit(['merge', 'peer'], repoDir);
    assert.equal(mergeAttempt.ok, false);

    const conflicts = await getMergeConflicts(repoDir);
    assert.equal(conflicts.count, 1);
    assert.equal(conflicts.conflicts[0].file, 'app.txt');

    const resolved = await resolveMergeConflict(repoDir, { filePath: 'app.txt', strategy: 'theirs' });
    assert.equal(resolved.remainingCount, 0);

    const done = await completeMerge(repoDir, 'resolve conflict');
    assert.equal(done.ok, true);

    const content = await fs.readFile(path.join(repoDir, 'app.txt'), 'utf8');
    assert.equal(content.trim(), 'peer change');

    const status = await getRepoStatus(repoDir);
    assert.equal(status.clean, true);
    const diff = await getDiff(repoDir, 'HEAD');
    assert.equal(diff.ok, true);
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
  }
});

test('LAN discovery engine rejects unpaired repo uploads and allows paired peers', async () => {
  const dest = await fs.mkdtemp(path.join(tmpdir(), 'work-lan-test-'));
  const lan = new LanDiscoveryEngine({ machineToken: 'WK-HOST-0001', machineName: 'Host', defaultParent: dest });
  try {
    await lan.startHttpServer();
    const unauth = await fetch(`http://127.0.0.1:${lan.httpPort}/p2p/send-repo?toolName=demo`, {
      method: 'POST',
      headers: { 'X-Machine-Token': 'WK-ROGUE-9999' },
      body: Buffer.from('not-a-zip'),
    });
    assert.equal(unauth.status, 401);
  } finally {
    await lan.stop();
    await fs.rm(dest, { recursive: true, force: true });
  }
});
