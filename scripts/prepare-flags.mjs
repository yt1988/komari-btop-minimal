import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, 'node_modules', 'flag-icons', 'flags', '4x3');
const licenseSource = path.resolve(root, 'node_modules', 'flag-icons', 'LICENSE');
const target = path.resolve(root, 'public', 'flags');
const rootPrefix = `${root}${path.sep}`;

if (!target.startsWith(rootPrefix)) {
  throw new Error(`Refusing to write outside workspace: ${target}`);
}

await rm(target, { force: true, recursive: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
await cp(licenseSource, path.join(target, 'LICENSE'));

const files = await readdir(target);
if (!files.includes('xx.svg') || !files.includes('cn.svg') || !files.includes('hk.svg')) {
  throw new Error('The local flag set is incomplete');
}

console.log(`Prepared ${files.length} local flag assets`);
