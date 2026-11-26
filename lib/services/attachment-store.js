import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

export function decodeAttachment(value) {
  if (typeof value !== 'string') throw new Error('Attachment base64 required');
  const raw = value.replace(/^data:[^,]*;base64,/, '');
  if (!raw || raw.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw))) {
    throw new Error('Invalid attachment or attachment exceeds 16MiB');
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds 16MiB');
  return bytes;
}

/**
 * Manages flat, symlink-confined local attachment persistence under dataDir/attachments.
 */
export function createAttachmentStore(dataDir) {
  const attachmentsDir = path.join(dataDir, 'attachments');

  async function attachmentDirectory(create = false) {
    if (create) await fs.mkdir(dataDir, { recursive: true });
    if ((await fs.lstat(dataDir)).isSymbolicLink()) throw new Error('Unsafe attachment data directory');
    if (create) await fs.mkdir(attachmentsDir, { recursive: true });
    if ((await fs.lstat(attachmentsDir)).isSymbolicLink()) throw new Error('Unsafe attachment directory');
    const realData = await fs.realpath(dataDir);
    const realDir = await fs.realpath(attachmentsDir);
    if (path.dirname(realDir) !== realData) throw new Error('Unsafe attachment directory');
    return realDir;
  }

  async function confinedAttachment(filePath) {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw new Error('Invalid attachment path');
    const requested = filePath.startsWith('file:') ? fileURLToPath(filePath) : filePath;
    if (requested.split(/[\\/]/).includes('..')) throw new Error('Attachment traversal rejected');
    const candidate = path.resolve(requested);
    // Files are stored flat. Reject nested paths, traversal and alternate data streams.
    if (path.dirname(candidate) !== attachmentsDir || /[:]/.test(path.basename(candidate))) {
      throw new Error('Attachment path outside storage');
    }
    const dir = await attachmentDirectory();
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || path.dirname(await fs.realpath(candidate)) !== dir) {
      throw new Error('Unsafe attachment file');
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds 16MiB');
    return candidate;
  }

  async function storeAttachment(fileMeta, bytes, type) {
    await attachmentDirectory(true);
    const name = String(fileMeta?.name || (type === 'voice' ? 'voice.webm' : 'attachment'))
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .slice(0, 180) || 'attachment';
    const filePath = path.join(attachmentsDir, `${randomUUID()}-${name}`);
    await fs.writeFile(filePath, bytes, { flag: 'wx' });
    const meta = { ...fileMeta, name, size: bytes.length, filePath, storedLocally: true };
    delete meta.rawBase64;
    delete meta.dataUrl;
    if (type === 'voice') meta.audioUrl = pathToFileURL(filePath).href;
    return meta;
  }

  return { decodeAttachment, confinedAttachment, storeAttachment };
}
