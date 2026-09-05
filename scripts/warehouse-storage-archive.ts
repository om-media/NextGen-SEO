import dotenv from 'dotenv';
import { initializeDatabase } from '../server/database.js';
import { RAW_GSC_WAREHOUSE_TABLES } from '../server/services/warehouseStorage.js';
import { archiveWarehouseTables } from '../server/services/warehouseStorageArchive.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const beforeDate = argValue('before');
if (!beforeDate) {
  throw new Error('Archive cutoff is required. Pass --before=YYYY-MM-DD. This command never deletes source rows.');
}

const archiveDir = argValue('archive-dir') || process.env.WAREHOUSE_ARCHIVE_DIR || './warehouse-archive';
const tables = (argValue('tables') || RAW_GSC_WAREHOUSE_TABLES.join(','))
  .split(',')
  .map((table) => table.trim())
  .filter(Boolean) as typeof RAW_GSC_WAREHOUSE_TABLES[number][];
const batchSize = Number(argValue('batch-size') || process.env.WAREHOUSE_ARCHIVE_BATCH_SIZE || 2000);
const force = process.argv.includes('--force');

const db = await initializeDatabase({ skipDataBackfills: true });
try {
  const manifests = await archiveWarehouseTables(db, { archiveDir, beforeDate, batchSize, force, tables });
  const manifestPath = `${archiveDir}/manifest.${beforeDate}.json`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(manifestPath, `${JSON.stringify({ formatVersion: 1, beforeDate, createdAt: new Date().toISOString(), files: manifests }, null, 2)}\n`, 'utf8');
  for (const manifest of manifests) {
    await db.run(`
      INSERT INTO warehouse_storage_archives
        (id, tableName, beforeDate, archivePath, rowCount, fileBytes, sha256, status, createdAt, verifiedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)
      ON CONFLICT (tableName, beforeDate) DO UPDATE SET
        archivePath = excluded.archivePath,
        rowCount = excluded.rowCount,
        fileBytes = excluded.fileBytes,
        sha256 = excluded.sha256,
        status = excluded.status,
        createdAt = excluded.createdAt,
        verifiedAt = excluded.verifiedAt
    `, [
      `${manifest.tableName}:${manifest.beforeDate}`,
      manifest.tableName,
      manifest.beforeDate,
      `${archiveDir}/${manifest.fileName}`,
      manifest.rowCount,
      manifest.fileBytes,
      manifest.sha256,
      manifest.createdAt,
      manifest.createdAt,
    ]);
  }
  console.log(JSON.stringify({ archiveDir, manifestPath, files: manifests }, null, 2));
} finally {
  await db.close();
}
