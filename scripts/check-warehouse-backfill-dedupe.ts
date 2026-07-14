import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import {
  queueWarehouseCoreRangeJob,
  queueWarehouseGa4DimensionBackfillJobs,
  queueWarehouseGa4PageRangeJob,
  queueWarehouseLlmBackfillJobs,
  recentStableWarehouseDates,
  startWarehouseJobWorker,
} from '../server/services/warehouseJobs.js';

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

type WarehouseJobRow = {
  id: string;
  jobType: string;
  metricsJson: string | null;
  status: string;
  targetDate: string;
  targetStartDate: string | null;
};

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const ownerId = 'owner-1';
const propertyId = 'properties/123';
const siteUrl = 'https://example.com/';
const dimensions = [
  'sessionSourceMedium',
  'country',
  'city',
  'region',
  'deviceCategory',
  'browser',
  'operatingSystem',
  'eventName',
];

process.env.GOOGLE_OAUTH_CLIENT_ID ||= 'test-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET ||= 'test-secret';

async function createMemoryDatabase() {
  const raw = new Database(':memory:');
  const db = new MemoryDatabase(raw);
  await db.exec(`
    CREATE TABLE warehouse_jobs (
      id TEXT PRIMARY KEY,
      ownerId TEXT,
      siteUrl TEXT,
      propertyId TEXT,
      jobType TEXT,
      status TEXT,
      targetStartDate TEXT,
      targetDate TEXT,
      priority INTEGER,
      attemptCount INTEGER,
      maxAttempts INTEGER,
      lockedAt TEXT,
      nextRunAt TEXT,
      startedAt TEXT,
      updatedAt TEXT,
      completedAt TEXT,
      lastError TEXT,
      rowsSynced INTEGER,
      metricsJson TEXT
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      tier TEXT,
      unlockedSites TEXT,
      knownSites TEXT,
      activatedSiteUrl TEXT,
      activatedGa4PropertyId TEXT,
      gscRefreshToken TEXT
    );
    CREATE TABLE workspace_ga4_mappings (
      ownerId TEXT,
      siteUrl TEXT,
      propertyId TEXT,
      displayName TEXT,
      updatedAt TEXT,
      PRIMARY KEY (ownerId, siteUrl)
    );
    CREATE TABLE warehouse_sync_status (
      ownerId TEXT,
      siteUrl TEXT,
      lastSyncDate TEXT,
      earliestSyncDate TEXT,
      status TEXT,
      lastUpdated TEXT,
      PRIMARY KEY (ownerId, siteUrl)
    );
    CREATE TABLE ga4_page_metrics (
      ownerId TEXT,
      propertyId TEXT,
      siteUrl TEXT,
      date TEXT,
      pagePath TEXT,
      pageKey TEXT,
      sessions REAL,
      totalUsers REAL,
      pageViews REAL,
      bounceRate REAL,
      eventCount REAL,
      PRIMARY KEY (ownerId, propertyId, siteUrl, date, pageKey)
    );
    CREATE TABLE ga4_dimension_metrics (
      ownerId TEXT,
      propertyId TEXT,
      siteUrl TEXT,
      date TEXT,
      dimension TEXT,
      dimensionValue TEXT,
      sessions REAL,
      totalUsers REAL,
      pageViews REAL,
      bounceRate REAL,
      eventCount REAL
    );
    CREATE TABLE ga4_llm_referral_metrics (
      ownerId TEXT,
      propertyId TEXT,
      siteUrl TEXT,
      date TEXT,
      source TEXT,
      sourceClass TEXT,
      pagePath TEXT,
      pageKey TEXT,
      sessions REAL,
      engagedSessions REAL,
      keyEvents REAL,
      averageSessionDuration REAL
    );
  `);
  return db;
}

async function seedAccessibleUser(db: AppDatabase) {
  await db.run(
    `INSERT INTO users (id, tier, unlockedSites, knownSites, activatedSiteUrl, activatedGa4PropertyId, gscRefreshToken)
     VALUES (?, 'pro', ?, ?, ?, ?, ?)`,
    [ownerId, JSON.stringify([siteUrl]), JSON.stringify([siteUrl]), siteUrl, propertyId, 'refresh-token'],
  );
}

