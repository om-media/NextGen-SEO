# Production Scaling

## Goal

This harness defines a repeatable acceptance run for the current production stack:

- React 19 dashboard traffic
- Express API reads and writes
- crawl queue bursts
- internal-link analysis queue bursts
- managed BAAI/bge-m3 worker pressure
- cancellation behavior
- fairness across site workloads
- optional Postgres restart recovery

The implementation lives in [`scripts/load`](../scripts/load/).

## Safety model

The load scripts are safe by default:

- `dashboard` is the only enabled scenario in the sample config.
- Crawl, internal-link, and cancellation scenarios require `allowWrites=true`.
- Database restart requires `allowDbRestart=true`.
- A run without `auth.usersPath` is rejected unless `bge` is the only enabled scenario.
- Reusing fewer than 200 auth fixtures is rejected unless `auth.allowAuthReuse=true`.

That means the default command exercises real authenticated dashboard reads, but it will not enqueue crawls, queue internal-link jobs, cancel work, or restart infrastructure unless those switches are deliberately armed.

## Topology under test

The acceptance harness assumes the production shape below:

```text
200 authenticated dashboard users
  -> Express API
    -> Postgres + pgvector
    -> crawl queue worker
    -> internal-links worker
    -> managed Python BAAI/bge-m3 embedding worker
```

Recommended production worker topology for the 200-user acceptance target:

| Layer | Minimum topology for acceptance |
| --- | --- |
| API | 2 stateless Express instances behind a shared LB |
| Postgres | 1 primary with readiness probes and connection limits set explicitly |
| pgvector | same primary, with enough memory for active similarity retrieval and indexes warmed |
| Crawl worker | 2 worker processes |
| Internal-link worker | 2 worker processes |
| BGE worker | 2 worker processes or 1 process with validated concurrency headroom |

## Scenarios

### 1. Dashboard read load

Target: 200 authenticated users, each executing 2 loops across:

- `/api/auth/session`
- `/api/workspace/sites/status`
- `/api/warehouse/status`
- `/api/warehouse/coverage`
- `/api/crawl/status`
- `/api/crawl/jobs`
- `/api/crawl/pages`
- `/api/crawl/links`
- `/api/internal-links/jobs`
- `/api/internal-links/opportunities`

This is the baseline production gate and should always run first.

### 2. Crawl burst

Target: enqueue 12 crawl jobs across distinct sites or tenant slices. This verifies admission behavior, conflict behavior, and downstream fairness when the queue is stressed.

### 3. Internal-link burst

Target: enqueue 12 internal-link analysis jobs using the local rules + built-in BGE path:

- `embeddingProvider=local`
- `embeddingModel=bge-m3-local`
- `provider=local`
- `reviewProvider=local-rules`

This is the cheapest production-like acceptance path because it avoids hosted spend while still stressing pgvector retrieval and the SentenceTransformer worker.

### 4. BGE concurrent batches

Target: pressure `/embed` with 24 batches x 16 texts at concurrency 8. This is the worker-only saturation check and should be treated as a separate acceptance dimension from the dashboard load.

### 5. Cancellation

Target: cancel a subset of crawl and internal-link jobs after a short delay to verify that queue state changes stay responsive under contention.

### 6. Fairness

Target: observe queued jobs and fail the run when one site or one queue slice starves. The harness computes:

- `terminalJain`
- `p95StartLagMs`
- `maxStartLagMs`

### 7. DB restart recovery

Target: while probes keep running, restart Postgres and require the stack to return to healthy readiness inside the configured recovery window.

This scenario is opt-in only.

## SLOs and pass/fail gates

The sample harness encodes these default gates:

| Gate | Default |
| --- | --- |
| Overall request error rate | `<= 2%` |
| Dashboard p95 | `<= 1500 ms` |
| Dashboard p99 | `<= 3500 ms` |
| BGE `/embed` p95 | `<= 12000 ms` |
| Cancellation success rate | `>= 90%` |
| Fairness Jain index | `>= 0.90` |
| Fairness max start lag | `<= 60000 ms` |
| DB restart recovery | `<= 120000 ms` |

Treat these as acceptance defaults, not eternal truths. Tighten them after production baselines stabilize.

## Capacity metrics to capture

During any 200-user acceptance run, collect:

- API instance CPU and RSS
- API request p50/p95/p99
- Postgres CPU, memory, active connections, and restart recovery time
- pgvector query latency and buffer hit ratio
- crawl queue depth and oldest queued age
- internal-link queue depth and oldest queued age
- BGE worker latency and active batch concurrency

If external observability is available, line these metrics up with the harness summary JSON instead of relying on the harness alone.

## Commands

Plan only:

```bash
node scripts/load/run-production-load.mjs --config scripts/load/fixtures/sample-config.json --plan-only
```

200-user dashboard acceptance:

```bash
node scripts/load/run-production-load.mjs --config scripts/load/fixtures/sample-config.json --users path/to/200-users.json --output scripts/load/results/dashboard-200.json
```

Write-enabled crawl + internal-link burst:

