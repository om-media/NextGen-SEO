import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import {
  GSC_COVERAGE_PROPERTY_ID,
  GSC_COVERAGE_DATASETS,
  markGscDatasetCoverageError,
  persistGscRangeCoverage,
} from '../server/services/warehouseJobs.js';
import { gscCoverageFromLedger } from '../server/routes/warehouse.js';

type CoverageRow = {
  dataset: string;
  date: string;
  lastError: string | null;
  rowCount: number;
  status: 'complete' | 'error' | 'partial' | 'zero';
  truncated: number;
};

function createMemoryDb(): AppDatabase {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE warehouse_dataset_coverage (
      ownerId TEXT NOT NULL,
      propertyId TEXT NOT NULL,
      siteUrl TEXT NOT NULL,
      date TEXT NOT NULL,
      dataset TEXT NOT NULL,
      status TEXT NOT NULL,
      rowCount INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      jobId TEXT,
      lastError TEXT,
      completedAt TEXT,
      updatedAt TEXT,
      PRIMARY KEY (ownerId, propertyId, siteUrl, date, dataset)
    );
    CREATE TABLE gsc_site_metrics (
      ownerId TEXT,
      siteUrl TEXT,
      date TEXT,
      clicks INTEGER,
      impressions INTEGER,
      ctr REAL,
      position REAL,
      queryCount INTEGER
    );
    CREATE TABLE gsc_query_metrics (
      ownerId TEXT,
      siteUrl TEXT,
      date TEXT,
      query TEXT,
      clicks INTEGER,
      impressions INTEGER,
      ctr REAL,
      position REAL
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
      position REAL
    );
    CREATE TABLE gsc_country_metrics (
      ownerId TEXT,
      siteUrl TEXT,
      date TEXT,
      country TEXT,
      clicks INTEGER,
      impressions INTEGER,
      ctr REAL,
      position REAL
    );
  `);

  const normalizeParams = (params?: QueryParams) => {
    if (!params) return [];
    return Array.isArray(params) ? params : params;
  };

  return {
    dialect: 'sqlite',
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: async (sql: string) => {
      sqlite.exec(sql);
    },
    get: async <T = unknown>(sql: string, params?: QueryParams) => sqlite.prepare(sql).get(normalizeParams(params)) as T | undefined,
    all: async <T = unknown>(sql: string, params?: QueryParams) => sqlite.prepare(sql).all(normalizeParams(params)) as T[],
    run: async (sql: string, params?: QueryParams): Promise<RunResult> => {
      const result = sqlite.prepare(sql).run(normalizeParams(params));
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    transaction: <Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) => {
      const wrapped = sqlite.transaction((...args: Args) => callback(...args));
      return async (...args: Args) => wrapped(...args);
    },
    close: async () => {
      sqlite.close();
    },
  };
}

async function main() {
  const db = createMemoryDb();
  const ownerId = 'owner-1';
  const siteUrl = 'sc-domain:example.com';
  const job = {
    id: 'job-complete',
    ownerId,
    siteUrl,
  };

  await persistGscRangeCoverage(db, {
    endDate: '2026-01-02',
    job,
    rangeCoverage: {
      'gsc-country': { rowCountsByDate: new Map([['2026-01-01', 2], ['2026-01-02', 1]]), truncated: false },
      'gsc-page-query': { rowCountsByDate: new Map([['2026-01-01', 5], ['2026-01-02', 4]]), truncated: false },
      'gsc-query': { rowCountsByDate: new Map([['2026-01-01', 3], ['2026-01-02', 2]]), truncated: false },
      'gsc-site': { rowCountsByDate: new Map([['2026-01-01', 1], ['2026-01-02', 1]]), truncated: false },
    },
    startDate: '2026-01-01',
  });

  await persistGscRangeCoverage(db, {
    endDate: '2026-01-03',
    job: { ...job, id: 'job-zero' },
    rangeCoverage: {
      'gsc-country': { rowCountsByDate: new Map(), truncated: false },
      'gsc-page-query': { rowCountsByDate: new Map(), truncated: false },
      'gsc-query': { rowCountsByDate: new Map(), truncated: false },
      'gsc-site': { rowCountsByDate: new Map(), truncated: false },
    },
    startDate: '2026-01-03',
  });

  await persistGscRangeCoverage(db, {
    endDate: '2026-01-05',
    job: { ...job, id: 'job-partial' },
    rangeCoverage: {
      'gsc-country': { rowCountsByDate: new Map([['2026-01-04', 1], ['2026-01-05', 1]]), truncated: false },
      'gsc-page-query': { rowCountsByDate: new Map([['2026-01-04', 100], ['2026-01-05', 120]]), truncated: true },
      'gsc-query': { rowCountsByDate: new Map([['2026-01-04', 50], ['2026-01-05', 60]]), truncated: true },
      'gsc-site': { rowCountsByDate: new Map([['2026-01-04', 1], ['2026-01-05', 1]]), truncated: false },
    },
    startDate: '2026-01-04',
  });

  let coverageRows = await db.all<CoverageRow>(
    `SELECT dataset, date, lastError, rowCount, status, truncated
     FROM warehouse_dataset_coverage
     WHERE ownerId = ? AND propertyId = ? AND siteUrl = ?
     ORDER BY date ASC, dataset ASC`,
    [ownerId, GSC_COVERAGE_PROPERTY_ID, siteUrl],
  );

  assert.equal(coverageRows.filter((row) => row.date === '2026-01-01' && row.status === 'complete').length, GSC_COVERAGE_DATASETS.length);
  assert.equal(coverageRows.filter((row) => row.date === '2026-01-03' && row.status === 'zero').length, GSC_COVERAGE_DATASETS.length);
  assert.equal(coverageRows.filter((row) => row.date === '2026-01-04' && row.dataset === 'gsc-page-query')[0]?.status, 'partial');
  assert.equal(coverageRows.filter((row) => row.date === '2026-01-05' && row.dataset === 'gsc-query')[0]?.truncated, 1);

  await markGscDatasetCoverageError(db, {
    id: 'job-error',
    ownerId,
    siteUrl,
    targetDate: '2026-01-06',
    targetStartDate: '2026-01-01',
  }, new Error('simulated gsc failure'));

  coverageRows = await db.all<CoverageRow>(
    `SELECT dataset, date, lastError, rowCount, status, truncated
     FROM warehouse_dataset_coverage
     WHERE ownerId = ? AND propertyId = ? AND siteUrl = ?
     ORDER BY date ASC, dataset ASC`,
    [ownerId, GSC_COVERAGE_PROPERTY_ID, siteUrl],
  );

  assert.equal(coverageRows.find((row) => row.date === '2026-01-01' && row.dataset === 'gsc-site')?.status, 'complete');
  assert.equal(coverageRows.find((row) => row.date === '2026-01-01' && row.dataset === 'gsc-site')?.lastError, null);
  assert.equal(coverageRows.find((row) => row.date === '2026-01-03' && row.dataset === 'gsc-page-query')?.status, 'zero');
  assert.equal(coverageRows.find((row) => row.date === '2026-01-04' && row.dataset === 'gsc-page-query')?.status, 'partial');
  assert.equal(coverageRows.find((row) => row.date === '2026-01-06' && row.dataset === 'gsc-site')?.status, 'error');
  assert.equal(coverageRows.find((row) => row.date === '2026-01-06' && row.dataset === 'gsc-site')?.lastError, 'simulated gsc failure');

  await db.run(
    'INSERT INTO gsc_query_metrics (ownerId, siteUrl, date, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [ownerId, siteUrl, '2026-02-01', '', 0, 0, 0, 0],
  );
  await db.run(
    'INSERT INTO gsc_query_metrics (ownerId, siteUrl, date, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [ownerId, siteUrl, '2026-02-01', 'real query', 10, 100, 0.1, 3],
  );
  await db.run(
    'INSERT INTO gsc_query_metrics (ownerId, siteUrl, date, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [ownerId, siteUrl, '2026-02-02', '', 0, 0, 0, 0],
  );
  await db.run(
    'INSERT INTO gsc_page_query_metrics (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ownerId, siteUrl, '2026-02-01', '', '', '', 0, 0, 0, 0],
  );
  await db.run(
    'INSERT INTO gsc_page_query_metrics (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ownerId, siteUrl, '2026-02-01', 'https://example.com/page', '/page', 'real query', 5, 50, 0.1, 2],
  );

  const queryFallbackRows = await db.all<{ date: string; rowCount: number }>(
    `SELECT date, SUM(CASE WHEN query <> '' THEN 1 ELSE 0 END) AS rowCount
     FROM gsc_query_metrics
     WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
     GROUP BY date
     ORDER BY date ASC`,
    [ownerId, siteUrl, '2026-02-01', '2026-02-02'],
  );
  const pageFallbackTotals = await db.get<{ total: number }>(
    `SELECT COUNT(*) AS total
     FROM (
       SELECT COALESCE(NULLIF(pageKey, ''), page) AS pageKey
       FROM gsc_page_query_metrics
       WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
         AND COALESCE(NULLIF(pageKey, ''), page) <> ''
       GROUP BY COALESCE(NULLIF(pageKey, ''), page)
     ) pages`,
    [ownerId, siteUrl, '2026-02-01', '2026-02-01'],
  );

  assert.deepEqual(queryFallbackRows, [
    { date: '2026-02-01', rowCount: 1 },
    { date: '2026-02-02', rowCount: 0 },
  ]);
  assert.equal(pageFallbackTotals?.total, 1);

  const zeroCoverage = gscCoverageFromLedger(
    ['2026-01-03'],
    coverageRows,
    'gsc-query',
    [],
  );
  assert.equal(zeroCoverage.zeroDateCount, 1);
  assert.equal(zeroCoverage.coveredDateCount, 1);

  const partialCoverage = gscCoverageFromLedger(
    ['2026-01-04', '2026-01-05'],
    coverageRows,
    'gsc-page-query',
    [],
  );
  assert.equal(partialCoverage.partialDateCount, 2);
  assert.deepEqual(partialCoverage.truncatedDates, ['2026-01-04', '2026-01-05']);
  assert.equal(partialCoverage.completeDateCount, 0);

  const filteredFallbackCoverage = gscCoverageFromLedger(
    ['2026-02-01', '2026-02-02'],
    [],
    'gsc-query',
    queryFallbackRows,
  );
  assert.equal(filteredFallbackCoverage.coveredDateCount, 1);
  assert.deepEqual(filteredFallbackCoverage.missingDates, ['2026-02-02']);

  await db.close?.();
  console.log('gsc completeness contract: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
