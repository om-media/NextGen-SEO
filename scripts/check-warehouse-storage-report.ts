import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { getWarehouseStorageReport } from '../server/services/warehouseStorage.js';

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
  CREATE TABLE gsc_site_metrics (date TEXT);
  CREATE TABLE gsc_query_metrics (date TEXT);
  CREATE TABLE gsc_country_metrics (date TEXT);
  CREATE TABLE gsc_page_metrics (date TEXT);
  CREATE TABLE gsc_page_query_metrics (date TEXT);
`);

for (const table of ['gsc_site_metrics', 'gsc_query_metrics', 'gsc_country_metrics', 'gsc_page_metrics', 'gsc_page_query_metrics']) {
  await db.run(`INSERT INTO ${table} (date) VALUES (?), (?), (?)`, ['2026-01-01', '2026-04-01', '2026-06-30']);
}

const report = await getWarehouseStorageReport(db, 90);
assert(report.latestObservedDate === '2026-06-30', 'Report should use the latest observed warehouse date as its anchor');
assert(report.cutoffDate === '2026-04-02', `Unexpected cutoff date: ${report.cutoffDate}`);
assert(report.tables.every((table) => table.rowCount === 3), 'Report should count every raw GSC table');
assert(report.tables.every((table) => table.candidateRows === 2 && table.retainedRows === 1), 'Report should split rows at the retention cutoff');

console.log(JSON.stringify({ ok: true, cutoffDate: report.cutoffDate, retentionDays: report.retentionDays }, null, 2));
await db.close();
