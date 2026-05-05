import { authFetch } from "@/src/lib/authFetch";

export type WorkspaceSiteStatus = {
  crawl: null | {
    completedAt: string | null;
    crawledCount: number;
    discoveredCount: number;
    errorCount: number;
    id: string;
    lastError: string | null;
    renderMode: string;
    startedAt: string | null;
    status: string;
    summary: {
      errorPages: number;
      noindexPages: number;
      successPages: number;
      totalPages: number;
    };
    updatedAt: string | null;
  };
  isDefault: boolean;
  isUnlocked: boolean;
  siteUrl: string;
  warehouse: {
    earliestMetricDate: string | null;
    lastMetricDate: string | null;
    metricDayCount: number;
    rowCount: number;
    status: string;
    updatedAt: string | null;
  };
};

export type WorkspaceSitesResponse = {
  ga4PropertyId: string | null;
  sites: WorkspaceSiteStatus[];
};

export async function fetchWorkspaceSiteStatuses() {
  const response = await authFetch("/api/workspace/sites/status");
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to load workspace sites");
  }

  return data as WorkspaceSitesResponse;
}
