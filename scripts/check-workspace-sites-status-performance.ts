import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';

class CountingDatabase implements AppDatabase {
  dialect = 'sqlite' as const;
  queryCount = 0;

  constructor(private readonly db: Database.Database) {}

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  async exec(sql: string) {
    this.db.exec(sql);
  }

  async get<T = unknown>(sql: string, params?: QueryParams) {
    this.queryCount += 1;
    const statement = this.db.prepare(sql);
    return (params === undefined ? statement.get() : statement.get(params as any)) as T | undefined;
  }

  async all<T = unknown>(sql: string, params?: QueryParams) {
    this.queryCount += 1;
    const statement = this.db.prepare(sql);
    return (params === undefined ? statement.all() : statement.all(params as any)) as T[];
  }

  async run(sql: string, params?: QueryParams): Promise<RunResult> {
    const statement = this.db.prepare(sql);
    const result = params === undefined ? statement.run() : statement.run(params as any);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => callback(...args);
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

  post() {}
  put() {}
  delete() {}
}

class FakeResponse {
  statusCode = 200;
  body: unknown = null;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: unknown) {
    this.body = body;
    return this;
  }
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const db = new CountingDatabase(new Database(':memory:'));
await db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    tier TEXT,
    unlockedSites TEXT,
    knownSites TEXT,
    activatedSiteUrl TEXT,
    activatedGa4PropertyId TEXT
  );
  CREATE TABLE gsc_site_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT
  );
  CREATE TABLE warehouse_sync_status (
    ownerId TEXT,
    siteUrl TEXT,
    status TEXT,
    lastSyncDate TEXT,
    lastUpdated TEXT
  );
  CREATE TABLE warehouse_jobs (
    id TEXT PRIMARY KEY,
    ownerId TEXT,
    siteUrl TEXT,
    jobType TEXT,
    status TEXT,
    targetStartDate TEXT,
    targetDate TEXT,
    rowsSynced INTEGER,
    lastError TEXT,
    updatedAt TEXT
  );
  CREATE TABLE crawl_jobs (
    id TEXT PRIMARY KEY,
    ownerId TEXT,
    siteUrl TEXT,
    completedAt TEXT,
    crawledCount INTEGER,
    discoveredCount INTEGER,
    errorCount INTEGER,
    lastError TEXT,
    renderMode TEXT,
    startedAt TEXT,
    status TEXT,
    updatedAt TEXT
  );
  CREATE TABLE crawl_pages (
    ownerId TEXT,
    siteUrl TEXT,
    jobId TEXT,
    statusCode INTEGER,
    noindex INTEGER
  );
`);

const ownerId = 'performance-owner';
const sites = Array.from({ length: 50 }, (_, index) => `https://site-${index + 1}.example`);
await db.run(
  'INSERT INTO users (id, tier, unlockedSites, knownSites, activatedSiteUrl, activatedGa4PropertyId) VALUES (?, ?, ?, ?, ?, ?)',
  [ownerId, 'pro', JSON.stringify(sites), '[]', sites[0], null],
);
for (const siteUrl of sites) {
  await db.run('INSERT INTO gsc_site_metrics (ownerId, siteUrl, date) VALUES (?, ?, ?)', [ownerId, siteUrl, '2026-01-01']);
}

const { registerWorkspaceCrudRoutes } = await import('../server/routes/workspaceCrud.js');
const app = new FakeApp();
registerWorkspaceCrudRoutes(app as any, db);
const handler = app.routes.get('GET:/api/workspace/sites/status')?.at(-1);
assert(handler, 'Missing workspace sites status handler');

const response = new FakeResponse();
await handler!({ authUser: { uid: ownerId } }, response);
assert(response.statusCode === 200, `Workspace status returned ${response.statusCode}`);
const body = response.body as { sites?: unknown[] };
assert(body.sites?.length === sites.length, `Expected ${sites.length} sites, got ${body.sites?.length ?? 0}`);
assert(db.queryCount <= 12, `Workspace status used ${db.queryCount} database queries; expected at most 12 for 50 sites`);

console.log(JSON.stringify({ ok: true, siteCount: sites.length, queryCount: db.queryCount }, null, 2));
await db.close();
