import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import {
  runIntentClassificationWarehouseJob,
  setWarehouseIntentClassifier,
} from '../server/services/intentClassificationWarehouse.js';

class MemoryDatabase implements AppDatabase {
  dialect = 'sqlite' as const;
  constructor(private readonly db: Database.Database) {}
  prepare(sql: string) { return this.db.prepare(sql); }
  async exec(sql: string) { this.db.exec(sql); }
  async get<T = unknown>(sql: string, params?: QueryParams) {
    return (params === undefined ? this.db.prepare(sql).get() : this.db.prepare(sql).get(params as any)) as T | undefined;
  }
  async all<T = unknown>(sql: string, params?: QueryParams) {
    return (params === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(params as any)) as T[];
  }
  async run(sql: string, params?: QueryParams): Promise<RunResult> {
    const result = params === undefined ? this.db.prepare(sql).run() : this.db.prepare(sql).run(params as any);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }
  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => callback(...args);
  }
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const raw = new Database(':memory:');
const db = new MemoryDatabase(raw);
await db.exec(`
  CREATE TABLE gsc_query_metrics (ownerId TEXT, siteUrl TEXT, date TEXT, query TEXT);
  CREATE TABLE gsc_query_intent_cache (
    ownerId TEXT, siteUrl TEXT, query TEXT, modelVersion TEXT, intent TEXT,
    confidence REAL DEFAULT 0, reason TEXT, status TEXT DEFAULT 'pending',
    attemptCount INTEGER DEFAULT 0, nextRunAt TEXT, lastError TEXT,
    createdAt TEXT, updatedAt TEXT, classifiedAt TEXT,
    PRIMARY KEY (ownerId, siteUrl, query, modelVersion)
  );
`);
await db.run('INSERT INTO gsc_query_metrics (ownerId, siteUrl, date, query) VALUES (?, ?, ?, ?)', ['u1', 'example.com', '2026-08-10', 'brand pricing']);
await db.run('INSERT INTO gsc_query_metrics (ownerId, siteUrl, date, query) VALUES (?, ?, ?, ?)', ['u1', 'example.com', '2026-08-10', 'how to visit']);

let calls = 0;
let failNext = false;
setWarehouseIntentClassifier(async ({ queries }) => {
  calls += 1;
  if (failNext) {
    failNext = false;
    throw new Error('temporary provider outage');
  }
  return queries.map((query) => ({
    confidence: 0.9,
    intent: query.includes('pricing') ? 'Commercial' as const : 'Informational' as const,
    query,
    reason: 'fixture',
  }));
});

const first = await runIntentClassificationWarehouseJob(db, { modelVersion: 'test-v1', ownerId: 'u1', siteUrl: 'example.com' });
assert(first.processed === 2, `expected first run to process 2 queries, got ${first.processed}`);
assert(calls === 1, `expected one provider batch, got ${calls}`);
const cached = await db.all<{ intent: string; status: string; confidence: number; modelVersion: string }>('SELECT intent, status, confidence, modelVersion FROM gsc_query_intent_cache ORDER BY query');
assert(cached.every((row) => row.status === 'completed' && row.modelVersion === 'test-v1'), 'classified rows were not persisted as completed model-versioned cache entries');
assert(cached[0]?.confidence === 0.9, 'classifier confidence was not persisted');

const second = await runIntentClassificationWarehouseJob(db, { modelVersion: 'test-v1', ownerId: 'u1', siteUrl: 'example.com' });
assert(second.processed === 0 && second.skipped === 2, 'second run should reuse cache without provider work');
assert(calls === 1, 'cache hit unexpectedly invoked provider again');

failNext = true;
const retried = await runIntentClassificationWarehouseJob(db, { modelVersion: 'test-v2', ownerId: 'u1', siteUrl: 'example.com' });
assert(retried.processed === 2, 'provider retry should eventually classify the batch');
assert(calls === 3, `expected one failed attempt plus one retry, got ${calls} provider calls`);

setWarehouseIntentClassifier(null);
await raw.close();
console.log('Intent classification warehouse lifecycle checks passed.');
