import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';

process.env.WAREHOUSE_INITIAL_BACKFILL_DAYS = '14';
process.env.WAREHOUSE_CORE_RANGE_JOB_DAYS = '7';
process.env.WAREHOUSE_GA4_DIMENSION_RANGE_JOB_DAYS = '14';
process.env.WAREHOUSE_LLM_RANGE_JOB_DAYS = '14';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
process.env.APP_BASE_URL = 'http://localhost:3000';

const { registerAccountDataRoutes } = await import('../server/routes/accountData.js');
const { registerGoogleRoutes } = await import('../server/routes/google.js');
const { registerWarehouseRoutes } = await import('../server/routes/warehouse.js');
const { registerWorkspaceCrudRoutes } = await import('../server/routes/workspaceCrud.js');
const { runBingDailySchedulerTick } = await import('../server/services/bingWarehouse.js');
const { runWarehouseDailySchedulerTick } = await import('../server/services/warehouseJobs.js');

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

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
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

const fetchLog: string[] = [];
const bingFactDate = '2026-07-01';
const bingFactTimestamp = Date.UTC(2026, 6, 1);
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  fetchLog.push(url);
  if (url.startsWith('https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats')) {
    const siteUrl = new URL(url).searchParams.get('siteUrl') || '';
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          d: [
            { Date: `/Date(${bingFactTimestamp}+0000)/`, Query: `${siteUrl}:brand`, Impressions: 10, Clicks: 2, AvgClickPosition: 3, AvgImpressionPosition: 5 },
            { Date: `/Date(${bingFactTimestamp}+0000)/`, Query: `${siteUrl}:brand`, Impressions: 15, Clicks: 3, AvgClickPosition: 5, AvgImpressionPosition: 7 },
          ],
        };
      },
    } as Response;
  }
  if (url === 'https://oauth2.googleapis.com/token') {
    return {
      ok: true,
      status: 200,
      async json() {
        return { access_token: 'google-access-token' };
      },
    } as Response;
  }
  if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          siteEntry: [
            { siteUrl: 'https://onboard.example/' },
            { siteUrl: 'https://known.example/' },
          ],
        };
      },
    } as Response;
  }
  if (url === 'https://analyticsadmin.googleapis.com/v1beta/properties/123') {
    return {
      ok: true,
      status: 200,
      async json() {
        return { createTime: '2024-01-15T00:00:00Z', displayName: 'Primary GA4' };
      },
    } as Response;
  }
  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

