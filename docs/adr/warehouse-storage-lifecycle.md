# ADR: Hot and cold warehouse storage lifecycle

## Status

Proposed implementation direction. The current PostgreSQL tables remain the source of truth until an archive has been verified.

## Context

GSC page/query facts are high-cardinality daily observations. In the measured database, the largest daily fact tables contain tens of millions of rows and their indexes consume more space than the table data. Keeping application state, interactive analytics, and indefinite raw history in the same row-oriented PostgreSQL tables makes storage and vacuum cost grow with every retained day.

## Decision

Use three storage temperatures:

1. **Hot PostgreSQL data** — recent daily facts, monthly summaries, site metadata, jobs, and API-serving aggregates.
2. **Cold archive** — older raw facts in compressed, partitioned files or a managed analytical warehouse, retained according to the workspace plan.
3. **Application state** — users, access mappings, queues, annotations, and analysis outputs remain in PostgreSQL regardless of analytics retention.

The first implementation seam is `getWarehouseStorageReport()`. It measures raw-table row counts, date spans, retention candidates, and PostgreSQL relation sizes without mutating data. `warehouse_storage_archives` records verified archive files, and `warehouse_storage_partitions` records a plan only when `warehouse:partition-plan --record` is explicitly requested. The archive writer uses a temporary file and atomic rename; `warehouse:storage-verify` independently re-reads gzip JSONL, checks keys/cutoff/date order, and recomputes the content hash. The `warehouse:partition-plan` command generates shadow-table PostgreSQL DDL from the live date coverage; by default it does not apply that DDL or move source rows. `getWarehouseStorageRangeRoute()` classifies a historical request as hot, cold, mixed, or unavailable from the hot cutoff and verified archive coverage. A future archive/purge adapter must require an explicit cutoff, write and verify an archive manifest, then remove data only after checksums and row counts match.

## Lifecycle rules

- New raw daily tables should be partitioned by month on PostgreSQL. The existing raw fact primary keys already include `date`, which keeps them compatible with PostgreSQL's partitioned-table uniqueness rule. The first migration should use shadow parents, validate counts/checksums, switch writers/readers, and only then retire the old tables.
- The partition plan provisions one month beyond the latest observed month. A scheduled migration must add each subsequent month before ingestion reaches it; a default partition is intentionally omitted so an unexpected date fails loudly instead of silently bypassing lifecycle controls.
- Monthly summaries are retained longer than daily page/query facts.
- Retention is explicit and configurable; startup must never purge rows implicitly.
- Historical exports read cold storage asynchronously when the requested range is outside hot PostgreSQL data.
- A logical property should be stored once when multiple authorized users refer to the same provider property; access membership remains separate from fact ownership.

## Consequences

This keeps interactive reads small and makes old data cheap to retain, but it introduces an archive format, manifest verification, and a second read adapter. The storage-report, archive, and partition-plan modules provide the seams and test surface before the physical migration is attempted.
