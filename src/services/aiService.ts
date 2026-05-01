import { authFetch } from "../lib/authFetch";
import type { GscSearchAnalyticsRow } from "./gscService";

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
    throw new Error(payload?.error || 'Failed to generate AI insights');
  }

  return payload?.insights || '';
}
