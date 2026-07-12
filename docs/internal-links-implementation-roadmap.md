# Internal Links Implementation Roadmap

## Phase 1: Foundation

Status: complete for the current V1 slice; deeper worker/test hardening remains below.

- Sidebar and Internal Links view
- Sentence-level crawl capture
- Link context capture
- Analysis jobs
- Persisted opportunities
- Local rules-first recommendations
- Ollama embedding boost
- Estimate endpoint
- Workspace batch queue
- Cancel/rerun
- Stale detection
- Implemented annotations
- CSV/Markdown export
- Deterministic QA script
- Score breakdown persistence/display/export

Remaining hardening:

- multi-process worker lock owner/heartbeat
- route/database integration tests

## Phase 2: Recommendation Transparency

Status: complete for persisted score components, UI display, and CSV/Markdown export.

Goal: make users understand why each recommendation exists.

Tasks:

- Add score breakdown column/table field.
- Persist target need, source authority, topic match, semantic boost, anchor quality, safety, diversity penalty.
- Show breakdown in UI.
- Include breakdown in Markdown export.
- Add deterministic QA for score-breakdown totals.

Acceptance:

- every recommendation has a score breakdown
- score explains confidence and priority
- no recommendation is accepted without exact anchor offsets

## Phase 3: Extraction Quality

Goal: improve source sentence quality.

Tasks:

- Add extraction version.
- Add heading context to sentences.
- Add link density and boilerplate score.
- Suppress repeated boilerplate across pages.
- Exclude TOC/nav/sidebar/footer/CTA patterns. Partial: heuristic filtering added; needs corpus QA.

Acceptance:

- source snippets are article-body quality
- no recommendations from nav/footer/sidebar text
- old crawl data prompts recrawl when extraction version changes

## Phase 4: LLM Judge

Goal: turn deterministic candidates into premium editorial recommendations.

Tasks:

- Add provider-neutral judge interface.
- Add local rules judge implementation.
- Add Ollama judge implementation.
- Add structured output validation.
- Add spend/token accounting fields if needed.
- Add reject reasons.

Acceptance:

- LLM judge only sees finalists
- malformed judge output is rejected
- anchor offsets are always verified
- reader benefit is specific
- hosted calls obey spend caps

## Phase 5: Provider Settings

Goal: agency-safe configuration.

Tasks:

- Add workspace AI/provider settings UI.
- Store provider type, model, endpoint, encrypted API key reference.
- Add max hosted spend defaults.
- Add provider setup guidance.
- Add actual usage/cost reporting.

Acceptance:

- local-first default works without keys
- users see estimate before hosted runs
- hosted run cannot exceed configured cap

## Phase 6: Persistent Embeddings

Goal: avoid re-embedding unchanged sentences.

Tasks:

- Add sentence embedding table/service or vector-store adapter.
- Use self-hosted Postgres + pgvector as the free default vector database; BGE-M3 vectors are stored and queried there for nearest-sentence retrieval, while Qdrant/LanceDB stay optional for separate vector-service deployments.
- Reuse by `textHash + model`.
- Track embedding model version.
- Add resumable embedding batches.

Acceptance:

- unchanged sentence hashes are not re-embedded
- embedding failures are resumable
- large sites do not block the web server

## Phase 7: Agency Dashboard

Goal: manage hundreds of sites.

Tasks:

- Global Internal Links queue dashboard.
- Workspace-wide job filters.
- Bulk cancel/rerun.
- Per-site recommendation counts.
- Stale/ready/implemented rollups.

Acceptance:

- user can queue all eligible sites server-side
- user can see progress across workspace
- failures are visible per site

## Phase 8: Evaluation And Rollout

Goal: prove quality.

Tasks:

- Golden recommendation dataset.
- Precision@10 tracking.
- Manual QA rubric.
- Provider comparison report.
- Regression checks for extraction/scoring.

Acceptance:

- quality improves over local-rules baseline
- users can explain why recommendations are ranked
- bad/forced recommendations are rare and measurable




