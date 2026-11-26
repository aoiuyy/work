import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runGit, getRepoStatus, stageAndCommit, getDiff, pushCollabBranch } from '../lib/engines/git-engine.js';

test('getRepoStatus detects git repository and commit status', async () => {
  const testDir = path.join(tmpdir(), 'git-test-' + Math.random().toString(36).slice(2, 8));
  await fs.mkdir(testDir, { recursive: true });

  try {
    await runGit(['init'], testDir);
    await runGit(['config', 'user.name', 'Tester'], testDir);
    await runGit(['config', 'user.email', 'test@test.local'], testDir);

    const st1 = await getRepoStatus(testDir);
    assert.equal(st1.isGit, true);
    assert.equal(st1.clean, true);

    await fs.writeFile(path.join(testDir, 'hello.txt'), 'world\n');
    const st2 = await getRepoStatus(testDir);
    assert.equal(st2.untracked.includes('hello.txt'), true);

    const commitRes = await stageAndCommit(testDir, { message: 'feat: add hello.txt' });
    assert.equal(commitRes.ok, true);
    assert.ok(commitRes.shortHash);

    const st3 = await getRepoStatus(testDir);
    assert.equal(st3.clean, true);
    assert.equal(st3.lastCommit.message, 'feat: add hello.txt');

    await fs.writeFile(path.join(testDir, 'hello.txt'), 'world updated\n');
    const diff = await getDiff(testDir);
    assert.equal(diff.ok, true);
    assert.equal(diff.files.length, 1);
    assert.equal(diff.files[0].file, 'hello.txt');
    assert.equal(diff.audit.safe, true);

    await assert.rejects(() => pushCollabBranch(testDir, {}), /auth|credential|parameter|Vault|token/i);
  } finally {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});
