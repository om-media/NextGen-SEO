import Database from 'better-sqlite3';
import fs from 'fs';

const DB_FILENAME = 'sqlite.db';
const DB_BACKUP_FILENAME = `${DB_FILENAME}.bak`;

const schemaSql = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    domain TEXT,
    ownerId TEXT,
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS filters (
    id TEXT PRIMARY KEY,
    name TEXT,
    projectId TEXT,
    ownerId TEXT,
    configuration TEXT,
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    passwordHash TEXT,
    authProvider TEXT DEFAULT 'local',
    name TEXT,
    company TEXT,
    avatarUrl TEXT,
    bio TEXT,
    tier TEXT,
    unlockedSites TEXT,
    createdAt TEXT,
    bingApiKey TEXT,
    gscRefreshToken TEXT,
    knownSites TEXT,
    onboardingCompleted INTEGER DEFAULT 0,
    activatedSiteUrl TEXT,
    activatedGa4PropertyId TEXT,
    activatedGa4DisplayName TEXT,
    billingStatus TEXT DEFAULT 'trialing',
    subscriptionId TEXT,
    trialEndsAt TEXT,
    currentPeriodEnd TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    tokenHash TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    userId TEXT,
    siteUrl TEXT,
    date TEXT,
    title TEXT,
    description TEXT,
    type TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS gsc_site_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date)
  );

  CREATE TABLE IF NOT EXISTS gsc_query_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date, query)
  );

  CREATE TABLE IF NOT EXISTS gsc_page_query_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    page TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date, page, query)
  );

  CREATE TABLE IF NOT EXISTS warehouse_sync_status (
    ownerId TEXT,
    siteUrl TEXT,
    lastSyncDate TEXT,
    earliestSyncDate TEXT,
    status TEXT,
    lastUpdated TEXT,
    PRIMARY KEY (ownerId, siteUrl)
  );

  CREATE TABLE IF NOT EXISTS tracked_keywords (
    id TEXT PRIMARY KEY,
    siteUrl TEXT,
    ownerId TEXT,
    keyword TEXT,
    location TEXT,
    device TEXT,
    tags TEXT,
    targetDomain TEXT,
    createdAt TEXT,
    UNIQUE(ownerId, siteUrl, keyword, location, device)
  );

  CREATE TABLE IF NOT EXISTS keyword_rankings (
    keywordId TEXT,
    date TEXT,
    position INTEGER,
    rankingUrl TEXT,
    PRIMARY KEY (keywordId, date)
  );

  CREATE TABLE IF NOT EXISTS server_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ownerId TEXT,
    siteUrl TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    ipAddress TEXT,
    httpMethod TEXT,
    urlPath TEXT NOT NULL,
    statusCode INTEGER,
    userAgent TEXT,
    botType TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS url_inspection_cache (
    ownerId TEXT,
    siteUrl TEXT NOT NULL,
    url TEXT NOT NULL,
    inspectionResult TEXT,
    coverageState TEXT,
    lastInspectionTime TEXT NOT NULL,
    PRIMARY KEY (ownerId, siteUrl, url)
  );
