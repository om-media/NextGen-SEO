import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import {
  ensureWorkspaceGa4PropertyMetadata,
  resolveWorkspaceGa4PropertyStartDate,
} from '../server/services/ga4Mappings.js';
import {
  queueWarehouseBootstrapJobs,
  SEARCH_CONSOLE_HISTORY_DAYS,
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

type GooglePropertyFixture = {
  createTime?: string;
  displayName: string;
};

type WarehouseJobRow = {
  id: string;
  jobType: string;
  propertyId: string | null;
  siteUrl: string;
  status: string;
  targetDate: string;
  targetStartDate: string | null;
};

const toIsoDate = (value: Date) => value.toISOString().slice(0, 10);

const addDays = (value: Date, days: number) => {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const eachIsoDate = (startDate: string, endDate: string) => {
  const dates: string[] = [];
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return dates;

  for (let current = start; current <= end; current = new Date(current.getTime() + 24 * 60 * 60 * 1000)) {
    dates.push(toIsoDate(current));
  }

  return dates;
};

const latestStableWarehouseDate = () => toIsoDate(addDays(new Date(), -2));
const earliestSearchConsoleDate = () => toIsoDate(addDays(addDays(new Date(), -2), -(SEARCH_CONSOLE_HISTORY_DAYS - 1)));

function coveredDates(rows: WarehouseJobRow[]) {
  const dates = new Set<string>();
  for (const row of rows) {
    const startDate = row.targetStartDate || row.targetDate;
    for (const date of eachIsoDate(startDate, row.targetDate)) {
      dates.add(date);
    }
  }
  return dates;
}

function createMemoryDatabase() {
  const raw = new Database(':memory:');
  const db = new MemoryDatabase(raw);
  return db;
}

async function installSchema(db: AppDatabase) {
  await db.exec(`
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

    CREATE TABLE gsc_site_metrics (
      ownerId TEXT,
      siteUrl TEXT,
      date TEXT
    );

    CREATE TABLE gsc_query_metrics (
      ownerId TEXT,
      siteUrl TEXT,
      date TEXT
    );

    CREATE TABLE gsc_page_query_metrics (
      ownerId TEXT,
      siteUrl TEXT,
      date TEXT
    );

    CREATE TABLE gsc_country_metrics (
      ownerId TEXT,
      siteUrl TEXT,
      date TEXT
    );

    CREATE TABLE ga4_page_metrics (
      ownerId TEXT,
      propertyId TEXT,
      siteUrl TEXT,
      date TEXT
    );

    CREATE TABLE ga4_dimension_metrics (
      ownerId TEXT,
      propertyId TEXT,
      siteUrl TEXT,
      date TEXT,
      dimension TEXT
    );

    CREATE TABLE ga4_llm_referral_metrics (
      ownerId TEXT,
      propertyId TEXT,
      siteUrl TEXT,
      date TEXT
    );
  `);
}

async function seedAccessibleUser(db: AppDatabase, input: { ownerId: string; siteUrl: string }) {
  await db.run(
    `INSERT INTO users (id, tier, unlockedSites, knownSites, activatedSiteUrl, activatedGa4PropertyId, gscRefreshToken)
     VALUES (?, 'pro', ?, ?, ?, NULL, ?)`,
    [
      input.ownerId,
      JSON.stringify([input.siteUrl]),
      JSON.stringify([input.siteUrl]),
      input.siteUrl,
      'plain-refresh-token',
    ],
  );
}

function installGoogleFetchMock(properties: Record<string, GooglePropertyFixture>) {
  const calls = {
    admin: new Map<string, number>(),
    token: 0,
  };
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (request: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = typeof request === 'string'
      ? request
      : request instanceof URL
        ? request.toString()
        : request.url;

    if (url === 'https://oauth2.googleapis.com/token') {
      calls.token += 1;
      return new Response(JSON.stringify({ access_token: 'test-access-token' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    if (url.startsWith('https://analyticsadmin.googleapis.com/v1beta/properties/')) {
      const propertyId = url.slice('https://analyticsadmin.googleapis.com/v1beta/'.length);
      const property = properties[propertyId];
      calls.admin.set(propertyId, (calls.admin.get(propertyId) || 0) + 1);
      assert.ok(property, `Unexpected property lookup for ${propertyId}`);
      return new Response(JSON.stringify(property), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function runCheck() {
  process.env.GOOGLE_OAUTH_CLIENT_ID ||= 'test-client-id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ||= 'test-client-secret';

  const ownerId = 'ga4-owner';
  const siteUrl = 'https://example.com/';
  const originalPropertyId = 'properties/1001';
  const switchedPropertyId = 'properties/2002';
  const latestStableDate = latestStableWarehouseDate();
  const bootstrapGa4StartDate = toIsoDate(addDays(
    new Date(`${latestStableDate}T00:00:00.000Z`),
    -(SEARCH_CONSOLE_HISTORY_DAYS + 30),
  ));
  const originalCreateTime = `${bootstrapGa4StartDate}T06:07:08.000Z`;

  const db = createMemoryDatabase();
  const fetchMock = installGoogleFetchMock({
    [originalPropertyId]: {
      createTime: originalCreateTime,
      displayName: 'Original Property',
    },
    [switchedPropertyId]: {
      displayName: 'Replacement Property',
    },
  });

  try {
    await installSchema(db);
    await seedAccessibleUser(db, { ownerId, siteUrl });

    const firstCreatedAt = await ensureWorkspaceGa4PropertyMetadata(db, {
      ownerId,
      propertyId: originalPropertyId,
      siteUrl,
    });
    assert.equal(firstCreatedAt, originalCreateTime, 'First metadata lookup should persist createTime');
    assert.equal(fetchMock.calls.token, 1, 'First metadata lookup should refresh a Google access token');
    assert.equal(fetchMock.calls.admin.get(originalPropertyId), 1, 'First metadata lookup should hit the Admin API once');

    const storedOriginal = await db.get<{
      displayName: string | null;
      propertyCreatedAt: string | null;
      propertyId: string;
    }>(
      'SELECT propertyId, displayName, propertyCreatedAt FROM workspace_ga4_mappings WHERE ownerId = ? AND siteUrl = ?',
      [ownerId, siteUrl],
    );
    assert.equal(storedOriginal?.propertyId, originalPropertyId, 'Original property should be stored for the site');
    assert.equal(storedOriginal?.propertyCreatedAt, originalCreateTime, 'Stored mapping should keep the fetched createTime');
    assert.equal(
      await resolveWorkspaceGa4PropertyStartDate(db, ownerId, siteUrl, originalPropertyId),
      bootstrapGa4StartDate,
      'Start date should resolve from the stored property createTime',
    );

    const secondCreatedAt = await ensureWorkspaceGa4PropertyMetadata(db, {
      ownerId,
      propertyId: originalPropertyId,
      siteUrl,
    });
    assert.equal(secondCreatedAt, originalCreateTime, 'Repeat metadata lookup should return the cached createTime');
    assert.equal(fetchMock.calls.token, 1, 'Repeat metadata lookup should not refresh another token');
    assert.equal(fetchMock.calls.admin.get(originalPropertyId), 1, 'Repeat metadata lookup should not hit the Admin API again');

    const bootstrapTokenCalls = fetchMock.calls.token;
    const bootstrapAdminCalls = fetchMock.calls.admin.get(originalPropertyId) || 0;
    const bootstrap = await queueWarehouseBootstrapJobs(db, {
      ownerId,
      propertyId: originalPropertyId,
      siteUrl,
    });
    assert.equal(fetchMock.calls.token, bootstrapTokenCalls, 'Bootstrap queueing should reuse cached GA4 metadata');
    assert.equal(fetchMock.calls.admin.get(originalPropertyId), bootstrapAdminCalls, 'Bootstrap queueing should not call the Admin API after metadata is cached');

    const coreJobs = bootstrap.core as WarehouseJobRow[];
    const ga4DimensionJobs = bootstrap.ga4Dimensions as WarehouseJobRow[];
    const ga4PageJobs = bootstrap.ga4Pages as WarehouseJobRow[];
    const llmJobs = bootstrap.llm as WarehouseJobRow[];

    assert.ok(coreJobs.length > 0, 'Bootstrap should queue core range jobs');
    assert.ok(ga4DimensionJobs.length > 1, 'Long GA4 history should be split into bounded dimension range jobs');
    assert.ok(llmJobs.length > 1, 'Long GA4 history should be split into bounded LLM range jobs');
    assert.ok(ga4PageJobs.length > 0, 'GA4 page history older than GSC support should use dedicated page jobs');

    const coreCoveredDates = coveredDates(coreJobs);
    const expectedCoreDates = eachIsoDate(earliestSearchConsoleDate(), latestStableDate);
    assert.equal(coreCoveredDates.size, SEARCH_CONSOLE_HISTORY_DAYS, 'Core bootstrap should stay within the Search Console history window');
    assert.deepEqual(
      [...coreCoveredDates].sort(),
      expectedCoreDates,
      'Core range jobs should cover the full Search Console history window and no more',
    );

    const expectedGa4Dates = eachIsoDate(bootstrapGa4StartDate, latestStableDate);
    const dimensionCoveredDates = coveredDates(ga4DimensionJobs);
    const llmCoveredDates = coveredDates(llmJobs);
    assert.deepEqual(
      [...dimensionCoveredDates].sort(),
      expectedGa4Dates,
      'GA4 dimension jobs should start at the cached property create date',
    );
    assert.deepEqual(
      [...llmCoveredDates].sort(),
      expectedGa4Dates,
      'GA4 LLM jobs should start at the cached property create date',
    );

    const ga4PageCoveredDates = coveredDates([...coreJobs, ...ga4PageJobs]);
    for (const date of expectedGa4Dates) {
      assert.ok(
        ga4PageCoveredDates.has(date),
        `Core and dedicated GA4 page jobs should cover GA4 page backfill date ${date}`,
      );
    }

    const switchedCreatedAt = await ensureWorkspaceGa4PropertyMetadata(db, {
      ownerId,
      propertyId: switchedPropertyId,
      siteUrl,
    });
    assert.equal(switchedCreatedAt, null, 'Replacement property without createTime should return null');
    assert.equal(fetchMock.calls.token, 2, 'Property switch should perform one more token refresh');
    assert.equal(fetchMock.calls.admin.get(switchedPropertyId), 1, 'Property switch should hit the Admin API for the new property');

    const storedSwitched = await db.get<{
      displayName: string | null;
      propertyCreatedAt: string | null;
      propertyId: string;
    }>(
      'SELECT propertyId, displayName, propertyCreatedAt FROM workspace_ga4_mappings WHERE ownerId = ? AND siteUrl = ?',
      [ownerId, siteUrl],
    );
    assert.equal(storedSwitched?.propertyId, switchedPropertyId, 'Property switch should replace the stored property id');
    assert.equal(storedSwitched?.displayName, 'Replacement Property', 'Property switch should update displayName');
    assert.equal(storedSwitched?.propertyCreatedAt, null, 'Property switch must clear the previous propertyCreatedAt when the new property has none');
    assert.equal(
      await resolveWorkspaceGa4PropertyStartDate(db, ownerId, siteUrl, switchedPropertyId),
      null,
      'Replacement property without createTime should not resolve a start date',
    );
    assert.equal(
      await resolveWorkspaceGa4PropertyStartDate(db, ownerId, siteUrl, originalPropertyId),
      null,
      'Previous property should no longer resolve after the site switches to a different GA4 property',
    );

    console.log(JSON.stringify({
      ok: true,
      cachedPropertyId: originalPropertyId,
      bootstrapGa4StartDate,
      latestStableDate,
      switchedPropertyId,
      changedFile: 'scripts/check-ga4-property-metadata.ts',
    }, null, 2));
  } finally {
    fetchMock.restore();
    await db.close();
  }
}

await runCheck();

