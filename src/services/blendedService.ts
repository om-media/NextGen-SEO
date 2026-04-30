import { authFetch } from "../lib/authFetch";

export type BlendedPageGscMetrics = {
  clicks: number;
  ctr: number;
  impressions: number;
  position: number;
  queryCount: number;
};

export type BlendedPageGa4Metrics = {
  bounceRate: number;
  eventCount: number;
  pageViews: number;
  sessions: number;
  totalUsers: number;
};

export type BlendedPagePerformanceRow = {
  ga4: BlendedPageGa4Metrics | null;
  gsc: BlendedPageGscMetrics | null;
  page: string;
  pageKey: string;
};

export type BlendedPagePerformanceResponse = {
  meta: {
    endDate: string;
    freshness: {
      bing: null;
      ga4: {
        earliestDate: string | null;
        latestDate: string | null;
        rowCount: number;
      };
      gsc: {
        earliestDate: string | null;
        historicalLimit: string | null;
        lastUpdated: string | null;
        latestDate: string | null;
        rowCount: number;
        syncStatus: string | null;
        syncedThrough: string | null;
      };
    };
    ga4PropertyId: string | null;
    siteUrl: string;
    sources: {
      bing: boolean;
      ga4: boolean;
      gsc: boolean;
    };
    startDate: string;
  };
  rows: BlendedPagePerformanceRow[];
};

type FetchBlendedPagePerformanceParams = {
  endDate: string;
  ga4PropertyId?: string | null;
  limit?: number;
  siteUrl: string;
  startDate: string;
};

export async function fetchBlendedPagePerformance({
  endDate,
  ga4PropertyId,
  limit = 500,
  siteUrl,
  startDate,
}: FetchBlendedPagePerformanceParams): Promise<BlendedPagePerformanceResponse> {
  const response = await authFetch("/api/blended/page-performance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endDate,
      ga4PropertyId: ga4PropertyId || undefined,
      limit,
      siteUrl,
      startDate,
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error || "Failed to fetch blended page data");
  }

  return data as BlendedPagePerformanceResponse;
}
