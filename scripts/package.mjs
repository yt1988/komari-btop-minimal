import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distPath = path.join(root, 'dist');
const manifestPath = path.join(root, 'komari-theme.json');
const previewPath = path.join(root, 'preview.png');
const releaseDirectory = path.join(root, 'release');
const archivePath = path.join(releaseDirectory, 'komari-btop-minimal.zip');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const field of ['name', 'short', 'description', 'version', 'author', 'url', 'preview']) {
  if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
    throw new Error(`komari-theme.json is missing a non-empty ${field}`);
  }
}
if (manifest.preview !== 'preview.png') {
  throw new Error('komari-theme.json preview must reference preview.png');
}
if (manifest.version !== packageJson.version) {
  throw new Error('komari-theme.json and package.json versions must match');
}

const htmlPath = path.join(distPath, 'index.html');
if (!(await stat(distPath)).isDirectory()) {
  throw new Error('dist/ is missing');
}
if (!(await stat(htmlPath)).isFile()) {
  throw new Error('dist/index.html is missing');
}
if (!(await stat(previewPath)).isFile()) {
  throw new Error('preview.png is missing');
}
const preview = await readFile(previewPath);
const isPng = preview.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const isJpeg = preview.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
if (!isPng && !isJpeg) {
  throw new Error('preview image must contain a PNG or JPEG image');
}
for (const asset of ['cn.svg', 'hk.svg', 'xx.svg', 'LICENSE']) {
  if (!(await stat(path.join(distPath, 'flags', asset))).isFile()) {
    throw new Error(`dist/flags/${asset} is missing`);
  }
}

await mkdir(releaseDirectory, { recursive: true });
await new Promise((resolve, reject) => {
  const output = createWriteStream(archivePath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
  archive.pipe(output);
  archive.file(manifestPath, { name: 'komari-theme.json' });
  archive.file(previewPath, { name: 'preview.png' });
  archive.directory(distPath, 'dist');
  void archive.finalize().catch(reject);
});

const archiveBytes = await readFile(archivePath);
const entries = [];
const endOfCentralDirectory = archiveBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (endOfCentralDirectory < 0) {
  throw new Error('Archive is missing its central directory');
}
let cursor = archiveBytes.readUInt32LE(endOfCentralDirectory + 16);
while (cursor + 46 <= archiveBytes.length && archiveBytes.readUInt32LE(cursor) === 0x02014b50) {
  const nameLength = archiveBytes.readUInt16LE(cursor + 28);
  const extraLength = archiveBytes.readUInt16LE(cursor + 30);
  const commentLength = archiveBytes.readUInt16LE(cursor + 32);
  entries.push(archiveBytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
  cursor += 46 + nameLength + extraLength + commentLength;
}

if (!entries.includes('komari-theme.json') || !entries.includes('preview.png') || !entries.includes('dist/index.html')) {
  throw new Error('Archive is missing required root entries');
}
const unexpected = entries.filter((name) => name !== 'komari-theme.json' && name !== 'preview.png' && !name.startsWith('dist/'));
if (unexpected.length > 0) {
  throw new Error(`Archive contains unexpected entries: ${unexpected.join(', ')}`);
}
if ((await readdir(distPath, { recursive: true })).length === 0) {
  throw new Error('dist/ contains no build output');
}

console.log(`Created ${path.relative(root, archivePath)}`);
console.log(entries.join('\n'));

