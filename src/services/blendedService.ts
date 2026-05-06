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

export type BlendedPageCrawlSummary = {
  canonicalUrl: string | null;
  crawledAt: string | null;
  errorMessage: string | null;
  finalUrl: string | null;
  h1Count: number;
  h1Text: string | null;
  inboundLinkCount: number;
  metaDescription: string | null;
  noindex: boolean;
  outgoingLinkCount: number;
  statusCode: number | null;
  title: string | null;
  url: string;
};

export type BlendedPagePerformanceRow = {
  crawl: BlendedPageCrawlSummary | null;
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
    topFolders: Array<{
      clicks: number;
      folder: string;
      pages: number;
      sessions: number;
    }>;
    topOpportunities: BlendedPagePerformanceRow[];
    topTechnicalRisks: BlendedPagePerformanceRow[];
    totals: {
      bounceRate: number;
      clicks: number;
      crawlIssuePages: number;
      crawlMatchedPages: number;
      ctr: number;
      eventCount: number;
      ga4Pages: number;
      gscPages: number;
      impressions: number;
      matchedPages: number;
      metadataGapPages: number;
      notCrawledPages: number;
      pageViews: number;
      position: number;
      queryCount: number;
      sessions: number;
      totalPages: number;
      totalUsers: number;
    };
  };
  page: {
    filteredTotal: number;
    limit: number;
    offset: number;
    total: number;
  };
  rows: BlendedPagePerformanceRow[];
};

type FetchBlendedPagePerformanceParams = {
  endDate: string;
  ga4PropertyId?: string | null;
  limit?: number;
  offset?: number;
  issueFilter?: string;
  search?: string;
  siteUrl: string;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
  startDate: string;
  trafficFilter?: string;
};

export async function fetchBlendedPagePerformance({
  endDate,
  ga4PropertyId,
  limit = 500,
  offset = 0,
  issueFilter,
  search,
  siteUrl,
  sortColumn,
  sortDirection,
  startDate,
  trafficFilter,
}: FetchBlendedPagePerformanceParams): Promise<BlendedPagePerformanceResponse> {
  const response = await authFetch("/api/blended/page-performance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endDate,
      ga4PropertyId: ga4PropertyId || undefined,
      issueFilter,
      limit,
      offset,
      search,
      siteUrl,
      sortColumn,
      sortDirection,
      startDate,
      trafficFilter,
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error || "Failed to fetch blended page data");
  }

  return data as BlendedPagePerformanceResponse;
}
