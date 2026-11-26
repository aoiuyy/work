import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['node_modules', '.git', 'data', 'crates', 'scratch', 'temp']);
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) { await scan(target); continue; }
    if (!/\.(?:js|mjs|jsx|css)$/.test(entry.name)) continue;
    const source = await readFile(target, 'utf8');
    assert(!/transition\s*:\s*all\b/i.test(source), `Unbounded transition: ${target}`);
    assert(!/#(?:7928ca|8b5cf6)\b/i.test(source), `Forbidden palette: ${target}`);
    assert(!/\p{Extended_Pictographic}/u.test(source), `Emoji in source: ${target}`);
    if (/\.(?:js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', target], { stdio: 'inherit' });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `Syntax failure: ${target}`);
    }
  }
}
await scan(root);
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const locale of ['en', 'vi']) {
  const value = JSON.parse(await readFile(path.join(root, 'locale', `${locale}.json`), 'utf8'));
  assert(value.meta.title && value.meta.description, `Missing ${locale} display metadata`);
}
assert.equal(pkg.exports['./icon'], './icon.svg');
console.log('[PASS] Work V4 syntax, motion, palette, source icons and metadata');
