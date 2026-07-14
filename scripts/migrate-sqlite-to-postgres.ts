import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import fs from 'fs';
import pg from 'pg';
import { backfillLegacyBingQueryMetrics, initializeDatabase } from '../server/database.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;

const sqlitePath = process.env.SQLITE_DB_PATH || 'sqlite.db';
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

type TableMigration = {
  table: string;
  conflictColumns: string[];
};

const POSTGRES_MAX_PARAMETERS = 60_000;
const configuredBatchSize = Number(process.env.POSTGRES_MIGRATION_BATCH_SIZE || 1000);
const DEFAULT_BATCH_SIZE = Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
  ? Math.floor(configuredBatchSize)
  : 1000;

const migrations: TableMigration[] = [
  { table: 'projects', conflictColumns: ['id'] },
  { table: 'filters', conflictColumns: ['id'] },
  { table: 'users', conflictColumns: ['id'] },
  { table: 'sessions', conflictColumns: ['tokenHash'] },
  { table: 'annotations', conflictColumns: ['id'] },
  { table: 'gsc_site_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date'] },
  { table: 'gsc_query_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'query'] },
  { table: 'gsc_page_query_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'page', 'query'] },
  { table: 'gsc_page_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'pageKey'] },
  { table: 'bing_query_stats', conflictColumns: ['ownerId', 'siteUrl', 'query'] },
  { table: 'bing_query_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'query'] },
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

function quoteSqliteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.toLowerCase().replace(/"/g, '""')}"`;
}

function getBatchSize(columnCount: number) {
  if (columnCount <= 0) return 1;
  const maxByParameterLimit = Math.max(1, Math.floor(POSTGRES_MAX_PARAMETERS / columnCount));
  return Math.max(1, Math.min(DEFAULT_BATCH_SIZE, maxByParameterLimit));
}

function buildBatchUpsertSql(table: string, columns: string[], conflictColumns: string[], rowCount: number) {
  const insertColumns = columns.map(quoteIdentifier).join(', ');
  const conflictTarget = conflictColumns.map(quoteIdentifier).join(', ');
  const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
  const updateClause = updateColumns.length > 0
    ? `DO UPDATE SET ${updateColumns.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(', ')}`
    : 'DO NOTHING';
  const values = Array.from({ length: rowCount }, (_, rowIndex) => {
    const offset = rowIndex * columns.length;
    const placeholders = columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(', ');
    return `(${placeholders})`;
  }).join(', ');

  return `
    INSERT INTO ${quoteIdentifier(table)} (${insertColumns})
    VALUES ${values}
    ON CONFLICT (${conflictTarget}) ${updateClause}
  `;
}

async function migrateTable(pool: pg.Pool, sqlite: Database.Database, migration: TableMigration) {
  const columns = getSqliteColumns(sqlite, migration.table);
  if (columns.length === 0) {
    console.log(`[skip] ${migration.table}: table does not exist in SQLite`);
    return;
  }

  const rowCount = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(migration.table)}`).get() as { count: number };
  const totalRows = Number(rowCount.count || 0);
  if (totalRows === 0) {
    console.log(`[skip] ${migration.table}: no rows`);
    return;
  }

  const batchSize = getBatchSize(columns.length);
  const selectSql = `SELECT ${columns.map(quoteSqliteIdentifier).join(', ')} FROM ${quoteSqliteIdentifier(migration.table)}`;
  const iterator = sqlite.prepare(selectSql).iterate() as Iterable<Record<string, unknown>>;
  const client = await pool.connect();
  const startedAt = Date.now();
  let migratedRows = 0;
  let batch: Record<string, unknown>[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const sql = buildBatchUpsertSql(migration.table, columns, migration.conflictColumns, batch.length);
    const values = batch.flatMap((row) => columns.map((column) => row[column]));
    await client.query(sql, values);
    migratedRows += batch.length;
    batch = [];

    if (migratedRows % (batchSize * 10) === 0 || migratedRows === totalRows) {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[progress] ${migration.table}: ${migratedRows}/${totalRows} rows in ${seconds}s`);
    }
  };

  try {
    await client.query('BEGIN');
    for (const row of iterator) {
      batch.push(row);
      if (batch.length >= batchSize) {
        await flush();
      }
    }
    await flush();
    await client.query('COMMIT');
    console.log(`[ok] ${migration.table}: migrated ${migratedRows} rows`);
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

  const migratedDb = await initializeDatabase();
  try {
    await backfillLegacyBingQueryMetrics(migratedDb);
  } finally {
    await migratedDb.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
