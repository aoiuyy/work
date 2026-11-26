import { inflateRawSync, crc32 } from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const MAX_UNCOMPRESSED_TOTAL_BYTES = 1024 * 1024 * 1024; // 1GB
export const MAX_FILE_COUNT = 20000;
export const MAX_EXPANSION_RATIO = 100;

export class ZipSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipSecurityError';
  }
}

/**
 * Validate path string for traversal, UNC, drive letters, and null bytes.
 *
 * @param {string} rawName
 * @returns {string} normalized relative path
 */
export function sanitizeEntryPath(rawName) {
  if (typeof rawName !== 'string' || !rawName) {
    throw new ZipSecurityError('Entry name cannot be empty');
  }

  if (rawName.includes('\0')) {
    throw new ZipSecurityError(`Null byte in archive entry name: ${JSON.stringify(rawName)}`);
  }

  // Reject UNC paths (\\server\share or //server/share)
  if (rawName.startsWith('\\\\') || rawName.startsWith('//')) {
    throw new ZipSecurityError(`UNC paths are forbidden: ${rawName}`);
  }

  // Reject Windows drive letters (C:, D:, etc.)
  if (/^[a-zA-Z]:/.test(rawName)) {
    throw new ZipSecurityError(`Absolute drive letter path is forbidden: ${rawName}`);
  }

  const normalized = rawName.replaceAll('\\', '/');

  if (normalized.startsWith('/')) {
    throw new ZipSecurityError(`Absolute path is forbidden: ${rawName}`);
  }

  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new ZipSecurityError(`Path traversal (..) is forbidden: ${rawName}`);
    }
  }

  return normalized;
}

/**
 * Resolve target directory based on conflict resolution policy.
 *
 * @param {string} targetDir
 * @param {'auto-rename'|'clean'|'fail'} conflictResolution
 * @returns {Promise<{ finalTarget: string, needsClean: boolean }>}
 */
