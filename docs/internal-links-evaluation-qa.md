# Internal Links Evaluation And QA Plan

## Purpose

The Internal Links engine should be evaluated like a recommendation system, not just tested like a CRUD feature.

Testing must cover:

- deterministic invariants
- route/database behavior
- extraction quality
- recommendation quality
- provider fallback and cost safety
- workflow correctness

## Existing QA

`scripts/check-internal-link-qa.mjs` currently covers deterministic in-memory checks for:

- estimate provider-cost semantics
- anchor offset exactness
- export-safe row shape
- duplicate suppression semantics
- annotation idempotency semantics
- stale detection semantics
- stale marking across crawl generations
- job lifecycle status rules

Run:

```bash
node scripts/check-internal-link-qa.mjs
npm run check:internal-link-quality
```

`check:internal-link-quality` is the small golden editorial fixture. It asserts screenshot-style examples produce exact anchor offsets and reader-benefit rationales, suppress existing links, reject generic anchors, and never recommend image/PDF targets.

## Browser Smoke

After `npm run build` and `npm run db:postgres:up`, run the built UI against the real Express routes and local PostgreSQL database:

```bash
npm run check:internal-link-browser-smoke
```

This script starts the compiled Express app on an ephemeral localhost port, creates a temporary authenticated session for the most recent user with an activated site, opens Chromium with Playwright, clicks the `Internal Links` sidebar item, asserts the internal-link API calls are successful, checks that no image/PDF asset targets are rendered, saves a screenshot to `.tmp/internal-links-browser-smoke.png`, then closes the browser/server/database handles.

It is intentionally not part of `npm run verify` because it requires a built frontend, a running database, and browser-launch permission in sandboxed environments.

## Required Integration Tests

Add a route/database integration harness when the repo has a test runner.

Critical tests:

1. Queue requires active workspace site access.
2. Queue requires completed crawl.
3. Duplicate active queue returns `409`.
4. Cancel only works for queued/running jobs.
5. Rerun only works for terminal jobs.
6. New crawl marks old recommendations stale.
7. Implemented status creates exactly one annotation.
8. Implemented opportunities cannot move back to non-implemented status.
9. Existing source-target links are excluded.
10. Noindex/error targets are excluded.
11. Anchor offsets slice back to anchor text.
12. CSV/Markdown exports include source URL, target URL, anchor, context, rationale, note, score.

## Extraction Fixtures

Create fixtures for:

- normal article body
- article with table of contents
- article with sidebar/nav/footer
- repeated CTA blocks
- link-heavy paragraphs
- short fragments
- headings and paragraph sections

Assertions:

- article body sentences are retained
- nav/footer/sidebar sentences are excluded
- repeated boilerplate is suppressed
- heading context is attached
- link-heavy blocks are penalized/excluded

## Recommendation Quality Dataset

Create a small golden dataset:

- 5-10 real sites/pages initially
- 20-50 source articles
- known target pages
- manually labeled good/bad recommendations

For each candidate:

- source URL
- source sentence
- anchor text
- target URL
- label: good, acceptable, bad
- reason

Track:

- precision@10
- accepted recommendations per site
- rejection reasons
- duplicate anchor rate
- target/source diversity

## Manual QA Checklist

No crawl:

- estimate says crawl required
- analysis queue fails with clear message
- UI empty state is clear

Old crawl without sentence data:

- analysis prompts recrawl

Local rules:

- zero hosted cost
- recommendations generated without AI provider

Ollama unavailable:

- job completes with local fallback warning
- hosted cost remains zero

Workspace batch:

- queues eligible sites
- skips active jobs
- reports per-site failures
- does not leak inaccessible sites

Implemented workflow:

- mark complete updates status
- annotation appears for property
- repeated mark complete does not create duplicate annotations
- implemented row cannot be rejected afterward through API

Exports:

- CSV opens correctly with newlines/quotes
- Markdown groups by source article
- notes are included

## Provider QA

For every provider adapter:

- missing key produces setup guidance
- timeout falls back or fails clearly
- usage/cost recorded when available
- spend cap stops hosted calls
- malformed structured output is rejected
- anchor offset mismatch is rejected

## Release Gate

Before considering the engine production-ready:

- deterministic QA script passes
- `npm run lint` passes
- `npm run build` passes
- route/database integration tests exist for workflow-critical behavior
- at least one manual crawl-based QA run validates screenshot-style recommendations
- provider-cost preview is visible before hosted runs
### Postgres pgvector smoke

Run `npm run check:internal-link-pgvector` with the local pgvector Postgres container running. It validates free vector DB retrieval, zero fresh embedding tokens when cache is warm, exact anchor generation, asset-target suppression, implementation annotation creation, annotation idempotency, and rollback rejection for implemented recommendations.

### API route smoke

Run `npm run check:internal-link-api-smoke` with the local pgvector Postgres container running. It starts the compiled Express app without Chromium, authenticates with a real session cookie, verifies estimate/opportunity routes, confirms forbidden sites return 403, confirms invalid opportunity statuses return 400, confirms implemented rollback returns 409, and verifies implementation creates exactly one annotation.