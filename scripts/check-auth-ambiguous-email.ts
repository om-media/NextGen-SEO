import Database from 'better-sqlite3';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { hashPassword } from '../server/auth.js';
import { registerLocalAuthRoutes, resolveGoogleAppAuthUser, resolvePasswordLoginUser } from '../server/routes/auth.js';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

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
  ['duplicate-a', 'duplicate@example.com', hashPassword('duplicate-a-password'), 'local', 'enterprise', '[]', '[]'],
);
await db.run(
  'INSERT INTO users (id, email, passwordHash, authProvider, tier, unlockedSites, knownSites) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ['duplicate-b', 'DUPLICATE@example.com', hashPassword('duplicate-b-password'), 'local', 'enterprise', '[]', '[]'],
);
const localUser = { id: 'local-user', email: 'duplicate@example.com', passwordHash: hashPassword('correct-password'), authProvider: 'local', gscRefreshToken: 'local-refresh' };
const googleUser = { id: 'google-user', email: 'duplicate@example.com', passwordHash: null, authProvider: 'google', gscRefreshToken: 'google-refresh' };
const passwordResolution = resolvePasswordLoginUser([localUser, googleUser], 'correct-password');
assert(passwordResolution.kind === 'ready' && passwordResolution.user.id === 'local-user', 'A matching password should select the local account among duplicates');
const wrongPasswordResolution = resolvePasswordLoginUser([localUser, googleUser], 'wrong-password');
assert(wrongPasswordResolution.kind === 'ambiguous', 'A non-matching password must not guess between duplicate accounts');
const googleResolution = resolveGoogleAppAuthUser([localUser, googleUser]);
assert(googleResolution.kind === 'ready' && googleResolution.user.id === 'google-user', 'Google sign-in should select the Google-provider account among duplicates');

const app = new FakeApp();
registerLocalAuthRoutes(app as any, db);
const loginHandler = app.routes.get('POST:/api/auth/login')?.at(-1);
if (!loginHandler) throw new Error('Missing local login handler');

const matchingResponse = new FakeResponse();
await loginHandler({ body: { email: 'duplicate@example.com', password: 'duplicate-a-password' } }, matchingResponse);
if (matchingResponse.statusCode !== 200 || matchingResponse.body?.user?.uid !== 'duplicate-a') {
  throw new Error(`Matching duplicate password returned ${matchingResponse.statusCode}/${String(matchingResponse.body?.user?.uid)}`);
}

const response = new FakeResponse();
await loginHandler({ body: { email: ' duplicate@example.com ', password: 'anything-valid-length' } }, response);
if (response.statusCode !== 409 || response.body?.code !== 'AMBIGUOUS_ACCOUNT') {
  throw new Error(`Ambiguous normalized email returned ${response.statusCode}/${String(response.body?.code)}, expected 409/AMBIGUOUS_ACCOUNT`);
}

console.log(JSON.stringify({ code: response.body.code, duplicateRowsPreserved: 2, status: response.statusCode }, null, 2));
raw.close();
