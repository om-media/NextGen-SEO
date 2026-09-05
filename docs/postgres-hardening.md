# PostgreSQL configuration and checks

`server/database.ts` builds a PostgreSQL pool from environment variables and exposes pool, transaction, and recoverable-error diagnostics through `getDiagnostics()`.

## Pool settings

| Variable | Default |
| --- | ---: |
| `POSTGRES_POOL_MAX` | `20` |
| `POSTGRES_POOL_MIN` | `0` |
| `POSTGRES_IDLE_TIMEOUT_MS` | `30000` |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | `10000` |
| `POSTGRES_POOL_MAX_LIFETIME_SECONDS` | `1800` |
| `POSTGRES_QUERY_TIMEOUT_MS` | `0` |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | `0` |
| `POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `120000` |
| `POSTGRES_KEEP_ALIVE` | `true` |
| `POSTGRES_KEEP_ALIVE_INITIAL_DELAY_MS` | `10000` |
| `POSTGRES_APPLICATION_NAME` | `gscplus` |

Role-specific Compose settings such as `WEB_POSTGRES_POOL_MAX` override the shared pool maximum for that process.

## Behavior covered by code

- Invalid numeric and boolean pool values fail validation before pool creation.
- SQLite fallback remains available when no PostgreSQL URL is configured outside production.
- PostgreSQL initialization uses migration locking and nested transactions use savepoints.
- Pool and transaction diagnostics are available through the health/readiness path without exposing credentials.

## Check

Run:

```bash
npm run check:postgres-hardening
```

Without an exported `DATABASE_URL` or `POSTGRES_URL`, the script checks configuration and skips live PostgreSQL integration. With a reachable database, it also checks initialization, nested savepoint transactions, rollback isolation, and diagnostics counters.
