# Internal Links Scoring And Provider Spec

## Goal

The scoring system should rank recommendations by SEO impact and editorial usefulness while staying transparent enough for an agency user to trust.

## Score Shape

Each opportunity should eventually persist a score breakdown:

```json
{
  "targetNeed": 34,
  "sourceAuthority": 22,
  "topicMatch": 18,
  "semanticBoost": 9,
  "anchorQuality": 8,
  "safety": 9,
  "diversityPenalty": 0,
  "total": 100,
  "notes": ["Target ranks 4-20", "Source is shallow and relevant"]
}
```

All values should be deterministic before optional LLM judging.

## Target Need

Inputs:

- inbound internal link count
- orphan/near-orphan state
- GSC impressions
- GSC clicks
- weighted average position
- distinct query count
- GA4 sessions/page views
- search visibility gap

Signals:

- low inbound links increases need
- rankings 4-20 increase priority
- high impressions increase priority
- GA4 engagement with low search visibility increases priority

## Source Authority

Inputs:

- crawl depth
- source GSC clicks
- source inbound link count
- source indexability

Signals:

- shallow pages are stronger sources
- pages with clicks/traffic are stronger sources
- pages with inbound links are stronger sources

## Topic Match

Inputs:

- target title/H1/meta/page-key tokens
- target GSC top queries
- source sentence tokens
- heading context when available
- semantic similarity when available

Rules:

- lexical overlap is cheap and deterministic
- semantic similarity can boost but should not override anchor exactness
- source sentence must still support a natural anchor

## Anchor Quality

Good anchors:

- exact phrase in source sentence
- descriptive
- 2-6 meaningful words when possible
- aligned with target title/query/topic

Bad anchors:

- click here
- learn more
- this guide
- generic one-word anchors unless the target is a brand/entity page
- repeated exact anchor across many source pages

## Safety

Reject or penalize when:

- source already links to target
- source equals target
- target is noindex/error/canonicalized away
- source sentence is too short
- sentence appears in boilerplate/navigation/CTA
- source or target is outside the workspace site scope

## Diversity

Avoid:

- too many links to the same target in one run
- too many recommendations from one source page
- repeated anchors across many pages
- near-duplicate source sentences

## Provider Modes

### Built-in BGE-M3

- default provider key: `local`
- zero hosted cost
- runs the official `BAAI/bge-m3` model through the managed GSC+ embedding worker
- worker source: `services/embedding-worker`
- local endpoint: `http://127.0.0.1:8091`
- configuration: `INTERNAL_LINK_EMBEDDING_WORKER_URL`
- started automatically with PostgreSQL by `npm run dev` or manually with `npm run local:services:up`
- model weights are downloaded once into the persistent `bge-m3-model-cache` Docker volume
- returns normalized 1024-dimensional dense vectors
- does not require, call, or configure Ollama
- reports `loading`, `ready`, and `error` states through the provider readiness endpoint
- fails before queueing analysis when the managed worker is unavailable

### Local Rules Fallback

- explicit provider key: `local-rules`
- zero hosted cost
- always available
- deterministic
- weaker than BGE-M3 and should be used only as a fallback or test mode

### Embedding Cache

BGE-M3 vectors are persisted in `internal_link_embedding_cache` by provider, runtime model, input type, and text hash.

Rules:

- sentence hashes from crawl extraction are reused when available
- target descriptor text is hashed from title, H1, meta description, URL tokens, and top GSC queries
- duplicate sentence/target inputs are embedded once per model
- cached vectors do not count toward actual embedding token usage
- model versions include cache coverage, for example `semantic:local:BAAI/bge-m3:cache:1258/1258`

This is the baseline scale-control layer. For a free vector database, the default deployment path is self-hosted Postgres with pgvector:

- local Docker uses `pgvector/pgvector:pg16`
- migrations try `CREATE EXTENSION IF NOT EXISTS vector`
- 1024-dimensional BGE-M3 vectors are mirrored into `internal_link_embedding_vectors_1024`
- HNSW cosine index is created when pgvector is available
- semantic candidate retrieval joins current crawl sentences to pgvector by sentence hash inside Postgres, then maps matching rows back to exact filtered source sentences
- crawl sentence indexes cover owner/site/job/textHash and quality-filtered textHash retrieval for agency-scale crawls
- Postgres schema setup is protected by an advisory transaction lock so multiple app/API workers do not race on startup migrations
- if pgvector is unavailable, the app keeps using the JSON embedding cache and in-memory semantic scan without failing startup

Qdrant or LanceDB can remain optional later if a deployment wants a separate vector service, but V1 should avoid that extra service for agencies that want zero hosted database cost.

### Optional Ollama Embeddings

- zero hosted cost
- uses `OLLAMA_BASE_URL` or `INTERNAL_LINK_OLLAMA_BASE_URL`
- tries `/api/embed`, then `/api/embeddings`
- fails loudly with setup guidance on failure

Recommended models:

- `bge-m3`
- `mxbai-embed-large`
- `nomic-embed-text`
### Hosted Embeddings

Selectable providers with estimate and spend-cap controls:

- OpenAI
- Gemini
- Jina
- Cohere
- Voyage

Current behavior:

- estimate before run
- enforce `maxHostedSpend` before queueing
- persist provider/model version
- execute through encrypted provider settings; OpenAI `text-embedding-3-*` is requested at 1024 dimensions for pgvector compatibility

Adapter requirements:

- actual usage recording
- retry/backoff
- provider-specific auth settings stored in encrypted internal-link provider settings
- strict failure accounting

### LLM Judge

Current local behavior:

- Ollama judge is supported when users select review provider `ollama`
- returned JSON must pass strict source sentence, target URL, anchor text, and anchor offset validation
- malformed, generic, partial-word, wrong-target, or non-specific outputs are rejected instead of repaired silently

Supported optional hosted/local providers:

- Ollama
- OpenAI
- Gemini
- Anthropic
- OpenRouter-compatible endpoints

Judge input should include only finalists:

- source title/url
- source heading context
- source sentence
- candidate target title/url
- target GSC queries/metrics
- existing links summary
- deterministic score breakdown

Judge output must be strict JSON:

```json
{
  "accept": true,
  "anchorText": "forecast my traffic",
  "anchorStart": 12,
  "anchorEnd": 31,
  "targetUrl": "https://example.com/forecast-seo-traffic/",
  "readerBenefit": "A reader trying to forecast traffic here benefits from...",
  "confidence": "high",
  "rejectReason": null
}
```

Acceptance gate:

- `accept` must be true
- anchor offsets must match exactly
- reader benefit must be specific
- target URL must match candidate target
- reject reason required when `accept` is false

## Cost Model

Estimate:

- embedding tokens from usable sentence count and average sentence length
- review tokens from finalists count and prompt size
- hosted embedding cost by provider rate
- hosted review cost by provider/model rate

Current rough defaults:

- hosted embedding placeholder: `$0.02 / 1M tokens`
- hosted review placeholder: `$0.20 / 1M tokens`
- local/Ollama: `$0 hosted cost`

## Implementation Order

1. Persist score breakdown.
2. Display score breakdown in UI.
3. Add provider-reported usage reconciliation for hosted adapters.
4. Add live-key acceptance tests for hosted embedding and judge providers.







