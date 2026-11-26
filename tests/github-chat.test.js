import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import {
  verifyGithubAuth,
  uploadToolToGithub,
  downloadToolFromGithub,
  listReleasesFromGithub,
  getRepoFileContent,
  putRepoFileContent,
  listRepoFiles,
  requestGithubDeviceCode,
  pollGithubDeviceToken,
} from '../lib/engines/github-client.js';
import {
  writeGithubAuth,
  readGithubAuth,
  deleteGithubAuth,
  writeMachineProfile,
  readMachineProfile,
} from '../lib/engines/dpapi-vault.js';
import { createArchiveFromPath } from '../lib/engines/publisher.js';

test('DPAPI vault supports github-auth and machine-profile persistence', async () => {
  const tmpVault = await mkdtemp(path.join(tmpdir(), 'dsh-vault-test-'));
  const options = { vaultDir: tmpVault };

  try {
    // 1. GitHub auth
    await writeGithubAuth({ username: 'testuser', token: 'ghp_secret123' }, options);
    const readAuth = await readGithubAuth(options);
    assert.deepEqual(readAuth, { username: 'testuser', token: 'ghp_secret123' });

    await deleteGithubAuth(options);
    const afterDel = await readGithubAuth(options);
    assert.equal(afterDel, null);

    // 2. Machine profile
    await writeMachineProfile({ machineId: 'm-123', machineName: 'PC-1', machineToken: 'WK-AAAA-BBBB' }, options);
    const readProf = await readMachineProfile(options);
    assert.deepEqual(readProf, { machineId: 'm-123', machineName: 'PC-1', machineToken: 'WK-AAAA-BBBB' });
  } finally {
    await rm(tmpVault, { recursive: true, force: true }).catch(() => {});
  }
});

test('createArchiveFromPath handles single file properly', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-archive-test-'));
  const testFile = path.join(tmp, 'test.txt');
  const zipFile = path.join(tmp, 'output.zip');

  try {
    await writeFile(testFile, 'Hello Work v3!');
    const res = await createArchiveFromPath(testFile, zipFile);
    assert.ok(res.size > 0);
    assert.equal(typeof res.sha256, 'string');
    assert.equal(res.sha256.length, 64);
    assert.deepEqual(res.files, ['test.txt']);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test('github-client handles auth verification, releases, and mock download', async (t) => {
  const originalFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const urlStr = url.toString();
    if (urlStr === 'https://api.github.com/user') {
      return new Response(JSON.stringify({ login: 'octocat', name: 'Mona Lisa', avatar_url: 'https://example.com/avatar.png' }), { status: 200 });
    }
    if (urlStr.includes('/releases?per_page=100')) {
      return new Response(JSON.stringify([
        {
          id: 101,
          name: 'MyRepo (v-1)',
          tag_name: 'v-1',
          body: 'SHA-256: `abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234`\nGit Bundle: Yes',
          assets: [
            { id: 201, name: 'myrepo.zip', size: 1024, browser_download_url: 'https://download.mock/myrepo.zip' }
          ],
          created_at: new Date().toISOString(),
        }
      ]), { status: 200 });
    }
    if (urlStr.includes('/releases/assets/123')) {
      return new Response(Buffer.from('mock-zip-content'), { status: 200 });
    }
    if (urlStr.includes('/contents/chat/rooms/general/test.jsonl')) {
      return new Response(JSON.stringify({
        content: Buffer.from('{"id":"m1","content":"hello"}\n').toString('base64'),
        sha: 'sha-mock',
      }), { status: 200 });
    }
    if (urlStr === 'https://github.com/login/device/code') {
      return new Response(JSON.stringify({
        device_code: 'dev-1234',
        user_code: 'WDWD-6799',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }), { status: 200 });
    }
    if (urlStr === 'https://github.com/login/oauth/access_token') {
      return new Response(JSON.stringify({
        access_token: 'gho_mock_token_123',
        token_type: 'bearer',
        scope: 'repo,read:user',
      }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  const auth = await verifyGithubAuth({ username: 'octocat', token: 'ghp_mock' });
  assert.equal(auth.valid, true);
  assert.equal(auth.user.login, 'octocat');

  // Test Device Flow
  const devCode = await requestGithubDeviceCode();
  assert.equal(devCode.deviceCode, 'dev-1234');
  assert.equal(devCode.userCode, 'WDWD-6799');

  const tokenRes = await pollGithubDeviceToken({ deviceCode: 'dev-1234' });
  assert.equal(tokenRes.status, 'success');
  assert.equal(tokenRes.token, 'gho_mock_token_123');

  const downloaded = await downloadToolFromGithub({ username: 'octocat', token: 'ghp_mock', assetId: 123 });
  assert.equal(downloaded.buffer.toString(), 'mock-zip-content');

  const releases = await listReleasesFromGithub({ username: 'octocat', token: 'ghp_mock' });
  assert.equal(releases.length, 1);
  assert.equal(releases[0].tool_name, 'MyRepo');
  assert.equal(releases[0].has_git_bundle, true);

  const fileData = await getRepoFileContent({ username: 'octocat', token: 'ghp_mock', path: 'chat/rooms/general/test.jsonl' });
  assert.equal(fileData.exists, true);
  assert.ok(fileData.content.includes('hello'));
});
