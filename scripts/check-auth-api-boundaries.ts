import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { registerLocalAuthRoutes } from '../server/routes/auth.js';
import { isIsoDateString } from '../server/validation.js';

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
}

class FakeApp {
  routes = new Map<string, Function[]>();

  get(path: string, ...handlers: Function[]) {
    this.routes.set(`GET:${path}`, handlers);
  }

  post(path: string, ...handlers: Function[]) {
    this.routes.set(`POST:${path}`, handlers);
  }
}

class FakeResponse {
  statusCode = 200;
  body: any = null;
  headers = new Map<string, unknown>();

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown) {
    this.body = payload;
    return this;
  }

  setHeader(name: string, value: unknown) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const raw = new Database(':memory:');
const db = new MemoryDatabase(raw);
await db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT,
    passwordHash TEXT,
    authProvider TEXT,
    name TEXT,
    company TEXT,
    avatarUrl TEXT,
    bio TEXT,
    tier TEXT,
    unlockedSites TEXT,
    knownSites TEXT,
    createdAt TEXT,
    bingApiKey TEXT,
    onboardingCompleted INTEGER,
    activatedSiteUrl TEXT,
    activatedGa4PropertyId TEXT,
    activatedGa4DisplayName TEXT,
    gscRefreshToken TEXT
  );
  CREATE UNIQUE INDEX idx_users_email_normalized_unique ON users(lower(email));
  CREATE TABLE sessions (
    tokenHash TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
`);

const app = new FakeApp();
registerLocalAuthRoutes(app as any, db);
const registerHandler = app.routes.get('POST:/api/auth/register')?.at(-1);
assert(registerHandler, 'Missing local registration handler');

const register = async (email: string, password: string) => {
  const response = new FakeResponse();
  await registerHandler!({ body: { email, password } }, response);
  return response;
};

const newAccountResponses = await Promise.all([
  register('Concurrent@Example.com', 'strong-password-a'),
  register('concurrent@example.com', 'strong-password-b'),
]);
const newAccountRows = await db.get<{ count: number }>(
  'SELECT COUNT(*) AS count FROM users WHERE lower(email) = lower(?)',
  ['concurrent@example.com'],
);
assert(newAccountRows?.count === 1, 'Concurrent registration created duplicate normalized emails');
assert(
  newAccountResponses.map((response) => response.statusCode).sort().join(',') === '201,409',
  `Concurrent registration should return 201/409, got ${newAccountResponses.map((response) => response.statusCode).join('/')}`,
);

await db.run(
  `INSERT INTO users (id, email, passwordHash, authProvider, tier, unlockedSites, knownSites, createdAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ['google-user', 'google@example.com', null, 'google', 'enterprise', '[]', '[]', new Date().toISOString()],
);
const googleClaimResponses = await Promise.all([
  register('google@example.com', 'strong-password-c'),
  register('GOOGLE@example.com', 'strong-password-d'),
]);
assert(
  googleClaimResponses.map((response) => response.statusCode).sort().join(',') === '201,409',
  `Concurrent password claim should return 201/409, got ${googleClaimResponses.map((response) => response.statusCode).join('/')}`,
);

assert(isIsoDateString('2026-08-01'), 'Valid ISO calendar date was rejected');
assert(!isIsoDateString('2026-02-29'), 'Non-leap February 29 was accepted');
assert(!isIsoDateString('2026-99-99'), 'Impossible month/day was accepted');
assert(!isIsoDateString('2026-01-01T00:00:00Z'), 'Timestamp was accepted where a date is required');

console.log(JSON.stringify({
  impossibleDatesRejected: true,
  normalizedEmailRows: newAccountRows?.count,
  newAccountStatuses: newAccountResponses.map((response) => response.statusCode).sort(),
  passwordClaimStatuses: googleClaimResponses.map((response) => response.statusCode).sort(),
}, null, 2));

raw.close();
