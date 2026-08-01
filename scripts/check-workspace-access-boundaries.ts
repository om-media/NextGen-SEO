import Database from 'better-sqlite3';
import { canAccessGa4Property, canAccessSite } from '../server/accessControl.js';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';

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

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const raw = new Database(':memory:');
const db = new MemoryDatabase(raw);
await db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    tier TEXT,
    unlockedSites TEXT,
    knownSites TEXT,
    activatedSiteUrl TEXT,
    activatedGa4PropertyId TEXT
  );
  CREATE TABLE workspace_ga4_mappings (
    ownerId TEXT,
    siteUrl TEXT,
    propertyId TEXT,
    PRIMARY KEY (ownerId, siteUrl)
  );
  CREATE TABLE ga4_page_metrics (ownerId TEXT, propertyId TEXT);
  CREATE TABLE ga4_dimension_metrics (ownerId TEXT, propertyId TEXT);
  CREATE TABLE ga4_llm_referral_metrics (ownerId TEXT, propertyId TEXT);
`);

await db.run(
  'INSERT INTO users (id, tier, unlockedSites, knownSites, activatedSiteUrl, activatedGa4PropertyId) VALUES (?, ?, ?, ?, ?, ?)',
  ['owner-a', 'enterprise', JSON.stringify(['https://a.example/']), JSON.stringify(['sc-domain:a.example']), 'https://active-a.example/', 'properties/a-active'],
);
await db.run(
  'INSERT INTO users (id, tier, unlockedSites, knownSites, activatedSiteUrl, activatedGa4PropertyId) VALUES (?, ?, ?, ?, ?, ?)',
  ['owner-b', 'enterprise', JSON.stringify(['https://b.example/']), JSON.stringify([]), 'https://active-b.example/', 'properties/b-active'],
);
await db.run(
  'INSERT INTO users (id, tier, unlockedSites, knownSites, activatedSiteUrl, activatedGa4PropertyId) VALUES (?, ?, ?, ?, ?, ?)',
  ['owner-malformed', 'enterprise', '{bad json', 'null', null, null],
);
await db.run(
  'INSERT INTO workspace_ga4_mappings (ownerId, siteUrl, propertyId) VALUES (?, ?, ?)',
  ['owner-a', 'https://a.example/', 'properties/a-mapped'],
);
await db.run(
  'INSERT INTO ga4_page_metrics (ownerId, propertyId) VALUES (?, ?)',
  ['owner-b', 'properties/b-stored'],
);

assert(await canAccessSite(db, 'owner-a', 'https://a.example/'), 'Owner cannot access its unlocked site');
assert(await canAccessSite(db, 'owner-a', 'sc-domain:a.example'), 'Owner cannot access its known GSC domain property');
assert(await canAccessSite(db, 'owner-a', 'https://active-a.example/'), 'Owner cannot access its active site');
assert(!(await canAccessSite(db, 'owner-a', 'https://b.example/')), 'Owner A crossed into owner B site');
assert(!(await canAccessSite(db, 'missing-owner', 'https://a.example/')), 'Missing owner gained site access');
assert(!(await canAccessSite(db, 'owner-malformed', 'https://a.example/')), 'Malformed site JSON widened access');

assert(await canAccessGa4Property(db, 'owner-a', 'properties/a-active'), 'Owner cannot access its active GA4 property');
assert(await canAccessGa4Property(db, 'owner-a', 'properties/a-mapped'), 'Owner cannot access its mapped GA4 property');
assert(await canAccessGa4Property(db, 'owner-b', 'properties/b-stored'), 'Owner cannot access its stored GA4 property');
assert(!(await canAccessGa4Property(db, 'owner-a', 'properties/b-stored')), 'Owner A crossed into owner B stored GA4 data');
assert(!(await canAccessGa4Property(db, 'owner-a', 'properties/b-active')), 'Owner A crossed into owner B active GA4 property');

console.log(JSON.stringify({
  malformedWorkspaceDenied: true,
  missingOwnerDenied: true,
  ownerGa4Isolation: true,
  ownerSiteIsolation: true,
}, null, 2));

raw.close();
