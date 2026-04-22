import Database from 'better-sqlite3';

try {
const db = new Database('sqlite.db');
let allSites = new Set<string>();

const statuses = db.prepare('SELECT siteUrl FROM warehouse_sync_status').all() as any[];
statuses.forEach(s => allSites.add(s.siteUrl));

const queries = db.prepare('SELECT DISTINCT siteUrl FROM gsc_site_metrics').all() as any[];
queries.forEach(s => allSites.add(s.siteUrl));

const logs = db.prepare('SELECT DISTINCT siteUrl FROM server_logs').all() as any[];
logs.forEach(s => allSites.add(s.siteUrl));

const caches = db.prepare('SELECT DISTINCT siteUrl FROM url_inspection_cache').all() as any[];
caches.forEach(s => allSites.add(s.siteUrl));

const keywords = db.prepare('SELECT DISTINCT siteUrl FROM tracked_keywords').all() as any[];
keywords.forEach(s => allSites.add(s.siteUrl));

console.log("Found sites:", Array.from(allSites));
} catch (e) {
  console.error(e);
}
