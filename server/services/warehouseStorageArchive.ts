import { createHash } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import type { AppDatabase } from '../database.js';
import { RAW_GSC_WAREHOUSE_TABLES, type RawGscWarehouseTable } from './warehouseStorage.js';

type ArchiveTableConfig = {
  cursorColumns: string[];
  dateColumn: 'date';
  tableName: RawGscWarehouseTable;
};

export type WarehouseArchiveOptions = {
  archiveDir: string;
  beforeDate: string;
  batchSize?: number;
  force?: boolean;
  tables?: RawGscWarehouseTable[];
};

export type WarehouseArchiveManifest = {
  beforeDate: string;
  createdAt: string;
  fileBytes: number;
  fileName: string;
  formatVersion: 1;
  rowCount: number;
  sha256: string;
  tableName: RawGscWarehouseTable;
};

const TABLE_CONFIG: Record<RawGscWarehouseTable, ArchiveTableConfig> = {
  gsc_site_metrics: { cursorColumns: ['date', 'ownerId', 'siteUrl'], dateColumn: 'date', tableName: 'gsc_site_metrics' },
  gsc_query_metrics: { cursorColumns: ['date', 'ownerId', 'siteUrl', 'query'], dateColumn: 'date', tableName: 'gsc_query_metrics' },
  gsc_country_metrics: { cursorColumns: ['date', 'ownerId', 'siteUrl', 'country'], dateColumn: 'date', tableName: 'gsc_country_metrics' },
  gsc_page_metrics: { cursorColumns: ['date', 'ownerId', 'siteUrl', 'pageKey'], dateColumn: 'date', tableName: 'gsc_page_metrics' },
  gsc_page_query_metrics: { cursorColumns: ['date', 'ownerId', 'siteUrl', 'page', 'query'], dateColumn: 'date', tableName: 'gsc_page_query_metrics' },
};

function normalizeBatchSize(value: number | undefined) {
  if (!Number.isFinite(value)) return 2000;
  return Math.max(100, Math.min(10000, Math.trunc(value!)));
}

function validateBeforeDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid archive cutoff date: ${value}. Use YYYY-MM-DD.`);
  }
  return value;
}

function validateTables(tables: RawGscWarehouseTable[] | undefined) {
  const selected = tables?.length ? tables : [...RAW_GSC_WAREHOUSE_TABLES];
  for (const table of selected) {
    if (!TABLE_CONFIG[table]) throw new Error(`Unsupported warehouse archive table: ${table}`);
  }
  return Array.from(new Set(selected));
}

function quoteArchiveName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function writeLine(stream: ReturnType<typeof createGzip>, line: string) {
  if (!stream.write(line)) await once(stream, 'drain');
}

async function verifyArchiveFilePath(
  filePath: string,
  manifest: WarehouseArchiveManifest,
): Promise<WarehouseArchiveManifest> {
  const config = TABLE_CONFIG[manifest.tableName];
  const fileStats = await stat(filePath);
  const hash = createHash('sha256');
  const input = createReadStream(filePath).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  let rowCount = 0;
  let previousDate: string | null = null;

  try {
    for await (const line of lines) {
      if (!line) throw new Error(`Archive contains an empty JSONL line: ${filePath}`);
      const lineBytes = Buffer.from(`${line}\n`, 'utf8');
      const row = JSON.parse(line) as Record<string, unknown> | null;
      if (!row || typeof row !== 'object' || typeof row.date !== 'string' || row.date >= manifest.beforeDate) {
        throw new Error(`Archive row violates cutoff ${manifest.beforeDate}: ${filePath}`);
      }
      const cursor = config.cursorColumns.map((column) => row[column]);
      if (cursor.some((value) => value === null || value === undefined)) {
        throw new Error(`Archive row has a null key column: ${filePath}`);
      }
      if (previousDate && row.date < previousDate) {
        throw new Error(`Archive rows are not ordered by date: ${filePath}`);
      }
      hash.update(lineBytes);
      previousDate = row.date;
      rowCount += 1;
    }
  } finally {
    lines.close();
  }

  const sha256 = hash.digest('hex');
  if (manifest.formatVersion !== 1) {
    throw new Error(`Unsupported warehouse archive format: ${String(manifest.formatVersion)}`);
  }
  if (fileStats.size !== manifest.fileBytes) {
    throw new Error(`Archive byte count mismatch for ${filePath}: expected ${manifest.fileBytes}, got ${fileStats.size}`);
  }
  if (rowCount !== manifest.rowCount) {
    throw new Error(`Archive row count mismatch for ${filePath}: expected ${manifest.rowCount}, got ${rowCount}`);
  }
  if (sha256 !== manifest.sha256) {
    throw new Error(`Archive checksum mismatch for ${filePath}`);
  }
  return manifest;
}

export async function verifyWarehouseArchiveFile(
  archiveDir: string,
  manifest: WarehouseArchiveManifest,
) {
  return verifyArchiveFilePath(join(archiveDir, manifest.fileName), manifest);
}

export async function archiveWarehouseTable(
  db: AppDatabase,
  options: WarehouseArchiveOptions,
  tableName: RawGscWarehouseTable,
): Promise<WarehouseArchiveManifest> {
  const beforeDate = validateBeforeDate(options.beforeDate);
  const config = TABLE_CONFIG[tableName];
  const batchSize = normalizeBatchSize(options.batchSize);
  await mkdir(options.archiveDir, { recursive: true });

  const fileName = `${tableName}.${quoteArchiveName(beforeDate)}.jsonl.gz`;
  const filePath = join(options.archiveDir, fileName);
  if (!options.force) {
    try {
      await stat(filePath);
      throw new Error(`Archive file already exists: ${filePath}. Use --force only to replace it.`);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const partialPath = `${filePath}.partial-${process.pid}-${Date.now()}`;
  const output = createWriteStream(partialPath, { flags: 'wx' });
  const gzip = createGzip({ level: 9 });
  const completion = pipeline(gzip, output);
  const hash = createHash('sha256');
  let cursor: unknown[] | null = null;
  let rowCount = 0;

  try {
    while (true) {
      const cursorFilter = cursor
        ? ` AND (${config.cursorColumns.join(', ')}) > (${cursor.map(() => '?').join(', ')})`
        : '';
      const params = cursor ? [beforeDate, ...cursor, batchSize] : [beforeDate, batchSize];
      const rows = await db.all<any>(`
        SELECT *
        FROM ${config.tableName}
        WHERE ${config.dateColumn} < ?${cursorFilter}
        ORDER BY ${config.cursorColumns.join(', ')}
        LIMIT ?
      `, params);
      if (!rows.length) break;

      for (const row of rows) {
        const line = `${JSON.stringify(row)}\n`;
        hash.update(line);
        await writeLine(gzip, line);
        rowCount += 1;
      }
      cursor = rows[rows.length - 1] && config.cursorColumns.map((column) => rows[rows.length - 1][column]);
      if (rows.length < batchSize) break;
    }

    gzip.end();
    await completion;

    const partialStats = await stat(partialPath);
    const candidateManifest: WarehouseArchiveManifest = {
      beforeDate,
      createdAt: new Date().toISOString(),
      fileBytes: partialStats.size,
      fileName,
      formatVersion: 1,
      rowCount,
      sha256: hash.digest('hex'),
      tableName,
    };
    await verifyArchiveFilePath(partialPath, candidateManifest);
    if (options.force) await rm(filePath, { force: true });
    await rename(partialPath, filePath);
    const finalStats = await stat(filePath);
    return { ...candidateManifest, fileBytes: finalStats.size };
  } catch (error) {
    gzip.destroy();
    await completion.catch(() => undefined);
    await rm(partialPath, { force: true });
    throw error;
  }
}

export async function archiveWarehouseTables(
  db: AppDatabase,
  options: WarehouseArchiveOptions,
): Promise<WarehouseArchiveManifest[]> {
  const tables = validateTables(options.tables);
  const manifests: WarehouseArchiveManifest[] = [];
  for (const tableName of tables) {
    manifests.push(await archiveWarehouseTable(db, options, tableName));
  }
  return manifests;
}
