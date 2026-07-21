# Visual Semantics and Topical Authority Plan

## Objective

Add evidence-based page understanding to GSC+ so the app can identify page structure, page purpose, query-to-page mismatch, template-wide issues, topical gaps, and better contextual internal-link placements.

This capability must extend the warehouse-first crawl and reporting model. It must not depend on live provider requests while a report is open, render every page on every crawl, or present speculative ranking claims as facts.

## Product Principles

1. Evidence before scores. Every recommendation must expose the page regions, queries, crawl facts, and performance metrics that produced it.
2. Rules before expensive models. Deterministic extraction and local embeddings are the default; hosted review is optional and only resolves ambiguous cases.
3. Crawl once, derive many times. Store reusable page structure and task features, then materialize reports from PostgreSQL.
4. Analyze templates before pages. Detect representative templates and propagate supported findings rather than rendering every URL.
5. Existing data remains usable. Background analysis never blocks crawl inventory, GSC, GA4, blended, or internal-link reports.
6. Avoid ranking-factor language. Describe editorial, information-architecture, and coverage evidence, not guaranteed Google behavior.

## Existing Foundations

- `crawl_pages`, `crawl_links`, `crawl_page_text_blocks`, and `crawl_page_sentences` already persist the crawl corpus.
- Sentence rows already include `headingText`, `linkDensity`, `boilerplateScore`, and `extractionVersion`.
- JavaScript rendering exists through Puppeteer, but its current request profile intentionally blocks visual assets and is not suitable for screenshot analysis.
- Internal Links already provides queued analysis jobs, local BGE-M3 embeddings, pgvector support, cost estimates, score breakdowns, stale-result handling, and editorial actions.
- `gsc_page_query_metrics` is the correct base fact for query-to-page relationships.
- Canonical page reconciliation already exists across GSC, GA4, and crawl data.
- Background worker roles, queue leases, retries, Docker services, and health endpoints already exist.

## Target Data Flow

```text
Completed crawl
  -> DOM feature extraction
  -> template clustering and cross-page boilerplate analysis
  -> page region and page-task profiles
  -> query activity classification from warehouse GSC facts
  -> query/page function matching
  -> layout-aware internal-link ranking
  -> topical map and opportunity materializations
  -> sampled rendered enrichment for representative or ambiguous pages
  -> evidence-first Content & Authority UI
```

All derived records are scoped by `ownerId`, logical site scope, `siteUrl`, and `crawlJobId`. A newer completed crawl marks older derived findings stale without deleting their history.

## Architecture Decisions

### 1. Add a logical site scope

Introduce a canonical site-scope dimension above provider-specific properties so `sc-domain:`, `https://`, `www`, and mapped GA4 properties can share one logical website without double counting.

The site scope is required before topical materialization because current warehouse primary keys can split the same website across property variants.

### 2. Use a two-stage page-understanding pipeline

**Stage A: DOM-first analysis**

- Runs from stored crawl HTML-derived data.
- Covers semantic regions, heading chains, block type, page type/task, repeated boilerplate, template clustering, query-function matching, and internal-link placement.
- Does not require screenshots or a browser session.

**Stage B: sampled rendered enrichment**

- Runs in a dedicated low-concurrency worker after Stage A.
- Captures bounding boxes, viewport prominence, component visibility, screenshots, and render fingerprints.
- Processes representative template pages, high-value pages, pages with low classifier confidence, and pages where DOM and query evidence disagree.
- Does not render an entire site by default.

### 3. Keep screenshots outside primary SQL payloads

PostgreSQL stores artifact metadata and an object/file storage key. Screenshot binary data is not stored in report rows or returned with normal list endpoints.

### 4. Reuse the Internal Links execution model

Visual-semantic analysis follows the same queue, lease, progress, retry, estimate, stale-result, provider-setting, and score-breakdown patterns as Internal Links. It receives a separate worker role only when rendered analysis is enabled.

## Proposed PostgreSQL Model

Exact names can be adjusted during migration design, but ownership and relationships should remain stable.

### Core identity and jobs

- `site_scopes`
  - `id`, `ownerId`, `canonicalDomain`, `createdAt`, `updatedAt`
- `site_scope_sources`
  - `siteScopeId`, `sourceType`, `sourceKey`, `siteUrl`, `propertyId`
