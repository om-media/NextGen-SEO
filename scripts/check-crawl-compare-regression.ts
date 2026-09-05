import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { compareCrawlJobs } from '../server/services/crawl.js';

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
    return async (...args: Args) => callback(...args);
  }

  async close() {
    this.db.close();
  }
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const db = new MemoryDatabase(new Database(':memory:'));
await db.exec(`
  CREATE TABLE crawl_jobs (
    id TEXT PRIMARY KEY,
    ownerId TEXT,
    siteUrl TEXT,
    completedAt TEXT,
    updatedAt TEXT,
    startedAt TEXT
  );
  CREATE TABLE crawl_pages (
    ownerId TEXT,
    siteUrl TEXT,
    jobId TEXT,
    pageKey TEXT,
    normalizedUrl TEXT,
    url TEXT,
    statusCode INTEGER,
    title TEXT,
    canonicalUrl TEXT
  );
`);

const ownerId = 'compare-owner';
const siteUrl = 'https://example.test';
await db.run('INSERT INTO crawl_jobs VALUES (?, ?, ?, ?, ?, ?)', ['base', ownerId, siteUrl, '2026-02-02', '2026-02-02', '2026-02-02']);
await db.run('INSERT INTO crawl_jobs VALUES (?, ?, ?, ?, ?, ?)', ['compare', ownerId, siteUrl, '2026-02-01', '2026-02-01', '2026-02-01']);

const insertPage = (jobId: string, pageKey: string, statusCode: number, title: string, canonicalUrl: string) =>
  db.run('INSERT INTO crawl_pages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [ownerId, siteUrl, jobId, pageKey, pageKey, pageKey, statusCode, title, canonicalUrl]);

await insertPage('base', '/a', 200, 'A', '/a');
await insertPage('base', '/b', 404, 'B', '/b');
await insertPage('base', '/c', 200, 'New C', '/c');
await insertPage('base', '/d', 200, 'D', '/new-d');
await insertPage('base', '/e', 200, 'E', '/e');
await insertPage('compare', '/a', 200, 'A', '/a');
await insertPage('compare', '/b', 200, 'B', '/b');
await insertPage('compare', '/c', 200, 'Old C', '/c');
await insertPage('compare', '/d', 200, 'D', '/old-d');
await insertPage('compare', '/missing', 200, 'Missing', '/missing');

const result = await compareCrawlJobs(db, ownerId, siteUrl, 'base', 'compare');
assert(JSON.stringify(result.summary) === JSON.stringify({
  canonicalChanged: 1,
  missing: 1,
  new: 1,
  statusChanged: 1,
  titleChanged: 1,
  unchanged: 1,
}), `Unexpected crawl comparison summary: ${JSON.stringify(result.summary)}`);
assert(result.samples.new[0]?.url === '/e', 'New-page sample should identify /e');
assert(result.samples.missing[0]?.url === '/missing', 'Missing-page sample should identify /missing');
assert(result.samples.statusChanged[0]?.currentStatus === 404, 'Status sample should preserve current status');

console.log(JSON.stringify({ ok: true, summary: result.summary }, null, 2));
await db.close();
