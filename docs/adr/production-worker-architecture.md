# ADR: Production Worker Architecture For 200-User Acceptance

## Status

Accepted

## Context

The platform now combines:

- authenticated dashboard reads
- crawl queueing and processing
- internal-link analysis jobs
- Postgres + pgvector retrieval
- a managed Python SentenceTransformer worker running `BAAI/bge-m3`

The load harness in [`scripts/load`](../../scripts/load/) needs a stable production target to validate. Without a declared topology, the same acceptance run can mean very different things from one environment to the next.

## Decision

Use a split architecture for production and production-like acceptance:

1. Stateless API instances handle dashboard traffic and job admission.
2. Crawl workers run independently from API instances.
3. Internal-link workers run independently from crawl workers.
4. The BGE embedding worker runs as a separately managed service with explicit readiness checks.
5. Postgres remains the single source of truth for dashboard reads, queue state, and pgvector retrieval.

## Why this shape

### API separation

Dashboard traffic should not compete directly with heavy background work in the same process. Queue admission, read endpoints, and readiness probes stay more predictable when API instances are stateless and disposable.

### Dedicated crawl workers

Crawl bursts can be large, spiky, and network-bound. Isolating them keeps fetch-heavy behavior away from dashboard request handling and from the semantic analysis path.

### Dedicated internal-link workers

Internal-link analysis mixes SQL reads, pgvector similarity lookups, scoring, and optional cancellation. It deserves its own concurrency budget and queue visibility.

### Separate BGE worker

Embedding latency and model warmup behave differently from the Node app. The Python worker should be supervised, health-checked, and scaled on its own axis.

## Expected concurrency model

For the 200-user acceptance harness:

- Dashboard reads scale horizontally across API instances.
- Crawl burst concurrency is limited by dedicated crawl workers.
- Internal-link burst concurrency is limited by dedicated internal-link workers.
- BGE concurrency is limited by the worker process count or validated per-process batch headroom.

This separation keeps queue fairness measurable and makes failure injection easier to interpret.

## Operational consequences

### Positive

- Dashboard latency remains measurable even during crawl and internal-link bursts.
- Queue fairness has clearer ownership.
- BGE worker bottlenecks are easier to spot.
- Postgres restart recovery can be tested without confusing API-process crashes for DB failures.

### Negative

- More runtime roles means more deployment wiring and process supervision.
- Acceptance failures must be read with per-role metrics, not just HTTP summaries.
- Some fairness issues may still require deeper queue instrumentation later.

## Acceptance mapping

The harness scenarios map to the topology like this:

| Scenario | Primary bottleneck it should reveal |
| --- | --- |
| `dashboard` | API + Postgres read path |
| `crawlBurst` | crawl worker admission and queue depth |
| `internalLinksBurst` | internal-link worker throughput + pgvector reads |
| `bge` | embedding worker latency and concurrency headroom |
| `cancellation` | queue responsiveness under contention |
| `fairness` | cross-site starvation and worker scheduling imbalance |
| `restart` | DB readiness recovery and API resilience |

## Follow-up expectations

- Add runtime dashboards that mirror the harness gates.
- Add worker-level queue age metrics if fairness becomes ambiguous from HTTP-visible state alone.
- Re-baseline the documented SLO thresholds after several clean production-like runs.


## Implemented concurrency and recovery details

The accepted architecture is implemented with explicit runtime roles: `web`, `crawl`, `internal-links`, `warehouse`, and `scheduler`. Production defaults the HTTP entrypoint to `web`, so background loops cannot accidentally start in every web replica.

Queue claims use PostgreSQL `FOR UPDATE SKIP LOCKED` plus a short advisory transaction lock around fairness selection. The advisory lock does not cover job execution. Crawl jobs and internal-link jobs maintain heartbeats; internal-link workers additionally rotate a lease token, which fences a stale process after replacement.

BGE-M3 is hosted as a private Python service. Concurrent requests are dynamically coalesced into inference batches, and bounded request/text queues return explicit backpressure responses instead of allowing unbounded memory growth.

Schema preparation and legacy backfills run once through the `database-prepare` service. Normal web and worker replicas set `RUN_DATABASE_BACKFILLS=false`, avoiding a startup stampede.
