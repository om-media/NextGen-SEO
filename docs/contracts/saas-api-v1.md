# Proposed SaaS control-plane contract v1

## Status

This file describes a proposed integration contract. The current repository does not implement `/api/saas/v1` routes, event delivery, service authentication, billing, entitlements, or usage metering. The core must continue to work with no SaaS connection.

## Transport and authentication

- Use HTTPS outside local development.
- Use a short-lived service credential issued for one core installation.
- Never send end-user Google OAuth access or refresh tokens to the control plane.
- Validate service audience, issuer, expiry, and request signature before accepting a mutating request.
- Require `Idempotency-Key` on every mutating request.
- Send `X-NG-Contract-Version: 1`.

## Proposed capability endpoint

`GET /api/saas/v1/capabilities`

The future core adapter may return a document like this:

```json
{
  "contractVersion": 1,
  "coreVersion": "0.1.0",
  "features": {
    "usageMetering": true,
    "hostedAiPolicy": true,
    "localAiMode": true
  },
  "acceptedEventTypes": ["usage.record", "provider.status", "entitlement.snapshot"]
}
```

Consumers must ignore unknown fields and must not assume an unsupported capability.

## Event envelope

Events sent from the core to the SaaS use this proposed shape:

```json
{
  "contractVersion": 1,
  "eventId": "evt_01J...",
  "eventType": "usage.record",
  "occurredAt": "2026-08-12T12:00:00.000Z",
  "installationId": "install_01J...",
  "workspaceId": "workspace_01J...",
  "payload": {}
}
```

Required invariants:

- `eventId` is unique within an installation.
- `occurredAt` uses UTC ISO-8601.
- Consumers deduplicate by `eventId` and acknowledge after durable handling.
- Payloads never contain OAuth tokens, API keys, passwords, or raw secrets.
- Delivery is at least once and may retry.

## Proposed event types

### `usage.record`

Carries feature, provider mode, provider, model, workspace/site, request count, and optional token/cost metadata. A local provider may omit token counts. Missing values mean unknown.

### `provider.status`

Reports `ready`, `not_configured`, `unavailable`, `quota_exceeded`, or `consent_required` without exposing credentials.

### `entitlement.snapshot`

Carries optional hosted entitlements. The core must ignore the event when no SaaS connection exists and fail closed for hosted-only operations when the snapshot is expired, missing, or invalid.

## Compatibility

Backward-compatible v1 additions use optional fields or new event types. Breaking changes require v2 and a migration period. SaaS clients must tolerate an unavailable core and retry with bounded backoff. The core must not block dashboard reads on SaaS acknowledgements.
