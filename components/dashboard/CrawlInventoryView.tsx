import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import { AlertCircle, CheckCircle2, Download, Globe2, History, Loader2, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { getPlanCrawlLimits } from "@/shared/plans";
import { useAuth } from "@/src/contexts/AuthContext";
import {
  cancelCrawl,
  fetchCrawlJobs,
  fetchCrawlPages,
  fetchCrawlCompare,
  fetchCrawlStatus,
  fetchCrawlLinks,
  startCrawl,
  type CrawlCompareResponse,
  type CrawlIssueFilter,
  type CrawlJob,
  type CrawlLinkRow,
  type CrawlPageRow,
  type CrawlSummary,
} from "@/src/services/crawlService";

type CrawlInventoryViewProps = {
  defaultStartUrl?: string | null;
  siteUrl: string;
};

const formatNumber = (value: number) => new Intl.NumberFormat("en-US").format(Math.round(value));

const formatStatusLabel = (statusCode: number | null) => {
  if (!statusCode) return "No response";
  if (statusCode >= 200 && statusCode < 300) return "200 OK";
  if (statusCode >= 300 && statusCode < 400) return "Redirect";
  if (statusCode >= 400) return "Error";
  return String(statusCode);
};

function SummaryCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  tone: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-foreground">{value}</p>
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-full ${tone}`}>{icon}</div>
      </div>
    </div>
  );
}

function StatusPill({ job }: { job: CrawlJob | null }) {
  if (!job) {
    return <span className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">No crawl yet</span>;
  }

  const status = job.status.toLowerCase();
  const classes =
    status === "running" || status === "queued" || status === "retrying"
      ? "border-blue-200 bg-blue-50 text-blue-700"
      : status === "completed"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-red-200 bg-red-50 text-red-700";

  return <span className={`rounded-full border px-3 py-1 text-xs font-medium ${classes}`}>{job.status}</span>;
}

function formatRelativeTime(value: string | null) {
  if (!value) return "never";
  try {
    return `${formatDistanceToNow(new Date(value), { addSuffix: true })}`;
  } catch {
    return value;
  }
}

function resolveStartUrl(value: string | null | undefined, siteUrl: string) {
  const candidates = [value, siteUrl].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    const stripped = trimmed.replace(/^sc-domain:/i, "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (stripped) {
      return `https://${stripped}/`;
    }
  }

  return "";
}

function formatJobLabel(job: CrawlJob) {
  const status = job.status.charAt(0).toUpperCase() + job.status.slice(1);
  const counts = `${formatNumber(job.crawledCount)}/${formatNumber(job.discoveredCount)}`;
  return `${status} - ${formatRelativeTime(job.startedAt || job.updatedAt || null)} - ${counts}`;
}

