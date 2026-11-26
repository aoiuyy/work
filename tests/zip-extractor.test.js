import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractZipSafely, ZipSecurityError } from '../lib/engines/zip-extractor.js';

/**
 * Helper to build a minimal in-memory zip archive with custom entries.
 */
function buildZip(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const entry of entries) {
    const fileNameBuf = Buffer.from(entry.name, 'utf8');
    const isDeflated = entry.method === 8;
    const rawData = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const compressedData = isDeflated ? deflateRawSync(rawData) : rawData;
    const uncompressedSize = rawData.length;
    const compressedSize = compressedData.length;
    const compressionMethod = isDeflated ? 8 : 0;
    const externalAttributes = entry.externalAttributes || (entry.isSymlink ? ((0o120777 << 16) >>> 0) : ((0o100644 << 16) >>> 0));
    const versionMadeBy = (3 << 8) | 20; // UNIX, v2.0

    // Local file header (30 bytes)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // sig
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (skipped in test)
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(fileNameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    const localOffset = offset;
    localParts.push(localHeader, fileNameBuf, compressedData);
    offset += localHeader.length + fileNameBuf.length + compressedData.length;

    // Central directory header (46 bytes)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // sig
    cdHeader.writeUInt16LE(versionMadeBy, 4);
    cdHeader.writeUInt16LE(20, 6); // version needed
    cdHeader.writeUInt16LE(0, 8); // flags
    cdHeader.writeUInt16LE(compressionMethod, 10);
    cdHeader.writeUInt16LE(0, 12); // mod time
    cdHeader.writeUInt16LE(0, 14); // mod date
    cdHeader.writeUInt32LE(0, 16); // crc32
    cdHeader.writeUInt32LE(compressedSize, 20);
    cdHeader.writeUInt32LE(uncompressedSize, 24);
    cdHeader.writeUInt16LE(fileNameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30); // extra len
    cdHeader.writeUInt16LE(0, 32); // comment len
    cdHeader.writeUInt16LE(0, 34); // disk start
    cdHeader.writeUInt16LE(0, 36); // internal attr
    cdHeader.writeUInt32LE(externalAttributes, 38);
    cdHeader.writeUInt32LE(localOffset, 42);

    cdParts.push(cdHeader, fileNameBuf);
  }

  const cdOffset = offset;
  const cdBuffer = Buffer.concat(cdParts);
  const cdSize = cdBuffer.length;

  // EOCD (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk num
  eocd.writeUInt16LE(0, 6); // cd disk num
  eocd.writeUInt16LE(entries.length, 8); // num entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localParts, cdBuffer, eocd]);
}

