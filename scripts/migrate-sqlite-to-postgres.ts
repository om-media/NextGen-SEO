import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import fs from 'fs';
import pg from 'pg';
import { initializeDatabase } from '../server/database.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;

const sqlitePath = process.env.SQLITE_DB_PATH || 'sqlite.db';
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

type TableMigration = {
  table: string;
  conflictColumns: string[];
};

const migrations: TableMigration[] = [
  { table: 'projects', conflictColumns: ['id'] },
  { table: 'filters', conflictColumns: ['id'] },
  { table: 'users', conflictColumns: ['id'] },
  { table: 'sessions', conflictColumns: ['tokenHash'] },
  { table: 'annotations', conflictColumns: ['id'] },
  { table: 'gsc_site_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date'] },
  { table: 'gsc_query_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'query'] },
  { table: 'gsc_page_query_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'page', 'query'] },
  { table: 'warehouse_sync_status', conflictColumns: ['ownerId', 'siteUrl'] },
  { table: 'tracked_keywords', conflictColumns: ['id'] },
  { table: 'keyword_rankings', conflictColumns: ['keywordId', 'date'] },
  { table: 'url_inspection_cache', conflictColumns: ['ownerId', 'siteUrl', 'url'] },
  { table: 'server_logs', conflictColumns: ['id'] },
];

function requireDatabaseUrl() {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required to migrate SQLite data into PostgreSQL.');
  }
}

function getSqliteColumns(db: Database.Database, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row: any) => String(row.name));
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.toLowerCase().replace(/"/g, '""')}"`;
}

function buildUpsertSql(table: string, columns: string[], conflictColumns: string[]) {
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const insertColumns = columns.map(quoteIdentifier).join(', ');
  const conflictTarget = conflictColumns.map(quoteIdentifier).join(', ');
  const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
  const updateClause = updateColumns.length > 0
    ? `DO UPDATE SET ${updateColumns.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(', ')}`
    : 'DO NOTHING';

  return `
    INSERT INTO ${quoteIdentifier(table)} (${insertColumns})
    VALUES (${placeholders})
    ON CONFLICT (${conflictTarget}) ${updateClause}
  `;
}

async function migrateTable(pool: pg.Pool, sqlite: Database.Database, migration: TableMigration) {
  const columns = getSqliteColumns(sqlite, migration.table);
  if (columns.length === 0) {
    console.log(`[skip] ${migration.table}: table does not exist in SQLite`);
    return;
  }

  const rows = sqlite.prepare(`SELECT ${columns.join(', ')} FROM ${migration.table}`).all();
  if (rows.length === 0) {
    console.log(`[skip] ${migration.table}: no rows`);
    return;
  }

  const sql = buildUpsertSql(migration.table, columns, migration.conflictColumns);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    for (const row of rows as Record<string, unknown>[]) {
      await client.query(sql, columns.map((column) => row[column]));
    }
    await client.query('COMMIT');
    console.log(`[ok] ${migration.table}: migrated ${rows.length} rows`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  requireDatabaseUrl();

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found at ${sqlitePath}`);
  }

  const appDb = await initializeDatabase();
  await appDb.close?.();

  const sqlite = new Database(sqlitePath, { readonly: true });
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  try {
    for (const migration of migrations) {
      await migrateTable(pool, sqlite, migration);
    }
  } finally {
    sqlite.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
