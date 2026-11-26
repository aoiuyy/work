import { createWriteStream, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import * as archiverModule from 'archiver';

function createZipArchive(options) {
  if (archiverModule.ZipArchive) {
    return new archiverModule.ZipArchive(options);
  }
  const fn = archiverModule.default || archiverModule;
  return fn('zip', options);
}

const srcDir = 'D:\\dsh only\\plugins\\work-v2';
const distZip = 'D:\\dsh only\\plugins\\work-v2-dist.zip';

if (existsSync(distZip)) {
  unlinkSync(distZip);
}

const output = createWriteStream(distZip);
const archive = createZipArchive({ zlib: { level: 9 } });

output.on('close', () => {
  console.log(`Successfully generated ${distZip}: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB (${archive.pointer()} bytes)`);
  process.exit(0);
});

archive.on('error', (err) => {
  console.error('Archive error:', err);
  process.exit(1);
});

archive.pipe(output);

// Include everything necessary for machine 2 offline install
archive.glob('**/*', {
  cwd: srcDir,
  ignore: [
    '**/*.test.js',
    '**/tests/**',
    '**/.git/**',
    '**/scratch/**',
    '**/*.log',
    'scripts/create-dist.*',
  ],
  dot: true,
});

archive.finalize();
