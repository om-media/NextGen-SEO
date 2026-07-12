import assert from 'node:assert/strict';
import {
  getPostgresPoolSettingsFromEnv,
  initializeDatabase,
  isRecoverablePostgresPoolError,
  type DatabaseDiagnostics,
  type PostgresPoolSettings,
  validatePostgresPoolSettings,
} from '../server/database.js';

function withEnv<T>(overrides: Record<string, string | undefined>, callback: () => T) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function assertPoolDiagnostics(diagnostics: DatabaseDiagnostics | undefined) {
  assert.equal(diagnostics?.dialect, 'postgres', 'Expected PostgreSQL diagnostics when PostgreSQL is active');
  assert.ok(diagnostics?.pool, 'Expected pool diagnostics to be exposed');
  assert.ok(diagnostics?.transactions, 'Expected transaction diagnostics to be exposed');
  assert.ok(diagnostics?.errors, 'Expected pool error diagnostics to be exposed');
}

function runConfigChecks() {
  const explicitSettings: PostgresPoolSettings = {
    max: 12,
    min: 3,
    idleTimeoutMillis: 15000,
    connectionTimeoutMillis: 2500,
    maxLifetimeSeconds: 900,
    queryTimeoutMs: 5000,
    statementTimeoutMs: 12000,
    idleInTransactionSessionTimeoutMs: 45000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 500,
    applicationName: 'gscplus-hardening-check',
  };

  validatePostgresPoolSettings(explicitSettings);

  const parsed = withEnv(
    {
      POSTGRES_POOL_MAX: '7',
      POSTGRES_POOL_MIN: '2',
      POSTGRES_IDLE_TIMEOUT_MS: '1111',
      POSTGRES_CONNECTION_TIMEOUT_MS: '2222',
      POSTGRES_POOL_MAX_LIFETIME_SECONDS: '333',
      POSTGRES_QUERY_TIMEOUT_MS: '4444',
      POSTGRES_STATEMENT_TIMEOUT_MS: '5555',
      POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS: '6666',
      POSTGRES_KEEP_ALIVE: 'false',
      POSTGRES_KEEP_ALIVE_INITIAL_DELAY_MS: '7777',
      POSTGRES_APPLICATION_NAME: 'db-hardening-check',
    },
    () => getPostgresPoolSettingsFromEnv(),
  );

  assert.equal(parsed.max, 7, 'POSTGRES_POOL_MAX should be parsed from env');
  assert.equal(parsed.min, 2, 'POSTGRES_POOL_MIN should be parsed from env');
  assert.equal(parsed.idleTimeoutMillis, 1111, 'POSTGRES_IDLE_TIMEOUT_MS should be parsed from env');
  assert.equal(parsed.connectionTimeoutMillis, 2222, 'POSTGRES_CONNECTION_TIMEOUT_MS should be parsed from env');
  assert.equal(parsed.maxLifetimeSeconds, 333, 'POSTGRES_POOL_MAX_LIFETIME_SECONDS should be parsed from env');
  assert.equal(parsed.queryTimeoutMs, 4444, 'POSTGRES_QUERY_TIMEOUT_MS should be parsed from env');
  assert.equal(parsed.statementTimeoutMs, 5555, 'POSTGRES_STATEMENT_TIMEOUT_MS should be parsed from env');
  assert.equal(parsed.idleInTransactionSessionTimeoutMs, 6666, 'POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS should be parsed from env');
  assert.equal(parsed.keepAlive, false, 'POSTGRES_KEEP_ALIVE should be parsed from env');
  assert.equal(parsed.keepAliveInitialDelayMillis, 7777, 'POSTGRES_KEEP_ALIVE_INITIAL_DELAY_MS should be parsed from env');
  assert.equal(parsed.applicationName, 'db-hardening-check', 'POSTGRES_APPLICATION_NAME should be parsed from env');

  assert.throws(
    () => withEnv({ POSTGRES_POOL_MAX: 'abc' }, () => getPostgresPoolSettingsFromEnv()),
    /POSTGRES_POOL_MAX/,
    'Non-numeric pool limits should be rejected',
  );

  assert.equal(
    isRecoverablePostgresPoolError({ code: 'ECONNRESET' }),
    true,
    'Recoverable socket resets should be classified as recoverable pool errors',
  );
  assert.equal(
    isRecoverablePostgresPoolError({ code: '42P01' }),
    false,
    'Application SQL errors should not be classified as recoverable pool errors',
  );

  console.log('1 PostgreSQL pool configuration checks passed.');
}

async function runIntegrationCheck() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!databaseUrl) {
    console.log('2 PostgreSQL integration check skipped (DATABASE_URL/POSTGRES_URL is unset).');
    return;
  }

  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = originalNodeEnv || 'development';

  const db = await initializeDatabase();
  try {
    assert.equal(db.dialect, 'postgres', 'Expected initializeDatabase to select PostgreSQL when DATABASE_URL is set');
    assertPoolDiagnostics(db.getDiagnostics?.());

    const tableName = `codex_pg_tx_hardening_${Date.now().toString(36)}`;
    const outer = db.transaction(async () => {
      await db.exec(`CREATE TEMP TABLE ${tableName} (id INTEGER PRIMARY KEY, label TEXT) ON COMMIT DROP`);
      await db.run(`INSERT INTO ${tableName} (id, label) VALUES (@id, @label)`, { id: 1, label: 'outer' });

      const nested = db.transaction(async () => {
        await db.run(`INSERT INTO ${tableName} (id, label) VALUES (@id, @label)`, { id: 2, label: 'nested' });
        throw new Error('nested rollback sentinel');
      });

      await assert.rejects(nested(), /nested rollback sentinel/, 'Nested transaction failures should surface to callers');

      const rows = await db.all<{ id: number; label: string }>(`SELECT id, label FROM ${tableName} ORDER BY id`);
      assert.deepEqual(rows, [{ id: 1, label: 'outer' }], 'Nested rollback should preserve outer transaction work');
    });

    await outer();

    const diagnostics = db.getDiagnostics?.();
    assertPoolDiagnostics(diagnostics);
    assert.ok((diagnostics?.transactions?.nestedStarted || 0) >= 1, 'Nested savepoint-backed transactions should be counted');
    assert.ok((diagnostics?.transactions?.committed || 0) >= 1, 'Successful transactions should be counted');
    assert.ok((diagnostics?.transactions?.rolledBack || 0) >= 1, 'Rolled back transactions should be counted');

    console.log('2 PostgreSQL transaction hardening check passed.');
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    await db.close?.();
  }
}

runConfigChecks();
await runIntegrationCheck();
