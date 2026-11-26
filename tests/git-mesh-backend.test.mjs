import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import * as githubClient from '../lib/engines/github-client.js';
import * as gitEngine from '../lib/engines/git-engine.js';
import { isNewerVersion, applyWorkUpdate } from '../lib/engines/work-updates.js';
import { packagePluginSelf } from '../lib/engines/publisher.js';

const { runGit, stageAndCommit, getRepoStatus, getDiff, pushCollabBranch, syncGitRepository, fetchCollabBranch, mergeCollabBranch, cloneSharedRepository, getRepositoryIdentity, redactGitError } = gitEngine;

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-git-mesh-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'source');
  await fs.mkdir(repo);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@local']]) assert.equal((await runGit(args, repo)).ok, true);
  return { dir, repo };
}

async function commit(repo, content, message = 'fixture') {
  await fs.writeFile(path.join(repo, 'app.txt'), content);
  return stageAndCommit(repo, { message });
}

test('initial diff, per-file patches, unique status, bounded secrets and binary previews', async t => {
  const { repo } = await fixture(t);
  assert.equal((await getRepoStatus(repo)).totalChanges, 0);
  await fs.writeFile(path.join(repo, 'app.txt'), 'one\ntwo\n');
  let diff = await getDiff(repo);
  assert.equal(diff.totalAdditions, 2);
  assert.match(diff.files[0].patch, /\+two/);
  await stageAndCommit(repo, { message: 'initial' });
  await fs.writeFile(path.join(repo, 'app.txt'), 'staged\n');
  await runGit(['add', 'app.txt'], repo);
  await fs.writeFile(path.join(repo, 'app.txt'), 'working\n');
  const status = await getRepoStatus(repo);
  assert.equal(status.totalChanges, 1);
  assert.equal(status.additions, 1);
  assert.equal(status.deletions, 2);
  await fs.writeFile(path.join(repo, '.env'), 'NEVER_PREVIEW=yes');
  await fs.writeFile(path.join(repo, 'big.txt'), Buffer.alloc(300 * 1024, 65));
  await fs.writeFile(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
  diff = await getDiff(repo);
  assert.ok(diff.truncated);
  assert.ok(!diff.diffText.includes('NEVER_PREVIEW'));
  assert.equal(diff.audit.safe, false);
  await assert.rejects(pushCollabBranch(repo, {}), /Authenticated Git Vault/);
  await assert.rejects(getDiff(repo, '--output=bad'), /Invalid Git ref/);
});

test('native bare Vault roundtrip, no implicit commit, peer orientation and unrelated protection', async t => {
  const { dir, repo } = await fixture(t);
  const bare = path.join(dir, 'vault.git');
  await fs.mkdir(bare);
  assert.equal((await runGit(['init', '--bare'], bare)).ok, true);
  const globalConfig = path.join(dir, 'gitconfig');
  await fs.writeFile(globalConfig, `[url "${bare.replaceAll('\\', '/')}"]\n\tinsteadOf = https://github.com/fixture/vault.git\n[protocol "file"]\n\tallow = always\n`);
  const prior = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  t.after(() => { if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prior; });
  const options = { username: 'alice', token: 'synthetic-test-token', vaultOwner: 'fixture', vaultRepo: 'vault' };
  const initial = await commit(repo, 'initial\n');
  const pushed = await pushCollabBranch(repo, options);
  assert.equal(pushed.hash, initial.hash);
  assert.equal((await runGit(['branch', '--show-current'], repo)).stdout, 'main');
  const card = { ...options, peerUsername: 'alice', repoId: pushed.repoId, branch: pushed.branch, hash: pushed.hash };
  const clone = await cloneSharedRepository(dir, 'clone', card);
  assert.equal((await fs.readFile(path.join(clone.path, 'app.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'initial\n');
  assert.ok(!(await fs.readFile(path.join(clone.path, '.git/config'), 'utf8')).includes(options.token));
  await assert.rejects(cloneSharedRepository(dir, 'clone', card), /EEXIST/);
  await assert.rejects(cloneSharedRepository(dir, '../escape', card), /Valid parent/);
  const badId = { ...card, repoId: 'a'.repeat(40) };
  await assert.rejects(cloneSharedRepository(dir, 'bad-id', badId), /identity mismatch/);
  await assert.rejects(cloneSharedRepository(dir, 'bad-ref', { ...card, branch: 'main' }), /branch/);
  await fs.writeFile(path.join(repo, 'app.txt'), 'uncommitted\n');
  await syncGitRepository(repo, options);
  assert.equal((await runGit(['rev-parse', 'HEAD'], repo)).stdout, initial.hash);
  const next = await commit(repo, 'peer addition\nsecond line\n', 'next');
  await pushCollabBranch(repo, options);
  await fs.writeFile(path.join(clone.path, 'noise.txt'), 'worktree noise\n');
  const peer = await fetchCollabBranch(clone.path, card);
  assert.equal(peer.peerCommit.hash, next.hash);
  assert.match(peer.diff.diffText, /\+peer addition/);
  assert.ok(!peer.diff.diffText.includes('worktree noise'));
  assert.equal(peer.diff.files.length, 1);
  await fs.unlink(path.join(clone.path, 'noise.txt'));
  assert.equal((await mergeCollabBranch(clone.path, 'alice', card)).ok, true);
  assert.equal((await runGit(['rev-parse', 'HEAD'], clone.path)).stdout, next.hash);
  const unrelated = path.join(dir, 'other'); await fs.mkdir(unrelated);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Other'], ['config', 'user.email', 'other@local']]) await runGit(args, unrelated);
  const otherCommit = await commit(unrelated, 'unrelated\n');
  const pushedOther = await pushCollabBranch(unrelated, options);
  assert.notEqual(pushedOther.branch, pushed.branch, 'multi-repo pushes must namespace separate collab branches');
  assert.equal((await runGit(['rev-parse', `refs/heads/${pushed.branch}`], bare)).stdout, next.hash);
  assert.equal((await runGit(['rev-parse', `refs/heads/${pushedOther.branch}`], bare)).stdout, otherCommit.hash);
  const cloneOther = await cloneSharedRepository(dir, 'clone-other', { ...options, peerUsername: 'alice', repoId: pushedOther.repoId, branch: pushedOther.branch, hash: pushedOther.hash });
  assert.equal((await fs.readFile(path.join(cloneOther.path, 'app.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'unrelated\n');
  assert.equal(await getRepositoryIdentity(repo), pushed.repoId);
  assert.equal(redactGitError(`bad ${options.token}`, options.token), 'bad ***');
});

test('Vault share posts canonical repo-card and persists full Vault room coordinates without LAN', async t => {
  const { dir, repo } = await fixture(t);
  const initial = await commit(repo, 'shared preview\n');
  const repoId = await getRepositoryIdentity(repo);
  const vault = {
    readMachineProfile: async () => ({ machineToken: 'WK-TEST', machineName: 'Fixture' }),
    readGithubAuth: async () => ({ username: 'alice', token: 'synthetic-token' }),
    readWorkConfig: async () => ({}),
    writeGithubAuth: async () => null,
    deleteGithubAuth: async () => null,
    writeMachineProfile: async () => null,
    readPeerLinks: async () => null,
    writePeerLinks: async () => null,
    writeWorkConfig: async () => null,
  };
  const github = {
    ...githubClient,
    verifyGithubAuth: async () => ({ user: { login: 'alice' } }),
    ensureWorkVaultRepo: async () => ({}),
    ensureRoomIssue: async () => ({ issueNumber: 42 }),
    postRoomComment: async (o) => { globalThis.__repoPosted = o; return { commentId: 123 }; },
    fetchRoomCommentsDelta: async (o) => { globalThis.__repoPolled = o; return { notModified: true }; },
    inviteVaultCollaborator: async (o) => { globalThis.__repoInvited = o; return { ok: true, status: 201 }; },
    checkUserRepoInvitations: async () => [{ id: 7, repoFullName: 'owner/shared-vault' }, { id: 8, repoFullName: 'other/unselected' }],
    acceptUserRepoInvitation: async (o) => { globalThis.__repoAccepted = o; return true; },
  };
  const git = {
    ...gitEngine,
    pushCollabBranch: async () => ({ repoId, hash: initial.hash, branch: 'collab/alice' }),
  };
  class MockLanEngine {
    async start() {}
    async stop() {}
    async sendChatToPeers() { throw Error('Repo must never use LAN'); }
  }

  const routes = new Map();
  const disposals = [];
  apply(
    { connection: { fetch: { register(r) { routes.set(r.path, r); } } }, on(_, fn) { disposals.push(fn); } },
    {},
    { dataDir: path.join(dir, 'data'), vault, githubClient: github, gitEngine: git, LanDiscoveryEngine: MockLanEngine }
  );
  t.after(async () => { for (const fn of disposals) await fn(); delete globalThis.__repoPosted; delete globalThis.__repoPolled; });
  const rpc = async (action, args) => (await (await routes.get('/api/work/' + action).fetch(new Request('http://localhost/api/work/' + action, {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'share', method: 'work/' + action, payload: { args } }),
  }))).json()).result;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/owner/shared-vault/collaborators/bob/permission');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
    return Response.json({ permission: 'none' });
  };
  t.after(() => { globalThis.fetch = originalFetch; delete globalThis.__repoInvited; delete globalThis.__repoAccepted; });
  const result = await rpc('shareRepository', { repoPath: repo, roomId: 'channel:mesh', vaultOwner: 'owner', vaultRepo: 'shared-vault', recipientUsername: 'bob' });
  assert.equal(globalThis.__repoInvited.collaborator, 'bob');
  assert.equal(globalThis.__repoInvited.repo, 'owner/shared-vault');
  assert.equal(globalThis.__repoInvited.permission, 'push');
  await rpc('fetchCollabBranch', { repoPath: repo, peerUsername: 'alice', vaultOwner: 'owner', vaultRepo: 'shared-vault', branch: 'bad' });
  assert.equal(globalThis.__repoAccepted.invitationId, 7);
  assert.equal(result.ok, true);
  const posted = globalThis.__repoPosted;
  assert.equal(posted.payload.type, 'repo-card');
  assert.equal(posted.payload.sender, 'WK-TEST');
  assert.equal(posted.payload.fileMeta.senderUsername, 'alice');
  assert.equal(posted.payload.fileMeta.repoId, repoId);
  assert.match(posted.payload.fileMeta.diffPreview, /\+shared preview/);
  assert.ok(!JSON.stringify(posted.payload).includes(repo));
  assert.ok(!JSON.stringify(posted.payload).includes('synthetic-token'));
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'data/messages.json')));
  assert.equal(disk.rooms['channel:mesh'].issueNumber, 42);
  assert.equal(disk.rooms['channel:mesh'].vaultRepo, 'owner/shared-vault');
  await rpc('getChatMessages', { roomId: 'channel:mesh' });
  assert.equal(globalThis.__repoPolled.repo, 'owner/shared-vault');
});

test('registered Repo endpoints use RPC envelopes and current branch commits without credentials', async t => {
  const { dir, repo } = await fixture(t);
  const vault = {
    readMachineProfile: async () => ({ machineToken: 'WK-TEST', machineName: 'Fixture' }),
    readWorkConfig: async () => ({}),
    readGithubAuth: async () => null,
    writeGithubAuth: async () => null,
    deleteGithubAuth: async () => null,
    writeMachineProfile: async () => null,
    readPeerLinks: async () => null,
    writePeerLinks: async () => null,
    writeWorkConfig: async () => null,
  };
  class MockLanEngine { async start() {} async stop() {} }

  const routes = new Map();
  const disposals = [];
  apply(
    { connection: { fetch: { register(r) { routes.set(r.path, r); } } }, on(_, fn) { disposals.push(fn); } },
    {},
    { dataDir: path.join(dir, 'data'), vault, LanDiscoveryEngine: MockLanEngine }
  );
  t.after(async () => { for (const fn of disposals) await fn(); });
  const rpc = async (action, args) => (await (await routes.get('/api/work/' + action).fetch(new Request('http://localhost/api/work/' + action, {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'git', method: 'work/' + action, payload: { args } }),
  }))).json()).result;
  for (const action of ['commitRepository', 'syncGitRepository', 'shareRepository', 'cloneSharedRepository']) assert.ok(routes.has('/api/work/' + action));
  await fs.writeFile(path.join(repo, 'app.txt'), 'initial\n');
  assert.equal((await rpc('commitRepository', { repoPath: repo, message: 'initial' })).ok, true);
  assert.equal((await runGit(['branch', '--show-current'], repo)).stdout, 'main');
  for (const action of ['pushCollabBranch', 'syncGitRepository', 'shareRepository', 'cloneSharedRepository', 'fetchCollabBranch', 'mergeCollabBranch']) assert.equal((await rpc(action, { repoPath: repo })).ok, false);
});

test('applyWorkUpdate installs real plugin bundle with cordis.patch.yml and semver compares numerically', async t => {
  assert.equal(isNewerVersion('4.6.10', '4.6.9'), true);
  assert.equal(isNewerVersion('4.6.2', '4.6.2'), false);
  assert.equal(isNewerVersion('4.6.1', '4.6.2'), false);

  const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')), '..');
  const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'));
  const bundle = await packagePluginSelf({ pluginDir: pluginRoot });
  const clientDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-client-upd-'));
  t.after(() => fs.rm(clientDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(clientDir, 'package.json'), JSON.stringify({ ...pkg, version: '2.0.0' }, null, 2));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('/releases?per_page=100')) {
      return Response.json([
        {
          // Legacy v4.x tag MUST be ignored so 2.0.x clients never downgrade to old v4.6.2
          tag_name: 'work-plugin-v4.6.2',
          draft: false,
          prerelease: false,
          author: { login: 'aoiuyy' },
          assets: [{
            id: 4444,
            name: 'work-plugin-v4.6.2.zip',
            state: 'uploaded',
            uploader: { login: 'aoiuyy' },
            size: bundle.size,
            digest: `sha256:${bundle.sha256}`,
          }],
        },
        {
          tag_name: `work-v${bundle.version}`,
          draft: false,
          prerelease: false,
          author: { login: 'aoiuyy' },
          assets: [{
            id: 9991,
            name: `work-v${bundle.version}.zip`,
            state: 'uploaded',
            uploader: { login: 'aoiuyy' },
            size: bundle.size,
            digest: `sha256:${bundle.sha256}`,
          }],
        },
      ]);
    }
    if (s.includes('/releases/assets/9991')) {
      return new Response(bundle.zipBuffer, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    }
    throw new Error('Unexpected fetch: ' + s);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const applied = await applyWorkUpdate(clientDir, { username: 'khoi1709', token: 'synthetic-token' }, { version: bundle.version, assetId: 9991 });
  assert.equal(applied.updated, true);
  assert.equal(applied.version, bundle.version);
  assert.ok(applied.updatedFiles >= 10);
  const installedPkg = JSON.parse(await fs.readFile(path.join(clientDir, 'package.json'), 'utf8'));
  assert.equal(installedPkg.version, bundle.version);
  const patchYml = await fs.readFile(path.join(clientDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patchYml.length > 0);
});
