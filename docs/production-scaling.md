# Production load and operations

This document describes the load harness and the production topology that the Compose files define. It does not claim that the application meets the thresholds below in every environment.

## Preconditions

The harness lives in [`scripts/load`](../scripts/load/). A real run needs:

- a built and running API;
- PostgreSQL with the application schema;
- the worker roles required by the selected scenarios;
- a ready BGE-M3 worker for embedding scenarios;
- authentication fixtures for dashboard and queue scenarios.

Run the harness self-check without external services:

```bash
npm run check:load-harness
```

The default configuration is in [`scripts/load/fixtures/sample-config.json`](../scripts/load/fixtures/sample-config.json), merged with defaults from [`scripts/load/lib/config.mjs`](../scripts/load/lib/config.mjs).

## Safety gates

The harness starts with the read-only `dashboard` scenario enabled. The following actions require explicit flags:

| Action | Required flag |
| --- | --- |
| Crawl burst, internal-link burst, or cancellation | `--allow-writes` |
| PostgreSQL restart | `--allow-db-restart` |
| Dashboard or queue scenarios | `--users <path>` or `auth.usersPath` |

`--plan-only` validates the configuration and prints the execution plan without sending requests. The harness rejects missing auth fixtures for scenarios that need authenticated users.

## Scenarios and defaults

The code currently defines these scenarios:

| Scenario | Default | Behavior |
| --- | ---: | --- |
| `dashboard` | enabled | Authenticated reads across session, workspace, warehouse, crawl, and internal-link endpoints |
| `crawlBurst` | disabled | Enqueues 12 crawl jobs |
| `internalLinksBurst` | disabled | Enqueues 12 local BGE/local-rules analyses |
| `bge` | disabled | 24 batches of 16 texts at concurrency 8 |
| `cancellation` | disabled | Cancels selected crawl and internal-link jobs after a delay |
| `fairness` | disabled | Observes queue start lag and cross-site distribution |
| `restart` | disabled | Runs a configured database restart command and checks recovery |

The default dashboard run uses 200 virtual users, two loops per user, a 60-second ramp, and a 28-day coverage range. Those are test inputs, not production capacity claims.

## Default gates

The harness evaluates these defaults:

| Gate | Default |
| --- | ---: |
| Overall request error rate | `<= 2%` |
| Dashboard p95 | `<= 1500 ms` |
| Dashboard p99 | `<= 3500 ms` |
| BGE p95 | `<= 12000 ms` |
| Cancellation success | `>= 90%` |
| Fairness Jain index | `>= 0.90` |
| Fairness maximum start lag | `<= 60000 ms` |
| Database restart recovery | `<= 120000 ms` |

Treat these values as acceptance defaults. Record the commit, configuration, database size, topology, and result JSON with each meaningful run. Do not present a single local run as a general SLO.

## Commands

Print a plan:

```bash
node scripts/load/run-production-load.mjs --config scripts/load/fixtures/sample-config.json --plan-only
```

Run the read-only dashboard baseline with supplied fixtures:

```bash
node scripts/load/run-production-load.mjs --config scripts/load/fixtures/sample-config.json --users path/to/200-users.json --output .tmp/dashboard-200.json
```

Run write-enabled queue scenarios in a disposable environment:

```bash
node scripts/load/run-production-load.mjs --config path/to/load-config.json --users path/to/200-users.json --allow-writes --scenarios dashboard,crawlBurst,internalLinksBurst,cancellation,fairness
```

Run BGE pressure by itself:

```bash
node scripts/load/run-production-load.mjs --config path/to/load-config.json --scenarios bge
```

Run database recovery only during a maintenance or staging window:

```bash
node scripts/load/run-production-load.mjs --config path/to/load-config.json --users path/to/200-users.json --allow-db-restart --scenarios dashboard,restart
```

The fixture helper creates disposable auth data after a build:

```bash
npm run load:fixtures -- --count 200 --output .tmp/load-users-200.json
npm run load:fixtures -- --cleanup
```

## Production topology

`docker-compose.production.yml` defines these services:

- Nginx gateway;
- stateless web replicas;
- one-shot `database-prepare` for schema setup and legacy backfills;
- dedicated crawl, internal-link, warehouse, and scheduler processes;
- PostgreSQL 16 with pgvector;
- a self-hosted Python BGE-M3 worker with bounded queues and dynamic batching.

Production web replicas set `APP_PROCESS_ROLE=web`, disable background workers, and skip database backfills. Worker readiness probes use ports 3101 through 3104. The Compose defaults allocate 30 PostgreSQL connections to two web replicas, then 8 to crawl, 10 to internal links, 8 to warehouse, and 4 to the scheduler.

The standalone Docker image runs the web role only. It does not provide scheduled imports or background workers.

## Worker probes

For crawl, internal-link, warehouse, and scheduler workers:

- `/health` reports process liveness;
- `/ready` checks database access and, for warehouse/scheduler, runtime health.

An idle queue is healthy. Alert on failed or degraded runtime status, stale heartbeats, stale running jobs, or growing authentication/quota/provider failures.

## What this harness does not measure

- Browser paint and interaction timing.
- Production network latency or target-site behavior unless the test environment includes it.
- Capacity beyond the configured scenarios and fixture data.
- Internal fairness details that the public job state does not expose.

The repository has no current, reproducible benchmark recorded in this document. Add measured results only with the run metadata described above.
