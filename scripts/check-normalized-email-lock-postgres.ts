import { AsyncLocalStorage } from 'node:async_hooks';
import dotenv from 'dotenv';
import pg from 'pg';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { withNormalizedEmailLock } from '../server/services/normalizedEmailLock.js';

dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ path: '.env', quiet: true });

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!databaseUrl) {
  console.log('PostgreSQL normalized-email lock check skipped: DATABASE_URL/POSTGRES_URL is unset.');
  process.exit(0);
}

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 2 });

class PostgresLockProbe implements AppDatabase {
  dialect = 'postgres' as const;
  private readonly context = new AsyncLocalStorage<pg.PoolClient>();

  prepare() { throw new Error('prepare is not used'); }
  async exec() { throw new Error('exec is not used'); }

  async get<T = unknown>(sql: string, params: QueryParams = []) {
    const client = this.context.getStore();
    if (!client) throw new Error('Lock query escaped its transaction');
    let index = 0;
    const boundSql = sql.replace(/\?/g, () => `$${++index}`);
    const result = await client.query(boundSql, params as unknown[]);
    return result.rows[0] as T | undefined;
  }

  async all<T = unknown>() { return [] as T[]; }
  async run(): Promise<RunResult> { return { changes: 0 }; }

  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await this.context.run(client, () => callback(...args));
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
}

let enterFirst!: () => void;
const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
let releaseFirst!: () => void;
const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
const email = `lock-probe-${process.pid}@example.invalid`;

try {
  const first = withNormalizedEmailLock(new PostgresLockProbe(), email, async () => {
    enterFirst();
    await firstRelease;
  });
  await firstEntered;

  const startedAt = performance.now();
  const second = withNormalizedEmailLock(new PostgresLockProbe(), email, async () => performance.now() - startedAt);
  await new Promise((resolve) => setTimeout(resolve, 80));
  releaseFirst();

  const [, secondWaitMs] = await Promise.all([first, second]);
  if (secondWaitMs < 60) {
    throw new Error(`PostgreSQL same-email advisory lock waited only ${secondWaitMs.toFixed(1)}ms`);
  }

  console.log(JSON.stringify({ advisoryLockBlockedConcurrentEmail: true, secondWaitMs: Math.round(secondWaitMs) }, null, 2));
} finally {
  await pool.end();
}
