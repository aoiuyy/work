import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readToken, writeToken, deleteToken } from '../lib/engines/dpapi-vault.js';

const windows = process.platform === 'win32';
const createTempVault = () => mkdtemp(path.join(os.tmpdir(), 'dsh-work-vault-test-'));

test('DPAPI temp vault roundtrip, deletion, ciphertext, and environment override', { skip: !windows }, async () => {
  const vaultDir = await createTempVault();
  const vault = { vaultDir };
  const originalVaultDir = process.env.DSH_WORK_VAULT_DIR;
  try {
    assert.equal(await readToken(vault), null);
    await writeToken('synthetic-refresh-token-first', vault);
    await writeToken('synthetic-refresh-token-second', vault);
    assert.equal(await readToken(vault), 'synthetic-refresh-token-second');
    const files = await readdir(vaultDir);
    assert.deepEqual(files, ['refresh-token.dpapi']);
    const encrypted = await readFile(path.join(vaultDir, files[0]));
    assert.equal(encrypted.includes(Buffer.from('synthetic-refresh-token-first')), false);
    assert.equal(encrypted.includes(Buffer.from('synthetic-refresh-token-second')), false);
    assert.equal(files.some(name => name.endsWith('.tmp') || name.endsWith('.bak')), false);
    await deleteToken(vault);
    assert.equal(await readToken(vault), null);

    process.env.DSH_WORK_VAULT_DIR = vaultDir;
    await writeToken('synthetic-env-vault-token');
    assert.equal(await readToken(), 'synthetic-env-vault-token');
    await deleteToken();
  } finally {
    if (originalVaultDir === undefined) delete process.env.DSH_WORK_VAULT_DIR;
    else process.env.DSH_WORK_VAULT_DIR = originalVaultDir;
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test('corrupt DPAPI ciphertext fails closed', { skip: !windows }, async () => {
  const vaultDir = await createTempVault();
  const vault = { vaultDir };
  try {
    await writeToken('synthetic-refresh-token', vault);
    await writeFile(path.join(vaultDir, 'refresh-token.dpapi'), Buffer.from('corrupt ciphertext'));
    await assert.rejects(readToken(vault), /DPAPI vault operation failed/);
  } finally { await rm(vaultDir, { recursive: true, force: true }); }
});

test('vault rejects non-Windows operation and oversized/invalid values', async () => {
  if (!windows) await assert.rejects(readToken(), /only available on Windows/);
  await assert.rejects(readToken({ vaultDir: `${os.tmpdir()}${path.sep}..${path.sep}outside-vault` }), /path traversal/);
  await assert.rejects(writeToken(''), /non-empty string/);
  await assert.rejects(writeToken('x'.repeat(8193)), /8192 bytes/);
});
