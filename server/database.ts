import Database from 'better-sqlite3';
import fs from 'fs';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool } = pg;
type PgQueryable = pg.Pool | pg.PoolClient;

const DB_FILENAME = 'sqlite.db';
const DB_BACKUP_FILENAME = `${DB_FILENAME}.bak`;

export type QueryParams = unknown[] | Record<string, unknown>;

export type RunResult = {
  changes: number;
  lastInsertRowid?: number | bigint;
};

export type AppDatabase = {
  dialect: 'sqlite' | 'postgres';
  prepare: (sql: string) => any;
  exec: (sql: string) => Promise<void>;
  get: <T = unknown>(sql: string, params?: QueryParams) => Promise<T | undefined>;
  all: <T = unknown>(sql: string, params?: QueryParams) => Promise<T[]>;
  run: (sql: string, params?: QueryParams) => Promise<RunResult>;
  transaction: <Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) => (...args: Args) => Promise<T>;
  close?: () => Promise<void>;
};

const commonSchemaSql = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    domain TEXT,
    ownerId TEXT,
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS filters (
    id TEXT PRIMARY KEY,
    name TEXT,
    projectId TEXT,
    ownerId TEXT,
    configuration TEXT,
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    passwordHash TEXT,
    authProvider TEXT DEFAULT 'local',
    name TEXT,
    company TEXT,
    avatarUrl TEXT,
    bio TEXT,
    tier TEXT,
    unlockedSites TEXT,
    createdAt TEXT,
    bingApiKey TEXT,
    gscRefreshToken TEXT,
    knownSites TEXT,
    onboardingCompleted INTEGER DEFAULT 0,
    activatedSiteUrl TEXT,
    activatedGa4PropertyId TEXT,
    activatedGa4DisplayName TEXT,
    billingStatus TEXT DEFAULT 'active',
    subscriptionId TEXT,
    trialEndsAt TEXT,
    currentPeriodEnd TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    tokenHash TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    userId TEXT,
    siteUrl TEXT,
    date TEXT,
    title TEXT,
    description TEXT,
    type TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS gsc_site_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date)
  );

  CREATE TABLE IF NOT EXISTS gsc_query_metrics (
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

  CREATE TABLE IF NOT EXISTS gsc_page_query_metrics (
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

  CREATE TABLE IF NOT EXISTS ga4_page_metrics (
    ownerId TEXT,
    propertyId TEXT,
    siteUrl TEXT,
    date TEXT,
    pagePath TEXT,
    pageKey TEXT,
    sessions INTEGER,
    totalUsers INTEGER,
    pageViews INTEGER,
    bounceRate REAL,
    eventCount INTEGER,
    PRIMARY KEY (ownerId, propertyId, date, pageKey)
  );

  CREATE TABLE IF NOT EXISTS warehouse_sync_status (
    ownerId TEXT,
    siteUrl TEXT,
    lastSyncDate TEXT,
    earliestSyncDate TEXT,
    status TEXT,
    lastUpdated TEXT,
    PRIMARY KEY (ownerId, siteUrl)
  );

  CREATE TABLE IF NOT EXISTS tracked_keywords (
    id TEXT PRIMARY KEY,
    siteUrl TEXT,
    ownerId TEXT,
    keyword TEXT,
    location TEXT,
    device TEXT,
    tags TEXT,
    targetDomain TEXT,
    createdAt TEXT,
    UNIQUE(ownerId, siteUrl, keyword, location, device)
  );

  CREATE TABLE IF NOT EXISTS keyword_rankings (
    keywordId TEXT,
    date TEXT,
    position INTEGER,
    rankingUrl TEXT,
    PRIMARY KEY (keywordId, date)
  );

  CREATE TABLE IF NOT EXISTS url_inspection_cache (
    ownerId TEXT,
    siteUrl TEXT NOT NULL,
    url TEXT NOT NULL,
    inspectionResult TEXT,
    coverageState TEXT,
    lastInspectionTime TEXT NOT NULL,
    PRIMARY KEY (ownerId, siteUrl, url)
  );

  CREATE TABLE IF NOT EXISTS warehouse_jobs (
    id TEXT PRIMARY KEY,
    ownerId TEXT,
    siteUrl TEXT,
    propertyId TEXT,
    jobType TEXT,
    status TEXT,
    targetDate TEXT,
    attemptCount INTEGER DEFAULT 0,
    maxAttempts INTEGER DEFAULT 3,
    lockedAt TEXT,
    nextRunAt TEXT,
    startedAt TEXT,
    updatedAt TEXT,
    completedAt TEXT,
    lastError TEXT,
    rowsSynced INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS crawl_jobs (
    id TEXT PRIMARY KEY,
    ownerId TEXT,
    siteUrl TEXT,
    startUrl TEXT,
    sitemapUrl TEXT,
    status TEXT,
    maxPages INTEGER,
    maxDepth INTEGER,
    discoveredCount INTEGER DEFAULT 0,
    crawledCount INTEGER DEFAULT 0,
    errorCount INTEGER DEFAULT 0,
    skippedCount INTEGER DEFAULT 0,
    queuedCount INTEGER DEFAULT 0,
    startedAt TEXT,
    updatedAt TEXT,
    completedAt TEXT,
    lastError TEXT,
    attemptCount INTEGER DEFAULT 0,
    maxAttempts INTEGER DEFAULT 3,
    lockedAt TEXT,
    nextRunAt TEXT,
    renderMode TEXT DEFAULT 'html',
    respectRobots INTEGER DEFAULT 1,
    includeQueryStrings INTEGER DEFAULT 0,
    userAgent TEXT
  );

  CREATE TABLE IF NOT EXISTS crawl_pages (
    ownerId TEXT,
    siteUrl TEXT,
    jobId TEXT,
    url TEXT,
    normalizedUrl TEXT,
    pageKey TEXT,
    finalUrl TEXT,
    statusCode INTEGER,
    contentType TEXT,
    title TEXT,
    metaDescription TEXT,
    canonicalUrl TEXT,
    h1Text TEXT,
    h1Count INTEGER,
    h2Count INTEGER,
    wordCount INTEGER,
    depth INTEGER,
    discoveredFrom TEXT,
    discoveredFromUrl TEXT,
    discoveredAt TEXT,
    crawledAt TEXT,
    responseTimeMs INTEGER,
    noindex INTEGER DEFAULT 0,
    internalLinkCount INTEGER DEFAULT 0,
    outgoingLinkCount INTEGER DEFAULT 0,
    errorMessage TEXT,
    PRIMARY KEY (ownerId, siteUrl, jobId, normalizedUrl)
  );

  CREATE TABLE IF NOT EXISTS crawl_links (
    ownerId TEXT,
    siteUrl TEXT,
    jobId TEXT,
    fromUrl TEXT,
    toUrl TEXT,
    fromPageKey TEXT,
    toPageKey TEXT,
    discoveredAt TEXT,
    depth INTEGER,
    PRIMARY KEY (ownerId, siteUrl, jobId, fromUrl, toUrl)
  );
`;

const sqliteSchemaSql = `
  ${commonSchemaSql}
  CREATE TABLE IF NOT EXISTS server_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ownerId TEXT,
    siteUrl TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    ipAddress TEXT,
    httpMethod TEXT,
    urlPath TEXT NOT NULL,
    statusCode INTEGER,
    userAgent TEXT,
    botType TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

const postgresSchemaSql = `
  ${commonSchemaSql}
  CREATE TABLE IF NOT EXISTS server_logs (
    id BIGSERIAL PRIMARY KEY,
    ownerId TEXT,
    siteUrl TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    ipAddress TEXT,
    httpMethod TEXT,
    urlPath TEXT NOT NULL,
    statusCode INTEGER,
    userAgent TEXT,
    botType TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

const indexSql = `
  CREATE INDEX IF NOT EXISTS idx_server_logs_owner_site_time ON server_logs(ownerId, siteUrl, timestamp);
  CREATE INDEX IF NOT EXISTS idx_server_logs_owner_botType ON server_logs(ownerId, siteUrl, botType);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);
  CREATE INDEX IF NOT EXISTS idx_gsc_site_owner_site_date ON gsc_site_metrics(ownerId, siteUrl, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_query_owner_site_date ON gsc_query_metrics(ownerId, siteUrl, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_query_owner_site_date_query ON gsc_query_metrics(ownerId, siteUrl, date, query);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_date_page ON gsc_page_query_metrics(ownerId, siteUrl, date, page);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_date_query ON gsc_page_query_metrics(ownerId, siteUrl, date, query);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_page_date ON gsc_page_query_metrics(ownerId, siteUrl, page, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_pagekey_date ON gsc_page_query_metrics(ownerId, siteUrl, pageKey, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_date_pagekey ON gsc_page_query_metrics(ownerId, siteUrl, date, pageKey);
  CREATE INDEX IF NOT EXISTS idx_ga4_page_owner_property_date_key ON ga4_page_metrics(ownerId, propertyId, date, pageKey);
  CREATE INDEX IF NOT EXISTS idx_ga4_page_owner_property_key_date ON ga4_page_metrics(ownerId, propertyId, pageKey, date);
  CREATE INDEX IF NOT EXISTS idx_ga4_page_owner_property_date_path ON ga4_page_metrics(ownerId, propertyId, date, pagePath);
  CREATE INDEX IF NOT EXISTS idx_warehouse_jobs_queue ON warehouse_jobs(status, nextRunAt, updatedAt);
  CREATE INDEX IF NOT EXISTS idx_warehouse_jobs_owner_site ON warehouse_jobs(ownerId, siteUrl, updatedAt);
  CREATE INDEX IF NOT EXISTS idx_warehouse_jobs_owner_site_target_status ON warehouse_jobs(ownerId, siteUrl, targetDate, status);
  CREATE INDEX IF NOT EXISTS idx_crawl_jobs_owner_site_status ON crawl_jobs(ownerId, siteUrl, status, updatedAt);
  CREATE INDEX IF NOT EXISTS idx_crawl_jobs_queue ON crawl_jobs(status, nextRunAt, updatedAt);
  CREATE INDEX IF NOT EXISTS idx_crawl_pages_owner_site_job ON crawl_pages(ownerId, siteUrl, jobId);
  CREATE INDEX IF NOT EXISTS idx_crawl_pages_owner_site_job_crawled ON crawl_pages(ownerId, siteUrl, jobId, crawledAt, depth, url);
  CREATE INDEX IF NOT EXISTS idx_crawl_pages_owner_site_pagekey ON crawl_pages(ownerId, siteUrl, pageKey);
  CREATE INDEX IF NOT EXISTS idx_crawl_links_owner_site_job ON crawl_links(ownerId, siteUrl, jobId);
  CREATE INDEX IF NOT EXISTS idx_crawl_links_owner_site_job_tourl ON crawl_links(ownerId, siteUrl, jobId, toUrl);
`;

const camelCaseColumns: Record<string, string> = {
  ownerid: 'ownerId',
  createdat: 'createdAt',
  projectid: 'projectId',
  userid: 'userId',
  siteurl: 'siteUrl',
  tokenhash: 'tokenHash',
  expiresat: 'expiresAt',
  passwordhash: 'passwordHash',
  authprovider: 'authProvider',
  avatarurl: 'avatarUrl',
  bingapikey: 'bingApiKey',
  gscrefreshtoken: 'gscRefreshToken',
  knownsites: 'knownSites',
  unlockedsites: 'unlockedSites',
  onboardingcompleted: 'onboardingCompleted',
  activatedsiteurl: 'activatedSiteUrl',
  activatedga4propertyid: 'activatedGa4PropertyId',
  activatedga4displayname: 'activatedGa4DisplayName',
  billingstatus: 'billingStatus',
  subscriptionid: 'subscriptionId',
  trialendsat: 'trialEndsAt',
  currentperiodend: 'currentPeriodEnd',
  lastsyncdate: 'lastSyncDate',
  earliestsyncdate: 'earliestSyncDate',
  lastupdated: 'lastUpdated',
  jobtype: 'jobType',
  targetdate: 'targetDate',
  rowssynced: 'rowsSynced',
  keywordid: 'keywordId',
  rankingurl: 'rankingUrl',
  ipaddress: 'ipAddress',
  httpmethod: 'httpMethod',
  urlpath: 'urlPath',
  statuscode: 'statusCode',
  useragent: 'userAgent',
  bottype: 'botType',
  inspectionresult: 'inspectionResult',
  coveragestate: 'coverageState',
  lastinspectiontime: 'lastInspectionTime',
  earliestmetricdate: 'earliestMetricDate',
  lastmetricdate: 'lastMetricDate',
  metricdaycount: 'metricDayCount',
  querycount: 'queryCount',
  propertyid: 'propertyId',
  pagepath: 'pagePath',
  pagekey: 'pageKey',
  jobid: 'jobId',
  starturl: 'startUrl',
  sitemapurl: 'sitemapUrl',
  discoveredcount: 'discoveredCount',
  crawledcount: 'crawledCount',
  errorcount: 'errorCount',
  skippedcount: 'skippedCount',
  queuedcount: 'queuedCount',
  startedat: 'startedAt',
  updatedat: 'updatedAt',
  completedat: 'completedAt',
  lasterror: 'lastError',
  attemptcount: 'attemptCount',
  maxattempts: 'maxAttempts',
  lockedat: 'lockedAt',
  nextrunat: 'nextRunAt',
  rendermode: 'renderMode',
  respectrobots: 'respectRobots',
  includequerystrings: 'includeQueryStrings',
  normalizedurl: 'normalizedUrl',
  finalurl: 'finalUrl',
  contenttype: 'contentType',
  metadescription: 'metaDescription',
  canonicalurl: 'canonicalUrl',
  h1text: 'h1Text',
  h1count: 'h1Count',
  h2count: 'h2Count',
  wordcount: 'wordCount',
  discoveredfrom: 'discoveredFrom',
  discoveredfromurl: 'discoveredFromUrl',
  discoveredat: 'discoveredAt',
  crawledat: 'crawledAt',
  responsetimems: 'responseTimeMs',
  internallinkcount: 'internalLinkCount',
  outgoinglinkcount: 'outgoingLinkCount',
  fromurl: 'fromUrl',
  tourl: 'toUrl',
  frompagekey: 'fromPageKey',
  topagekey: 'toPageKey',
  totalusers: 'totalUsers',
  pageviews: 'pageViews',
  bouncerate: 'bounceRate',
  eventcount: 'eventCount',
};

function normalizeRow<T>(row: T): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return row;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    normalized[camelCaseColumns[key] || key] = value;
  }
  return normalized as T;
}

function normalizeSqlForPostgres(sql: string) {
  return sql
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO')
    .replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'INSERT INTO')
    .replace(/\bIFNULL\s*\(/gi, 'COALESCE(')
    .replace(/MAX\(SUM\(impressions\),\s*1\)/gi, 'GREATEST(SUM(impressions), 1)')
    .replace(/\bAUTOINCREMENT\b/gi, '');
}

function bindPostgresParams(sql: string, params?: QueryParams) {
  const values: unknown[] = [];

  if (!params) {
    return { sql: normalizeSqlForPostgres(sql), values };
  }

  if (Array.isArray(params)) {
    let index = 0;
    return {
      sql: normalizeSqlForPostgres(sql.replace(/\?/g, () => `$${++index}`)),
      values: params,
    };
  }

  const positions = new Map<string, number>();
  const boundSql = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    if (!positions.has(name)) {
      positions.set(name, values.push(params[name]));
    }
    return `$${positions.get(name)}`;
  });

  return { sql: normalizeSqlForPostgres(boundSql), values };
}

class SqliteAppDatabase implements AppDatabase {
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
    const row = params === undefined ? statement.get() : statement.get(params as any);
    return normalizeRow(row as T | undefined);
  }

  async all<T = unknown>(sql: string, params?: QueryParams) {
    const statement = this.db.prepare(sql);
    const rows = params === undefined ? statement.all() : statement.all(params as any);
    return rows.map((row) => normalizeRow(row as T));
  }

  async run(sql: string, params?: QueryParams) {
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

class PostgresAppDatabase implements AppDatabase {
  dialect = 'postgres' as const;
  private readonly transactionContext = new AsyncLocalStorage<PgQueryable>();

  constructor(private readonly pool: pg.Pool) {}

  prepare(_sql: string) {
    throw new Error('This route still uses the legacy synchronous SQLite API and must be migrated before PostgreSQL mode can run it.');
  }

  async exec(sql: string) {
    await (this.transactionContext.getStore() || this.pool).query(normalizeSqlForPostgres(sql));
  }

  async get<T = unknown>(sql: string, params?: QueryParams) {
    const { sql: boundSql, values } = bindPostgresParams(sql, params);
    const result = await (this.transactionContext.getStore() || this.pool).query(boundSql, values);
    return normalizeRow(result.rows[0] as T | undefined);
  }

  async all<T = unknown>(sql: string, params?: QueryParams) {
    const { sql: boundSql, values } = bindPostgresParams(sql, params);
    const result = await (this.transactionContext.getStore() || this.pool).query(boundSql, values);
    return result.rows.map((row) => normalizeRow(row as T));
  }

  async run(sql: string, params?: QueryParams) {
    const { sql: boundSql, values } = bindPostgresParams(sql, params);
    const result = await (this.transactionContext.getStore() || this.pool).query(boundSql, values);
    return { changes: result.rowCount || 0 };
  }

  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await this.transactionContext.run(client, () => callback(...args));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
  }

  async close() {
    await this.pool.end();
  }
}

function isSqliteCorruptionError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'SQLITE_CORRUPT',
  );
}

function removeIfExists(filePath: string) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function archiveIfExists(filePath: string, label: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const archivedPath = `${filePath}.${label}`;
  removeIfExists(archivedPath);
  fs.renameSync(filePath, archivedPath);
}

function archiveDatabaseFiles(label: string, includePrimary = true) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveLabel = `${label}.${timestamp}`;

  if (includePrimary) {
    archiveIfExists(DB_FILENAME, archiveLabel);
  }

  archiveIfExists(`${DB_FILENAME}-wal`, archiveLabel);
  archiveIfExists(`${DB_FILENAME}-shm`, archiveLabel);
}

function createSqliteConnection() {
  try {
    return new Database(DB_FILENAME);
  } catch (error) {
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }
  }

  archiveDatabaseFiles('corrupt-wal-recovery', false);

  try {
    return new Database(DB_FILENAME);
  } catch (error) {
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }
  }

  if (fs.existsSync(DB_BACKUP_FILENAME)) {
    archiveDatabaseFiles('corrupt-primary');
    fs.copyFileSync(DB_BACKUP_FILENAME, DB_FILENAME);

    try {
      return new Database(DB_FILENAME);
    } catch (error) {
      if (!isSqliteCorruptionError(error)) {
        throw error;
      }
    }
  }

  archiveDatabaseFiles('fresh-db-reset');
  removeIfExists(DB_FILENAME);
  removeIfExists(`${DB_FILENAME}-wal`);
  removeIfExists(`${DB_FILENAME}-shm`);
  return new Database(DB_FILENAME);
}

function runOptionalSqliteAlter(db: Database.Database, statement: string) {
  try {
    db.exec(statement);
  } catch {
    // Column likely already exists.
  }
}

function applySqliteMigrations(db: Database.Database) {
  db.exec(sqliteSchemaSql);

  for (const statement of [
    'ALTER TABLE users ADD COLUMN passwordHash TEXT',
    "ALTER TABLE users ADD COLUMN authProvider TEXT DEFAULT 'local'",
    'ALTER TABLE users ADD COLUMN bingApiKey TEXT',
    'ALTER TABLE users ADD COLUMN name TEXT',
    'ALTER TABLE users ADD COLUMN company TEXT',
    'ALTER TABLE users ADD COLUMN avatarUrl TEXT',
    'ALTER TABLE users ADD COLUMN bio TEXT',
    'ALTER TABLE users ADD COLUMN onboardingCompleted INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN activatedSiteUrl TEXT',
    'ALTER TABLE users ADD COLUMN activatedGa4PropertyId TEXT',
    'ALTER TABLE users ADD COLUMN activatedGa4DisplayName TEXT',
    "ALTER TABLE users ADD COLUMN billingStatus TEXT DEFAULT 'active'",
    'ALTER TABLE users ADD COLUMN subscriptionId TEXT',
    'ALTER TABLE users ADD COLUMN trialEndsAt TEXT',
    'ALTER TABLE users ADD COLUMN currentPeriodEnd TEXT',
    'ALTER TABLE tracked_keywords ADD COLUMN targetDomain TEXT',
    'ALTER TABLE tracked_keywords ADD COLUMN ownerId TEXT',
    'ALTER TABLE server_logs ADD COLUMN ownerId TEXT',
    'ALTER TABLE url_inspection_cache ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_site_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_query_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_page_query_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_page_query_metrics ADD COLUMN pageKey TEXT',
    'ALTER TABLE warehouse_sync_status ADD COLUMN ownerId TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN ownerId TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN attemptCount INTEGER DEFAULT 0',
    'ALTER TABLE crawl_jobs ADD COLUMN maxAttempts INTEGER DEFAULT 3',
    'ALTER TABLE crawl_jobs ADD COLUMN lockedAt TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN nextRunAt TEXT',
    "ALTER TABLE crawl_jobs ADD COLUMN renderMode TEXT DEFAULT 'html'",
    'ALTER TABLE crawl_jobs ADD COLUMN respectRobots INTEGER DEFAULT 1',
    'ALTER TABLE crawl_jobs ADD COLUMN includeQueryStrings INTEGER DEFAULT 0',
    'ALTER TABLE crawl_jobs ADD COLUMN userAgent TEXT',
    'ALTER TABLE crawl_pages ADD COLUMN ownerId TEXT',
    'ALTER TABLE crawl_links ADD COLUMN ownerId TEXT',
  ]) {
    runOptionalSqliteAlter(db, statement);
  }

  db.exec(indexSql);
}

async function applyPostgresMigrations(db: AppDatabase) {
  await db.exec(postgresSchemaSql);

  for (const statement of [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS passwordHash TEXT',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS authProvider TEXT DEFAULT 'local'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS bingApiKey TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS company TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatarUrl TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS onboardingCompleted INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS activatedSiteUrl TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS activatedGa4PropertyId TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS activatedGa4DisplayName TEXT',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS billingStatus TEXT DEFAULT 'active'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS subscriptionId TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS trialEndsAt TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS currentPeriodEnd TEXT',
    'ALTER TABLE tracked_keywords ADD COLUMN IF NOT EXISTS targetDomain TEXT',
    'ALTER TABLE tracked_keywords ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE server_logs ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE url_inspection_cache ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_site_metrics ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_query_metrics ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_page_query_metrics ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_page_query_metrics ADD COLUMN IF NOT EXISTS pageKey TEXT',
    'ALTER TABLE warehouse_sync_status ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS attemptCount INTEGER DEFAULT 0',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS maxAttempts INTEGER DEFAULT 3',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS lockedAt TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS nextRunAt TEXT',
    "ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS renderMode TEXT DEFAULT 'html'",
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS respectRobots INTEGER DEFAULT 1',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS includeQueryStrings INTEGER DEFAULT 0',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS userAgent TEXT',
    'ALTER TABLE crawl_pages ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE crawl_links ADD COLUMN IF NOT EXISTS ownerId TEXT',
  ]) {
    await db.exec(statement);
  }

  await db.exec("UPDATE crawl_pages SET jobId = 'legacy' WHERE jobId IS NULL");
  await db.exec("UPDATE crawl_links SET jobId = 'legacy' WHERE jobId IS NULL");
  await db.exec('ALTER TABLE crawl_pages DROP CONSTRAINT IF EXISTS crawl_pages_pkey');
  await db.exec('ALTER TABLE crawl_pages ADD PRIMARY KEY (ownerId, siteUrl, jobId, normalizedUrl)');
  await db.exec('ALTER TABLE crawl_links DROP CONSTRAINT IF EXISTS crawl_links_pkey');
  await db.exec('ALTER TABLE crawl_links ADD PRIMARY KEY (ownerId, siteUrl, jobId, fromUrl, toUrl)');

  await db.exec(indexSql);
}

export async function initializeDatabase(): Promise<AppDatabase> {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

  if (databaseUrl) {
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    const db = new PostgresAppDatabase(pool);
    await applyPostgresMigrations(db);
    console.log('[db] Connected to PostgreSQL');
    return db;
  }

  const sqlite = createSqliteConnection();
  applySqliteMigrations(sqlite);
  console.log('[db] Connected to local SQLite');
  return new SqliteAppDatabase(sqlite);
}
