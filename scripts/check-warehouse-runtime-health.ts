import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';

const { getWarehouseRuntimeHealth } = await import('../server/services/warehouseJobs.js');

class MemoryDatabase implements AppDatabase {
  dialect = 'sqlite' as const;
  constructor(private readonly db: Database.Database) {}  prepare(sql: string) { return this.db.prepare(sql); }
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
  async exec(sql: string) { this.db.exec(sql); }
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
  async close() { this.db.close(); }
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const raw = new Database(':memory:');
const db = new MemoryDatabase(raw);
await db.exec(`
  CREATE TABLE warehouse_runtime_heartbeats (
    role TEXT PRIMARY KEY,
    processId TEXT,
    startedAt TEXT NOT NULL,
    lastTickStartedAt TEXT,
    lastTickSuccessAt TEXT,
    lastTickErrorAt TEXT,
    lastErrorCode TEXT,
    lastTickProcessedCount INTEGER DEFAULT 0,
    updatedAt TEXT NOT NULL
  );
  CREATE TABLE warehouse_jobs (
    id TEXT PRIMARY KEY,
    status TEXT,
    nextRunAt TEXT,
    updatedAt TEXT,
    startedAt TEXT,
    lockedAt TEXT,
    lastError TEXT
  );
`);

const observedAt = new Date('2026-08-02T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(observedAt.getTime() - minutes * 60_000).toISOString();
await db.run(
  `INSERT INTO warehouse_runtime_heartbeats
    (role, processId, startedAt, lastTickStartedAt, lastTickSuccessAt, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?)`,
  ['warehouse', 'test-worker', minutesAgo(30), minutesAgo(1), minutesAgo(1), observedAt.toISOString()],
);
const jobs = [
  ['queued-old', 'queued', minutesAgo(20), minutesAgo(20), null, null, null],
  ['retrying', 'retrying', minutesAgo(5), minutesAgo(5), null, null, null],
  ['running-stale', 'running', null, minutesAgo(15), minutesAgo(15), minutesAgo(15), null],
  ['auth-error', 'error', null, minutesAgo(1), null, null, 'invalid_grant: revoked token'],
  ['quota-error', 'error', null, minutesAgo(2), null, null, '429 quota exceeded'],
];
for (const job of jobs) {
  await db.run('INSERT INTO warehouse_jobs (id, status, nextRunAt, updatedAt, startedAt, lockedAt, lastError) VALUES (?, ?, ?, ?, ?, ?, ?)', job);
}

const health = await getWarehouseRuntimeHealth(db, 'warehouse', observedAt.toISOString());
assert(health.queue.queuedCount === 1, `Expected one queued job, got ${health.queue.queuedCount}`);
assert(health.queue.retryingCount === 1, `Expected one retrying job, got ${health.queue.retryingCount}`);
assert(health.queue.readyCount === 2, `Expected two ready jobs, got ${health.queue.readyCount}`);
assert(health.queue.staleRunningCount === 1, `Expected one stale running job, got ${health.queue.staleRunningCount}`);
assert(health.recentFailures.auth === 1, `Expected one auth failure, got ${health.recentFailures.auth}`);
assert(health.recentFailures.quota === 1, `Expected one quota failure, got ${health.recentFailures.quota}`);
assert(health.status === 'degraded', `Expected degraded status, got ${health.status}`);
assert((health.queue.oldestReadyAgeMs || 0) >= 20 * 60_000, 'Expected queue age to be reported');
await db.run('UPDATE warehouse_runtime_heartbeats SET lastTickStartedAt = ?, lastTickSuccessAt = ? WHERE role = ?', [minutesAgo(5), minutesAgo(5), 'warehouse']);
const staleHeartbeatHealth = await getWarehouseRuntimeHealth(db, 'warehouse', observedAt.toISOString());
assert(staleHeartbeatHealth.status === 'degraded', `Expected stale heartbeat to degrade readiness, got ${staleHeartbeatHealth.status}`);

console.log(JSON.stringify({ ok: true, status: health.status, queue: health.queue, recentFailures: health.recentFailures }, null, 2));
await db.close();