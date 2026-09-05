# ADR: Separate production worker roles

## Status

Accepted in the repository configuration. This ADR describes the topology; it does not certify production capacity.

## Context

The application handles dashboard reads, provider imports, crawl jobs, internal-link analysis, page analysis, warehouse work, and scheduled refreshes. These workloads use different CPU, network, database, and queue resources.

## Decision

Run the HTTP application and background workloads as separate roles:

1. `web` serves authenticated dashboard/API traffic.
2. `crawl` processes crawl and page-analysis jobs.
3. `internal-links` processes semantic internal-link analysis.
4. `warehouse` processes warehouse jobs and GSC monthly-summary backfill.
5. `scheduler` runs Bing, warehouse, and rank-tracking schedules.

`database-prepare` runs schema preparation and legacy backfills once before the application roles start. PostgreSQL remains the source of truth for production data, queue state, and pgvector retrieval.

## Repository evidence

- `server.ts` accepts `web` or `all`; production defaults to `web`.
- `worker.ts` accepts `crawl`, `internal-links`, `warehouse`, or `scheduler` and exposes `/health` and `/ready`.
- `server/runtimeRoles.ts` maps each role to its services.
- `docker-compose.production.yml` wires the roles, readiness dependencies, healthchecks, and per-role PostgreSQL pool caps.
- Web replicas set `START_BACKGROUND_WORKERS=false` and all production roles skip normal database backfills.

## Queue and recovery model

PostgreSQL workers claim durable queue rows with short scheduling locks; job execution runs outside the claim lock. Crawl and internal-link jobs heartbeat their leases. Internal-link leases include a rotating token so a stale worker cannot finish replacement work. The BGE-M3 service runs separately with bounded request/text queues.

## Consequences

The split keeps dashboard traffic independent from crawl and analysis work and makes queue health observable per role. It also adds deployment and supervision requirements: all required services must start, share the same database, and pass readiness checks.

## Validation

Use `npm run verify:docker` for the production-like Compose smoke test and the load harness in [`docs/production-scaling.md`](../production-scaling.md) for workload checks. A passing TypeScript build does not validate this topology.
