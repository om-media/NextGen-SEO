# Open-source core and hosted SaaS boundary

## Status

This document records product and engineering policy. The hosted SaaS described here is separate from this repository. The public core contains no SaaS control-plane implementation.

This document is not legal advice. Confirm AGPL-3.0 obligations with counsel before commercial launch.

## Products

1. The open-source edition is this repository, released under AGPL-3.0.
2. The hosted SaaS is a separate private product built around the public core.

The public edition must remain useful and self-hostable without a hosted account. The SaaS must not disable public functionality to force an upgrade.

## Keep in this repository

- Bug fixes, UX and accessibility work, security and reliability hardening.
- Public connectors, warehouse correctness, migrations, tests, and deployment recipes.
- Self-hosted processing and user-managed provider configuration.

Do not add hosted billing, payment integrations, platform-owned credentials, SaaS-only quotas or entitlements, private operational dashboards, or tenant administration that exists only for the hosted service.

## Keep in the private SaaS

The hosted product owns managed deployment, tenant provisioning, platform-managed AI routing and consent, quotas, billing, backups, hosted worker coordination, monitoring, and support workflows.

## Integration seam

[`contracts/saas-api-v1.md`](contracts/saas-api-v1.md) defines a proposed versioned seam. It does not expose routes in this repository. Any future adapter must satisfy these rules:

- Use HTTPS outside local development and short-lived service credentials.
- Authenticate service requests independently of end-user Google OAuth tokens.
- Require an idempotency key on mutating requests.
- Keep provider, model, policy, and usage identifiers explicit.
- Keep core workflows working when the SaaS is unavailable.
- Treat hosted metadata as optional and ignore it when no connection exists.

Changes to the seam require a contract version update and compatibility notes.

## AI policy

The public core should prefer deterministic and local processing, then cached results, then configured provider enrichment. A provider failure must produce an explicit unavailable or unclassified state. It must not silently switch providers or imply that missing token data proves zero cost.

## Release rule

Before release, check that public behavior works without the SaaS, no SaaS secrets or private files are tracked, and any licensing or linking uncertainty has received legal review.