```bash
node scripts/load/run-production-load.mjs --config path/to/load-config.json --users path/to/200-users.json --allow-writes --scenarios dashboard,crawlBurst,internalLinksBurst,cancellation,fairness
```

BGE worker saturation:

```bash
node scripts/load/run-production-load.mjs --config path/to/load-config.json --scenarios bge
```

DB restart recovery:

```bash
node scripts/load/run-production-load.mjs --config path/to/load-config.json --users path/to/200-users.json --allow-db-restart --scenarios dashboard,restart
```

Harness self-check:

```bash
node scripts/load/check-load-harness.mjs
```

## Recommended acceptance sequence

1. Run `--plan-only`.
2. Run the 200-user dashboard baseline.
3. Run `dashboard + crawlBurst + internalLinksBurst + cancellation + fairness` with writes armed.
4. Run the BGE saturation scenario by itself.
5. Run DB restart recovery only in a maintenance window or a production-like staging environment.

## Known blind spots

- The harness measures HTTP behavior and queue observability, not browser paint timing.
- It does not generate or seed 200 accounts; you must provide auth fixtures.
- It observes fairness through exposed job status, not internal queue instrumentation.
- It will surface 409 conflicts, but interpreting whether that conflict rate is healthy still needs environment context.


## Implemented single-VPS topology

The repository includes `docker-compose.production.yml` with:

- an Nginx gateway on `APP_PORT`
- `WEB_REPLICAS` stateless web replicas
- a one-shot `database-prepare` service for migrations and legacy backfills
- dedicated crawl, internal-link, warehouse, and singleton scheduler processes
- self-hosted PostgreSQL 16 with pgvector
- a private, self-hosted BGE-M3 service with dynamic batching and bounded queues
- shared uploads and model-cache volumes

Start it with:

```bash
cp .env.production.example .env.production
# Replace every CHANGE_ME value before continuing.
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

The web and unrelated workers do not depend on BGE-M3 health. If embeddings are unavailable, internal-link semantic analysis pauses or errors clearly while dashboard reads, crawls, warehouse jobs, and scheduling remain available.

## Capacity controls

| Variable | Purpose | Production example |
| --- | --- | --- |
| `WEB_REPLICAS` | Stateless HTTP replicas behind Nginx | `2` |
| `*_POSTGRES_POOL_MAX` | Role-specific connection cap per process | web `15`, crawl `8`, internal links `10`, warehouse `8`, scheduler `4` |
| `CRAWL_JOB_CONCURRENCY` | Crawl jobs per crawl-worker process | `2` |
| `CRAWL_PAGE_CONCURRENCY` | Simultaneous page fetches per crawl job | `4` |
| `INTERNAL_LINK_JOB_CONCURRENCY` | Analyses per internal-link worker process | `2` |
| `INTERNAL_LINK_LOCK_TIMEOUT_MS` | Stale analysis recovery threshold | `600000` |
| `EMBEDDING_MAX_BATCH_SIZE` | Maximum texts coalesced per BGE inference | `128` |
| `EMBEDDING_MAX_QUEUE_REQUESTS` | BGE request backpressure limit | `128` |
| `EMBEDDING_MAX_QUEUE_TEXTS` | BGE text backpressure limit | `4096` |

Total background concurrency is process replicas multiplied by the per-process concurrency setting. The example role caps keep the steady-state Compose topology near 60 possible PostgreSQL connections (30 web + 8 crawl + 10 internal links + 8 warehouse + 4 scheduler), below PostgreSQL's usual 100-connection default with operational headroom. Increase one axis at a time while watching PostgreSQL waiting connections, crawler CPU/RSS, target-site response behavior, BGE batch latency, and queue age.

PostgreSQL is self-hosted and free in this topology. Backups, off-host retention, TLS, disk monitoring, and failover remain operator responsibilities.

## Queue guarantees

- Crawl and internal-link claims are durable PostgreSQL rows.
- Claim selection is serialized for only the short scheduling decision with PostgreSQL advisory transaction locks; job execution remains parallel.
- Scheduling balances the first worker wave across owners and prevents concurrent work for the same owner/site queue.
- Crawl and internal-link jobs heartbeat their leases.
- Stale internal-link workers are fenced by a rotating lease token and cannot complete or mark replacement work as failed.
- Recovered internal-link jobs reuse persisted embedding cache and existing recommendation checkpoints.
- The product API and UI expose workspace queue position, workload state, queue depth, and learned ETA.

## Verified local acceptance

On 2026-07-11, the compiled web-only artifact was tested against local PostgreSQL/pgvector with 200 distinct authenticated sessions. One dashboard loop per user exercised ten endpoints each:

- 2,000 requests
- 0 failures
- p50 3.56 ms
- p95 16.32 ms
- p99 27.96 ms
- max 57.63 ms

This proves the application path under the local fixture workload; it is not a substitute for repeating the harness on the target VPS with production-sized data, network latency, and observability enabled. The summary is written to the configured `outputPath`.

Create disposable local fixtures after a build:

```bash
npm run load:fixtures -- --count 200 --output .tmp/load-users-200.json
```

Remove them when finished:

```bash
npm run load:fixtures -- --cleanup
```
