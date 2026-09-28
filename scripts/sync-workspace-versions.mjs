import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.env.NEXT;
if (!version) {
  console.error('NEXT is not set');
  process.exit(1);
}

const packagesDir = join(process.cwd(), 'packages');
let updated = 0;
for (const name of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, name, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.version === version) continue;
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  updated += 1;
}

console.log(`Set ${updated} workspace package version(s) to ${version}`);
