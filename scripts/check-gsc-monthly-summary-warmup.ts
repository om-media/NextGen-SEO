import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import {
  ALL_GSC_MONTHLY_SUMMARY_TABLES,
  ensureGscMonthlySummariesForRange,
  hasGscMonthlySummariesForRange,
  getGscMonthlySummaryCoverage,
} from '../server/services/gscMonthlySummaries.js';

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
    return async (...args: Args) => {
      this.db.exec('BEGIN');
      try {
        const result = await callback(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    };
  }

  async close() {
    this.db.close();
  }
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const raw = new Database(':memory:');
const db = new MemoryDatabase(raw);
const ownerId = 'owner-1';
const siteUrl = 'https://example.com/';
const input = { ownerId, siteUrl, startDate: '2026-01-15', endDate: '2026-04-20' };

await db.exec(`
  CREATE TABLE gsc_site_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date)
  );
  CREATE TABLE gsc_query_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date, query)
  );
  CREATE TABLE gsc_country_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    country TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date, country)
  );
  CREATE TABLE gsc_page_query_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    page TEXT,
    pageKey TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date, page, query)
  );
  CREATE TABLE gsc_page_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    page TEXT,
    pageKey TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    queryCount INTEGER,
    PRIMARY KEY (ownerId, siteUrl, date, pageKey)
  );
  CREATE TABLE gsc_site_monthly_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    monthStart TEXT,
    clicks INTEGER,
    impressions INTEGER,
    positionSum REAL,
    PRIMARY KEY (ownerId, siteUrl, monthStart)
  );
  CREATE TABLE gsc_query_monthly_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    monthStart TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    positionSum REAL,
    PRIMARY KEY (ownerId, siteUrl, monthStart, query)
  );
  CREATE TABLE gsc_country_monthly_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    monthStart TEXT,
    country TEXT,
    clicks INTEGER,
    impressions INTEGER,
    positionSum REAL,
    PRIMARY KEY (ownerId, siteUrl, monthStart, country)
  );
  CREATE TABLE gsc_page_monthly_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    monthStart TEXT,
    page TEXT,
    pageKey TEXT,
    clicks INTEGER,
    impressions INTEGER,
    positionSum REAL,
    queryCount INTEGER,
    PRIMARY KEY (ownerId, siteUrl, monthStart, pageKey)
  );
  CREATE TABLE gsc_page_query_monthly_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    monthStart TEXT,
    page TEXT,
    pageKey TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    positionSum REAL,
    PRIMARY KEY (ownerId, siteUrl, monthStart, pageKey, query)
  );
`);

const rows = [
  { date: '2026-02-10', query: 'alpha', page: 'https://example.com/a', pageKey: '/a', country: 'US', clicks: 4, impressions: 40, position: 2 },
  { date: '2026-02-20', query: 'beta', page: 'https://example.com/b', pageKey: '/b', country: 'GB', clicks: 3, impressions: 60, position: 4 },
  { date: '2026-03-05', query: 'alpha', page: 'https://example.com/a', pageKey: '/a', country: 'US', clicks: 6, impressions: 50, position: 3 },
  { date: '2026-03-25', query: 'gamma', page: 'https://example.com/c', pageKey: '/c', country: 'CA', clicks: 2, impressions: 20, position: 5 },
];

for (const row of rows) {
  const ctr = row.impressions > 0 ? row.clicks / row.impressions : 0;
  await db.run('INSERT INTO gsc_site_metrics VALUES (?, ?, ?, ?, ?, ?, ?)', [ownerId, siteUrl, row.date, row.clicks, row.impressions, ctr, row.position]);
  await db.run('INSERT INTO gsc_query_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [ownerId, siteUrl, row.date, row.query, row.clicks, row.impressions, ctr, row.position]);
  await db.run('INSERT INTO gsc_country_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [ownerId, siteUrl, row.date, row.country, row.clicks, row.impressions, ctr, row.position]);
  await db.run('INSERT INTO gsc_page_query_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [ownerId, siteUrl, row.date, row.page, row.pageKey, row.query, row.clicks, row.impressions, ctr, row.position]);
  await db.run('INSERT INTO gsc_page_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [ownerId, siteUrl, row.date, row.page, row.pageKey, row.clicks, row.impressions, ctr, row.position, 1]);
}

const beforeCoverage = await getGscMonthlySummaryCoverage(db, input, ALL_GSC_MONTHLY_SUMMARY_TABLES);
assert(beforeCoverage.expectedMonthStarts.join(',') === '2026-02-01,2026-03-01', 'coverage should target the full interior months');
assert(beforeCoverage.tables.some((table) => table.missingMonthStarts.length > 0), 'coverage should report missing months before warm-up');

const before = await hasGscMonthlySummariesForRange(db, input, ALL_GSC_MONTHLY_SUMMARY_TABLES);
assert(before === false, 'monthly summary coverage should be missing before warm-up');

const warmed = await ensureGscMonthlySummariesForRange(db, input, ALL_GSC_MONTHLY_SUMMARY_TABLES);
assert(warmed === true, 'warm-up should build missing monthly summaries');

const after = await hasGscMonthlySummariesForRange(db, input, ALL_GSC_MONTHLY_SUMMARY_TABLES);
assert(after === true, 'monthly summary coverage should exist after warm-up');

const secondWarm = await ensureGscMonthlySummariesForRange(db, input, ALL_GSC_MONTHLY_SUMMARY_TABLES);
const afterCoverage = await getGscMonthlySummaryCoverage(db, input, ALL_GSC_MONTHLY_SUMMARY_TABLES);
assert(afterCoverage.tables.every((table) => table.missingMonthStarts.length === 0), 'coverage should report full monthly coverage after warm-up');

assert(secondWarm === false, 'warm-up should be a no-op once coverage exists');

const alpha = await db.get<{ clicks: number; impressions: number; positionSum: number }>(`
  SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(positionSum) AS positionSum
  FROM gsc_query_monthly_metrics
  WHERE ownerId = ? AND siteUrl = ? AND query = ?
`, [ownerId, siteUrl, 'alpha']);
assert(alpha?.clicks === 10, 'query summary should aggregate clicks by month');
assert(alpha?.impressions === 90, 'query summary should aggregate impressions by month');
assert(alpha?.positionSum === 230, 'query summary should retain weighted position sums');

const pages = await db.get<{ total: number }>(`
  SELECT COUNT(*) AS total
  FROM gsc_page_monthly_metrics
  WHERE ownerId = ? AND siteUrl = ? AND pageKey <> ''
`, [ownerId, siteUrl]);
assert(pages?.total === 4, 'page summary should retain monthly page rows');

await db.close();
console.log('GSC monthly summary warm-up check passed');