- `page_analysis_jobs`
  - `id`, `ownerId`, `siteScopeId`, `siteUrl`, `crawlJobId`, `analysisType`, `status`, progress, lease, retry, model/extraction versions, timestamps, `lastError`

### Crawl-derived page understanding

- `crawl_page_regions`
  - identity: owner/site/crawl/page/region
  - structure: `parentRegionIndex`, `regionRole`, `componentType`, `blockIndex`, `headingChainJson`, `domPath`, `selector`
  - evidence: `text`, `textHash`, `textDensity`, `linkDensity`, `boilerplateScore`, `templateFrequency`
  - rendered fields, nullable: `bboxX`, `bboxY`, `bboxWidth`, `bboxHeight`, `viewportProminence`, `visible`
  - classification: `confidence`, `featureBreakdownJson`, `extractionVersion`
- `page_template_clusters`
  - `siteScopeId`, `crawlJobId`, `templateKey`, `exemplarPageKey`, `urlSkeleton`, `domSignature`, `regionSequenceHash`, `memberCount`, `confidence`
- `page_template_members`
  - `templateKey`, `pageKey`, `distance`, `isExemplar`
- `page_function_profiles`
  - `pageKey`, `crawlJobId`, `templateKey`, `pageType`, `primaryTask`, `secondaryTasksJson`, `centerpieceRegionIndex`, `confidence`, `featureBreakdownJson`, `manualOverrideJson`
- `page_render_snapshots`
  - `pageKey`, `crawlJobId`, viewport/render profile, dimensions, `domHash`, `assetHash`, `screenshotStorageKey`, `renderedAt`, `renderStatus`, `lastError`

### Warehouse-derived matching and topical maps

- `query_classifications`
  - `siteScopeId`, `queryKey`, `intentClass`, `activityClass`, `confidence`, `evidenceJson`, `modelVersion`, first/last seen
- `query_page_match_scores`
  - `siteScopeId`, `queryKey`, `pageKey`, `windowDays`, demand/performance facts, `canonicalAdjusted`, `matchScore`, `reasonCodesJson`, `computedAt`
- `topic_map_nodes`
  - page/query/topic/template nodes with label, embedding reference, confidence, and evidence
- `topic_map_edges`
  - source/target node, edge type, weight, evidence, and computed time
- `topical_opportunities`
  - gap type, affected pages/queries, priority, confidence, evidence, recommendation, status, user note, stale state

### Additive changes to existing tables

- `crawl_page_sentences`: add stable `blockIndex`, `regionIndex`, `regionRole`, `blockType`, `pageType`, and `visualProminence` fields.
- `crawl_links`: add source `regionRole`, `blockType`, and placement evidence.
- `internal_link_opportunities`: persist source region/block/page-type and `layoutFit` evidence.
- Bump sentence extraction version when the new region contract becomes required.

## Classification and Scoring

Scores are diagnostic ordering tools, not ranking predictions.

### Semantic regions

Initial region vocabulary:

`header`, `navigation`, `breadcrumb`, `hero`, `table_of_contents`, `main`, `section`, `sidebar`, `faq`, `comparison`, `product_grid`, `tool`, `form`, `related_content`, `cta`, `footer`, `unknown`.

Features include semantic HTML, ARIA role, DOM path, heading ancestry, text density, link density, DOM depth, sibling shape, repeated block hashes, and template frequency. Rendered fields are optional enrichments, not prerequisites.

### Page type and primary task

Initial page types:

`article`, `guide`, `hub`, `category`, `service`, `product`, `comparison`, `tool`, `faq`, `location`, `legal`, `utility`, `transactional`.

Initial query/page activities:

`learn`, `compare`, `calculate`, `buy_or_hire`, `find`, `navigate`, `troubleshoot`, `review`, `reference`.

Rules produce the baseline. Local embeddings and a small classifier may refine uncertain records. Manual overrides survive recomputation.

### Centerpiece evidence

Return the top three candidate regions with confidence rather than a single unqualified answer. Candidate evidence includes:

- structural role and heading strength
- uniqueness relative to the template
- query affinity
- text or functional richness
- viewport prominence when rendered
- penalties for repeated boilerplate, high link density, navigation, sidebars, and promotional blocks

### Query-function mismatch

Prioritize mismatches using stored demand and evidence:

- dominant query activities do not match the page task
- expected functional component is absent or low prominence
- CTR is weak relative to position and comparable pages
- query modifiers conflict with title, H1, or centerpiece
- multiple pages compete for the same activity without distinct functions

