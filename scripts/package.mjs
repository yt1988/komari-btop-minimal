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
if (manifest.name !== 'Btop Minimal'
  || manifest.short !== 'btop-minimal'
  || manifest.description !== 'A minimal btop-inspired Komari monitor theme.'
  || manifest.version !== '1.1.0'
  || manifest.author !== 'Tao'
  || manifest.url !== "https://github.com/yt1988/komari-btop-minimal"
  || manifest.preview !== 'preview.png') {
  throw new Error('komari-theme.json does not match the approved theme manifest');
}

const htmlPath = path.join(distPath, 'index.html');
const html = await readFile(htmlPath, 'utf8');
for (const marker of [
  '<title>Komari Monitor</title>',
  '<meta name="description" content="A simple server monitor tool." />',
  'Powered by Komari Monitor.',
]) {
  if (!html.includes(marker)) {
    throw new Error(`dist/index.html is missing required marker: ${marker}`);
  }
}
if (!(await stat(distPath)).isDirectory()) {
  throw new Error('dist/ is missing');
}
if (!(await stat(previewPath)).isFile()) {
  throw new Error('preview.png is missing');
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

