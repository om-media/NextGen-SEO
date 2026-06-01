import { authFetch } from "../lib/authFetch";
import type { GscSearchAnalyticsRow } from "./gscService";

const AI_PROVIDER_UNAVAILABLE_MESSAGE =
  "AI insights are temporarily unavailable while the LLM provider is being configured.";

export class AiProviderUnavailableError extends Error {
  constructor(message = AI_PROVIDER_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "AiProviderUnavailableError";
  }
}

export function isAiProviderUnavailableError(error: unknown): error is AiProviderUnavailableError {
  return error instanceof AiProviderUnavailableError;
}

export async function generateGscInsights(
  data: GscSearchAnalyticsRow[],
  dimension: string,
  searchTerm: string,
  intentFilter: string,
) {
  const topData = data.slice(0, 50);
  const response = await authFetch('/api/ai/gsc-insights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: topData,
      dimension,
      searchTerm,
      intentFilter,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 503) {
      throw new AiProviderUnavailableError(payload?.error);
    }
    throw new Error(payload?.error || 'Failed to generate AI insights');
  }

  return payload?.insights || '';
}

export async function generateContentAuditBrief(data: Record<string, unknown>[], siteUrl: string) {
  const response = await authFetch('/api/ai/content-audit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: data.slice(0, 40),
      siteUrl,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 503) {
      throw new AiProviderUnavailableError(payload?.error);
    }
    throw new Error(payload?.error || 'Failed to generate content audit brief');
  }

  return payload?.brief || '';
}