### Topical opportunity types

- demand without a suitable page
- wrong page or page function for existing demand
- missing supporting task such as comparison, pricing, examples, FAQ, or how-to
- over-fragmented/cannibalized cluster
- weak hub or weak internal support
- important centerpiece obscured by template boilerplate

## Layout-Aware Internal Links

The existing recommendation engine should consume the shared page-understanding fields rather than create separate classifications.

1. Hard-exclude navigation, footer, share, cookie, account, cart, and other non-editorial regions.
2. Prefer main-content paragraphs and list items with a useful heading context.
3. Add `layoutFit` to the score breakdown and persist it with each opportunity.
4. Apply identical region filters to pgvector retrieval and the in-memory fallback.
5. Limit repeated recommendations per block and region.
6. Use page-type priors to exclude low-value source pages and avoid unnatural target relationships.

## API Surface

Add a cohesive `/api/content-authority` namespace:

- `GET /readiness?siteUrl=&crawlJobId=`
- `POST /analyze`
- `GET /jobs`
- `GET /pages`
- `GET /pages/:pageKey/evidence`
- `GET /templates`
- `GET /query-mismatches`
- `GET /topics`
- `GET /opportunities`
- `PATCH /opportunities/:id`
- `PATCH /pages/:pageKey/override`

Normal report endpoints are warehouse-only. Starting analysis is explicit in the API, but site onboarding and completed crawls may queue it automatically when feature flags allow.

## Product UX

### Information architecture

Use a `Content & Authority` workflow centered on the page:

1. Page Evidence: unified performance, crawl, structure, and source facts.
2. Content Opportunities: query/function mismatch and topical gaps.
3. Internal Links: exact contextual link recommendations.
4. Technical Crawl: crawl inventory and run history.

Do not add a vague standalone “topical authority score.”

### Page evidence sheet

Create one reusable responsive page evidence surface with tabs:

- Performance
- Technical
- Structure
- Content & intent
- Internal links

Each recommendation shows:

- finding and affected page/template
- exact query and region evidence
- confidence and why confidence is limited
- likely impact area, never promised ranking lift
- recommended editorial or template action
- stale/fresh state and source timestamps

### Loading and failure behavior

- Keep the last successful findings visible while background analysis runs.
- Show progress only when the current view is materially incomplete.
- Distinguish no evidence, pending analysis, renderer unavailable, stale findings, and failed jobs.
- A renderer failure must degrade to DOM evidence, not blank the report.

## Delivery Backlog

### Phase 0: Data-contract hardening

1. Add logical site scopes and source mappings.
2. Add a GSC truncation/completeness ledger for page-query facts.
3. Filter sentinel blank/zero rows from derived pipelines.
4. Standardize warehouse page responses on canonical `pageKey`.
5. Expand SQLite-to-PostgreSQL migration coverage for crawl and internal-link tables.

Exit criteria:

- property variants reconcile without double counting
- partial/truncated GSC facts cannot be reported as complete
- crawl and internal-link data migrate in the supported migration path

### Phase 1: Shared DOM feature model

1. Add region and template tables plus additive sentence/link columns.
2. Extend crawl extraction with stable block keys, heading chains, DOM paths, semantic/ARIA roles, and component hints.
3. Implement cross-page repeated-block analysis and template clustering.
4. Implement rules-first page type/task classification.
5. Persist confidence and feature breakdowns.

Exit criteria:

- deterministic fixtures classify standard article, category, product, comparison, tool, FAQ, and utility pages
- template clustering remains stable across an unchanged recrawl
- old crawls are explicitly versioned and never silently treated as complete

### Phase 2: Query-to-page function matching

1. Move intent/activity classification from frontend-only heuristics to a derived warehouse service.
2. Materialize query classifications and query/page match scores for rolling 28-, 90-, and 365-day windows.
3. Join against latest acceptable crawl canonical keys.
4. Support manual page-task and query-classification overrides.
5. Build the first Content Opportunities list with evidence and confidence.

Exit criteria:

- updates touch only affected query/page pairs and rolling windows
- mismatch precision is reviewed against a human-labeled fixture set
- stale or missing crawls fall back to raw page keys with an explicit confidence reduction

### Phase 3: Layout-aware Internal Links

