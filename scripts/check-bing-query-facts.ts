import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { backfillLegacyBingQueryMetrics, initializeDatabase, type AppDatabase, type QueryParams, type RunResult } from '../server/database.js';
import { listBingQueryStatsForRange, syncBingQueryStats } from '../server/services/bingWarehouse.js';

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

async function runSqliteCheck() {
  const raw = new Database(':memory:');
  const db = new MemoryDatabase(raw);
  await db.exec(`
    CREATE TABLE bing_query_stats (
      ownerId TEXT,
      siteUrl TEXT,
      query TEXT,
      impressions INTEGER,
      clicks INTEGER,
      ctr REAL,
      avgClickPosition REAL,
      avgImpressionPosition REAL,
      fetchedAt TEXT,
      PRIMARY KEY (ownerId, siteUrl, query)
    );
    CREATE TABLE bing_query_metrics (
      ownerId TEXT,
      siteUrl TEXT,
      date TEXT,
      query TEXT,
      impressions INTEGER,
      clicks INTEGER,
      ctr REAL,
      avgClickPosition REAL,
      avgImpressionPosition REAL,
      fetchedAt TEXT,
      dateSource TEXT DEFAULT 'reported',
      PRIMARY KEY (ownerId, siteUrl, date, query)
    );
  `);

  const ownerId = 'sqlite-owner';
  const siteUrl = 'https://sqlite.example/';
  const legacySiteUrl = 'https://legacy.example/';
  const fetchedAt = '2026-07-13T09:30:00.000Z';
  const july1 = Date.UTC(2026, 6, 1);
  const july8 = Date.UTC(2026, 6, 8);
  const originalFetch = globalThis.fetch;

  try {
    await db.run(
      `INSERT INTO bing_query_stats
        (ownerId, siteUrl, query, impressions, clicks, ctr, avgClickPosition, avgImpressionPosition, fetchedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ownerId, legacySiteUrl, 'legacy term', 9, 3, 1 / 3, 2, 6, fetchedAt],
    );

    await backfillLegacyBingQueryMetrics(db);
    await backfillLegacyBingQueryMetrics(db);

    const legacyFacts = await db.all<{ date: string; dateSource: string }>(
      'SELECT date, dateSource FROM bing_query_metrics WHERE ownerId = ? AND siteUrl = ?',
      [ownerId, legacySiteUrl],
    );
    assert.equal(legacyFacts.length, 1, 'Legacy Bing backfill should be idempotent');
    assert.equal(legacyFacts[0]?.date, '2026-07-13', 'Legacy Bing facts should use fetchedAt calendar date');
    assert.equal(legacyFacts[0]?.dateSource, 'compatibility-fetchedAt', 'Legacy Bing facts should be tagged as compatibility rows');

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          d: [
            { Date: `/Date(${july1}+0000)/`, Query: 'brand', Impressions: 10, Clicks: 2, AvgClickPosition: 3, AvgImpressionPosition: 6 },
            { Date: `/Date(${july1}+0000)/`, Query: 'brand', Impressions: 30, Clicks: 6, AvgClickPosition: 5, AvgImpressionPosition: 8 },
            { Date: `/Date(${july8}+0000)/`, Query: 'brand', Impressions: 20, Clicks: 4, AvgClickPosition: 4, AvgImpressionPosition: 10 },
            { Date: `/Date(${july8}+0000)/`, Query: 'support', Impressions: 5, Clicks: 0, AvgClickPosition: 0, AvgImpressionPosition: 12 },
          ],
        };
      },
    })) as unknown as typeof fetch;

    const syncResult = await syncBingQueryStats(db, {
      apiKey: 'bing-key',
      ownerId,
      siteUrl,
    });

    assert.equal(syncResult.rows.length, 3, 'Sync should store one Bing fact per date and query');
    assert.equal(syncResult.legacyRows.length, 2, 'Legacy Bing mirror should stay query-aggregated');

    const rangeResult = await listBingQueryStatsForRange(db, ownerId, siteUrl, '2026-07-01', '2026-07-08');
    const brand = rangeResult.rows.find((row) => row.Query === 'brand');
    assert.ok(brand, 'Range result should include the brand query');
    assert.equal(brand?.Impressions, 60, 'Range reads should sum impressions across dated facts');
    assert.equal(brand?.Clicks, 12, 'Range reads should sum clicks across dated facts');
    assert.ok(Math.abs((brand?.Ctr || 0) - 0.2) < 0.000001, 'Range reads should recompute CTR from summed clicks/impressions');
    assert.ok(Math.abs((brand?.AvgClickPosition || 0) - (52 / 12)) < 0.000001, 'Range reads should weight average click position by clicks');
    assert.ok(Math.abs((brand?.AvgImpressionPosition || 0) - (500 / 60)) < 0.000001, 'Range reads should weight average impression position by impressions');
    assert.equal(rangeResult.meta.availableStartDate, '2026-07-01', 'Range metadata should expose earliest matched fact date');
    assert.equal(rangeResult.meta.availableEndDate, '2026-07-08', 'Range metadata should expose latest matched fact date');
    assert.equal(rangeResult.meta.matchedDateCount, 2, 'Range metadata should count distinct matched report dates');
    assert.equal(rangeResult.meta.factRowCount, 3, 'Range metadata should count raw fact rows, not aggregated queries');
    assert.equal(rangeResult.meta.compatibilityBackfill.rowCount, 0, 'Reported Bing facts should not report compatibility rows');

    const compatibilityRange = await listBingQueryStatsForRange(db, ownerId, legacySiteUrl, '2026-07-13', '2026-07-13');
    assert.equal(compatibilityRange.meta.compatibilityBackfill.rowCount, 1, 'Compatibility metadata should expose backfilled legacy facts');
    assert.equal(compatibilityRange.meta.compatibilityBackfill.dateCount, 1, 'Compatibility metadata should expose affected dates');

    console.log('1 SQLite Bing fact/backfill check passed.');
  } finally {
    globalThis.fetch = originalFetch;
    await db.close();
  }
}

async function runPostgresCheck() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!databaseUrl) {
    console.log('2 PostgreSQL Bing fact check skipped (DATABASE_URL/POSTGRES_URL is unset).');
    return;
  }

  const db = await initializeDatabase();
  const ownerId = `bing-pg-check-${Date.now().toString(36)}`;
  const siteUrl = 'https://postgres.example/';
  const fetchedAt = '2026-07-11T00:00:00.000Z';

  try {
    await db.run('DELETE FROM bing_query_metrics WHERE ownerId = ?', [ownerId]);
    await db.run('DELETE FROM bing_query_stats WHERE ownerId = ?', [ownerId]);

    await db.run(
      `INSERT INTO bing_query_metrics
        (ownerId, siteUrl, date, query, impressions, clicks, ctr, avgClickPosition, avgImpressionPosition, fetchedAt, dateSource)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ownerId, siteUrl, '2026-07-01', 'brand', 10, 2, 0.2, 3, 6, fetchedAt, 'reported'],
    );
    await db.run(
      `INSERT INTO bing_query_metrics
        (ownerId, siteUrl, date, query, impressions, clicks, ctr, avgClickPosition, avgImpressionPosition, fetchedAt, dateSource)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ownerId, siteUrl, '2026-07-08', 'brand', 20, 4, 0.2, 4, 10, fetchedAt, 'reported'],
    );
    await db.run(
      `INSERT INTO bing_query_stats
        (ownerId, siteUrl, query, impressions, clicks, ctr, avgClickPosition, avgImpressionPosition, fetchedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ownerId, siteUrl, 'legacy-only', 5, 1, 0.2, 2, 4, fetchedAt],
    );

    await backfillLegacyBingQueryMetrics(db);
    await backfillLegacyBingQueryMetrics(db);

    const rangeResult = await listBingQueryStatsForRange(db, ownerId, siteUrl, '2026-07-01', '2026-07-11');
    const brand = rangeResult.rows.find((row) => row.Query === 'brand');
    const legacy = rangeResult.rows.find((row) => row.Query === 'legacy-only');
    assert.equal(brand?.Impressions, 30, 'PostgreSQL range reads should aggregate reported Bing facts');
    assert.equal(brand?.Clicks, 6, 'PostgreSQL range reads should aggregate click totals');
    assert.equal(legacy?.Impressions, 5, 'PostgreSQL backfill should expose compatibility-only legacy rows');
    assert.equal(rangeResult.meta.compatibilityBackfill.rowCount, 1, 'PostgreSQL metadata should expose compatibility rows');

    console.log('2 PostgreSQL Bing fact check passed.');
  } finally {
    await db.run('DELETE FROM bing_query_metrics WHERE ownerId = ?', [ownerId]).catch(() => undefined);
    await db.run('DELETE FROM bing_query_stats WHERE ownerId = ?', [ownerId]).catch(() => undefined);
    await db.close?.();
  }
}

await runSqliteCheck();
await runPostgresCheck();
