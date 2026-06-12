import { authFetch } from "@/src/lib/authFetch";

export type RawPage = {
  limit: number;
  offset: number;
  total: number;
};

export type RawGscKind = "site" | "query" | "page" | "page_query";
export type RawGa4Kind = "page" | "page_date" | "event" | "traffic" | "country" | "city" | "device" | "browser" | "operatingSystem" | "region";

export type RawGscRow = {
  clicks: number;
  ctr: number;
  date?: string;
  impressions: number;
  pageKey?: string | null;
  page?: string | null;
  position: number;
  queryCount?: number;
  query?: string | null;
};

export type RawGa4PageRow = {
  bounceRate: number;
  date?: string;
  eventCount: number;
  pageKey: string;
  pagePath: string;
  pageViews: number;
  sessions: number;
  siteUrl: string;
  totalUsers: number;
};

export type RawGa4ReportRow = {
  bounceRate: number;
  dimension: string;
  dimensionValue: string;
  eventCount: number;
  pageViews: number;
  sessions: number;
  totalUsers: number;
};

type RawResponse<T> = {
  page: RawPage;
  rows: T[];
};

function appendCommonParams(params: URLSearchParams, values: {
  endDate: string;
  limit?: number;
  offset?: number;
  search?: string;
  startDate: string;
}) {
  params.set("startDate", values.startDate);
  params.set("endDate", values.endDate);
  params.set("limit", String(values.limit ?? 100));
  params.set("offset", String(values.offset ?? 0));
  if (values.search?.trim()) {
    params.set("search", values.search.trim());
  }
}

export async function fetchRawGscRows(params: {
  endDate: string;
  kind: RawGscKind;
  limit?: number;
  offset?: number;
  search?: string;
  siteUrl: string;
  startDate: string;
}) {
  const searchParams = new URLSearchParams({
    kind: params.kind,
    siteUrl: params.siteUrl,
  });
  appendCommonParams(searchParams, params);

  const response = await authFetch(`/api/warehouse/raw/gsc?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to load raw GSC rows");
  }

  return data as RawResponse<RawGscRow>;
}

export async function fetchRawGa4PageRows(params: {
  endDate: string;
  kind?: RawGa4Kind;
  limit?: number;
  offset?: number;
  propertyId: string;
  search?: string;
  siteUrl: string;
  startDate: string;
}) {
  const searchParams = new URLSearchParams({
    kind: params.kind ?? "page",
    propertyId: params.propertyId,
    siteUrl: params.siteUrl,
  });
  appendCommonParams(searchParams, params);

  const response = await authFetch(`/api/warehouse/raw/ga4-pages?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to load raw GA4 rows");
  }

  return data as RawResponse<RawGa4PageRow>;
}

export async function fetchRawGa4ReportRows(params: {
  endDate: string;
  kind: Exclude<RawGa4Kind, "page" | "page_date">;
  limit?: number;
  offset?: number;
  propertyId: string;
  search?: string;
  siteUrl: string;
  startDate: string;
}) {
  const searchParams = new URLSearchParams({
    kind: params.kind,
    propertyId: params.propertyId,
    siteUrl: params.siteUrl,
  });
  appendCommonParams(searchParams, params);

  const response = await authFetch(`/api/warehouse/raw/ga4-report?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to load raw GA4 report rows");
  }

  return data as RawResponse<RawGa4ReportRow>;
}