function exportCsv(rows: CrawlPageRow[]) {
  const headers = [
    "URL",
    "Final URL",
    "Page Key",
    "Status",
    "Content Type",
    "Response Time MS",
    "Title",
    "Meta Description",
    "H1 Count",
    "H1 Text",
    "H2 Count",
    "Canonical",
    "Depth",
    "Discovered From",
    "Discovered From URL",
    "Inlinks",
    "Outlinks",
    "Words",
    "Noindex",
    "Error Message",
    "Discovered At",
    "Crawled At",
  ];

  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const body = rows.map((row) => [
    row.url,
    row.finalUrl || "",
    row.pageKey || "",
    row.statusCode || "",
    row.contentType || "",
    row.responseTimeMs ?? "",
    row.title || "",
    row.metaDescription || "",
    row.h1Count ?? "",
    row.h1Text || "",
    row.h2Count ?? "",
    row.canonicalUrl || "",
    row.depth,
    row.discoveredFrom || "",
    row.discoveredFromUrl || "",
    row.inboundLinkCount ?? row.internalLinkCount ?? 0,
    row.outgoingLinkCount,
    row.wordCount,
    row.noindex ? "yes" : "no",
    row.errorMessage || "",
    row.discoveredAt || "",
    row.crawledAt || "",
  ]);

  const csv = [headers, ...body].map((line) => line.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `crawl-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

function exportLinksCsv(rows: CrawlLinkRow[]) {
  const headers = [
    "From URL",
    "From Page Key",
    "To URL",
    "To Page Key",
    "Depth",
    "Discovered At",
  ];

  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const body = rows.map((row) => [
    row.fromUrl,
    row.fromPageKey,
    row.toUrl,
    row.toPageKey,
    row.depth,
    row.discoveredAt || "",
  ]);

  const csv = [headers, ...body].map((line) => line.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `crawl-links-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

const exportBatchSize = 5000;

export function CrawlInventoryView({ defaultStartUrl, siteUrl }: CrawlInventoryViewProps) {
  const { userProfile } = useAuth();
  const crawlLimits = getPlanCrawlLimits(userProfile?.tier);
  const [job, setJob] = useState<CrawlJob | null>(null);
  const [jobs, setJobs] = useState<CrawlJob[]>([]);
  const [summary, setSummary] = useState<CrawlSummary | null>(null);
  const [rows, setRows] = useState<CrawlPageRow[]>([]);
  const [compare, setCompare] = useState<CrawlCompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingLinks, setExportingLinks] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [hasLoadedJobs, setHasLoadedJobs] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [issueFilter, setIssueFilter] = useState<CrawlIssueFilter>("all");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageTotal, setPageTotal] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [maxDepth, setMaxDepth] = useState(crawlLimits.maxDepth);
  const [maxPages, setMaxPages] = useState(crawlLimits.maxPages);
  const [renderMode, setRenderMode] = useState<"html" | "javascript">("html");
  const [respectRobots, setRespectRobots] = useState(true);
  const [includeQueryStrings, setIncludeQueryStrings] = useState(false);
  const [userAgent, setUserAgent] = useState("NextGenSEO-Crawler/1.0");
  const hasAutoStartedRef = useRef(false);
  const resolvedStartUrl = useMemo(() => resolveStartUrl(defaultStartUrl, siteUrl), [defaultStartUrl, siteUrl]);
  const activeJobId = selectedJobId || job?.id || null;

  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(pageTotal / pageSize));
  const progress = useMemo(() => {
    if (!job?.discoveredCount) return 0;
    return Math.min(100, Math.round((job.crawledCount / job.discoveredCount) * 100));
  }, [job?.crawledCount, job?.discoveredCount]);
  const canCancelActiveJob = Boolean(job?.id && ["queued", "retrying", "running"].includes(job.status));

  useEffect(() => {
    setMaxDepth((current) => Math.min(current, crawlLimits.maxDepth));
    setMaxPages((current) => Math.min(current, crawlLimits.maxPages));
    if (!crawlLimits.allowJavaScriptRendering) {
      setRenderMode("html");
    }
  }, [crawlLimits.allowJavaScriptRendering, crawlLimits.maxDepth, crawlLimits.maxPages]);

  useEffect(() => {
    setPageIndex(0);
  }, [siteUrl, searchTerm, issueFilter]);

  useEffect(() => {
    setSelectedJobId("");
    setJobs([]);
    setJob(null);
    setSummary(null);
    setRows([]);
    setPageTotal(0);
    setHasLoadedJobs(false);
    hasAutoStartedRef.current = false;
  }, [siteUrl]);

  const loadJobs = async () => {
    if (!siteUrl) return [];
    setJobsLoading(true);
    try {
      const result = await fetchCrawlJobs(siteUrl);
      const nextJobs = result.jobs.length > 0 ? result.jobs : job ? [job] : [];
      setJobs(nextJobs);
      if (!selectedJobId && nextJobs[0]) {
        setSelectedJobId(nextJobs[0].id);
      } else if (selectedJobId && !nextJobs.some((entry) => entry.id === selectedJobId)) {
        setSelectedJobId("");
      }
      return nextJobs;
    } finally {
      setHasLoadedJobs(true);
      setJobsLoading(false);
    }
  };

  const loadStatus = async (jobId?: string | null) => {
    if (!siteUrl) return;
    const result = await fetchCrawlStatus(siteUrl, jobId ?? activeJobId);
    setJob(result.job);
    setSummary(result.summary);
  };

  const loadPages = async (jobId?: string | null, pageIndexOverride?: number) => {
    if (!siteUrl) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCrawlPages({
        limit: pageSize,
        offset: (pageIndexOverride ?? pageIndex) * pageSize,
        issue: issueFilter,
        jobId: jobId ?? activeJobId,
        search: searchTerm,
        siteUrl,
      });
      setJob(result.job);
      setSummary(result.summary);
      setRows(result.rows);
      setPageTotal(result.page.total);
    } catch (err: any) {
      setError(err.message || "Failed to load crawl inventory");
    } finally {
      setLoading(false);
    }
  };

  const loadCompare = async (jobId?: string | null) => {
    if (!siteUrl) return;
    const result = await fetchCrawlCompare({
      baseJobId: jobId ?? activeJobId,
      siteUrl,
    });
    setCompare(result);
  };

  const exportAllRows = async () => {
    if (!siteUrl) return;
    setExporting(true);
    setError(null);

    try {
      const allRows: CrawlPageRow[] = [];
      let nextOffset = 0;
      let total = 0;

      do {
        const result = await fetchCrawlPages({
          limit: exportBatchSize,
          offset: nextOffset,
          issue: issueFilter,
          jobId: activeJobId,
          search: searchTerm,
          siteUrl,
        });
        allRows.push(...result.rows);
        total = result.page.total;
        nextOffset += result.page.limit;
      } while (nextOffset < total);

      exportCsv(allRows);
    } catch (err: any) {
      setError(err.message || "Failed to export crawl inventory");
      toast.error("Export failed", { description: err.message || "Unable to export crawl inventory." });
    } finally {
      setExporting(false);
    }
  };

  const exportAllLinks = async () => {
    if (!siteUrl) return;
    setExportingLinks(true);
    setError(null);

    try {
      const allRows: CrawlLinkRow[] = [];
      let nextOffset = 0;
      let total = 0;

      do {
        const result = await fetchCrawlLinks({
          limit: exportBatchSize,
          offset: nextOffset,
          jobId: activeJobId,
          search: searchTerm,
          siteUrl,
        });
        allRows.push(...result.rows);
        total = result.page.total;
        nextOffset += result.page.limit;
      } while (nextOffset < total);

      exportLinksCsv(allRows);
    } catch (err: any) {
      setError(err.message || "Failed to export crawl links");
      toast.error("Link export failed", { description: err.message || "Unable to export crawl link graph." });
    } finally {
      setExportingLinks(false);
    }
  };

  useEffect(() => {
    loadJobs().catch((err) => setError(err.message || "Failed to load crawl runs"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteUrl]);

  useEffect(() => {
    loadPages().catch((err) => setError(err.message || "Failed to load crawl inventory"));
    loadCompare().catch(() => setCompare(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteUrl, pageIndex, searchTerm, selectedJobId, issueFilter]);

  useEffect(() => {
    if (!job || !["queued", "retrying", "running"].includes(job.status)) return;
    const timer = window.setInterval(() => {
      loadStatus().catch(() => {});
      loadPages().catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, siteUrl, pageIndex, searchTerm, selectedJobId, issueFilter]);

  const handleStart = async (options: { silent?: boolean } = {}) => {
    if (!siteUrl) return;
    setStarting(true);
    setError(null);
    try {
      const result = await startCrawl({
        includeQueryStrings,
        maxDepth: Math.min(maxDepth, crawlLimits.maxDepth),
        maxPages: Math.min(maxPages, crawlLimits.maxPages),
        renderMode: crawlLimits.allowJavaScriptRendering ? renderMode : "html",
        respectRobots,
        sitemapUrl: null,
        siteUrl,
        startUrl: resolvedStartUrl || null,
        userAgent: userAgent.trim() || null,
      });
      if (result.job) {
        setSelectedJobId(result.job.id);
        setPageIndex(0);
        setJob(result.job);
        setSummary(null);
      }
      if (!options.silent) {
        toast.success("Crawl queued", {
          description: `The crawler is now collecting pages for ${siteUrl}.`,
        });
      }
      await loadJobs();
      await loadPages(result.job?.id || null, 0);
    } catch (err: any) {
      setError(err.message || "Failed to start crawl");
      if (!options.silent) {
        toast.error("Crawl start failed", { description: err.message || "Unable to start crawl." });
      }
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!siteUrl || !job?.id) return;
    setCancelling(true);
    setError(null);
    try {
      const result = await cancelCrawl({ jobId: job.id, siteUrl });
      setJob(result.job);
      await loadJobs();
      await loadPages(result.job.id, pageIndex);
      toast.success("Crawl cancelled", {
        description: `The active crawl for ${siteUrl} has been stopped.`,
      });
    } catch (err: any) {
      setError(err.message || "Failed to cancel crawl");
      toast.error("Cancel failed", { description: err.message || "Unable to cancel the crawl." });
    } finally {
      setCancelling(false);
    }
  };

  useEffect(() => {
    if (!siteUrl || !hasLoadedJobs || jobs.length > 0 || job || starting || hasAutoStartedRef.current) {
      return;
    }

    hasAutoStartedRef.current = true;
    handleStart({ silent: true }).catch((err) => {
      setError(err.message || "Failed to start crawl");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLoadedJobs, job, jobs.length, siteUrl, starting]);

  const displayedRows = rows;

  return (
    <div className="space-y-5">
      <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardHeader className="flex flex-col gap-4 border-b border-border/70 pb-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Globe2 className="h-5 w-5 text-primary" />
              <CardTitle className="text-xl">Crawl inventory</CardTitle>
              <StatusPill job={job} />
            </div>
            <CardDescription className="max-w-3xl">
              First-party crawl inventory for the current site. Seed from sitemap and internal links, then keep the raw URL rows inside the app.
            </CardDescription>
          </div>
          <div className="flex flex-col gap-3 lg:items-end">
            <div className="text-sm text-muted-foreground lg:text-right">
              <div>Workspace site</div>
              <div className="font-medium text-foreground">{siteUrl}</div>
            </div>
            <div className="flex flex-wrap gap-2 lg:justify-end">
              <Button className="h-10 rounded-xl" disabled={starting || !siteUrl} onClick={() => handleStart()}>
                {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh crawl
              </Button>
              <Button
                className="h-10 rounded-xl"
                variant="outline"
                onClick={() => {
                  loadJobs().catch(() => {});
                  loadStatus().catch(() => {});
                  loadPages().catch(() => {});
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh view
              </Button>
              {canCancelActiveJob && (
                <Button
                  className="h-10 rounded-xl"
                  variant="outline"
                  disabled={cancelling}
                  onClick={handleCancel}
                >
                  {cancelling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <AlertCircle className="mr-2 h-4 w-4" />}
                  Cancel crawl
                </Button>
              )}
              <Button
                className="h-10 rounded-xl"
                variant="outline"
                onClick={exportAllRows}
                disabled={exporting || pageTotal === 0}
              >
                {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Export CSV
              </Button>
              <Button
                className="h-10 rounded-xl"
                variant="outline"
                onClick={exportAllLinks}
                disabled={exportingLinks || !job}
              >
                {exportingLinks ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Export links
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1fr)]">
            <div className="space-y-3 rounded-2xl border border-border bg-background p-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  <History className="h-3.5 w-3.5" />
                  Crawl runs
                </div>
                <Select
                  value={selectedJobId || "__latest__"}
                  onValueChange={(value) => {
                    setSelectedJobId(value === "__latest__" ? "" : value);
                    setPageIndex(0);
                  }}
                >
                  <SelectTrigger className="h-11 rounded-xl border-border bg-card">
                    <SelectValue placeholder={jobsLoading ? "Loading runs..." : "Latest crawl"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__latest__">Latest crawl</SelectItem>
                    {jobs.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {`${entry.status.charAt(0).toUpperCase() + entry.status.slice(1)} - ${formatRelativeTime(entry.startedAt || entry.updatedAt || null)} - ${formatNumber(entry.crawledCount)}/${formatNumber(entry.discoveredCount)}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="text-xs text-muted-foreground">
                  {jobsLoading ? "Refreshing crawl history..." : `${formatNumber(jobs.length)} crawl run${jobs.length === 1 ? "" : "s"} loaded`}
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <div className="mb-3 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Crawl options</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground">Max depth</span>
                    <Input className="h-10 rounded-xl bg-card" min={0} max={crawlLimits.maxDepth} onChange={(event) => setMaxDepth(Math.max(0, Math.min(crawlLimits.maxDepth, Number(event.target.value) || 0)))} type="number" value={maxDepth} />
                  </label>
                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground">Max pages</span>
                    <Input className="h-10 rounded-xl bg-card" min={1} max={crawlLimits.maxPages} onChange={(event) => setMaxPages(Math.max(1, Math.min(crawlLimits.maxPages, Number(event.target.value) || 1)))} type="number" value={maxPages} />
                  </label>
                </div>
                <label className="mt-3 block space-y-1.5 text-sm">
                  <span className="text-muted-foreground">User agent</span>
                  <Input className="h-10 rounded-xl bg-card" onChange={(event) => setUserAgent(event.target.value)} value={userAgent} />
                </label>
                <label className="mt-3 block space-y-1.5 text-sm">
                  <span className="text-muted-foreground">Rendering</span>
                  <Select value={renderMode} onValueChange={(value) => setRenderMode(value as "html" | "javascript")}>
                    <SelectTrigger className="h-10 rounded-xl border-border bg-card">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="html">HTML fetch</SelectItem>
                      {crawlLimits.allowJavaScriptRendering && <SelectItem value="javascript">JavaScript render</SelectItem>}
                    </SelectContent>
                  </Select>
                </label>
                <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
                  {!crawlLimits.allowJavaScriptRendering && (
                    <div className="rounded-xl border border-border bg-muted/40 p-3 text-xs">
                      JavaScript rendering and larger crawl limits are available on paid plans.
                    </div>
                  )}
                  <label className="flex items-center gap-2">
                    <input checked={respectRobots} onChange={(event) => setRespectRobots(event.target.checked)} type="checkbox" />
                    Respect robots.txt disallow rules
                  </label>
                  <label className="flex items-center gap-2">
                    <input checked={includeQueryStrings} onChange={(event) => setIncludeQueryStrings(event.target.checked)} type="checkbox" />
                    Treat query-string URLs as unique pages
                  </label>
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-2xl border border-border bg-background p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-foreground">Progress</span>
                <span className="text-muted-foreground">
                  {job ? `${formatNumber(job.crawledCount)} of ${formatNumber(job.discoveredCount)} crawled` : "Waiting for first crawl"}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${progress}%` }} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-card p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Started</p>
                  <p className="mt-2 text-sm font-medium text-foreground">{formatRelativeTime(job?.startedAt || null)}</p>
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Updated</p>
                  <p className="mt-2 text-sm font-medium text-foreground">{formatRelativeTime(job?.updatedAt || null)}</p>
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Current crawl</p>
                  <p className="mt-2 truncate text-sm font-medium text-foreground" title={job?.startUrl || resolvedStartUrl || ""}>{job?.startUrl || resolvedStartUrl || "Not set"}</p>
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Sitemap</p>
                  <p className="mt-2 text-sm font-medium text-foreground">{job?.sitemapUrl || "Auto-discovered"}</p>
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Options</p>
                  <p className="mt-2 text-sm font-medium text-foreground">
                    {job?.renderMode === "javascript" ? "JS render" : "HTML fetch"}, depth {job?.maxDepth ?? maxDepth}, {job?.includeQueryStrings ? "query URLs on" : "query URLs off"}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Robots</p>
                  <p className="mt-2 text-sm font-medium text-foreground">{job?.respectRobots === 0 ? "Ignored for crawl" : "Respected"}</p>
                </div>
              </div>
              {job?.lastError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {job.lastError}
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <AlertCircle className="mr-2 inline-block h-4 w-4" />
              {error}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
            <SummaryCard icon={<CheckCircle2 className="h-4 w-4" />} label="Pages" tone="bg-primary/10 text-primary" value={formatNumber(summary?.totalPages || 0)} />
            <SummaryCard icon={<CheckCircle2 className="h-4 w-4" />} label="200 OK" tone="bg-emerald-100 text-emerald-700" value={formatNumber(summary?.successPages || 0)} />
            <SummaryCard icon={<RefreshCw className="h-4 w-4" />} label="Redirects" tone="bg-amber-100 text-amber-700" value={formatNumber(summary?.redirectPages || 0)} />
            <SummaryCard icon={<ShieldAlert className="h-4 w-4" />} label="Noindex" tone="bg-violet-100 text-violet-700" value={formatNumber(summary?.noindexPages || 0)} />
            <SummaryCard icon={<Search className="h-4 w-4" />} label="Orphans" tone="bg-sky-100 text-sky-700" value={formatNumber(summary?.orphanPages || 0)} />
            <SummaryCard icon={<AlertCircle className="h-4 w-4" />} label="Errors" tone="bg-red-100 text-red-700" value={formatNumber(summary?.errorPages || 0)} />
          </div>

          {compare?.compareJob && (
            <div className="rounded-2xl border border-border bg-background p-4">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-foreground">Compared with previous crawl</p>
                  <p className="text-xs text-muted-foreground">
                    Previous run: {formatRelativeTime(compare.compareJob.startedAt || compare.compareJob.updatedAt || null)}
                  </p>
                </div>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
                {[
                  ["New", compare.summary.new],
                  ["Missing", compare.summary.missing],
                  ["Status changed", compare.summary.statusChanged],
                  ["Title changed", compare.summary.titleChanged],
                  ["Canonical changed", compare.summary.canonicalChanged],
                  ["Unchanged", compare.summary.unchanged],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-border bg-card p-3">
                    <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
                    <p className="mt-2 text-xl font-semibold text-foreground">{formatNumber(Number(value))}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex w-full flex-col gap-2 md:max-w-3xl md:flex-row">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  className="h-11 rounded-xl border-border bg-card pl-10"
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search URL, title, or canonical..."
                  value={searchTerm}
                />
              </div>
              <Select value={issueFilter} onValueChange={(value) => setIssueFilter(value as CrawlIssueFilter)}>
                <SelectTrigger className="h-11 rounded-xl border-border bg-card md:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All crawl rows</SelectItem>
                  <SelectItem value="success">200 OK</SelectItem>
                  <SelectItem value="redirect">Redirects</SelectItem>
                  <SelectItem value="error">Errors</SelectItem>
                  <SelectItem value="no_response">No response</SelectItem>
                  <SelectItem value="noindex">Noindex</SelectItem>
                  <SelectItem value="orphan">Orphan-like</SelectItem>
                  <SelectItem value="missing_title">Missing title</SelectItem>
                  <SelectItem value="missing_meta">Missing meta description</SelectItem>
                  <SelectItem value="canonicalized">Canonicalized</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="text-sm text-muted-foreground">
              {pageTotal === 0 ? "No crawl rows yet" : `${formatNumber(pageTotal)} rows in the current crawl`}
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border">
            <div className="overflow-x-auto">
              <Table className="min-w-[1280px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[24%]">URL</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Canonical</TableHead>
                    <TableHead>Depth</TableHead>
                    <TableHead>Discovery</TableHead>
                    <TableHead>Links</TableHead>
                    <TableHead>Words</TableHead>
                    <TableHead>Crawled</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                        <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
                        Loading crawl inventory...
                      </TableCell>
                    </TableRow>
                  ) : displayedRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                        {job ? "No rows match the current crawl filters." : "Start a crawl to populate the inventory."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    displayedRows.map((row) => (
                      <TableRow key={row.normalizedUrl}>
                        <TableCell className="max-w-0 truncate font-medium text-foreground" title={row.url}>
                          {row.url}
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                            {formatStatusLabel(row.statusCode)}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-0 truncate text-muted-foreground" title={row.title || ""}>
                          {row.title || "Untitled"}
                        </TableCell>
                        <TableCell className="max-w-0 truncate text-muted-foreground" title={row.canonicalUrl || ""}>
                          {row.canonicalUrl || "Not set"}
                        </TableCell>
                        <TableCell>{row.depth}</TableCell>
                        <TableCell className="text-muted-foreground">{row.discoveredFrom || "seed"}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatNumber(row.inboundLinkCount ?? row.internalLinkCount ?? 0)} in / {formatNumber(row.outgoingLinkCount)} out
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatNumber(row.wordCount)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatRelativeTime(row.crawledAt)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              Page {pageIndex + 1} of {totalPages}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="h-9 rounded-xl"
                disabled={pageIndex === 0}
                onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                className="h-9 rounded-xl"
                disabled={pageIndex + 1 >= totalPages}
                onClick={() => setPageIndex((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
