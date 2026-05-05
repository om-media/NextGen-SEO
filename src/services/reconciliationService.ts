import { authFetch } from "@/src/lib/authFetch";

export type ReconciliationStatus =
  | "all"
  | "issues"
  | "matched"
  | "missing-crawl"
  | "missing-gsc"
  | "missing-ga4"
  | "crawl-errors"
  | "noindex"
  | "canonical";

export type PageReconciliationRow = {
  crawl: null | {
    canonicalUrl: string | null;
    crawledAt: string | null;
    depth: number;
    errorMessage: string | null;
    noindex: boolean;
    statusCode: number | null;
    title: string | null;
    url: string;
    wordCount: number;
  };
  flags: string[];
  ga4: null | {
    bounceRate: number;
    eventCount: number;
    pagePath: string;
    pageViews: number;
    sessions: number;
    totalUsers: number;
  };
  gsc: null | {
    clicks: number;
    ctr: number;
    impressions: number;
    page: string;
    position: number;
    queryCount: number;
  };
  pageKey: string;
  representativeUrl: string;
  sources: {
    crawl: "present" | "missing";
    ga4: "present" | "missing";
    gsc: "present" | "missing";
  };
};

export type PageReconciliationResponse = {
  meta: {
    crawlJobId: string | null;
    totals: {
      crawlErrors: number;
      issues: number;
      missingCrawl: number;
      missingGa4: number;
      missingGsc: number;
      total: number;
    };
  };
  page: {
    limit: number;
    offset: number;
    total: number;
  };
  rows: PageReconciliationRow[];
};

export async function fetchPageReconciliation(params: {
  crawlJobId?: string | null;
  endDate: string;
  limit?: number;
  offset?: number;
  propertyId?: string | null;
  search?: string;
  siteUrl: string;
  startDate: string;
  status?: ReconciliationStatus;
}) {
  const searchParams = new URLSearchParams({
    endDate: params.endDate,
    limit: String(params.limit ?? 100),
    offset: String(params.offset ?? 0),
    siteUrl: params.siteUrl,
    startDate: params.startDate,
    status: params.status ?? "issues",
  });

  if (params.propertyId) searchParams.set("propertyId", params.propertyId);
  if (params.crawlJobId) searchParams.set("crawlJobId", params.crawlJobId);
  if (params.search?.trim()) searchParams.set("search", params.search.trim());

  const response = await authFetch(`/api/reconciliation/pages?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to load reconciliation data");
  }

  return data as PageReconciliationResponse;
}
