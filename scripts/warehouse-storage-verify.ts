import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { verifyWarehouseArchiveFile, type WarehouseArchiveManifest } from '../server/services/warehouseStorageArchive.js';

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const manifestPath = argValue('manifest');
if (!manifestPath) {
  throw new Error('Manifest path is required. Pass --manifest=path/to/manifest.json.');
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  formatVersion: number;
  beforeDate: string;
  files: WarehouseArchiveManifest[];
};
if (manifest.formatVersion !== 1) throw new Error(`Unsupported warehouse archive manifest format: ${String(manifest.formatVersion)}`);
const archiveDir = argValue('archive-dir') || dirname(manifestPath);

for (const file of manifest.files) {
  await verifyWarehouseArchiveFile(archiveDir, file);
}
console.log(JSON.stringify({ ok: true, archiveDir, beforeDate: manifest.beforeDate, files: manifest.files.length }, null, 2));
