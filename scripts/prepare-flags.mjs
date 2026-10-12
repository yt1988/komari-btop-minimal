import { access, cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, 'node_modules', 'flag-icons', 'flags', '4x3');
const licenseSource = path.resolve(root, 'node_modules', 'flag-icons', 'LICENSE');
const target = path.resolve(root, 'public', 'flags');
const staging = path.resolve(root, 'public', '.flags-staging');
const rootPrefix = `${root}${path.sep}`;

if (!target.startsWith(rootPrefix) || !staging.startsWith(rootPrefix)) {
  throw new Error('Refusing to write outside workspace');
}

await access(source);
await access(licenseSource);
await rm(staging, { force: true, recursive: true });
await mkdir(path.dirname(staging), { recursive: true });
await cp(source, staging, { recursive: true });
await cp(licenseSource, path.join(staging, 'LICENSE'));

const files = await readdir(staging);
for (const file of ['xx.svg', 'cn.svg', 'hk.svg', 'LICENSE']) {
  if (!files.includes(file)) {
    await rm(staging, { force: true, recursive: true });
    throw new Error(`The local flag set is missing ${file}`);
  }
}

await rm(target, { force: true, recursive: true });
await rename(staging, target);
console.log(`Prepared ${files.length} local flag assets`);