1. Feed region/block/page-task fields into both semantic retrieval paths.
2. Add exclusions, placement priors, block diversity, and `layoutFit` scoring.
3. Persist and expose placement evidence in API, UI, CSV, and Markdown.
4. Bump extraction version and preserve the existing crawl-to-analysis handoff.

Exit criteria:

- nav/footer/sidebar candidates are excluded in deterministic and pgvector modes
- the same fixture produces materially equivalent ranking in pgvector and fallback paths
- every recommendation identifies its source region and score breakdown

### Phase 4: Sampled rendered semantics

1. Add a dedicated `visual-semantics` worker role and feature flags.
2. Add visual render profiles that load layout-critical CSS/fonts/images without changing the normal crawler profile.
3. Select 25-50 representatives from templates, top folders, high-demand pages, and low-confidence pages.
4. Capture bounding boxes, viewport visibility, render hashes, and screenshot storage keys.
5. Enrich centerpiece and component-placement evidence.

Initial worker budget:

- one site analysis job per worker
- two browser tabs per worker
- explicit per-page timeout and per-site byte/runtime budget

Exit criteria:

- unchanged pages hit the render cache
- renderer failure preserves DOM-only analysis
- no full-site rendering occurs by default
- render p95, crash rate, cache hit rate, queue age, RSS, and storage growth are observable

### Phase 5: Topical map materialization

1. Build topic nodes from centerpiece/main text, titles, H1s, top GSC queries, and existing BGE-M3 embeddings.
2. Add page/query/topic/template/internal-link edges.
3. Detect the defined topical opportunity types.
4. Add cluster and page evidence views; avoid decorative graph-first UI.
5. Add editorial acceptance, dismissal, note, and implemented states.

Exit criteria:

- each gap traces back to stored queries/pages/regions
- editors can distinguish a missing topic from a missing page function
- accepted/dismissed opportunities survive recomputation

### Phase 6: Experiments and validation

1. Record content/layout interventions as annotations.
2. Compare GSC and GA4 outcomes against prior periods and, where possible, unaffected template cohorts.
3. Track recommendation acceptance and resolution rates.
4. Use hosted model review only for ambiguous cases with explicit spend caps.

Exit criteria:

- product copy reports correlations and confidence, not causality
- success is measured by evidence quality, editorial acceptance, and issue resolution

## Verification Matrix

### Unit and deterministic fixtures

- region segmentation and heading-chain propagation
- boilerplate suppression and repeated-block frequency
- template fingerprinting and cluster stability
- page type/task classification and confidence calibration
- query activity rules and manual overrides
- centerpiece top-three ordering
- sampling, render hash, cache reuse, and invalidation

### Integration

- queue deduplication, leases, retries, cancellation, and stale-result handling
- crawl completion to derived-analysis handoff
- canonical and site-scope joins
- partial GSC coverage protection
- idempotent re-import and re-analysis
- identical layout exclusions in pgvector and in-memory retrieval
- PostgreSQL migrations and SQLite migration utility coverage

### Browser/E2E

- page evidence workflow at desktop and mobile widths
- pending/stale/failed/DOM-only/rendered states
- page and template filtering
- manual override and opportunity status persistence
- deep links from Crawl, Content Opportunities, Blended/Page Evidence, and Internal Links
- keyboard navigation, focus, labels, `aria-sort`, and reduced motion

### Operational gates

- request error rate remains below the existing production threshold
- queue age remains inside the documented fairness window
- browser crash rate and resource use remain stable
- cache hit rate prevents repeated full analysis
- screenshot storage growth remains within forecast

## Feature Flags and Rollback

Use independent flags:

- `content_authority_ui`
- `content_authority_dom_analysis`
- `content_authority_render_capture`
- `content_authority_writeback`

Rollback order:

1. Disable render capture.
2. Stop the visual worker.
3. Keep DOM-derived reports read-only if healthy.
4. Disable the UI if derived data is unreliable.
5. Leave additive schema in place; do not require destructive rollback.

## Recommended First Implementation Package

The first package should contain only Phase 0 and the smallest vertical slice of Phase 1:

1. logical site-scope contract
2. region/template schema and migrations
3. stable block-to-sentence linkage
4. deterministic semantic-region extraction
5. template clustering
6. page type/task profile with evidence
7. read-only page evidence API
8. fixtures and PostgreSQL lifecycle checks

It should not include screenshots, a visual score, a topical graph, or hosted AI. This package establishes the reusable evidence model that every later feature depends on.