test('extractZipSafely extracts normal files properly', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'work-test-extract-'));
  const targetDir = path.join(tmp, 'repo');

  const zip = buildZip([
    { name: 'hello.txt', data: 'Hello World!', method: 8 },
    { name: 'sub/inner.js', data: 'console.log(42);', method: 0 },
  ]);

  try {
    const res = await extractZipSafely(zip, targetDir);
    assert.equal(res.extractedCount, 2);
    const c1 = await readFile(path.join(targetDir, 'hello.txt'), 'utf8');
    assert.equal(c1, 'Hello World!');
    const c2 = await readFile(path.join(targetDir, 'sub', 'inner.js'), 'utf8');
    assert.equal(c2, 'console.log(42);');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('extractZipSafely rejects path traversal with ..', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'work-test-traversal-'));
  const targetDir = path.join(tmp, 'repo');

  const zip = buildZip([
    { name: '../evil.txt', data: 'malicious', method: 0 },
  ]);

  try {
    await assert.rejects(
      async () => extractZipSafely(zip, targetDir),
      /Path traversal/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('extractZipSafely rejects absolute paths', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'work-test-abs-'));
  const targetDir = path.join(tmp, 'repo');

  const zip = buildZip([
    { name: '/etc/passwd', data: 'root:x:0:0', method: 0 },
  ]);

  try {
    await assert.rejects(
      async () => extractZipSafely(zip, targetDir),
      /Absolute path/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('extractZipSafely rejects duplicate entry names', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'work-test-dup-'));
  const targetDir = path.join(tmp, 'repo');

  const zip = buildZip([
    { name: 'file.txt', data: 'first', method: 0 },
    { name: 'file.txt', data: 'second', method: 0 },
  ]);

  try {
    await assert.rejects(
      async () => extractZipSafely(zip, targetDir),
      /Duplicate path/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('extractZipSafely rejects symlink entries', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'work-test-symlink-'));
  const targetDir = path.join(tmp, 'repo');

  const zip = buildZip([
    { name: 'link.txt', data: '/target', method: 0, isSymlink: true },
  ]);

  try {
    await assert.rejects(
      async () => extractZipSafely(zip, targetDir),
      /Disallowed Unix file type|Symlink/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('extractZipSafely refuses to overwrite non-empty target directory in fail mode', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'work-test-nonempty-'));
  const targetDir = path.join(tmp, 'repo');
  const zip = buildZip([{ name: 'test.txt', data: '123', method: 0 }]);

  // First extraction succeeds
  await extractZipSafely(zip, targetDir);

  // Second extraction into same directory must fail with conflictResolution: 'fail'
  await assert.rejects(
    async () => extractZipSafely(zip, targetDir, { conflictResolution: 'fail' }),
    /Target directory already exists/,
  );

  await rm(tmp, { recursive: true, force: true });
});

test('extractZipSafely conflictResolution auto-rename creates target_(1) and target_(2)', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'work-test-autorename-'));
  const targetDir = path.join(tmp, 'repo');
  const zip1 = buildZip([{ name: 'test.txt', data: 'v1', method: 0 }]);
  const zip2 = buildZip([{ name: 'test.txt', data: 'v2', method: 0 }]);
  const zip3 = buildZip([{ name: 'test.txt', data: 'v3', method: 0 }]);

  try {
    const res1 = await extractZipSafely(zip1, targetDir, { conflictResolution: 'auto-rename' });
    assert.equal(res1.targetDir, targetDir);
    assert.equal(await readFile(path.join(res1.targetDir, 'test.txt'), 'utf8'), 'v1');

    const res2 = await extractZipSafely(zip2, targetDir, { conflictResolution: 'auto-rename' });
    assert.equal(res2.targetDir, `${targetDir}_(1)`);
    assert.equal(await readFile(path.join(res2.targetDir, 'test.txt'), 'utf8'), 'v2');

    const res3 = await extractZipSafely(zip3, targetDir, { conflictResolution: 'auto-rename' });
    assert.equal(res3.targetDir, `${targetDir}_(2)`);
    assert.equal(await readFile(path.join(res3.targetDir, 'test.txt'), 'utf8'), 'v3');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('extractZipSafely conflictResolution clean safely replaces existing directory', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'work-test-clean-'));
  const targetDir = path.join(tmp, 'repo');
  const zip1 = buildZip([
    { name: 'old_file.txt', data: 'old', method: 0 },
    { name: 'config.json', data: '{"version":1}', method: 0 },
  ]);
  const zip2 = buildZip([
    { name: 'new_file.txt', data: 'new', method: 0 },
    { name: 'config.json', data: '{"version":2}', method: 0 },
  ]);

  try {
    await extractZipSafely(zip1, targetDir);
    assert.equal(await readFile(path.join(targetDir, 'old_file.txt'), 'utf8'), 'old');

    // Clean overwrite
    const res = await extractZipSafely(zip2, targetDir, { conflictResolution: 'clean' });
    assert.equal(res.targetDir, targetDir);
    assert.equal(await readFile(path.join(targetDir, 'new_file.txt'), 'utf8'), 'new');
    assert.equal(await readFile(path.join(targetDir, 'config.json'), 'utf8'), '{"version":2}');

    // old_file.txt must no longer exist
    await assert.rejects(
      async () => readFile(path.join(targetDir, 'old_file.txt'), 'utf8'),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
