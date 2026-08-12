# Open-source core and hosted SaaS boundary

## Decision

NextGen SEO has two products with different delivery models:

1. **Open-source edition** — this repository, released under AGPL-3.0.
2. **Hosted SaaS** — a separate, hosted-only product built around the open-source core and maintained in a private repository.

The open-source edition remains useful and self-hostable on its own. The SaaS does not intentionally cripple the public edition to force upgrades. SaaS revenue is intended to recover managed infrastructure, hosted AI, storage, crawling, operations, and support costs with a modest margin.

This document describes product intent and engineering rules. It is not legal advice; obtain a license review before commercial launch.

## What belongs in this repository

Public core work includes:

- bug fixes and regression fixes;
- UX, accessibility, and performance improvements;
- security and reliability hardening;
- data connectors and warehouse correctness;
- self-hosted local and user-managed provider support;
- public documentation, tests, deployment recipes, and migration tooling.

Do not add SaaS-only implementation here:

- billing, subscriptions, invoices, or payment-provider integrations;
- platform-owned hosted-provider credentials;
- SaaS-only quotas, entitlements, or plan enforcement;
- tenant administration that exists only for the hosted service;
- private operational dashboards, support tooling, or internal runbooks;
- proprietary hosted automation that is not required for self-hosting.

The public core must continue to run without a connection to the private SaaS.

## What belongs in the private SaaS repository

The hosted control plane owns:

- managed deployment and tenant provisioning;
- platform-managed AI routing, consent records, quotas, and usage metering;
- billing and subscription lifecycle;
- managed backups, retention, and operational automation;
- hosted worker fleet coordination and platform monitoring;
- support workflows and SaaS-only administration.

The SaaS may consume public-core APIs and events, but private implementation details must not be copied into public-core modules.

## Engineering seam

The public core is the system of record for product data and core workflows. A future SaaS control plane is an external adapter at the documented seam in [`contracts/saas-api-v1.md`](./contracts/saas-api-v1.md).

Rules for the seam:

- service-to-service traffic uses HTTPS and short-lived credentials;
- requests are authenticated independently of end-user Google OAuth tokens;
- every mutating request has an idempotency key;
- provider, model, policy, and usage identifiers are explicit;
- SaaS outages do not make self-hosted core workflows fail;
- hosted-only metadata is optional and ignored by older core versions;
- the public core never requires a SaaS account to start, authenticate, read stored data, or run local processing.

## AI and cost policy

The hosted SaaS uses a platform-managed provider by default and requires explicit user consent before sending eligible data to that provider. Local LLM mode applies to all AI features and sends data only to the configured local endpoint.

AI execution follows this order:

1. deterministic/local processing;
2. cached result for the selected provider and model version;
3. hosted or local model enrichment only when needed;
4. an honest unavailable or unclassified state when enrichment cannot run.

The SaaS must meter usage by workspace, user, site, feature, provider, and model. Hosted budgets are hard limits, not soft warnings. Reaching a limit must produce an actionable message and must not silently switch providers.

## Release and contribution rules

- Public releases continue to receive core stabilization and polish.
- SaaS-only behavior is not promised as open-source feature parity.
- A pull request that adds SaaS-only logic to this repository must be rejected or moved to the private SaaS repository.
- Changes that alter the integration seam require a versioned contract update and compatibility notes.
- Any licensing or linking uncertainty is escalated for legal review before release.

## Launch checklist

Before the hosted SaaS accepts paying users:

- confirm AGPL-3.0 obligations with legal counsel;
- create and restrict the private SaaS repository;
- implement contract authentication, idempotency, and version negotiation;
- prove the public core works with the SaaS unavailable;
- publish hosted-AI consent and data-use disclosure;
- add usage budgets, alerts, and hard stops;
- document self-hosted setup and user-managed API keys;
- verify no secrets, private code, or SaaS-only deployment files are tracked here.
