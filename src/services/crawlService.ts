import { authFetch } from "@/src/lib/authFetch";

export type CrawlJob = {
  attemptCount: number | null;
  completedAt: string | null;
  crawledCount: number;
  discoveredCount: number;
  errorCount: number;
  id: string;
  includeQueryStrings: number | null;
  lastError: string | null;
  lockedAt: string | null;
  maxDepth: number | null;
  maxAttempts: number | null;
  maxPages: number | null;
  nextRunAt: string | null;
  queuedCount: number;
  renderMode: string | null;
  respectRobots: number | null;
  sitemapUrl: string | null;
  skippedCount: number;
  siteUrl: string;
  startedAt: string | null;
  startUrl: string | null;
  status: string;
  updatedAt: string | null;
  userAgent: string | null;
};

export type CrawlSummary = {
  canonicalizedPages: number;
  errorPages: number;
  missingMetaPages: number;
  missingTitlePages: number;
  noindexPages: number;
  orphanPages: number;
  redirectPages: number;
  successPages: number;
  totalPages: number;
};

export type CrawlPageRow = {
  canonicalUrl: string | null;
  contentType: string | null;
  crawledAt: string | null;
  depth: number;
  discoveredAt: string | null;
  discoveredFrom: string | null;
  discoveredFromUrl: string | null;
  errorMessage: string | null;
  finalUrl: string | null;
  h1Count: number;
  h1Text: string | null;
  h2Count: number;
  inboundLinkCount?: number;
  internalLinkCount: number;
  jobId: string;
  metaDescription: string | null;
  noindex: number;
  normalizedUrl: string;
  outgoingLinkCount: number;
  pageKey: string;
  responseTimeMs: number | null;
  siteUrl: string;
  statusCode: number | null;
  title: string | null;
  url: string;
  wordCount: number;
};

export type CrawlLinkRow = {
  depth: number;
  discoveredAt: string | null;
  fromPageKey: string;
  fromUrl: string;
  jobId: string;
  ownerId: string;
  siteUrl: string;
  toPageKey: string;
  toUrl: string;
};

export type CrawlPagesResponse = {
  job: CrawlJob | null;
  page: {
    limit: number;
    offset: number;
    total: number;
  };
  rows: CrawlPageRow[];
  summary: CrawlSummary | null;
};

export type CrawlLinksResponse = {
  job: CrawlJob | null;
  page: {
    limit: number;
    offset: number;
    total: number;
  };
  rows: CrawlLinkRow[];
};

export type CrawlStatusResponse = {
  job: CrawlJob | null;
  summary: CrawlSummary | null;
};

export type CrawlJobsResponse = {
  jobs: CrawlJob[];
};

export type CrawlCompareResponse = {
  baseJob: CrawlJob | null;
  compareJob: CrawlJob | null;
  samples: {
    canonicalChanged: Array<{ currentCanonical: string | null; previousCanonical: string | null; url: string }>;
    missing: Array<{ url: string }>;
    new: Array<{ url: string }>;
    statusChanged: Array<{ currentStatus: number | null; previousStatus: number | null; url: string }>;
    titleChanged: Array<{ currentTitle: string | null; previousTitle: string | null; url: string }>;
  };
  summary: {
    canonicalChanged: number;
    missing: number;
    new: number;
    statusChanged: number;
    titleChanged: number;
    unchanged: number;
  };
};

export type StartCrawlParams = {
  includeQueryStrings?: boolean;
  maxDepth?: number;
  maxPages?: number;
  renderMode?: "html" | "javascript";
  respectRobots?: boolean;
  sitemapUrl?: string | null;
  siteUrl: string;
  startUrl?: string | null;
  userAgent?: string | null;
};

export type CrawlIssueFilter =
  | "all"
  | "success"
  | "redirect"
  | "error"
  | "no_response"
  | "noindex"
  | "orphan"
  | "missing_title"
  | "missing_meta"
  | "canonicalized";

export async function startCrawl(params: StartCrawlParams) {
  const response = await authFetch("/api/crawl/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to start crawl");
  }

  return data as { job: CrawlJob; startUrl: string; success: true };
}

export async function fetchCrawlStatus(siteUrl: string, jobId?: string | null) {
  const searchParams = new URLSearchParams({ siteUrl });
  if (jobId) {
    searchParams.set("jobId", jobId);
  }
  const response = await authFetch(`/api/crawl/status?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to fetch crawl status");
  }
  return {
    job: data?.job ?? null,
    summary: data?.summary ?? null,
  } satisfies CrawlStatusResponse;
}

export async function fetchCrawlJobs(siteUrl: string, limit = 20) {
  const searchParams = new URLSearchParams({
    limit: String(limit),
    siteUrl,
  });
  const response = await authFetch(`/api/crawl/jobs?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to fetch crawl jobs");
  }
  return {
    jobs: Array.isArray(data?.jobs) ? data.jobs : [],
  } satisfies CrawlJobsResponse;
}

export async function fetchCrawlPages(params: {
  issue?: CrawlIssueFilter;
  limit?: number;
  offset?: number;
  search?: string;
  jobId?: string | null;
  siteUrl: string;
}) {
  const searchParams = new URLSearchParams({
    siteUrl: params.siteUrl,
    limit: String(params.limit ?? 50),
    offset: String(params.offset ?? 0),
  });

  if (params.jobId) {
    searchParams.set("jobId", params.jobId);
  }

  if (params.search?.trim()) {
    searchParams.set("search", params.search.trim());
  }

  if (params.issue && params.issue !== "all") {
    searchParams.set("issue", params.issue);
  }

  const response = await authFetch(`/api/crawl/pages?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to fetch crawl pages");
  }
  return {
    job: data?.job ?? null,
    page: data?.page ?? { limit: params.limit ?? 50, offset: params.offset ?? 0, total: 0 },
    rows: Array.isArray(data?.rows) ? data.rows : [],
    summary: data?.summary ?? null,
  } satisfies CrawlPagesResponse;
}

export async function fetchCrawlLinks(params: {
  limit?: number;
  offset?: number;
  search?: string;
  jobId?: string | null;
  siteUrl: string;
}) {
  const searchParams = new URLSearchParams({
    siteUrl: params.siteUrl,
    limit: String(params.limit ?? 100),
    offset: String(params.offset ?? 0),
  });

  if (params.jobId) searchParams.set("jobId", params.jobId);
  if (params.search?.trim()) searchParams.set("search", params.search.trim());

  const response = await authFetch(`/api/crawl/links?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to fetch crawl links");
  }

  return {
    job: data?.job ?? null,
    page: data?.page ?? { limit: params.limit ?? 100, offset: params.offset ?? 0, total: 0 },
    rows: Array.isArray(data?.rows) ? data.rows : [],
  } satisfies CrawlLinksResponse;
}

export async function fetchCrawlCompare(params: {
  baseJobId?: string | null;
  compareJobId?: string | null;
  siteUrl: string;
}) {
  const searchParams = new URLSearchParams({ siteUrl: params.siteUrl });
  if (params.baseJobId) searchParams.set("baseJobId", params.baseJobId);
  if (params.compareJobId) searchParams.set("compareJobId", params.compareJobId);

  const response = await authFetch(`/api/crawl/compare?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to compare crawl runs");
  }

  return data as CrawlCompareResponse;
}

export async function cancelCrawl(params: { jobId: string; siteUrl: string }) {
  const response = await authFetch("/api/crawl/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to cancel crawl");
  }

  return data as { job: CrawlJob; success: true };
}
