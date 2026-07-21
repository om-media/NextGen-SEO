import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';

process.env.WAREHOUSE_CORE_RANGE_JOB_DAYS = '7';
process.env.WAREHOUSE_GA4_DIMENSION_RANGE_JOB_DAYS = '14';
process.env.WAREHOUSE_LLM_RANGE_JOB_DAYS = '14';

const { registerWarehouseRoutes } = await import('../server/routes/warehouse.js');

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

class FakeApp {
  routes = new Map<string, Function[]>();

  get(path: string, ...handlers: Function[]) {
    this.routes.set(`GET:${path}`, handlers);
  }

  post(path: string, ...handlers: Function[]) {
    this.routes.set(`POST:${path}`, handlers);
  }

  put(path: string, ...handlers: Function[]) {
    this.routes.set(`PUT:${path}`, handlers);
  }

  delete(path: string, ...handlers: Function[]) {
    this.routes.set(`DELETE:${path}`, handlers);
  }
}

class FakeResponse {
  statusCode = 200;
  body: unknown = null;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown) {
    this.body = payload;
    return this;
  }

  type(_value: string) {
    return this;
  }

  send(payload: unknown) {
    this.body = payload;
    return this;
  }
}

type WarehouseJobRow = {
  jobType: string;
  targetDate: string;
  targetStartDate: string | null;
};

const addIsoDays = (isoDate: string, days: number) => {
  const value = new Date(`${isoDate}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const latestStableReportingDate = () => {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() - 2);
  return value.toISOString().slice(0, 10);
};

async function installSchema(db: AppDatabase) {
  await db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      tier TEXT,
      unlockedSites TEXT,
      knownSites TEXT,
      activatedSiteUrl TEXT,
      activatedGa4PropertyId TEXT,
      gscRefreshToken TEXT,
      bingApiKey TEXT
    );

    CREATE TABLE workspace_ga4_mappings (
      ownerId TEXT NOT NULL,
      siteUrl TEXT NOT NULL,
      propertyId TEXT NOT NULL,
      displayName TEXT,
      propertyCreatedAt TEXT,
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
      rowsSynced INTEGER,
      metricsJson TEXT
    );

    CREATE TABLE gsc_site_metrics (ownerId TEXT, siteUrl TEXT, date TEXT);
    CREATE TABLE gsc_query_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, query TEXT);
    CREATE TABLE gsc_page_query_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, page TEXT, pageKey TEXT, query TEXT);
    CREATE TABLE gsc_country_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, country TEXT);
    CREATE TABLE ga4_page_metrics (ownerId TEXT, propertyId TEXT, siteUrl TEXT, date TEXT, pageKey TEXT, pagePath TEXT, sessions REAL, totalUsers REAL, pageViews REAL, bounceRate REAL, eventCount REAL);
    CREATE TABLE ga4_dimension_metrics (ownerId TEXT, propertyId TEXT, siteUrl TEXT, date TEXT, dimension TEXT, dimensionValue TEXT, sessions REAL, totalUsers REAL, pageViews REAL, bounceRate REAL, eventCount REAL);
    CREATE TABLE ga4_llm_referral_metrics (ownerId TEXT, propertyId TEXT, siteUrl TEXT, date TEXT, source TEXT, sourceClass TEXT, pageKey TEXT, pagePath TEXT, sessions REAL, engagedSessions REAL, keyEvents REAL, averageSessionDuration REAL);
    CREATE TABLE warehouse_dataset_coverage (ownerId TEXT, propertyId TEXT, siteUrl TEXT, date TEXT, dataset TEXT, status TEXT, rowCount INTEGER, truncated INTEGER, jobId TEXT, lastError TEXT, completedAt TEXT, updatedAt TEXT, PRIMARY KEY (ownerId, propertyId, siteUrl, date, dataset));
    CREATE TABLE crawl_jobs (id TEXT PRIMARY KEY, ownerId TEXT, siteUrl TEXT, status TEXT, startedAt TEXT, completedAt TEXT, updatedAt TEXT);
    CREATE TABLE crawl_pages (ownerId TEXT, siteUrl TEXT, jobId TEXT, statusCode INTEGER, noindex INTEGER);
    CREATE TABLE bing_query_stats (ownerId TEXT, siteUrl TEXT, fetchedAt TEXT);
  `);
}

