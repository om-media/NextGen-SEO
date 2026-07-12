# PostgreSQL hardening

`server/database.ts` now reads these optional PostgreSQL pool settings from the environment:

- `POSTGRES_POOL_MAX` (default `20`)
- `POSTGRES_POOL_MIN` (default `0`)
- `POSTGRES_IDLE_TIMEOUT_MS` (default `30000`)
- `POSTGRES_CONNECTION_TIMEOUT_MS` (default `10000`)
- `POSTGRES_POOL_MAX_LIFETIME_SECONDS` (default `1800`)
- `POSTGRES_QUERY_TIMEOUT_MS` (default `0`)
- `POSTGRES_STATEMENT_TIMEOUT_MS` (default `0`)
- `POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS` (default `120000`)
- `POSTGRES_KEEP_ALIVE` (default `true`)
- `POSTGRES_KEEP_ALIVE_INITIAL_DELAY_MS` (default `10000`)
- `POSTGRES_APPLICATION_NAME` (default `gscplus`)

The runtime validates malformed values before creating the pool, keeps SQLite fallback behavior unchanged, preserves PostgreSQL migration advisory locking, and exposes pool/transaction diagnostics through `getDiagnostics()`.

Run the focused validation script with:

```bash
npx tsx --tsconfig tsconfig.server.json scripts/check-postgres-hardening.ts
```

If `DATABASE_URL` or `POSTGRES_URL` is set, the script also verifies PostgreSQL initialization, nested savepoint-backed transactions, rollback isolation, and diagnostics counters against a live database.