try {
  const raw = new Database(':memory:');
  const db = new MemoryDatabase(raw);
  await db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      company TEXT,
      avatarUrl TEXT,
      bio TEXT,
      tier TEXT,
      unlockedSites TEXT,
      knownSites TEXT,
      createdAt TEXT,
      onboardingCompleted INTEGER,
      activatedSiteUrl TEXT,
      activatedGa4PropertyId TEXT,
      activatedGa4DisplayName TEXT,
      gscRefreshToken TEXT,
      bingApiKey TEXT,
      passwordHash TEXT,
      authProvider TEXT
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
    CREATE TABLE warehouse_sync_status (
      ownerId TEXT NOT NULL,
      siteUrl TEXT NOT NULL,
      lastSyncDate TEXT,
      earliestSyncDate TEXT,
      status TEXT,
      lastUpdated TEXT,
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
    CREATE TABLE crawl_jobs (
      id TEXT PRIMARY KEY,
      ownerId TEXT,
      siteUrl TEXT,
      startUrl TEXT,
      sitemapUrl TEXT,
      status TEXT,
      maxPages INTEGER,
      maxDepth INTEGER,
      discoveredCount INTEGER,
      crawledCount INTEGER,
      errorCount INTEGER,
      skippedCount INTEGER,
      queuedCount INTEGER,
      startedAt TEXT,
      updatedAt TEXT,
      completedAt TEXT,
      lastError TEXT,
      attemptCount INTEGER,
      maxAttempts INTEGER,
      lockedAt TEXT,
      nextRunAt TEXT,
      renderMode TEXT,
      respectRobots INTEGER,
      includeQueryStrings INTEGER,
      userAgent TEXT
    );
    CREATE TABLE crawl_pages (
      ownerId TEXT,
      siteUrl TEXT,
      jobId TEXT,
      statusCode INTEGER,
      noindex INTEGER
    );
    CREATE TABLE gsc_site_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL);
    CREATE TABLE gsc_query_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, query TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL);
    CREATE TABLE gsc_page_query_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, page TEXT, pageKey TEXT, query TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL);
    CREATE TABLE gsc_page_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, page TEXT, pageKey TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL, queryCount INTEGER);
    CREATE TABLE gsc_country_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, country TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL);
    CREATE TABLE ga4_page_metrics (ownerId TEXT, propertyId TEXT, siteUrl TEXT, date TEXT, pagePath TEXT, pageKey TEXT, sessions REAL, totalUsers REAL, pageViews REAL, bounceRate REAL, eventCount REAL);
    CREATE TABLE ga4_dimension_metrics (ownerId TEXT, propertyId TEXT, siteUrl TEXT, date TEXT, dimension TEXT, dimensionValue TEXT, sessions REAL, totalUsers REAL, screenPageViews REAL, bounceRate REAL, eventCount REAL);
    CREATE TABLE ga4_llm_referral_metrics (ownerId TEXT, propertyId TEXT, siteUrl TEXT, date TEXT, source TEXT, sourceClass TEXT, pagePath TEXT, pageKey TEXT, sessions REAL, engagedSessions REAL, keyEvents REAL, averageSessionDuration REAL);
    CREATE TABLE bing_query_stats (
      ownerId TEXT,
      siteUrl TEXT,
      query TEXT,
      impressions REAL,
      clicks REAL,
      ctr REAL,
      avgClickPosition REAL,
      avgImpressionPosition REAL,
      fetchedAt TEXT
    );
  `);

  const ownerId = 'owner-1';
  const activeSiteUrl = 'https://onboard.example/';
  const knownSiteUrl = 'https://known.example/';
  const propertyId = 'properties/123';
  await db.run(
    `INSERT INTO users (
      id, email, tier, unlockedSites, knownSites, createdAt, onboardingCompleted,
      activatedSiteUrl, activatedGa4PropertyId, activatedGa4DisplayName, gscRefreshToken, bingApiKey
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerId,
      'owner@example.com',
      'pro',
      JSON.stringify([]),
      JSON.stringify([]),
      new Date().toISOString(),
      0,
      null,
      null,
      null,
      'plain-refresh-token',
      'bing-api-key',
    ],
  );

  const app = new FakeApp();
  registerAccountDataRoutes(app as any, db);
  registerGoogleRoutes(app as any, db);
  registerWarehouseRoutes(app as any, db);
  registerWorkspaceCrudRoutes(app as any, db);

  const onboardingHandler = app.routes.get('PUT:/api/users/:id/onboarding')?.at(-1);
  assert(onboardingHandler, 'Missing onboarding handler');
  const onboardingRes = new FakeResponse();
  await onboardingHandler!(
    {
      body: {
        onboardingCompleted: true,
        activatedSiteUrl: activeSiteUrl,
        activatedGa4PropertyId: propertyId,
        activatedGa4DisplayName: 'Primary GA4',
      },
      params: { id: ownerId },
    },
    onboardingRes,
  );
  assert(onboardingRes.statusCode === 200, `Onboarding route returned ${onboardingRes.statusCode}`);

  const activeSiteJobsAfterOnboarding = await db.all<{ jobType: string; siteUrl: string; targetStartDate: string | null; targetDate: string }>(
    'SELECT jobType, siteUrl, targetStartDate, targetDate FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? ORDER BY jobType, targetStartDate, targetDate',
    [ownerId, activeSiteUrl],
  );
  const activeBingRowsAfterOnboarding = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM bing_query_stats WHERE ownerId = ? AND siteUrl = ?', [ownerId, activeSiteUrl]);
  const crawlJobs = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM crawl_jobs WHERE ownerId = ? AND siteUrl = ?', [ownerId, activeSiteUrl]);

  assert(Number(crawlJobs?.count || 0) === 1, 'Onboarding should queue the initial crawl');
  assert(activeSiteJobsAfterOnboarding.some((job) => job.jobType === 'core-range-sync'), 'Onboarding should queue core warehouse backfill');
  assert(activeSiteJobsAfterOnboarding.some((job) => job.jobType === 'ga4-dimension-range-sync'), 'Onboarding should queue GA4 dimension backfill for the mapped property');
  assert(activeSiteJobsAfterOnboarding.some((job) => job.jobType === 'ga4-llm-range-sync'), 'Onboarding should queue GA4 LLM backfill for the mapped property');
  assert(activeSiteJobsAfterOnboarding.every((job) => job.jobType !== 'daily-sync'), 'Onboarding should not rely on one-day daily jobs');
  assert(Number(activeBingRowsAfterOnboarding?.count || 0) > 0, 'Onboarding should sync Bing data when a Bing key is already configured');

  const bingStatsHandler = app.routes.get('GET:/api/bing/stats')?.at(-1);
  assert(bingStatsHandler, 'Missing Bing query stats handler');
  const bingStatsRes = new FakeResponse();
  await bingStatsHandler!(
    {
      authUser: { uid: ownerId },
      query: { endDate: bingFactDate, siteUrl: activeSiteUrl, startDate: bingFactDate },
    },
    bingStatsRes,
  );
  const bingStatsBody = bingStatsRes.body as any;
  assert(bingStatsRes.statusCode === 200, `Bing range route returned ${bingStatsRes.statusCode}`);
  assert(bingStatsBody?.meta?.source === 'dated-facts', 'Bing range route should read dated warehouse facts');
  assert(bingStatsBody?.meta?.range?.matchedDateCount === 1, 'Bing range route should report its stored date coverage');
  assert(bingStatsBody?.d?.length === 1, 'Bing range route should aggregate duplicate query rows');
  assert(bingStatsBody?.d?.[0]?.Clicks === 5, 'Bing range route should sum query clicks across duplicate API rows');

  const bingSyncHandler = app.routes.get('POST:/api/bing/stats/sync')?.at(-1);
  assert(bingSyncHandler, 'Missing Bing query sync handler');
  const bingSyncRes = new FakeResponse();
  await bingSyncHandler!(
    {
      authUser: { uid: ownerId },
      body: { endDate: bingFactDate, siteUrl: activeSiteUrl, startDate: bingFactDate },
    },
    bingSyncRes,
  );
  const bingSyncBody = bingSyncRes.body as any;
  assert(bingSyncRes.statusCode === 200, `Bing range sync route returned ${bingSyncRes.statusCode}`);
  assert(bingSyncBody?.meta?.source === 'dated-facts', 'Bing range sync should return the selected dated facts');
  assert(bingSyncBody?.d?.length === 1, 'Bing range sync should not return the all-time compatibility mirror');

  const googleSitesHandler = app.routes.get('GET:/api/google/gsc/sites')?.at(-1);
  assert(googleSitesHandler, 'Missing Google GSC sites handler');
  const googleSitesRes = new FakeResponse();
  await googleSitesHandler!(
    {
      authUser: { uid: ownerId },
      headers: {},
      query: {},
    },
    googleSitesRes,
  );
  assert(googleSitesRes.statusCode === 200, `Google GSC sites route returned ${googleSitesRes.statusCode}`);

  const activeSiteJobsAfterGoogle = await db.all<{ jobType: string; siteUrl: string; targetStartDate: string | null; targetDate: string }>(
    'SELECT jobType, siteUrl, targetStartDate, targetDate FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? ORDER BY jobType, targetStartDate, targetDate',
    [ownerId, activeSiteUrl],
  );
  const passiveKnownSiteJobs = await db.all<{ jobType: string; siteUrl: string; targetStartDate: string | null; targetDate: string }>(
    'SELECT jobType, siteUrl, targetStartDate, targetDate FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? ORDER BY jobType, targetStartDate, targetDate',
    [ownerId, knownSiteUrl],
  );
  const passiveKnownSiteBingRows = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM bing_query_stats WHERE ownerId = ? AND siteUrl = ?', [ownerId, knownSiteUrl]);
  const userRow = await db.get<{ knownSites?: string | null }>('SELECT knownSites FROM users WHERE id = ?', [ownerId]);

  assert(JSON.stringify(activeSiteJobsAfterGoogle) === JSON.stringify(activeSiteJobsAfterOnboarding), 'Passive Google site discovery should not duplicate active-site warehouse jobs');
  assert(passiveKnownSiteJobs.length === 0, 'Passive Google site discovery should not queue warehouse imports');
  assert(Number(passiveKnownSiteBingRows?.count || 0) === 0, 'Passive Google site discovery should not sync Bing data');
  assert(String(userRow?.knownSites || '').includes(knownSiteUrl), 'Passive Google site discovery should persist the discovered known site');

  await db.run('DELETE FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ?', [ownerId, activeSiteUrl]);

  const oldGa4EndDate = addIsoDays(latestStableReportingDate(), -520);
  const oldGa4StartDate = addIsoDays(oldGa4EndDate, -6);
  const missingJobsHandler = app.routes.get('POST:/api/warehouse/jobs/missing')?.at(-1);
  assert(missingJobsHandler, 'Missing warehouse missing-days handler');
  const missingJobsRes = new FakeResponse();
  await missingJobsHandler!(
    {
      authUser: { uid: ownerId },
      body: { endDate: oldGa4EndDate, maxDates: 3, propertyId, siteUrl: activeSiteUrl, startDate: oldGa4StartDate },
    },
    missingJobsRes,
  );
  const missingJobsBody = missingJobsRes.body as any;
  assert(missingJobsRes.statusCode === 200, `Missing-days route returned ${missingJobsRes.statusCode}`);
  assert(missingJobsBody?.queuedGa4PageDates === 7, 'GA4 page queueing should cover the full requested range instead of inheriting the GSC queue limit');
  assert((missingJobsBody?.jobs || []).some((job: any) => job.jobType === 'ga4-page-range-sync'), 'Old GA4 page gaps should queue dedicated GA4 page-range jobs');
  assert(!(missingJobsBody?.jobs || []).some((job: any) => job.jobType === 'core-range-sync'), 'Old GA4 page gaps must not queue GSC core jobs outside GSC history');
  const oldGa4QueuedJobs = await db.all<{ jobType: string }>(
    'SELECT jobType FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? AND targetStartDate = ? AND targetDate = ?',
    [ownerId, activeSiteUrl, oldGa4StartDate, oldGa4EndDate],
  );
  assert(oldGa4QueuedJobs.some((job) => job.jobType === 'ga4-page-range-sync'), 'Old GA4 page gaps should persist GA4 page-range jobs');
  assert(oldGa4QueuedJobs.every((job) => job.jobType !== 'core-range-sync'), 'Old GA4 page gaps must not persist GSC core jobs');

  const workspaceStatusHandler = app.routes.get('GET:/api/workspace/sites/status')?.at(-1);
  assert(workspaceStatusHandler, 'Missing workspace sites status handler');
  const workspaceStatusRes = new FakeResponse();
  await workspaceStatusHandler!(
    { authUser: { uid: ownerId } },
    workspaceStatusRes,
  );
  assert(workspaceStatusRes.statusCode === 200, `Workspace sites status route returned ${workspaceStatusRes.statusCode}`);
  const workspaceStatusBody = workspaceStatusRes.body as any;
  const activeSiteStatus = (workspaceStatusBody?.sites || []).find((site: any) => site.siteUrl === activeSiteUrl);
  assert(activeSiteStatus?.warehouse?.jobs?.latest?.targetStartDate === oldGa4StartDate, 'Workspace status should surface the latest GA4 page-range job start date');
  assert(activeSiteStatus?.warehouse?.jobs?.latest?.targetDate === oldGa4EndDate, 'Workspace status should surface the latest GA4 page-range job end date');

  const countBingFetches = (siteUrl: string) => fetchLog.filter((url) => {
    if (!url.startsWith('https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats')) return false;
    return new URL(url).searchParams.get('siteUrl') === siteUrl;
  }).length;
  const activeBingFetchesBeforeScheduler = countBingFetches(activeSiteUrl);

  await runWarehouseDailySchedulerTick(db);
  await runBingDailySchedulerTick(db);

  const knownSiteJobs = await db.all<{ jobType: string; siteUrl: string; targetStartDate: string | null; targetDate: string }>(
    'SELECT jobType, siteUrl, targetStartDate, targetDate FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? ORDER BY jobType, targetStartDate, targetDate',
    [ownerId, knownSiteUrl],
  );
  const knownSiteBingRows = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM bing_query_stats WHERE ownerId = ? AND siteUrl = ?', [ownerId, knownSiteUrl]);

  assert(knownSiteJobs.some((job) => job.jobType === 'core-range-sync'), 'The warehouse scheduler should queue backfill for newly discovered sites');
  assert(Number(knownSiteBingRows?.count || 0) > 0, 'The Bing scheduler should sync newly discovered sites');
  assert(countBingFetches(activeSiteUrl) === activeBingFetchesBeforeScheduler, 'The Bing scheduler should skip fresh active-site data');

  console.log(JSON.stringify({
    ok: true,
    activeSiteJobCount: activeSiteJobsAfterOnboarding.length,
    passiveKnownSiteJobCount: passiveKnownSiteJobs.length,
    knownSiteJobCount: knownSiteJobs.length,
    fetchCount: fetchLog.length,
  }, null, 2));

  await db.close();
} finally {
  globalThis.fetch = originalFetch;
}