async function seedWorkspace(db: AppDatabase, input: { ownerId: string; propertyId: string; propertyStartDate: string; siteUrl: string }) {
  await db.run(
    `INSERT INTO users (id, tier, unlockedSites, knownSites, activatedSiteUrl, activatedGa4PropertyId, gscRefreshToken, bingApiKey)
     VALUES (?, 'pro', ?, ?, ?, ?, ?, NULL)`,
    [
      input.ownerId,
      JSON.stringify([input.siteUrl]),
      JSON.stringify([input.siteUrl]),
      input.siteUrl,
      input.propertyId,
      'refresh-token',
    ],
  );
  await db.run(
    `INSERT INTO workspace_ga4_mappings (ownerId, siteUrl, propertyId, propertyCreatedAt, updatedAt)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.ownerId,
      input.siteUrl,
      input.propertyId,
      `${input.propertyStartDate}T00:00:00Z`,
      new Date().toISOString(),
    ],
  );
}

function getHandler(app: FakeApp, key: string) {
  const handler = app.routes.get(key)?.at(-1);
  assert.ok(handler, `Missing route handler for ${key}`);
  return handler as Function;
}

async function invoke(handler: Function, req: any) {
  const res = new FakeResponse();
  await handler(req, res);
  assert.equal(res.statusCode, 200, `${req.method || 'route'} returned ${res.statusCode}`);
  return res.body as any;
}

async function readJobs(db: AppDatabase, ownerId: string, siteUrl: string) {
  return db.all<WarehouseJobRow>(
    `SELECT jobType, targetStartDate, targetDate
     FROM warehouse_jobs
     WHERE ownerId = ? AND siteUrl = ?
     ORDER BY jobType, targetStartDate, targetDate`,
    [ownerId, siteUrl],
  );
}

async function clearJobs(db: AppDatabase, ownerId: string, siteUrl: string) {
  await db.run('DELETE FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]);
}

function assertGa4JobsBounded(jobs: WarehouseJobRow[], propertyStartDate: string) {
  const ga4Jobs = jobs.filter((job) => job.jobType.startsWith('ga4-'));
  assert.ok(ga4Jobs.length > 0, 'Expected GA4 jobs to be queued');
  for (const job of ga4Jobs) {
    assert.equal(job.targetStartDate, propertyStartDate, `GA4 job ${job.jobType} must start at property creation`);
  }
}

const ownerId = 'user-1';
const siteUrl = 'https://example.com/';
const propertyId = 'properties/123';
const latestStableDate = latestStableReportingDate();
const propertyStartDate = addIsoDays(latestStableDate, -2);
const spanningStartDate = addIsoDays(propertyStartDate, -2);
const spanningEndDate = latestStableDate;
const beforeStartDate = addIsoDays(propertyStartDate, -5);
const beforeEndDate = addIsoDays(propertyStartDate, -1);

const raw = new Database(':memory:');
const db = new MemoryDatabase(raw);
await installSchema(db);
await seedWorkspace(db, { ownerId, propertyId, propertyStartDate, siteUrl });

const app = new FakeApp();
registerWarehouseRoutes(app as any, db);

const ga4ReportHandler = getHandler(app, 'POST:/api/warehouse/ga4/report');
const ga4LlmReportHandler = getHandler(app, 'POST:/api/warehouse/ga4/llm/report');
const coverageHandler = getHandler(app, 'GET:/api/warehouse/coverage');
const missingJobsHandler = getHandler(app, 'POST:/api/warehouse/jobs/missing');

const pageReport = await invoke(ga4ReportHandler, {
  authUser: { uid: ownerId },
  body: {
    autoQueue: true,
    dimensions: ['date'],
    endDate: spanningEndDate,
    metrics: ['sessions'],
    propertyId,
    siteUrl,
    startDate: spanningStartDate,
  },
  method: 'POST:/api/warehouse/ga4/report',
});
assert.equal(pageReport.metadata.coverage.expectedDateCount, 3, 'GA4 page coverage should start at property creation');
assert.equal(pageReport.metadata.coverage.missingDateCount, 3, 'GA4 page coverage should only mark post-creation dates missing');
assert.equal(pageReport.metadata.coverage.queuedDateCount, 3, 'GA4 page auto-queue should only cover post-creation dates');
assert.equal(pageReport.metadata.coverage.skippedUnavailableDates, 2, 'GA4 page coverage should mark pre-creation dates unavailable');
assertGa4JobsBounded(await readJobs(db, ownerId, siteUrl), propertyStartDate);
await clearJobs(db, ownerId, siteUrl);

const dimensionReport = await invoke(ga4ReportHandler, {
  authUser: { uid: ownerId },
  body: {
    autoQueue: true,
    dimensionFilter: { filter: { fieldName: 'country', stringFilter: { value: 'US' } } },
    dimensions: ['date'],
    endDate: spanningEndDate,
    metrics: ['sessions'],
    propertyId,
    siteUrl,
    startDate: spanningStartDate,
  },
  method: 'POST:/api/warehouse/ga4/report',
});
assert.equal(dimensionReport.metadata.coverage.expectedDateCount, 3, 'GA4 dimension coverage should start at property creation');
assert.equal(dimensionReport.metadata.coverage.queuedDateCount, 3, 'GA4 dimension auto-queue should only cover post-creation dates');
assert.equal(dimensionReport.metadata.coverage.skippedUnavailableDates, 2, 'GA4 dimension coverage should mark pre-creation dates unavailable');
assert.deepEqual((await readJobs(db, ownerId, siteUrl)).map((job) => job.jobType), ['ga4-dimension-range-sync'], 'Only GA4 dimension jobs should be queued for the dimension coverage request');
await clearJobs(db, ownerId, siteUrl);

const llmReport = await invoke(ga4LlmReportHandler, {
  authUser: { uid: ownerId },
  body: {
    autoQueue: true,
    endDate: spanningEndDate,
    propertyId,
    siteUrl,
    startDate: spanningStartDate,
  },
  method: 'POST:/api/warehouse/ga4/llm/report',
});
assert.equal(llmReport.coverage.expectedDateCount, 3, 'GA4 LLM coverage should start at property creation');
assert.equal(llmReport.coverage.queuedDateCount, 3, 'GA4 LLM auto-queue should only cover post-creation dates');
assert.equal(llmReport.coverage.skippedUnavailableDates, 2, 'GA4 LLM coverage should mark pre-creation dates unavailable');
assert.deepEqual((await readJobs(db, ownerId, siteUrl)).map((job) => job.jobType), ['ga4-llm-range-sync'], 'Only GA4 LLM jobs should be queued for the LLM coverage request');
await clearJobs(db, ownerId, siteUrl);

await db.run(
  `INSERT INTO ga4_llm_referral_metrics
     (ownerId, propertyId, siteUrl, date, source, sourceClass, pageKey, pagePath, sessions, engagedSessions, keyEvents, averageSessionDuration)
   VALUES (?, ?, ?, ?, 'chatgpt.com', 'ChatGPT', '/', '/', 3, 2, 1, 42)`,
  [ownerId, propertyId, siteUrl, propertyStartDate],
);
const rawLlmReport = await invoke(ga4LlmReportHandler, {
  authUser: { uid: ownerId },
  body: { autoQueue: false, endDate: propertyStartDate, propertyId, siteUrl, startDate: propertyStartDate },
  method: 'POST:/api/warehouse/ga4/llm/report',
});
assert.deepEqual(rawLlmReport.source.rows[0].dimensionValues.map((value: any) => value.value), ['chatgpt.com', 'ChatGPT'], 'LLM source rows must expose raw source and provider class');
assert.deepEqual(rawLlmReport.landingPage.rows[0].dimensionValues.map((value: any) => value.value), ['/', 'chatgpt.com', 'ChatGPT'], 'LLM landing rows must expose page, raw source, and provider class');
await db.run('DELETE FROM ga4_llm_referral_metrics WHERE ownerId = ? AND propertyId = ? AND siteUrl = ?', [ownerId, propertyId, siteUrl]);

const sourceCoverage = await invoke(coverageHandler, {
  authUser: { uid: ownerId },
  query: {
    autoQueue: 'true',
    endDate: spanningEndDate,
    propertyId,
    siteUrl,
    startDate: spanningStartDate,
  },
});
assert.equal(sourceCoverage.ga4.pages.expectedDateCount, 3, 'Coverage route should clip GA4 pages to property creation');
assert.equal(sourceCoverage.ga4.dimensions.expectedDateCount, 3, 'Coverage route should clip GA4 dimensions to property creation');
assert.equal(sourceCoverage.ga4.llm.expectedDateCount, 3, 'Coverage route should clip GA4 LLM to property creation');
assert.equal(sourceCoverage.gsc.site.expectedDateCount, 5, 'Coverage route should leave GSC expected dates independent');
assertGa4JobsBounded(await readJobs(db, ownerId, siteUrl), propertyStartDate);
await clearJobs(db, ownerId, siteUrl);

const missingSpanning = await invoke(missingJobsHandler, {
  authUser: { uid: ownerId },
  body: {
    endDate: spanningEndDate,
    maxDates: 10,
    propertyId,
    siteUrl,
    startDate: spanningStartDate,
  },
  method: 'POST:/api/warehouse/jobs/missing',
});
assert.equal(missingSpanning.queuedCoreDates, 5, 'Missing-days import should keep GSC queueing independent of GA4 property creation');
assert.equal(missingSpanning.queuedGa4PageDates, 3, 'Missing-days import should only queue GA4 page dates after property creation');
assert.equal(missingSpanning.queuedGa4DimensionDates, 3, 'Missing-days import should only queue GA4 dimension dates after property creation');
assert.equal(missingSpanning.queuedLlmDates, 3, 'Missing-days import should only queue GA4 LLM dates after property creation');
assertGa4JobsBounded(await readJobs(db, ownerId, siteUrl), propertyStartDate);
await clearJobs(db, ownerId, siteUrl);

const beforePageReport = await invoke(ga4ReportHandler, {
  authUser: { uid: ownerId },
  body: {
    autoQueue: true,
    dimensions: ['date'],
    endDate: beforeEndDate,
    metrics: ['sessions'],
    propertyId,
    siteUrl,
    startDate: beforeStartDate,
  },
  method: 'POST:/api/warehouse/ga4/report',
});
assert.equal(beforePageReport.metadata.coverage.expectedDateCount, 0, 'All-pre-creation GA4 page ranges should be unavailable');
assert.equal(beforePageReport.metadata.coverage.missingDateCount, 0, 'All-pre-creation GA4 page ranges should not be missing');
assert.equal(beforePageReport.metadata.coverage.queuedDateCount, 0, 'All-pre-creation GA4 page ranges should not queue');
assert.equal(beforePageReport.metadata.coverage.skippedUnavailableDates, 5, 'All-pre-creation GA4 page ranges should be counted as unavailable');
assert.deepEqual(await readJobs(db, ownerId, siteUrl), [], 'All-pre-creation GA4 page ranges should not create jobs');

const missingBeforeCreation = await invoke(missingJobsHandler, {
  authUser: { uid: ownerId },
  body: {
    endDate: beforeEndDate,
    maxDates: 10,
    propertyId,
    siteUrl,
    startDate: beforeStartDate,
  },
  method: 'POST:/api/warehouse/jobs/missing',
});
assert.equal(missingBeforeCreation.queuedCoreDates, 5, 'All-pre-creation missing-days requests should still queue GSC work');
assert.equal(missingBeforeCreation.queuedGa4PageDates, 0, 'All-pre-creation missing-days requests should not queue GA4 pages');
assert.equal(missingBeforeCreation.queuedGa4DimensionDates, 0, 'All-pre-creation missing-days requests should not queue GA4 dimensions');
assert.equal(missingBeforeCreation.queuedLlmDates, 0, 'All-pre-creation missing-days requests should not queue GA4 LLM');
assert.deepEqual((await readJobs(db, ownerId, siteUrl)).map((job) => job.jobType), ['core-range-sync'], 'All-pre-creation missing-days requests should only queue GSC core jobs');

console.log(JSON.stringify({
  ok: true,
  beforeEndDate,
  propertyStartDate,
  spanningEndDate,
  spanningStartDate,
}, null, 2));

await db.close();
