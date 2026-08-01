import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { registerLocalAuthRoutes } from '../server/routes/auth.js';

class MemoryDatabase implements AppDatabase {
  dialect = 'sqlite' as const;
  constructor(private readonly db: Database.Database) {}
  prepare(sql: string) { return this.db.prepare(sql); }
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
  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => callback(...args);
  }
}

class FakeApp {
  routes = new Map<string, Function[]>();
  get(path: string, ...handlers: Function[]) { this.routes.set(`GET:${path}`, handlers); }
  post(path: string, ...handlers: Function[]) { this.routes.set(`POST:${path}`, handlers); }
}

class FakeResponse {
  statusCode = 200;
  body: any = null;
  status(code: number) { this.statusCode = code; return this; }
  json(payload: unknown) { this.body = payload; return this; }
  setHeader() { return this; }
}

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
  CREATE TABLE sessions (tokenHash TEXT PRIMARY KEY, userId TEXT, expiresAt TEXT, createdAt TEXT);
`);
await db.run(
  'INSERT INTO users (id, email, passwordHash, authProvider, tier, unlockedSites, knownSites) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ['duplicate-a', 'duplicate@example.com', 'invalid-a', 'local', 'enterprise', '[]', '[]'],
);
await db.run(
  'INSERT INTO users (id, email, passwordHash, authProvider, tier, unlockedSites, knownSites) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ['duplicate-b', 'DUPLICATE@example.com', 'invalid-b', 'local', 'enterprise', '[]', '[]'],
);

const app = new FakeApp();
registerLocalAuthRoutes(app as any, db);
const loginHandler = app.routes.get('POST:/api/auth/login')?.at(-1);
if (!loginHandler) throw new Error('Missing local login handler');

const response = new FakeResponse();
await loginHandler({ body: { email: ' duplicate@example.com ', password: 'anything-valid-length' } }, response);
if (response.statusCode !== 409 || response.body?.code !== 'AMBIGUOUS_ACCOUNT') {
  throw new Error(`Ambiguous normalized email returned ${response.statusCode}/${String(response.body?.code)}, expected 409/AMBIGUOUS_ACCOUNT`);
}

console.log(JSON.stringify({ code: response.body.code, duplicateRowsPreserved: 2, status: response.statusCode }, null, 2));
raw.close();
