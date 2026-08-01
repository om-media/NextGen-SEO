import multer from 'multer';
import type { AddressInfo } from 'node:net';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { buildApp } from '../server/app.js';

class NoopDatabase implements AppDatabase {
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

const app = buildApp({
  db: new NoopDatabase(),
  getSyncJobKey: (ownerId, siteUrl) => `${ownerId}:${siteUrl}`,
  startWorkers: false,
  syncJobs: new Map(),
  upload: multer({ storage: multer.memoryStorage() }),
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});

try {
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    body: '{',
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();

  if (response.status !== 400) throw new Error(`Malformed JSON returned ${response.status}, expected 400`);
  if (!contentType.includes('application/json')) {
    throw new Error(`Malformed JSON returned ${contentType || 'no content type'}, expected application/json`);
  }
  const payload = JSON.parse(body);
  if (payload?.code !== 'INVALID_JSON') {
    throw new Error(`Malformed JSON returned code ${String(payload?.code)}, expected INVALID_JSON`);
  }

  console.log(JSON.stringify({ code: payload.code, contentType, status: response.status }, null, 2));
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
