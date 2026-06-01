import { authFetch } from "@/src/lib/authFetch";

export type CoverageDataset = {
  coveredDateCount: number;
  coverageRatio: number;
  expectedDateCount: number;
  firstCoveredDate: string | null;
  lastCoveredDate: string | null;
  missingDateCount: number;
  missingDates: string[];
  totalRows: number;
};

export type DataCoverageResponse = {
  bing: {
    enabled: boolean;
    isFresh: boolean;
    latestFetchedAt: string | null;
    rowCount: number;
  };
  crawl: null | {
    completedAt: string | null;
    id: string;
    startedAt: string | null;
    status: string;
    summary: {
      errorPages: number;
      noindexPages: number;
      redirectPages: number;
      successPages: number;
      totalPages: number;
    };
    updatedAt: string | null;
  };
  dateRange: {
    endDate: string;
    latestAvailableDate?: string;
    requestedEndDate?: string;
    startDate: string;
    totalDays: number;
    unavailableDateCount?: number;
    unavailableDates?: string[];
  };
  ga4: {
    enabled: boolean;
    pages: CoverageDataset;
    propertyId: string | null;
  };
  gsc: {
    pageQuery: CoverageDataset;
    query: CoverageDataset;
    site: CoverageDataset;
  };
  siteUrl: string;
  warehouseJobs: {
    completed: number;
    error: number;
    queued: number;
    retrying: number;
    running: number;
    total: number;
  };
};

export async function fetchDataCoverage(params: {
  endDate: string;
  propertyId?: string | null;
  siteUrl: string;
  startDate: string;
}) {
  const searchParams = new URLSearchParams({
    endDate: params.endDate,
    siteUrl: params.siteUrl,
    startDate: params.startDate,
  });

  if (params.propertyId) {
    searchParams.set("propertyId", params.propertyId);
  }

  const response = await authFetch(`/api/warehouse/coverage?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to load data coverage");
  }

  return data as DataCoverageResponse;
}

export async function queueMissingCoverageSync(params: {
  endDate: string;
  maxDates?: number;
  propertyId?: string | null;
  siteUrl: string;
  startDate: string;
}) {
  const response = await authFetch("/api/warehouse/jobs/missing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to queue missing sync jobs");
  }

  return data as {
    jobs: Array<{ id: string; status: string; targetDate: string }>;
    latestAvailableDate?: string;
    queued: number;
    remainingMissingDates: number;
    skippedUnavailableDates?: number;
  };
}

export async function retryFailedCoverageSync(params: {
  endDate: string;
  maxJobs?: number;
  siteUrl: string;
  startDate: string;
}) {
  const response = await authFetch("/api/warehouse/jobs/retry-failed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to retry failed sync jobs");
  }

  return data as {
    remainingFailedJobs: number;
    retried: number;
  };
}
