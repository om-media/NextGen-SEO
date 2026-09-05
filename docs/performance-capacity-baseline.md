# Performance and capacity baseline

Measured 2026-09-03 against the running PostgreSQL 16 development database. Only the PostgreSQL container was running during this measurement; this is a storage and database baseline, not a full application throughput test.

## Observed database

- Database size before cleanup: 36,537,596,951 bytes (`34 GB` pretty-printed).
- Database size after cleanup: 36,218,919,959 bytes (`34 GB` pretty-printed).
- Reclaimed: 318,676,992 bytes by removing one exact duplicate index.
- Main table data: approximately 12 GB.
- Indexes: approximately 22 GB.
- Users: 17.
- Owners with GSC data: 5.
- Distinct sites: 20.
- Owner/site pairs: 46.

The largest relations are the GSC warehouse facts:

| Relation | Rows | Total size |
| --- | ---: | ---: |
| `gsc_page_query_metrics` | 16.6M | 17 GB |
| `gsc_query_metrics` | 11.3M | 7.0 GB |
| `gsc_page_query_monthly_metrics` | 3.37M | 3.7 GB |
| `gsc_page_metrics` | 2.49M | 2.2 GB |
| `gsc_query_monthly_metrics` | 2.52M | 2.0 GB |

The biggest single index is the `gsc_page_query_metrics` primary key at about 4.26 GB. The table also has several large, overlapping secondary indexes. They should be evaluated with production query-usage statistics before any more are removed.

The storage report uses the latest observed raw date (`2026-08-10`) as its anchor. A 90-day hot window ends at `2026-05-13`; a 180-day hot window ends at `2026-02-12`:

| Table | Total rows | 90-day hot rows | 90-day candidates | 180-day hot rows | 180-day candidates |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gsc_query_metrics` | 11.33M | 1.67M | 9.66M | 3.48M | 7.85M |
| `gsc_country_metrics` | 1.13M | 0.17M | 0.96M | 0.36M | 0.77M |
| `gsc_page_metrics` | 2.50M | 0.40M | 2.09M | 0.81M | 1.69M |
| `gsc_page_query_metrics` | 16.59M | 2.24M | 14.34M | 4.65M | 11.94M |

These are row counts, not a promise of exact disk savings. Existing unpartitioned tables would need a rewrite or repack after archival to return freed pages to the operating system.

The live no-delete purge preview for the 180-day cutoff (`2026-02-12`) found 22.26M candidate raw rows and estimated 20,151,985,508 reclaimable relation bytes. This is a proportional estimate across table-plus-index sizes; it is not a guaranteed post-purge footprint. The preview correctly reported `archiveReady=false` because no complete verified archive exists for all five tables.

## Changes applied

- `/api/workspace/sites/status` now performs grouped reads instead of roughly seven sequential reads per property. The 50-property regression fixture uses 6 database queries.
- Internal-link analysis now scopes link, sentence, GSC, and GA4 reads to the selected crawl pages instead of loading the entire site-wide sets into the worker.
- Crawl comparison now computes counts and samples in PostgreSQL instead of loading both complete crawl snapshots into Node.js memory.
- PostgreSQL planner statistics were refreshed with `ANALYZE`.
- One exact duplicate monthly warehouse index was removed after verifying its definition matched an existing index.
- Added `npm run warehouse:storage-report -- --retention-days=90|180` as a read-only, repeatable lifecycle measurement.
- Added `npm run warehouse:storage-archive -- --before=YYYY-MM-DD` as a checksum-verified, gzip JSONL export that never deletes source rows.
- Added `npm run warehouse:storage-verify -- --manifest=path/to/manifest.json` to independently verify archive bytes, row counts, content checksums, keys, cutoff, and date ordering.
- Added `npm run warehouse:partition-plan -- --retention-days=180` to generate a reviewed monthly shadow-table plan; it provisions the observed date range plus one future month and does not apply DDL.
- The partition planner accepts optional `--record` to persist the reviewed plan in lifecycle metadata; without it, planning remains read-only.
- Added `npm run warehouse:storage-purge-plan -- --retention-days=180` as a no-delete gate: it reports candidate rows, estimated reclaimable bytes, and whether every candidate table has a verified archive manifest. `--include-sql` prints review-only DELETE statements.
- Added `npm run warehouse:storage-route -- --table=gsc_page_query_metrics --start=YYYY-MM-DD --end=YYYY-MM-DD` to expose whether a requested range is hot, cold, mixed, or unavailable.

## VPS starting point

The number of registered users is not enough to size this system. Active properties, retained daily page/query rows, crawl size, concurrent workers, and backup history are the controlling variables.

For the measured 34 GB database alone, use at least:

- 100 GB fast SSD/NVMe for the database volume, with backups stored elsewhere.
- 16 GB RAM for a small production start; 32 GB is the safer target for analytical queries and vacuum/index maintenance.
- 4 dedicated vCPU as a practical floor for PostgreSQL plus light application traffic; use a separate worker host once crawls or embeddings are active.

For 1,000 users with up to 50 properties each, a single cheap VPS is not a credible capacity target unless most properties are inactive or raw warehouse retention is aggressively bounded. The current data already averages roughly 0.7 GB per owner/site pair, and the distribution is highly skewed. Extrapolating that average to 50,000 active pairs would imply tens of terabytes before backups and overhead; it is an upper-bound warning, not a forecast.

Before accepting that scale, define retention and rollup rules for daily page/query facts, and run a full-stack load test with representative page counts and concurrent worker jobs. Then use PostgreSQL `pg_stat_statements` and index usage counters over real traffic to consolidate the remaining overlapping indexes safely.
