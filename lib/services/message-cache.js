import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Atomic JSON message cache under dataDir/messages.json with serialized writes.
 */
export function createMessageCache(dataDir) {
  const messagesFile = path.join(dataDir, 'messages.json');
  let cachePromise;
  let cacheWrite = Promise.resolve();

  async function loadPersistentCache() {
    cachePromise ||= fs.readFile(messagesFile, 'utf8').then(raw => JSON.parse(raw)).catch(err => {
      if (err.code === 'ENOENT') return { rooms: {} };
      throw new Error(`Message cache unavailable: ${err.message}`);
    });
    return cachePromise;
  }

  async function savePersistentCache(cache) {
    const snapshot = JSON.stringify(cache, null, 2);
    const write = cacheWrite.catch(() => {}).then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const temporary = `${messagesFile}.tmp`;
      await fs.writeFile(temporary, snapshot, 'utf8');
      await fs.rename(temporary, messagesFile);
    });
    cacheWrite = write;
    try {
      await write;
    } catch (err) {
      throw new Error(`Message persistence failed: ${err.message}`);
    }
  }

  return { loadPersistentCache, savePersistentCache };
}