`;

function isSqliteCorruptionError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'SQLITE_CORRUPT',
  );
}

function removeIfExists(filePath: string) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function archiveIfExists(filePath: string, label: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const archivedPath = `${filePath}.${label}`;
  removeIfExists(archivedPath);
  fs.renameSync(filePath, archivedPath);
}

function archiveDatabaseFiles(label: string, includePrimary = true) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveLabel = `${label}.${timestamp}`;

  if (includePrimary) {
    archiveIfExists(DB_FILENAME, archiveLabel);
  }

  archiveIfExists(`${DB_FILENAME}-wal`, archiveLabel);
  archiveIfExists(`${DB_FILENAME}-shm`, archiveLabel);
}

function createDatabaseConnection() {
  try {
    return new Database(DB_FILENAME);
  } catch (error) {
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }

    console.warn('[db] SQLite corruption detected while opening primary database. Retrying without WAL/SHM sidecars.');
  }

  archiveDatabaseFiles('corrupt-wal-recovery', false);

  try {
    return new Database(DB_FILENAME);
  } catch (error) {
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }

    console.warn('[db] Primary database is still corrupt. Attempting restore from backup.');
  }

  if (fs.existsSync(DB_BACKUP_FILENAME)) {
    archiveDatabaseFiles('corrupt-primary');
    fs.copyFileSync(DB_BACKUP_FILENAME, DB_FILENAME);

    try {
      return new Database(DB_FILENAME);
    } catch (error) {
      if (!isSqliteCorruptionError(error)) {
        throw error;
      }

      console.warn('[db] Backup database is also unusable. Falling back to a clean database.');
    }
  }

  archiveDatabaseFiles('fresh-db-reset');
  removeIfExists(DB_FILENAME);
  removeIfExists(`${DB_FILENAME}-wal`);
  removeIfExists(`${DB_FILENAME}-shm`);
  return new Database(DB_FILENAME);
}

function initializeSchema(db: Database.Database) {
  try {
    db.exec(schemaSql);
    return db;
  } catch (error) {
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }

    console.warn('[db] SQLite corruption detected during schema initialization. Resetting to a clean local database.');

    try {
      db.close();
    } catch {
      // Ignore close failures during recovery.
    }

    archiveDatabaseFiles('schema-corrupt-reset');
    removeIfExists(DB_FILENAME);
    removeIfExists(`${DB_FILENAME}-wal`);
    removeIfExists(`${DB_FILENAME}-shm`);

    const recoveredDb = new Database(DB_FILENAME);
    recoveredDb.exec(schemaSql);
    return recoveredDb;
  }
}

function runOptionalAlter(db: Database.Database, statement: string) {
  try {
    db.exec(statement);
  } catch {
    // Column likely already exists.
  }
}

function migrateTrackedKeywordsSchema(db: Database.Database) {
  const trackedKeywordsSchema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tracked_keywords'")
    .get() as { sql?: string } | undefined;

  if (!trackedKeywordsSchema?.sql?.includes('UNIQUE(siteUrl, keyword)')) {
    return;
  }

  db.exec(`
    ALTER TABLE tracked_keywords RENAME TO tracked_keywords_legacy;

    CREATE TABLE tracked_keywords (
      id TEXT PRIMARY KEY,
      siteUrl TEXT,
      ownerId TEXT,
      keyword TEXT,
      location TEXT,
      device TEXT,
      tags TEXT,
      targetDomain TEXT,
      createdAt TEXT,
      UNIQUE(ownerId, siteUrl, keyword, location, device)
    );

    INSERT OR IGNORE INTO tracked_keywords (id, siteUrl, ownerId, keyword, location, device, tags, targetDomain, createdAt)
    SELECT
      id,
      siteUrl,
      '',
      keyword,
      COALESCE(location, 'US'),
      COALESCE(device, 'desktop'),
      COALESCE(tags, ''),
      COALESCE(targetDomain, ''),
      createdAt
    FROM tracked_keywords_legacy;

    DROP TABLE tracked_keywords_legacy;
  `);
}

function migrateInspectionCacheSchema(db: Database.Database) {
  const inspectionCacheSchema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'url_inspection_cache'")
    .get() as { sql?: string } | undefined;

  if (!inspectionCacheSchema?.sql?.includes('PRIMARY KEY (siteUrl, url)')) {
    return;
  }

  db.exec(`
    ALTER TABLE url_inspection_cache RENAME TO url_inspection_cache_legacy;

    CREATE TABLE url_inspection_cache (
      ownerId TEXT,
      siteUrl TEXT NOT NULL,
      url TEXT NOT NULL,
      inspectionResult TEXT,
      coverageState TEXT,
      lastInspectionTime TEXT NOT NULL,
      PRIMARY KEY (ownerId, siteUrl, url)
    );

    INSERT OR IGNORE INTO url_inspection_cache (ownerId, siteUrl, url, inspectionResult, coverageState, lastInspectionTime)
    SELECT
      '',
      siteUrl,
      url,
      inspectionResult,
      coverageState,
      lastInspectionTime
    FROM url_inspection_cache_legacy;

    DROP TABLE url_inspection_cache_legacy;
  `);
}

function migrateWarehouseTables(db: Database.Database) {
  const warehouseTableMigrations = [
    {
      table: 'gsc_site_metrics',
      legacyPrimaryKey: 'PRIMARY KEY (siteUrl, date)',
      createSql: `
        CREATE TABLE gsc_site_metrics (
          ownerId TEXT,
          siteUrl TEXT,
          date TEXT,
          clicks INTEGER,
          impressions INTEGER,
          ctr REAL,
          position REAL,
          PRIMARY KEY (ownerId, siteUrl, date)
        );
      `,
      columnList: 'ownerId, siteUrl, date, clicks, impressions, ctr, position',
      selectSql: "SELECT '', siteUrl, date, clicks, impressions, ctr, position FROM gsc_site_metrics_legacy",
    },
    {
      table: 'gsc_query_metrics',
      legacyPrimaryKey: 'PRIMARY KEY (siteUrl, date, query)',
      createSql: `
        CREATE TABLE gsc_query_metrics (
          ownerId TEXT,
          siteUrl TEXT,
          date TEXT,
          query TEXT,
          clicks INTEGER,
          impressions INTEGER,
          ctr REAL,
          position REAL,
          PRIMARY KEY (ownerId, siteUrl, date, query)
        );
      `,
      columnList: 'ownerId, siteUrl, date, query, clicks, impressions, ctr, position',
      selectSql: "SELECT '', siteUrl, date, query, clicks, impressions, ctr, position FROM gsc_query_metrics_legacy",
    },
    {
      table: 'gsc_page_query_metrics',
      legacyPrimaryKey: 'PRIMARY KEY (siteUrl, date, page, query)',
      createSql: `
        CREATE TABLE gsc_page_query_metrics (
          ownerId TEXT,
          siteUrl TEXT,
          date TEXT,
          page TEXT,
          query TEXT,
          clicks INTEGER,
          impressions INTEGER,
          ctr REAL,
          position REAL,
          PRIMARY KEY (ownerId, siteUrl, date, page, query)
        );
      `,
      columnList: 'ownerId, siteUrl, date, page, query, clicks, impressions, ctr, position',
      selectSql: "SELECT '', siteUrl, date, page, query, clicks, impressions, ctr, position FROM gsc_page_query_metrics_legacy",
    },
    {
      table: 'warehouse_sync_status',
      legacyPrimaryKey: 'siteUrl TEXT PRIMARY KEY',
      createSql: `
        CREATE TABLE warehouse_sync_status (
          ownerId TEXT,
          siteUrl TEXT,
          lastSyncDate TEXT,
          earliestSyncDate TEXT,
          status TEXT,
          lastUpdated TEXT,
          PRIMARY KEY (ownerId, siteUrl)
        );
      `,
      columnList: 'ownerId, siteUrl, lastSyncDate, earliestSyncDate, status, lastUpdated',
      selectSql: "SELECT '', siteUrl, lastSyncDate, earliestSyncDate, status, lastUpdated FROM warehouse_sync_status_legacy",
    },
  ];

  for (const migration of warehouseTableMigrations) {
    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(migration.table) as { sql?: string } | undefined;

    if (!schema?.sql?.includes(migration.legacyPrimaryKey)) {
      continue;
    }

    db.exec(`
      ALTER TABLE ${migration.table} RENAME TO ${migration.table}_legacy;
      ${migration.createSql}
      INSERT OR IGNORE INTO ${migration.table} (${migration.columnList})
      ${migration.selectSql};
      DROP TABLE ${migration.table}_legacy;
    `);
  }
}

function applyDatabaseMigrations(db: Database.Database) {
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN passwordHash TEXT');
  runOptionalAlter(db, "ALTER TABLE users ADD COLUMN authProvider TEXT DEFAULT 'local'");
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN bingApiKey TEXT');
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN name TEXT');
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN company TEXT');
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN avatarUrl TEXT');
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN bio TEXT');
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN onboardingCompleted INTEGER DEFAULT 0');
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN activatedSiteUrl TEXT');
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN activatedGa4PropertyId TEXT');
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN activatedGa4DisplayName TEXT');
  runOptionalAlter(db, "ALTER TABLE users ADD COLUMN billingStatus TEXT DEFAULT 'trialing'");
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN subscriptionId TEXT');
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN trialEndsAt TEXT');
  runOptionalAlter(db, 'ALTER TABLE users ADD COLUMN currentPeriodEnd TEXT');
  runOptionalAlter(db, 'ALTER TABLE tracked_keywords ADD COLUMN targetDomain TEXT');
  runOptionalAlter(db, 'ALTER TABLE tracked_keywords ADD COLUMN ownerId TEXT');
  runOptionalAlter(db, 'ALTER TABLE server_logs ADD COLUMN ownerId TEXT');
  runOptionalAlter(db, 'ALTER TABLE url_inspection_cache ADD COLUMN ownerId TEXT');

  for (const statement of [
    'ALTER TABLE gsc_site_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_query_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_page_query_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE warehouse_sync_status ADD COLUMN ownerId TEXT',
  ]) {
    runOptionalAlter(db, statement);
  }

  migrateTrackedKeywordsSchema(db);
  migrateInspectionCacheSchema(db);
  migrateWarehouseTables(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_server_logs_owner_site_time ON server_logs(ownerId, siteUrl, timestamp);
    CREATE INDEX IF NOT EXISTS idx_server_logs_owner_botType ON server_logs(ownerId, siteUrl, botType);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);
  `);
}

export function initializeDatabase() {
  const connectedDb = initializeSchema(createDatabaseConnection());
  applyDatabaseMigrations(connectedDb);
  return connectedDb;
}
