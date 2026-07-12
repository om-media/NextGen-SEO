import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';

process.env.WAREHOUSE_INITIAL_BACKFILL_DAYS = '14';
process.env.WAREHOUSE_CORE_RANGE_JOB_DAYS = '7';
process.env.WAREHOUSE_GA4_DIMENSION_RANGE_JOB_DAYS = '14';
process.env.WAREHOUSE_LLM_RANGE_JOB_DAYS = '14';

const { recentStableWarehouseDates, runWarehouseDailySchedulerTick } = await import('../server/services/warehouseJobs.js');

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
await db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    tier TEXT,
    activatedSiteUrl TEXT,
    activatedGa4PropertyId TEXT,
    knownSites TEXT,
    unlockedSites TEXT,
    gscRefreshToken TEXT,
    bingApiKey TEXT
  );
  CREATE TABLE workspace_ga4_mappings (
    ownerId TEXT NOT NULL,
    siteUrl TEXT NOT NULL,
    propertyId TEXT NOT NULL,
    displayName TEXT,
    updatedAt TEXT,
    PRIMARY KEY (ownerId, siteUrl)
  );
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
    metricsJson TEXT,
    rowsSynced INTEGER
  );
  CREATE TABLE gsc_site_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL);
  CREATE TABLE gsc_query_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, query TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL);
  CREATE TABLE gsc_page_query_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, page TEXT, pageKey TEXT, query TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL);
  CREATE TABLE gsc_page_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, page TEXT, pageKey TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL, queryCount INTEGER);
  CREATE TABLE gsc_country_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, country TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL);
  CREATE TABLE ga4_page_metrics (ownerId TEXT, propertyId TEXT, siteUrl TEXT, date TEXT, pagePath TEXT, pageKey TEXT, sessions REAL, totalUsers REAL, pageViews REAL, bounceRate REAL, eventCount REAL);
  CREATE TABLE ga4_dimension_metrics (ownerId TEXT, propertyId TEXT, siteUrl TEXT, date TEXT, dimension TEXT, dimensionValue TEXT, sessions REAL, totalUsers REAL, screenPageViews REAL, bounceRate REAL, eventCount REAL);
  CREATE TABLE ga4_llm_referral_metrics (ownerId TEXT, propertyId TEXT, siteUrl TEXT, date TEXT, source TEXT, sourceClass TEXT, pagePath TEXT, pageKey TEXT, sessions REAL, engagedSessions REAL, keyEvents REAL, averageSessionDuration REAL);
`);

const ownerId = 'owner-1';
const siteUrl = 'https://scheduler.example/';
const propertyId = 'properties/123';
await db.run(
  'INSERT INTO users (id, tier, activatedSiteUrl, activatedGa4PropertyId, knownSites, unlockedSites, gscRefreshToken, bingApiKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  [ownerId, 'pro', siteUrl, propertyId, JSON.stringify([]), JSON.stringify([siteUrl]), 'refresh-token', null],
);

const stableDates = recentStableWarehouseDates(14);
assert(stableDates.length === 14, 'Expected 14 stable dates');
const targetDate = stableDates[0];

await runWarehouseDailySchedulerTick(db);
const firstPassJobs = await db.all<{ jobType: string; propertyId: string | null; siteUrl: string; status: string; targetStartDate: string | null; targetDate: string }>(
  'SELECT jobType, propertyId, siteUrl, status, targetStartDate, targetDate FROM warehouse_jobs ORDER BY jobType, targetStartDate, targetDate',
);
await runWarehouseDailySchedulerTick(db);
const secondPassJobs = await db.all<{ jobType: string; propertyId: string | null; siteUrl: string; status: string; targetStartDate: string | null; targetDate: string }>(
  'SELECT jobType, propertyId, siteUrl, status, targetStartDate, targetDate FROM warehouse_jobs ORDER BY jobType, targetStartDate, targetDate',
);

const firstPassSummary = firstPassJobs.map((job) => ({
  ...job,
  range: `${job.targetStartDate || job.targetDate}..${job.targetDate}`,
}));
const secondPassSummary = secondPassJobs.map((job) => ({
  ...job,
  range: `${job.targetStartDate || job.targetDate}..${job.targetDate}`,
}));

const coreJobs = firstPassJobs.filter((job) => job.jobType === 'core-range-sync');
const dimJobs = firstPassJobs.filter((job) => job.jobType === 'ga4-dimension-range-sync');
const llmJobs = firstPassJobs.filter((job) => job.jobType === 'ga4-llm-range-sync');
const dailyJobs = firstPassJobs.filter((job) => job.jobType === 'daily-sync');

assert(coreJobs.length === 2, `Expected 2 core range jobs for 14-day backfill, got ${coreJobs.length}`);
assert(dimJobs.length === 1, `Expected 1 GA4 dimension range job, got ${dimJobs.length}`);
assert(llmJobs.length === 1, `Expected 1 GA4 LLM range job, got ${llmJobs.length}`);
assert(dailyJobs.length === 0, `Expected 0 daily-sync jobs because overlapping core ranges should dedupe them, got ${dailyJobs.length}`);
assert(dimJobs[0]?.targetStartDate !== targetDate, 'Dimension scheduler follow-up should reuse the backfill range instead of queueing a one-day duplicate');
assert(llmJobs[0]?.targetStartDate !== targetDate, 'LLM scheduler follow-up should reuse the backfill range instead of queueing a one-day duplicate');
assert(JSON.stringify(firstPassSummary) === JSON.stringify(secondPassSummary), 'Second scheduler tick should not add duplicate warehouse jobs');

console.log(JSON.stringify({
  ok: true,
  targetDate,
  firstPassSummary,
  secondPassJobCount: secondPassJobs.length,
}, null, 2));

await db.close();
