import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import {
  queueWarehouseGa4DimensionBackfillJobs,
  queueWarehouseLlmBackfillJobs,
  recentStableWarehouseDates,
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
    rowsSynced INTEGER
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
    screenPageViews REAL,
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

const [missingDate, activeDate, storedDate, olderStoredDate] = recentStableWarehouseDates(4);
assert(missingDate && activeDate && storedDate && olderStoredDate, 'Expected four stable dates for fixture');

for (const date of [storedDate, olderStoredDate]) {
  for (const dimension of dimensions) {
    await db.run(
      'INSERT INTO ga4_dimension_metrics (ownerId, propertyId, siteUrl, date, dimension, dimensionValue, sessions, totalUsers, screenPageViews, bounceRate, eventCount) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)',
      [ownerId, propertyId, siteUrl, date, dimension, 'sentinel'],
    );
  }
  await db.run(
    'INSERT INTO ga4_llm_referral_metrics (ownerId, propertyId, siteUrl, date, source, sourceClass, pagePath, pageKey, sessions, engagedSessions, keyEvents, averageSessionDuration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)',
    [ownerId, propertyId, siteUrl, date, '', '', '', ''],
  );
}

await db.run(
  `INSERT INTO warehouse_jobs (id, ownerId, siteUrl, propertyId, jobType, status, targetStartDate, targetDate, priority, attemptCount, maxAttempts, lockedAt, nextRunAt, startedAt, updatedAt, completedAt, lastError, rowsSynced)
   VALUES ('dim-active', ?, ?, ?, 'ga4-dimension-range-sync', 'running', ?, ?, 0, 0, 3, NULL, NULL, NULL, ?, NULL, NULL, 0)`,
  [ownerId, siteUrl, propertyId, activeDate, activeDate, new Date().toISOString()],
);
await db.run(
  `INSERT INTO warehouse_jobs (id, ownerId, siteUrl, propertyId, jobType, status, targetStartDate, targetDate, priority, attemptCount, maxAttempts, lockedAt, nextRunAt, startedAt, updatedAt, completedAt, lastError, rowsSynced)
   VALUES ('llm-active', ?, ?, ?, 'ga4-llm-range-sync', 'queued', ?, ?, 0, 0, 3, NULL, NULL, NULL, ?, NULL, NULL, 0)`,
  [ownerId, siteUrl, propertyId, activeDate, activeDate, new Date().toISOString()],
);

const dimensionJobs = await queueWarehouseGa4DimensionBackfillJobs(db, { days: 4, ownerId, propertyId, siteUrl });
const llmJobs = await queueWarehouseLlmBackfillJobs(db, { days: 4, ownerId, propertyId, siteUrl });

assert(dimensionJobs.length === 1, `Expected one GA4 dimension job, got ${dimensionJobs.length}`);
assert(llmJobs.length === 1, `Expected one LLM job, got ${llmJobs.length}`);
assert(dimensionJobs[0]?.targetStartDate === missingDate && dimensionJobs[0]?.targetDate === missingDate, 'Dimension job should cover only the missing date');
assert(llmJobs[0]?.targetStartDate === missingDate && llmJobs[0]?.targetDate === missingDate, 'LLM job should cover only the missing date');

const jobs = await db.all<{ jobType: string; status: string; targetDate: string; targetStartDate: string | null }>(
  'SELECT jobType, status, targetStartDate, targetDate FROM warehouse_jobs ORDER BY jobType, id',
);
console.log(JSON.stringify({ ok: true, missingDate, activeDate, storedDates: [storedDate, olderStoredDate], jobs }, null, 2));
await db.close();