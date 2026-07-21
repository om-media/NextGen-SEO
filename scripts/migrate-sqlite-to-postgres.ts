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
  transformRow?: (row: Record<string, unknown>) => Record<string, unknown>;
};

const POSTGRES_MAX_PARAMETERS = 60_000;
const configuredBatchSize = Number(process.env.POSTGRES_MIGRATION_BATCH_SIZE || 1000);
const DEFAULT_BATCH_SIZE = Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
  ? Math.floor(configuredBatchSize)
  : 1000;

function withLegacyJobId(row: Record<string, unknown>) {
  if (row.jobId == null) {
    return { ...row, jobId: 'legacy' };
  }
  return row;
}

const migrations: TableMigration[] = [
  { table: 'projects', conflictColumns: ['id'] },
  { table: 'filters', conflictColumns: ['id'] },
  { table: 'users', conflictColumns: ['id'] },
  { table: 'sessions', conflictColumns: ['tokenHash'] },
  { table: 'workspace_ga4_mappings', conflictColumns: ['ownerId', 'siteUrl'] },
  { table: 'annotations', conflictColumns: ['id'] },
  { table: 'site_scopes', conflictColumns: ['id'] },
  { table: 'site_scope_sources', conflictColumns: ['siteScopeId', 'sourceType', 'sourceKey'] },
  { table: 'warehouse_sync_status', conflictColumns: ['ownerId', 'siteUrl'] },
  { table: 'warehouse_jobs', conflictColumns: ['id'] },
  { table: 'warehouse_dataset_coverage', conflictColumns: ['ownerId', 'propertyId', 'siteUrl', 'date', 'dataset'] },
  { table: 'gsc_site_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date'] },
  { table: 'gsc_query_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'query'] },
  { table: 'gsc_country_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'country'] },
  { table: 'gsc_page_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'pageKey'] },
  { table: 'gsc_page_query_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'page', 'query'] },
  { table: 'gsc_site_monthly_metrics', conflictColumns: ['ownerId', 'siteUrl', 'monthStart'] },
  { table: 'gsc_query_monthly_metrics', conflictColumns: ['ownerId', 'siteUrl', 'monthStart', 'query'] },
  { table: 'gsc_country_monthly_metrics', conflictColumns: ['ownerId', 'siteUrl', 'monthStart', 'country'] },
  { table: 'gsc_page_monthly_metrics', conflictColumns: ['ownerId', 'siteUrl', 'monthStart', 'pageKey'] },
  { table: 'gsc_page_query_monthly_metrics', conflictColumns: ['ownerId', 'siteUrl', 'monthStart', 'pageKey', 'query'] },
  { table: 'ga4_page_metrics', conflictColumns: ['ownerId', 'propertyId', 'siteUrl', 'date', 'pageKey'] },
  { table: 'ga4_dimension_metrics', conflictColumns: ['ownerId', 'propertyId', 'siteUrl', 'date', 'dimension', 'dimensionValue'] },
  { table: 'ga4_llm_referral_metrics', conflictColumns: ['ownerId', 'propertyId', 'siteUrl', 'date', 'source', 'pageKey'] },
  { table: 'bing_query_stats', conflictColumns: ['ownerId', 'siteUrl', 'query'] },
  { table: 'bing_query_metrics', conflictColumns: ['ownerId', 'siteUrl', 'date', 'query'] },
  { table: 'tracked_keywords', conflictColumns: ['id'] },
  { table: 'keyword_rankings', conflictColumns: ['keywordId', 'date'] },
  { table: 'url_inspection_cache', conflictColumns: ['ownerId', 'siteUrl', 'url'] },
  { table: 'crawl_jobs', conflictColumns: ['id'] },
  { table: 'page_analysis_jobs', conflictColumns: ['id'] },
  { table: 'crawl_pages', conflictColumns: ['ownerId', 'siteUrl', 'jobId', 'normalizedUrl'], transformRow: withLegacyJobId },
  { table: 'crawl_links', conflictColumns: ['ownerId', 'siteUrl', 'jobId', 'fromUrl', 'toUrl'], transformRow: withLegacyJobId },
  { table: 'crawl_page_text_blocks', conflictColumns: ['ownerId', 'siteUrl', 'jobId', 'pageUrl', 'blockIndex'], transformRow: withLegacyJobId },
  { table: 'crawl_page_sentences', conflictColumns: ['ownerId', 'siteUrl', 'jobId', 'pageKey', 'paragraphIndex', 'sentenceIndex'], transformRow: withLegacyJobId },
  { table: 'crawl_page_regions', conflictColumns: ['ownerId', 'siteUrl', 'jobId', 'pageUrl', 'regionIndex'], transformRow: withLegacyJobId },
  { table: 'page_template_clusters', conflictColumns: ['siteScopeId', 'crawlJobId', 'templateKey'] },
  { table: 'page_template_members', conflictColumns: ['siteScopeId', 'crawlJobId', 'templateKey', 'pageKey'] },
  { table: 'page_function_profiles', conflictColumns: ['crawlJobId', 'pageKey'] },
  { table: 'internal_link_embedding_cache', conflictColumns: ['provider', 'model', 'inputType', 'textHash'] },
  { table: 'internal_link_provider_settings', conflictColumns: ['ownerId', 'provider'] },
  { table: 'internal_link_analysis_jobs', conflictColumns: ['id'] },
  { table: 'internal_link_opportunities', conflictColumns: ['id'] },
  { table: 'server_logs', conflictColumns: ['id'] },
];

const SQLITE_SCHEMA_MIGRATION_SKIP_TABLES = new Set([
  // PostgreSQL-only pgvector storage has no SQLite source table.
  'internal_link_embedding_vectors_1024',
]);

function listSqliteSchemaTables() {
  const databaseSource = fs.readFileSync(new URL('../server/database.ts', import.meta.url), 'utf8');
  const tables = new Set<string>();
  for (const match of databaseSource.matchAll(/CREATE TABLE IF NOT EXISTS ([A-Za-z0-9_]+)/g)) {
    const table = match[1];
    if (!SQLITE_SCHEMA_MIGRATION_SKIP_TABLES.has(table)) {
      tables.add(table);
    }
  }
  return [...tables];
}

function assertMigrationCoverage() {
  const configuredTables = migrations.map((migration) => migration.table);
  const duplicateConfiguredTables = configuredTables.filter((table, index) => configuredTables.indexOf(table) !== index);
  if (duplicateConfiguredTables.length > 0) {
    throw new Error(`Duplicate SQLite->PostgreSQL migration table entries: ${[...new Set(duplicateConfiguredTables)].join(', ')}`);
  }

  const configuredTableSet = new Set(configuredTables);
  const schemaTables = listSqliteSchemaTables();
  const missingTables = schemaTables.filter((table) => !configuredTableSet.has(table));
  if (missingTables.length > 0) {
    throw new Error(`SQLite->PostgreSQL migration list is missing schema tables: ${missingTables.join(', ')}`);
  }

  const extraTables = configuredTables.filter((table) => !schemaTables.includes(table));
  if (extraTables.length > 0) {
    throw new Error(`SQLite->PostgreSQL migration list references unknown schema tables: ${extraTables.join(', ')}`);
  }
}

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
      batch.push(migration.transformRow ? migration.transformRow(row) : row);
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
  if (process.argv.includes('--check-coverage')) {
    assertMigrationCoverage();
    console.log('Migration coverage check passed.');
    return;
  }

  assertMigrationCoverage();
  requireDatabaseUrl();

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found at ${sqlitePath}`);
  }

  const previousRunDatabaseBackfills = process.env.RUN_DATABASE_BACKFILLS;
  process.env.RUN_DATABASE_BACKFILLS = 'false';

  try {
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
  } finally {
    if (previousRunDatabaseBackfills === undefined) {
      delete process.env.RUN_DATABASE_BACKFILLS;
    } else {
      process.env.RUN_DATABASE_BACKFILLS = previousRunDatabaseBackfills;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