function installFakeGoogleFetch(input: { date: string; failReport?: boolean }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = typeof request === 'string'
      ? request
      : request instanceof URL
        ? request.toString()
        : request.url;

    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'access-token' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    if (url.includes('analyticsdata.googleapis.com')) {
      if (input.failReport) {
        throw new Error('Synthetic analytics failure');
      }
      return new Response(JSON.stringify({
        rows: [
          {
            dimensionValues: [
              { value: input.date.replace(/-/g, '') },
              { value: '/landing' },
            ],
            metricValues: [
              { value: '5' },
              { value: '4' },
              { value: '7' },
              { value: '0.25' },
              { value: '11' },
            ],
          },
        ],
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function waitForJobStatus(db: AppDatabase, jobId: string, statuses: string[], timeoutMs = 5_000) {
  const startedAt = Date.now();
  let lastStatus = 'missing';
  let lastMetricsJson: string | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const job = await db.get<WarehouseJobRow>('SELECT id, jobType, metricsJson, status, targetStartDate, targetDate FROM warehouse_jobs WHERE id = ?', [jobId]);
    if (job) {
      lastStatus = job.status;
      lastMetricsJson = job.metricsJson;
      if (statuses.includes(job.status)) {
        return job;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for warehouse job ${jobId} to reach ${statuses.join(", ")}; last status=${lastStatus}; last metrics=${lastMetricsJson ?? "null"}`);
}

async function runBackfillDedupeChecks() {
  const db = await createMemoryDatabase();
  try {
    const [missingDate, activeDate, storedDate, olderStoredDate] = recentStableWarehouseDates(4);
    assert(missingDate && activeDate && storedDate && olderStoredDate, 'Expected four stable dates for fixture');

    for (const date of [storedDate, olderStoredDate]) {
      for (const dimension of dimensions) {
        await db.run(
          'INSERT INTO ga4_dimension_metrics (ownerId, propertyId, siteUrl, date, dimension, dimensionValue, sessions, totalUsers, pageViews, bounceRate, eventCount) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)',
          [ownerId, propertyId, siteUrl, date, dimension, 'sentinel'],
        );
      }
      await db.run(
        'INSERT INTO ga4_llm_referral_metrics (ownerId, propertyId, siteUrl, date, source, sourceClass, pagePath, pageKey, sessions, engagedSessions, keyEvents, averageSessionDuration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)',
        [ownerId, propertyId, siteUrl, date, '', '', '', ''],
      );
    }

    await db.run(
      `INSERT INTO warehouse_jobs (id, ownerId, siteUrl, propertyId, jobType, status, targetStartDate, targetDate, priority, attemptCount, maxAttempts, lockedAt, nextRunAt, startedAt, updatedAt, completedAt, lastError, rowsSynced, metricsJson)
       VALUES ('dim-active', ?, ?, ?, 'ga4-dimension-range-sync', 'running', ?, ?, 0, 0, 3, NULL, NULL, NULL, ?, NULL, NULL, 0, NULL)`,
      [ownerId, siteUrl, propertyId, activeDate, activeDate, new Date().toISOString()],
    );
    await db.run(
      `INSERT INTO warehouse_jobs (id, ownerId, siteUrl, propertyId, jobType, status, targetStartDate, targetDate, priority, attemptCount, maxAttempts, lockedAt, nextRunAt, startedAt, updatedAt, completedAt, lastError, rowsSynced, metricsJson)
       VALUES ('llm-active', ?, ?, ?, 'ga4-llm-range-sync', 'queued', ?, ?, 0, 0, 3, NULL, NULL, NULL, ?, NULL, NULL, 0, NULL)`,
      [ownerId, siteUrl, propertyId, activeDate, activeDate, new Date().toISOString()],
    );

    const dimensionJobs = await queueWarehouseGa4DimensionBackfillJobs(db, { days: 4, ownerId, propertyId, siteUrl });
    const llmJobs = await queueWarehouseLlmBackfillJobs(db, { days: 4, ownerId, propertyId, siteUrl });

    assert(dimensionJobs.length === 1, `Expected one GA4 dimension job, got ${dimensionJobs.length}`);
    assert(llmJobs.length === 1, `Expected one LLM job, got ${llmJobs.length}`);
    assert(dimensionJobs[0]?.targetStartDate === missingDate && dimensionJobs[0]?.targetDate === missingDate, 'Dimension job should cover only the missing date');
    assert(llmJobs[0]?.targetStartDate === missingDate && llmJobs[0]?.targetDate === missingDate, 'LLM job should cover only the missing date');

    return { activeDate, missingDate };
  } finally {
    await db.close();
  }
}

async function runGa4PageCompatibilityChecks() {
  const [targetDate] = recentStableWarehouseDates(1);
  assert(targetDate, 'Expected at least one stable warehouse date');

  const coveredByCoreDb = await createMemoryDatabase();
  try {
    const coreJob = await queueWarehouseCoreRangeJob(coveredByCoreDb, {
      endDate: targetDate,
      ownerId,
      propertyId,
      siteUrl,
      startDate: targetDate,
    });
    assert(coreJob, 'Expected covering core job to be queued');

    const reusedJob = await queueWarehouseGa4PageRangeJob(coveredByCoreDb, {
      endDate: targetDate,
      ownerId,
      propertyId,
      siteUrl,
      startDate: targetDate,
    });
    assert(reusedJob?.id === coreJob.id, 'GA4 page range job should reuse a covering core job');
    assert(reusedJob?.jobType === 'core-range-sync', 'GA4 page range dedupe should resolve to the covering core job');
  } finally {
    await coveredByCoreDb.close();
  }

  const coreStillQueuesDb = await createMemoryDatabase();
  try {
    const pageJob = await queueWarehouseGa4PageRangeJob(coreStillQueuesDb, {
      endDate: targetDate,
      ownerId,
      propertyId,
      siteUrl,
      startDate: targetDate,
    });
    assert(pageJob, 'Expected GA4 page range job to be queued');

    const coreJob = await queueWarehouseCoreRangeJob(coreStillQueuesDb, {
      endDate: targetDate,
      ownerId,
      propertyId,
      siteUrl,
      startDate: targetDate,
    });
    assert(coreJob, 'Expected core range job to still queue');
    assert(coreJob.id !== pageJob.id, 'Core range job must not be deduped away by a GA4 page range job');
    assert(coreJob.jobType === 'core-range-sync', 'Expected queued job to remain a core range sync');
  } finally {
    await coreStillQueuesDb.close();
  }

  return { targetDate };
}

async function runGa4PageExecutionChecks() {
  const [targetDate] = recentStableWarehouseDates(1);
  assert(targetDate, 'Expected at least one stable warehouse date');

  const successDb = await createMemoryDatabase();
  await seedAccessibleUser(successDb);
  const restoreSuccessFetch = installFakeGoogleFetch({ date: targetDate });
  const successJob = await queueWarehouseGa4PageRangeJob(successDb, {
    endDate: targetDate,
    ownerId,
    propertyId,
    siteUrl,
    startDate: targetDate,
  });
  assert(successJob, 'Expected successful GA4 page range job to be queued');
  const stopSuccessWorker = startWarehouseJobWorker(successDb);
  try {
    const completedJob = await waitForJobStatus(successDb, successJob.id, ['completed', 'error']);
    assert(completedJob.status === 'completed', `Expected GA4 page range job to complete, got ${completedJob.status}`);
    const metrics = JSON.parse(completedJob.metricsJson || '{}') as Record<string, unknown>;
    assert(metrics.source === 'ga4-pages', 'Completed GA4 page range job should report ga4-pages source');
    assert(metrics.jobType === 'ga4-page-range-sync', 'Completed GA4 page range job should report its job type');
    assert(metrics.rowsSynced === 1, `Expected one synced GA4 page row, got ${String(metrics.rowsSynced)}`);
    assert(metrics.propertyIncluded === true, 'Completed GA4 page range job should report propertyIncluded=true');

    const syncStatusCount = await successDb.get<{ count: number }>('SELECT COUNT(*) AS count FROM warehouse_sync_status');
    assert(Number(syncStatusCount?.count || 0) === 0, 'GA4 page range job must not mutate warehouse_sync_status');

    const storedRow = await successDb.get<{ pagePath: string; sessions: number }>(
      'SELECT pagePath, sessions FROM ga4_page_metrics WHERE ownerId = ? AND propertyId = ? AND siteUrl = ? AND date = ?',
      [ownerId, propertyId, siteUrl, targetDate],
    );
    assert(storedRow?.pagePath === '/landing', 'Expected GA4 page sync to store the fetched page path');
    assert(Number(storedRow?.sessions || 0) === 5, 'Expected GA4 page sync to store the fetched sessions count');
  } finally {
    stopSuccessWorker();
    restoreSuccessFetch();
    await successDb.close();
  }

  const errorDb = await createMemoryDatabase();
  await seedAccessibleUser(errorDb);
  const restoreErrorFetch = installFakeGoogleFetch({ date: targetDate, failReport: true });
  const errorJob = await queueWarehouseGa4PageRangeJob(errorDb, {
    endDate: targetDate,
    ownerId,
    propertyId,
    siteUrl,
    startDate: targetDate,
  });
  assert(errorJob, 'Expected failing GA4 page range job to be queued');
  await errorDb.run('UPDATE warehouse_jobs SET maxAttempts = 1 WHERE id = ?', [errorJob.id]);
  const stopErrorWorker = startWarehouseJobWorker(errorDb);
  try {
    const failedJob = await waitForJobStatus(errorDb, errorJob.id, ['error', 'completed']);
    assert(failedJob.status === 'error', `Expected GA4 page range job to fail hard, got ${failedJob.status}`);
    const metrics = JSON.parse(failedJob.metricsJson || '{}') as Record<string, unknown>;
    assert(metrics.failedSource === 'ga4-pages', 'Failed GA4 page range job should report ga4-pages as the failed source');
    assert(metrics.jobType === 'ga4-page-range-sync', 'Failed GA4 page range job should report its job type');

    const syncStatusCount = await errorDb.get<{ count: number }>('SELECT COUNT(*) AS count FROM warehouse_sync_status');
    assert(Number(syncStatusCount?.count || 0) === 0, 'Failed GA4 page range job must not mutate warehouse_sync_status');
  } finally {
    stopErrorWorker();
    restoreErrorFetch();
    await errorDb.close();
  }

  return { targetDate };
}

const backfill = await runBackfillDedupeChecks();
const compatibility = await runGa4PageCompatibilityChecks();
const execution = await runGa4PageExecutionChecks();

console.log(JSON.stringify({
  backfill,
  compatibility,
  execution,
  ok: true,
}, null, 2));
