import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { getWarehouseStoragePurgePlan } from '../server/services/warehouseStorage.js';

class MemoryDatabase implements AppDatabase {
  dialect = 'sqlite' as const;
  constructor(private readonly db: Database.Database) {}
  prepare(sql: string) { return this.db.prepare(sql); }
  async exec(sql: string) { this.db.exec(sql); }
  async get<T = unknown>(sql: string, params?: QueryParams) { const statement = this.db.prepare(sql); return (params === undefined ? statement.get() : statement.get(params as any)) as T | undefined; }
  async all<T = unknown>(sql: string, params?: QueryParams) { const statement = this.db.prepare(sql); return (params === undefined ? statement.all() : statement.all(params as any)) as T[]; }
  async run(sql: string, params?: QueryParams): Promise<RunResult> { const statement = this.db.prepare(sql); const result = params === undefined ? statement.run() : statement.run(params as any); return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }; }
  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) { return async (...args: Args) => callback(...args); }
  async close() { this.db.close(); }
}

const db = new MemoryDatabase(new Database(':memory:'));
await db.exec(`
  CREATE TABLE gsc_site_metrics (date TEXT);
  CREATE TABLE gsc_query_metrics (date TEXT);
  CREATE TABLE gsc_country_metrics (date TEXT);
  CREATE TABLE gsc_page_metrics (date TEXT);
  CREATE TABLE gsc_page_query_metrics (date TEXT);
  CREATE TABLE warehouse_storage_archives (tableName TEXT, beforeDate TEXT, archivePath TEXT, status TEXT);
`);
for (const table of ['gsc_site_metrics', 'gsc_query_metrics', 'gsc_country_metrics', 'gsc_page_metrics', 'gsc_page_query_metrics']) {
  await db.run(`INSERT INTO ${table} (date) VALUES (?), (?)`, ['2026-01-01', '2026-06-30']);
}
await db.run(`INSERT INTO warehouse_storage_archives VALUES (?, ?, ?, ?)`, ['gsc_site_metrics', '2026-04-02', '/cold/site.gz', 'verified']);

const plan = await getWarehouseStoragePurgePlan(db, 90);
assert.equal(plan.cutoffDate, '2026-04-02');
assert.equal(plan.archiveReady, false);
assert.equal(plan.tables.find((table) => table.tableName === 'gsc_site_metrics')?.archiveVerified, true);
assert.equal(plan.tables.find((table) => table.tableName === 'gsc_query_metrics')?.archiveVerified, false);
assert.equal(plan.tables.reduce((sum, table) => sum + table.candidateRows, 0), 5);
console.log('warehouse storage purge plan checks passed');
await db.close();
