import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { withNormalizedEmailLock } from '../server/services/normalizedEmailLock.js';

class LockProbeDatabase implements AppDatabase {
  dialect = 'sqlite' as const;
  prepare() { throw new Error('prepare is not used'); }
  async exec() {}
  async get<T = unknown>(_sql: string, _params?: QueryParams) { return undefined as T | undefined; }
  async all<T = unknown>() { return [] as T[]; }
  async run(_sql: string, _params?: QueryParams): Promise<RunResult> { return { changes: 0 }; }
  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => callback(...args);
  }
}

const db = new LockProbeDatabase();
let active = 0;
let peakActive = 0;
const order: string[] = [];

const probe = (label: string, email: string) => withNormalizedEmailLock(db, email, async () => {
  active += 1;
  peakActive = Math.max(peakActive, active);
  order.push(`${label}:start`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  order.push(`${label}:end`);
  active -= 1;
});

await Promise.all([
  probe('first', 'same@example.com'),
  probe('second', 'same@example.com'),
]);

if (peakActive !== 1) {
  throw new Error(`Same-email SQLite callbacks overlapped; peak concurrency was ${peakActive}`);
}
if (order.join(',') !== 'first:start,first:end,second:start,second:end') {
  throw new Error(`Same-email lock order was not deterministic: ${order.join(',')}`);
}

active = 0;
peakActive = 0;
await Promise.all([
  probe('alpha', 'alpha@example.com'),
  probe('beta', 'beta@example.com'),
]);
if (peakActive !== 2) {
  throw new Error(`Different-email callbacks were unnecessarily serialized; peak concurrency was ${peakActive}`);
}

console.log(JSON.stringify({ differentEmailsPeakConcurrency: peakActive, sameEmailOrder: order.slice(0, 4) }, null, 2));
