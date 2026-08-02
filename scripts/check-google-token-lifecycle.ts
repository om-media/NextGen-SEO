import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import {
  getGoogleAccessTokenForUser,
  storeGoogleRefreshToken,
} from '../server/services/googleAuth.js';

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

const originalFetch = globalThis.fetch;
const originalClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const originalClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const originalEncryptionKey = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;

const raw = new Database(':memory:');
const db = new MemoryDatabase(raw);

try {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = 'test-token-encryption-key';

  await db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, gscRefreshToken TEXT)');
  await db.run('INSERT INTO users (id, gscRefreshToken) VALUES (?, NULL)', ['revoked-user']);
  await storeGoogleRefreshToken(db, 'revoked-user', 'revoked-refresh-token');

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'invalid_grant',
    error_description: 'Token has been expired or revoked.',
  }), {
    headers: { 'Content-Type': 'application/json' },
    status: 400,
  });

  await assert.rejects(
    getGoogleAccessTokenForUser(db, 'revoked-user'),
    (error: any) => error?.status === 400 && error?.payload?.error === 'invalid_grant',
    'The original Google invalid_grant response should remain observable',
  );

  const user = await db.get<{ gscRefreshToken: string | null }>(
    'SELECT gscRefreshToken FROM users WHERE id = ?',
    ['revoked-user'],
  );
  assert.equal(Boolean(user?.gscRefreshToken), false, 'A revoked Google refresh token should be cleared');

  console.log('1 Google revoked-token lifecycle check passed.');
} finally {
  globalThis.fetch = originalFetch;
  if (originalClientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  else process.env.GOOGLE_OAUTH_CLIENT_ID = originalClientId;
  if (originalClientSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  else process.env.GOOGLE_OAUTH_CLIENT_SECRET = originalClientSecret;
  if (originalEncryptionKey === undefined) delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  else process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
  await db.close();
}
