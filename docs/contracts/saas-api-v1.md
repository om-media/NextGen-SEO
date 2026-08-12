# SaaS control-plane contract v1

This is the public integration seam between the AGPL core and a future private hosted control plane. It is a contract, not a SaaS implementation. The core remains fully functional when no control plane is configured.

## Transport and authentication

- HTTPS is required outside local development.
- Service requests use a short-lived service credential issued for the specific core installation.
- End-user Google OAuth access and refresh tokens must never be sent to the control plane.
- The core must validate the service audience, issuer, expiry, and request signature before accepting a mutating request.
- Every mutating request includes `Idempotency-Key`.
- Requests include `X-NG-Contract-Version: 1`.

## Capability negotiation

`GET /api/saas/v1/capabilities`

Response:

```json
{
  "contractVersion": 1,
  "coreVersion": "0.1.0",
  "features": {
    "usageMetering": true,
    "hostedAiPolicy": true,
    "localAiMode": true
  },
  "acceptedEventTypes": [
    "usage.record",
    "provider.status",
    "entitlement.snapshot"
  ]
}
```

Unknown response fields must be ignored. The SaaS must not assume a feature is available unless it is advertised by the core.

## Event envelope

Events sent from the core to the SaaS use this shape:

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

- `eventId` is globally unique for the installation;
- `occurredAt` is UTC ISO-8601;
- consumers deduplicate by `eventId`;
- payloads contain usage metadata, never OAuth tokens, API keys, passwords, or raw secrets;
- event delivery is at-least-once and may be retried;
- consumers acknowledge only after durable handling.

## v1 event types

### `usage.record`

Records billable or budget-relevant work:

```json
{
  "feature": "intent-classification",
  "providerMode": "hosted",
  "provider": "openai",
  "model": "gpt-5.6-luna",
  "workspaceId": "workspace_01J...",
  "siteId": "site_01J...",
  "requestCount": 1,
  "inputTokens": 120,
  "outputTokens": 30,
  "estimatedCostUsd": 0.0003
}
```

The core may omit token counts when a local provider does not expose them. The SaaS must treat missing values as unknown, not zero-cost proof.

### `provider.status`

Reports readiness without exposing credentials:

```json
{
  "providerMode": "local",
  "provider": "ollama",
  "model": "qwen3:4b-instruct",
  "status": "ready",
  "checkedAt": "2026-08-12T12:00:00.000Z"
}
```

Allowed statuses are `ready`, `not_configured`, `unavailable`, `quota_exceeded`, and `consent_required`.

### `entitlement.snapshot`

Carries optional hosted entitlements from the SaaS to a core installation. The core must ignore this event when no SaaS connection exists.

```json
{
  "workspaceId": "workspace_01J...",
  "plan": "hosted-basic",
  "hostedAiEnabled": true,
  "monthlyAiCredits": 1000,
  "effectiveAt": "2026-08-01T00:00:00.000Z",
  "expiresAt": "2026-09-01T00:00:00.000Z"
}
```

An expired, missing, or invalid snapshot must fail closed for hosted-only operations while preserving local and self-hosted core functionality.

## Compatibility policy

- v1 additions are backward-compatible fields or new event types.
- Breaking changes require v2 and an explicit migration period.
- The SaaS must tolerate an unavailable core and retry with bounded backoff.
- The core must not block dashboard reads on SaaS acknowledgements.
