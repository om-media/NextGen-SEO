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

export type WarehouseSourceJobState = {
  error: number;
  lastError: string | null;
  queued?: number;
  retrying?: number;
  running?: number;
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
    earliestAvailableDate?: string;
    latestAvailableDate?: string;
    requestedEndDate?: string;
    requestedStartDate?: string;
    startDate: string;
    totalDays: number;
    unavailableDateCount?: number;
    unavailableDates?: string[];
  };
  ga4: {
    dimensions: CoverageDataset;
    enabled: boolean;
    llm?: CoverageDataset;
    pages: CoverageDataset;
    propertyId: string | null;
  };
  gsc: {
    country: CoverageDataset;
    pageQuery: CoverageDataset;
    query: CoverageDataset;
    site: CoverageDataset;
  };
  siteUrl: string;
  sourceJobs?: {
    core: WarehouseSourceJobState;
    ga4Pages: WarehouseSourceJobState;
    gsc: WarehouseSourceJobState;
  };
  warehouseJobs: {
    activeDateCount: number;
    completed: number;
    error: number;
    queued: number;
    retrying: number;
    running: number;
    superseded?: number;
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
    throw new Error(data?.error || "Failed to start missing-days import");
  }

  return data as {
    jobs: Array<{ id: string; status: string; targetDate: string; targetStartDate?: string | null }>;
    latestAvailableDate?: string;
    queued: number;
    queuedCoreDates?: number;
    queuedGa4DimensionDates?: number;
    queuedLlmDates?: number;
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
    throw new Error(data?.error || "Failed to retry failed imports");
  }

  return data as {
    remainingFailedJobs: number;
    retried: number;
  };
}

export type WarehouseJobSummary = {
  attemptCount?: number | null;
  completedAt?: string | null;
  id: string;
  jobType: string;
  lastError?: string | null;
  metrics?: {
    apiMs?: number;
    completedAt?: string;
    days?: number;
    jobType?: string;
    phases?: Record<string, { apiMs?: number; rows?: number; writeMs?: number }>;
    propertyIncluded?: boolean;
    rows?: Record<string, number>;
    rowsSynced?: number;
    totalMs?: number;
    writeMs?: number;
  } | null;
  propertyId?: string | null;
  rowsSynced?: number | null;
  startedAt?: string | null;
  status: "queued" | "running" | "retrying" | "completed" | "error" | "superseded" | string;
  targetDate: string;
  targetStartDate?: string | null;
  updatedAt?: string | null;
};

export async function fetchWarehouseJobs(params: {
  limit?: number;
  siteUrl: string;
}) {
  const searchParams = new URLSearchParams({
    limit: String(params.limit || 10),
    siteUrl: params.siteUrl,
  });

  const response = await authFetch(`/api/warehouse/jobs?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to load import jobs");
  }

  return (Array.isArray(data?.jobs) ? data.jobs : []) as WarehouseJobSummary[];
}