export async function resolveTargetDirectory(targetDir, conflictResolution = 'auto-rename') {
  const resolved = path.resolve(targetDir);
  let exists = false;
  try {
    await fs.stat(resolved);
    exists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (!exists) {
    return { finalTarget: resolved, needsClean: false };
  }

  if (conflictResolution === 'fail') {
    throw new ZipSecurityError(`Target directory already exists; refusing to overwrite: ${resolved}`);
  }

  if (conflictResolution === 'clean') {
    return { finalTarget: resolved, needsClean: true };
  }

  if (conflictResolution === 'auto-rename') {
    let counter = 1;
    while (true) {
      const candidate = `${resolved}_(${counter})`;
      try {
        await fs.stat(candidate);
        counter++;
      } catch (err) {
        if (err.code === 'ENOENT') {
          return { finalTarget: candidate, needsClean: false };
        }
        throw err;
      }
    }
  }

  throw new ZipSecurityError(`Unknown conflict resolution mode: ${conflictResolution}`);
}

/**
 * Parse and safely extract ZIP archive with strict security checks:
 * - Atomic stage & rename (no partial state on failure)
 * - Strict conflict resolution: auto-rename, clean, or fail
 * - Path traversal / UNC / drive letter rejection
 * - Symlink / FIFO / Socket / Device rejection
 * - Central directory vs Local header filename & CRC-32 consistency
 * - Decompression bomb & file count defense
 *
 * @param {Buffer|Uint8Array} zipBuffer
 * @param {string} targetDir
 * @param {object|string} [options={}]
 * @param {'auto-rename'|'clean'|'fail'} [options.conflictResolution='auto-rename']
 * @returns {Promise<{ extractedCount: number, totalBytes: number, files: string[], targetDir: string }>}
 */
export async function extractZipSafely(zipBuffer, targetDir, options = {}) {
  const opts = typeof options === 'string' ? { conflictResolution: options } : (options || {});
  const conflictResolution = opts.conflictResolution || 'auto-rename';

  const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
  const resolvedInitialTarget = path.resolve(targetDir);

  // 1. Initial check or fast-fail if fail mode is requested
  if (conflictResolution === 'fail') {
    try {
      await fs.stat(resolvedInitialTarget);
      throw new ZipSecurityError(`Target directory already exists; refusing to overwrite: ${resolvedInitialTarget}`);
    } catch (err) {
      if (err instanceof ZipSecurityError) throw err;
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // 2. Parse Central Directory from EOCD
  let eocdOffset = -1;
  const minEocdSize = 22;
  const maxSearch = Math.min(buf.length, 65535 + minEocdSize);
  for (let i = buf.length - minEocdSize; i >= buf.length - maxSearch; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new ZipSecurityError('Invalid ZIP archive: End of Central Directory record not found');
  }

  const diskNumber = buf.readUInt16LE(eocdOffset + 4);
  const cdDiskNumber = buf.readUInt16LE(eocdOffset + 6);
  if (diskNumber !== 0 || cdDiskNumber !== 0) {
    throw new ZipSecurityError('Multi-disk ZIP archives are not supported');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (totalEntries > MAX_FILE_COUNT) {
    throw new ZipSecurityError(`Archive contains ${totalEntries} entries, exceeding limit of ${MAX_FILE_COUNT}`);
  }

  if (cdOffset + cdSize > eocdOffset || cdOffset + cdSize > buf.length) {
    throw new ZipSecurityError('Corrupt ZIP archive: central directory extends beyond EOCD or buffer');
  }

  const seenPaths = new Set();
  const entriesToExtract = [];
  let currentOffset = cdOffset;
  let totalUncompressedSize = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (currentOffset + 46 > buf.length) {
      throw new ZipSecurityError('Corrupt ZIP archive: premature end of central directory header');
    }

    const sig = buf.readUInt32LE(currentOffset);
    if (sig !== 0x02014b50) {
      throw new ZipSecurityError(`Corrupt ZIP archive: invalid central directory signature 0x${sig.toString(16)}`);
    }

    const versionMadeBy = buf.readUInt16LE(currentOffset + 4);
    const flags = buf.readUInt16LE(currentOffset + 8);
    const compressionMethod = buf.readUInt16LE(currentOffset + 10);
    const expectedCrc = buf.readUInt32LE(currentOffset + 16);
    const compressedSize = buf.readUInt32LE(currentOffset + 20);
    const uncompressedSize = buf.readUInt32LE(currentOffset + 24);
    const fileNameLength = buf.readUInt16LE(currentOffset + 28);
    const extraFieldLength = buf.readUInt16LE(currentOffset + 30);
    const fileCommentLength = buf.readUInt16LE(currentOffset + 32);
    const externalAttributes = buf.readUInt32LE(currentOffset + 38);
    const localHeaderOffset = buf.readUInt32LE(currentOffset + 42);

    // Reject encrypted entries (bit 0 of flags)
    if (flags & 0x0001) {
      throw new ZipSecurityError('Encrypted ZIP entries are not supported');
    }

    // Verify Unix file mode in high 16 bits of externalAttributes if versionMadeBy host OS is UNIX (3)
    const hostOs = versionMadeBy >> 8;
    if (hostOs === 3) {
      const unixMode = (externalAttributes >> 16) & 0xffff;
      const fileType = unixMode & 0o170000;
      // 0o120000: symlink, 0o020000: char device, 0o060000: block device, 0o010000: FIFO, 0o140000: socket
      if (fileType === 0o120000) {
        throw new ZipSecurityError('Symlink entries in ZIP are forbidden');
      }
      if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
        throw new ZipSecurityError(`Disallowed Unix file type (0o${fileType.toString(8)}) in archive`);
      }
    }

    const fileNameStart = currentOffset + 46;
    if (fileNameStart + fileNameLength > buf.length) {
      throw new ZipSecurityError('Corrupt ZIP archive: filename extends beyond buffer');
    }

    const rawName = buf.toString('utf8', fileNameStart, fileNameStart + fileNameLength);
    const normalized = sanitizeEntryPath(rawName);

    // Directory entry check (ends with slash)
    const isDirectory = rawName.endsWith('/') || rawName.endsWith('\\');

    if (!isDirectory) {
      if (seenPaths.has(normalized)) {
        throw new ZipSecurityError(`Duplicate path detected in ZIP: ${normalized}`);
      }
      seenPaths.add(normalized);

      // Defend against decompression bomb
      totalUncompressedSize += uncompressedSize;
      if (totalUncompressedSize > MAX_UNCOMPRESSED_TOTAL_BYTES) {
        throw new ZipSecurityError(`Uncompressed archive size exceeds limit of ${MAX_UNCOMPRESSED_TOTAL_BYTES} bytes`);
      }

      if (compressedSize > 0) {
        const ratio = uncompressedSize / compressedSize;
        if (ratio > MAX_EXPANSION_RATIO && uncompressedSize > 1024 * 1024) {
          throw new ZipSecurityError(`Decompression ratio ${ratio.toFixed(1)} exceeds limit of ${MAX_EXPANSION_RATIO}`);
        }
      }

      entriesToExtract.push({
        fileName: normalized,
        localHeaderOffset,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        expectedCrc,
      });
    }

    currentOffset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  // 3. Stage extraction on the same volume as targetDir so final rename is atomic and never hits EXDEV across drives
  const targetParent = path.dirname(resolvedInitialTarget);
  let stageDir;
  try {
    await fs.mkdir(targetParent, { recursive: true });
    stageDir = await fs.mkdtemp(path.join(targetParent, '.work-extract-stage-'));
  } catch {
    stageDir = await fs.mkdtemp(path.join(tmpdir(), 'work-extract-stage-'));
  }
  const extractedFiles = [];

  try {
    for (const entry of entriesToExtract) {
      const stageDestination = path.join(stageDir, entry.fileName);
      const stageResolved = path.resolve(stageDestination);
      if (!stageResolved.startsWith(stageDir + path.sep)) {
        throw new ZipSecurityError(`Path traversal attempt in entry: ${entry.fileName}`);
      }

      if (entry.localHeaderOffset + 30 > buf.length) {
        throw new ZipSecurityError(`Corrupt ZIP: local header out of bounds for ${entry.fileName}`);
      }

      const localSig = buf.readUInt32LE(entry.localHeaderOffset);
      if (localSig !== 0x04034b50) {
        throw new ZipSecurityError(`Corrupt ZIP: invalid local header signature for ${entry.fileName}`);
      }

      const localNameLen = buf.readUInt16LE(entry.localHeaderOffset + 26);
      const localExtraLen = buf.readUInt16LE(entry.localHeaderOffset + 28);
      const localNameStart = entry.localHeaderOffset + 30;

      if (localNameStart + localNameLen > buf.length) {
        throw new ZipSecurityError(`Corrupt ZIP: local filename out of bounds for ${entry.fileName}`);
      }

      const localRawName = buf.toString('utf8', localNameStart, localNameStart + localNameLen);
      const localNormalized = sanitizeEntryPath(localRawName);

      // Verify CD filename and Local Header filename match
      if (localNormalized !== entry.fileName) {
        throw new ZipSecurityError(`Filename mismatch between central directory (${entry.fileName}) and local header (${localNormalized})`);
      }

      const dataOffset = entry.localHeaderOffset + 30 + localNameLen + localExtraLen;
      if (dataOffset + entry.compressedSize > buf.length) {
        throw new ZipSecurityError(`Corrupt ZIP: data out of bounds for ${entry.fileName}`);
      }

      const compressedSlice = buf.subarray(dataOffset, dataOffset + entry.compressedSize);
      let fileData;

      if (entry.compressionMethod === 0) {
        fileData = compressedSlice;
      } else if (entry.compressionMethod === 8) {
        try {
          fileData = inflateRawSync(compressedSlice, { maxOutputLength: entry.uncompressedSize });
        } catch (err) {
          throw new ZipSecurityError(`Decompression error for ${entry.fileName}: ${err.message}`);
        }
      } else {
        throw new ZipSecurityError(`Unsupported compression method ${entry.compressionMethod} in ${entry.fileName}`);
      }

      if (fileData.length !== entry.uncompressedSize) {
        throw new ZipSecurityError(`Size mismatch for ${entry.fileName}: expected ${entry.uncompressedSize}, got ${fileData.length}`);
      }

      // Verify CRC32
      if (typeof crc32 === 'function' && entry.expectedCrc !== 0) {
        const computedCrc = crc32(fileData);
        if (computedCrc !== entry.expectedCrc) {
          throw new ZipSecurityError(`CRC32 mismatch for ${entry.fileName}: expected ${entry.expectedCrc}, got ${computedCrc}`);
        }
      }

      await fs.mkdir(path.dirname(stageDestination), { recursive: true });
      await fs.writeFile(stageDestination, fileData, { flag: 'wx', mode: 0o644 });
      extractedFiles.push(entry.fileName);
    }

    // 4. Resolve destination according to conflict policy
    const { finalTarget, needsClean } = await resolveTargetDirectory(resolvedInitialTarget, conflictResolution);

    // If clean mode and target directory currently exists, move it aside safely
    let backupDir = null;
    if (needsClean) {
      backupDir = `${finalTarget}.clean-backup-${randomUUID()}`;
      try {
        await fs.rename(finalTarget, backupDir);
      } catch (backupErr) {
        throw new ZipSecurityError(`Failed to prepare target directory for clean overwrite: ${backupErr.message}`);
      }
    } else {
      // Ensure target directory still does not exist immediately before rename
      try {
        await fs.stat(finalTarget);
        throw new ZipSecurityError(`Target directory already exists; refusing to overwrite: ${finalTarget}`);
      } catch (err) {
        if (err instanceof ZipSecurityError) throw err;
        if (err.code !== 'ENOENT') throw err;
      }
    }

    // Atomically move stageDir to finalTarget (with EXDEV fallback across mount boundaries)
    try {
      await fs.rename(stageDir, finalTarget);
    } catch (renameErr) {
      if (renameErr && renameErr.code === 'EXDEV') {
        try {
          await fs.cp(stageDir, finalTarget, { recursive: true, errorOnExist: true });
          await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
        } catch (copyErr) {
          await fs.rm(finalTarget, { recursive: true, force: true }).catch(() => {});
          if (backupDir) await fs.rename(backupDir, finalTarget).catch(() => {});
          throw new ZipSecurityError(`Atomic destination copy fallback failed: ${copyErr.message}`);
        }
      } else {
        // If rename failed and we had moved old dir aside, restore it
        if (backupDir) {
          await fs.rename(backupDir, finalTarget).catch(() => {});
        }
        throw new ZipSecurityError(`Atomic destination rename failed: ${renameErr.message}`);
      }
    }

    // Successfully renamed stageDir -> finalTarget; now delete backupDir if any
    if (backupDir) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }

    // Read work.meta.json or package.json for Quick-Run execution
    let meta = null;
    try {
      const metaRaw = await fs.readFile(path.join(finalTarget, 'work.meta.json'), 'utf8');
      meta = JSON.parse(metaRaw);
    } catch {
      try {
        const pkgRaw = await fs.readFile(path.join(finalTarget, 'package.json'), 'utf8');
        const pkg = JSON.parse(pkgRaw);
        meta = {
          name: pkg.name || path.basename(finalTarget),
          framework: pkg.dependencies?.next ? 'nextjs' : (pkg.dependencies?.vite ? 'vite' : 'node'),
          installCommand: 'npm install',
          devCommand: pkg.scripts?.dev ? 'npm run dev' : (pkg.scripts?.start ? 'npm start' : null),
          buildCommand: pkg.scripts?.build ? 'npm run build' : null,
        };
      } catch {}
    }

    return {
      extractedCount: extractedFiles.length,
      totalBytes: totalUncompressedSize,
      files: extractedFiles,
      targetDir: finalTarget,
      meta,
    };
  } catch (error) {
    // Clean up stage directory on failure
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
