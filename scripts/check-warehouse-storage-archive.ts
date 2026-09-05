import { createGunzip } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { archiveWarehouseTable, verifyWarehouseArchiveFile } from '../server/services/warehouseStorageArchive.js';

class MemoryDatabase implements AppDatabase {
  dialect = 'sqlite' as const;

  constructor(private readonly db: Database.Database) {}

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  async exec(sql: string) {
    this.db.exec(sql);
  }

  async get<T = unknown>(sql: string, params?: QueryParams) {
    const statement = this.db.prepare(sql);
    return (params === undefined ? statement.get() : statement.get(params as any)) as T | undefined;
  }

  async all<T = unknown>(sql: string, params?: QueryParams) {
    const statement = this.db.prepare(sql);
    return (params === undefined ? statement.all() : statement.all(params as any)) as T[];
  }

  async run(sql: string, params?: QueryParams): Promise<RunResult> {
    const statement = this.db.prepare(sql);
    const result = params === undefined ? statement.run() : statement.run(params as any);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => callback(...args);
  }

  async close() {
    this.db.close();
  }
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const db = new MemoryDatabase(new Database(':memory:'));
await db.exec(`
  CREATE TABLE gsc_page_query_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    page TEXT,
    pageKey TEXT,
    query TEXT,
    clicks INTEGER
  );
`);
await db.run('INSERT INTO gsc_page_query_metrics VALUES (?, ?, ?, ?, ?, ?, ?)', ['owner', 'site', '2026-01-01', '/a', '/a', 'one', 1]);
await db.run('INSERT INTO gsc_page_query_metrics VALUES (?, ?, ?, ?, ?, ?, ?)', ['owner', 'site', '2026-02-01', '/b', '/b', 'two', 2]);
await db.run('INSERT INTO gsc_page_query_metrics VALUES (?, ?, ?, ?, ?, ?, ?)', ['owner', 'site', '2026-03-01', '/c', '/c', 'three', 3]);

const archiveDir = await mkdtemp(`${tmpdir()}\\gscplus-warehouse-`);
try {
  const manifest = await archiveWarehouseTable(db, {
    archiveDir,
    beforeDate: '2026-03-01',
    batchSize: 1,
  }, 'gsc_page_query_metrics');
  assert(manifest.rowCount === 2, `Expected 2 archived rows, got ${manifest.rowCount}`);
  assert(manifest.formatVersion === 1, 'Archive should declare format version 1');
  assert(manifest.fileBytes > 0, 'Archive file should not be empty');
  assert(manifest.sha256.length === 64, 'Archive should include a SHA-256 checksum');
  await verifyWarehouseArchiveFile(archiveDir, manifest);

  const chunks: Buffer[] = [];
  await pipeline(
    createReadStream(`${archiveDir}/${manifest.fileName}`),
    createGunzip(),
    new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
  );
  const rows = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert(rows.length === 2, `Expected 2 archived JSONL rows, got ${rows.length}`);
  assert(rows[0].date === '2026-01-01' && rows[1].date === '2026-02-01', 'Archive should preserve date order and cutoff');
  console.log(JSON.stringify({ ok: true, rowCount: manifest.rowCount, fileBytes: manifest.fileBytes }, null, 2));
} finally {
  await db.close();
  await rm(archiveDir, { recursive: true, force: true });
}
