import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import {
  claimNextWarehouseJob,
  createWarehouseJobLease,
  finalizeOwnedWarehouseJob,
  recoverStaleWarehouseJobs,
  WarehouseJobLeaseLostError,
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

const raw = new Database(':memory:');
const db = new MemoryDatabase(raw);

try {
  await db.exec(`
    CREATE TABLE warehouse_jobs (
      id TEXT PRIMARY KEY,
      ownerId TEXT,
      siteUrl TEXT,
      propertyId TEXT,
      jobType TEXT,
      status TEXT NOT NULL,
      targetStartDate TEXT,
      targetDate TEXT,
      priority INTEGER DEFAULT 0,
      attemptCount INTEGER DEFAULT 0,
      maxAttempts INTEGER DEFAULT 3,
      lockedAt TEXT,
      nextRunAt TEXT,
      startedAt TEXT,
      updatedAt TEXT,
      completedAt TEXT,
      lastError TEXT,
      metricsJson TEXT,
      rowsSynced INTEGER
    );
  `);

  const initialLease = '2026-07-14T08:00:00.000Z';
  await db.run(
    "INSERT INTO warehouse_jobs (id, status, lockedAt, updatedAt) VALUES (?, 'running', ?, ?)",
    ['owned-job', initialLease, initialLease],
  );
  const ownedJob = await db.get<any>('SELECT * FROM warehouse_jobs WHERE id = ?', ['owned-job']);
  assert.ok(ownedJob);
  const staleWorker = { ...ownedJob };

  const lease = createWarehouseJobLease(db, ownedJob, 5);
  await lease.refresh();
  const firstRefresh = ownedJob.lockedAt;
  assert.notEqual(firstRefresh, initialLease, 'An owned job heartbeat should rotate its lease value');

  await new Promise((resolve) => setTimeout(resolve, 25));
  const heartbeatRow = await db.get<any>('SELECT * FROM warehouse_jobs WHERE id = ?', ['owned-job']);
  assert.notEqual(heartbeatRow?.lockedAt, firstRefresh, 'The heartbeat timer should keep renewing a running job lease');

  await assert.rejects(
    () => finalizeOwnedWarehouseJob(db, staleWorker, { completedAt: '2026-07-14T08:01:00.000Z', status: 'completed' }),
    WarehouseJobLeaseLostError,
    'A worker holding an old lease must not finalize the job',
  );
  const afterStaleFinalize = await db.get<any>('SELECT * FROM warehouse_jobs WHERE id = ?', ['owned-job']);
  assert.equal(afterStaleFinalize?.status, 'running', 'A stale finalizer must leave the current worker state unchanged');

  await lease.finalize({ completedAt: '2026-07-14T08:02:00.000Z', status: 'completed' });
  await lease.stop();
  const completed = await db.get<any>('SELECT * FROM warehouse_jobs WHERE id = ?', ['owned-job']);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.lockedAt, null, 'Finalization should release the owned lease');

  await db.run(
    "INSERT INTO warehouse_jobs (id, status, lockedAt, updatedAt) VALUES (?, 'running', ?, ?)",
    ['stale-job', '2026-07-13T23:00:00.000Z', '2026-07-13T23:00:00.000Z'],
  );
  await db.run(
    "INSERT INTO warehouse_jobs (id, status, lockedAt, updatedAt) VALUES (?, 'running', ?, ?)",
    ['fresh-job', '2026-07-14T08:05:00.000Z', '2026-07-14T08:05:00.000Z'],
  );

  await recoverStaleWarehouseJobs(
    db,
    '2026-07-14T08:00:00.000Z',
    '2026-07-14T08:10:00.000Z',
  );

  const stale = await db.get<any>('SELECT * FROM warehouse_jobs WHERE id = ?', ['stale-job']);
  const fresh = await db.get<any>('SELECT * FROM warehouse_jobs WHERE id = ?', ['fresh-job']);
  assert.equal(stale?.status, 'queued', 'Recovery should requeue an expired running lease');
  assert.equal(stale?.lockedAt, null);
  assert.equal(fresh?.status, 'running', 'Recovery must not reclaim a recently renewed lease');
  assert.equal(fresh?.lockedAt, '2026-07-14T08:05:00.000Z');
  await db.run("UPDATE warehouse_jobs SET status = 'completed', lockedAt = NULL WHERE id IN (?, ?)", ['stale-job', 'fresh-job']);
  await db.run(
    "INSERT INTO warehouse_jobs (id, ownerId, siteUrl, status, lockedAt, updatedAt, targetDate) VALUES (?, ?, ?, 'running', ?, ?, ?)",
    ['site-a-running', 'owner-a', 'site-a', '2026-07-14T08:10:00.000Z', '2026-07-14T08:10:00.000Z', '2026-07-12'],
  );
  await db.run(
    "INSERT INTO warehouse_jobs (id, ownerId, siteUrl, status, updatedAt, targetDate) VALUES (?, ?, ?, 'queued', ?, ?)",
    ['site-a-queued', 'owner-a', 'site-a', '2026-07-14T08:11:00.000Z', '2026-07-11'],
  );
  await db.run(
    "INSERT INTO warehouse_jobs (id, ownerId, siteUrl, status, updatedAt, targetDate) VALUES (?, ?, ?, 'queued', ?, ?)",
    ['site-b-queued', 'owner-a', 'site-b', '2026-07-14T08:11:00.000Z', '2026-07-10'],
  );

  const crossSiteClaim = await claimNextWarehouseJob(db);
  assert.equal(crossSiteClaim?.id, 'site-b-queued', 'A busy site must not prevent another site from using worker capacity');
  const siteBLease = createWarehouseJobLease(db, crossSiteClaim!, 60_000);
  await siteBLease.finalize({ completedAt: '2026-07-14T08:12:00.000Z', status: 'completed' });
  await siteBLease.stop();

  const blockedClaim = await claimNextWarehouseJob(db);
  assert.equal(blockedClaim, null, 'A second warehouse job for a running site must remain queued');
  await db.run("UPDATE warehouse_jobs SET status = 'completed', lockedAt = NULL WHERE id = ?", ['site-a-running']);
  const resumedClaim = await claimNextWarehouseJob(db);
  assert.equal(resumedClaim?.id, 'site-a-queued', 'The next site job should become claimable after the active job completes');

  console.log('Warehouse job lease heartbeat, fencing, recovery, and per-site serialization checks passed.');
} finally {
  await db.close();
}
