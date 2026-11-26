import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

console.log(`Verifying package: ${pkg.name}@${pkg.version}`);

let errors = 0;
for (const f of pkg.files || []) {
  const fullPath = path.join(pkgRoot, f);
  if (!fs.existsSync(fullPath)) {
    console.error(`Missing packaged file or directory: ${f}`);
    errors++;
  } else {
    console.log(`  [OK] ${f}`);
  }
}
for (const [key, expPath] of Object.entries(pkg.exports || {})) {
  const fullPath = path.join(pkgRoot, expPath);
  const wildcard = expPath.includes('*');
  const exists = wildcard
    ? fs.existsSync(path.dirname(fullPath)) && fs.readdirSync(path.dirname(fullPath)).some(name => {
        const [prefix, suffix] = path.basename(expPath).split('*');
        return name.startsWith(prefix) && name.endsWith(suffix);
      })
    : fs.existsSync(fullPath);
  if (!exists) {
    console.error(`Missing export target ${key} -> ${expPath}`);
    errors++;
  } else {
    console.log(`  [OK] export "${key}" -> ${expPath}`);
  }
}
if (errors > 0) {
  console.error(`Verification failed with ${errors} error(s).`);
  process.exit(1);
} else {
  console.log('Package verification passed.');
}
