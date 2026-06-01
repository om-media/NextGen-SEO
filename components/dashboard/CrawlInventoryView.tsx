import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import { AlertCircle, CheckCircle2, Download, Eye, Globe2, History, Loader2, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

function DetailBlock({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</div>
      <div className="mt-3 space-y-2 text-sm">{children}</div>
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium text-foreground break-words">{value || "Missing"}</span>
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
  const [selectedRow, setSelectedRow] = useState<CrawlPageRow | null>(null);
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
  const issueTotal =
    (summary?.errorPages || 0) +
    (summary?.noindexPages || 0) +
    (summary?.missingTitlePages || 0) +
    (summary?.missingMetaPages || 0) +
    (summary?.canonicalizedPages || 0) +
    (summary?.orphanPages || 0);
  const summaryMetrics = [
    {
      filter: "all" as CrawlIssueFilter,
      icon: <Globe2 className="h-4 w-4" />,
      label: "Pages",
      tone: "bg-primary/10 text-primary",
      value: formatNumber(summary?.totalPages || 0),
    },
    {
      filter: "success" as CrawlIssueFilter,
      icon: <CheckCircle2 className="h-4 w-4" />,
      label: "200 OK",
      tone: "bg-emerald-100 text-emerald-700",
      value: formatNumber(summary?.successPages || 0),
    },
    {
      filter: "issues" as CrawlIssueFilter,
      icon: <ShieldAlert className="h-4 w-4" />,
      label: "Issues",
      tone: "bg-orange-100 text-orange-700",
      value: formatNumber(issueTotal),
    },
    {
      filter: "redirect" as CrawlIssueFilter,
      icon: <RefreshCw className="h-4 w-4" />,
      label: "Redirects",
      tone: "bg-amber-100 text-amber-700",
      value: formatNumber(summary?.redirectPages || 0),
    },
  ];
  const issueChips = [
    ["Errors", summary?.errorPages || 0, "error"],
    ["Noindex", summary?.noindexPages || 0, "noindex"],
    ["No title", summary?.missingTitlePages || 0, "missing_title"],
    ["No meta", summary?.missingMetaPages || 0, "missing_meta"],
    ["Canonicalized", summary?.canonicalizedPages || 0, "canonicalized"],
    ["Orphans", summary?.orphanPages || 0, "orphan"],
  ];

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
              Technical page analysis for the current site. The app starts collection automatically and keeps the latest crawl ready for review.
            </CardDescription>
          </div>
          <div className="flex flex-col gap-3 lg:items-end">
            <div className="text-sm text-muted-foreground lg:text-right">
              <div>Workspace site</div>
              <div className="font-medium text-foreground">{siteUrl}</div>
            </div>
            <div className="flex flex-wrap gap-2 lg:justify-end">
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
                Refresh results
              </Button>
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
                  Analysis history
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
                  {jobsLoading ? "Refreshing analysis history..." : `${formatNumber(jobs.length)} analysis run${jobs.length === 1 ? "" : "s"} loaded`}
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <div className="mb-3 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Automation</div>
                <div className="rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
                  {starting || canCancelActiveJob
                    ? "The app is collecting crawl data in the background. Results update here as pages are processed."
                    : job
                      ? "The latest crawl is ready. New analysis runs are started automatically when a site is activated."
                      : "The app will start the first crawl automatically for this site."}
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

          <div className="rounded-2xl border border-border bg-background p-4">
            <div className="grid gap-3 md:grid-cols-4">
              {summaryMetrics.map((metric) => (
                <button
                  key={metric.label}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors hover:bg-muted/60 ${
                    issueFilter === metric.filter ? "border-primary bg-primary/5" : "border-border bg-card"
                  }`}
                  onClick={() => {
                    setIssueFilter(metric.filter);
                    setPageIndex(0);
                  }}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{metric.label}</p>
                      <p className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-foreground">{metric.value}</p>
                    </div>
                    <div className={`flex h-9 w-9 items-center justify-center rounded-full ${metric.tone}`}>{metric.icon}</div>
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {issueChips.map(([label, value, filter]) => (
                <button
                  key={label}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/60 ${
                    issueFilter === filter ? "border-primary bg-primary/5 text-foreground" : "border-border bg-card text-muted-foreground"
                  }`}
                  onClick={() => {
                    setIssueFilter(filter as CrawlIssueFilter);
                    setPageIndex(0);
                  }}
                  type="button"
                >
                  {label}: <span className="text-foreground">{formatNumber(Number(value))}</span>
                </button>
              ))}
            </div>
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
                  <SelectItem value="issues">All issues</SelectItem>
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
              <Table className="min-w-[1660px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[24%]">URL</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Meta description</TableHead>
                    <TableHead>H1</TableHead>
                    <TableHead>Canonical</TableHead>
                    <TableHead>Depth</TableHead>
                    <TableHead>Discovery</TableHead>
                    <TableHead>Links</TableHead>
                    <TableHead>Words</TableHead>
                    <TableHead>Crawled</TableHead>
                    <TableHead className="text-right">Inspect</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                        <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
                        Loading crawl inventory...
                      </TableCell>
                    </TableRow>
                  ) : displayedRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                        {job ? "No rows match the current crawl filters." : "Automatic crawl collection is being prepared for this site."}
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
                        <TableCell className="max-w-0 truncate text-muted-foreground" title={row.metaDescription || ""}>
                          {row.metaDescription || "Missing"}
                        </TableCell>
                        <TableCell className="max-w-0 truncate text-muted-foreground" title={row.h1Text || ""}>
                          {row.h1Text || `${formatNumber(row.h1Count || 0)} H1`}
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
                        <TableCell className="text-right">
                          <Button variant="outline" size="sm" className="rounded-xl" onClick={() => setSelectedRow(row)}>
                            <Eye className="mr-2 h-4 w-4" />
                            Inspect
                          </Button>
                        </TableCell>
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

          <Dialog open={Boolean(selectedRow)} onOpenChange={(open) => !open && setSelectedRow(null)}>
            <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-5xl">
              <DialogHeader>
                <DialogTitle>Page source review</DialogTitle>
                <DialogDescription className="break-all">
                  {selectedRow?.url || "Review the crawler's technical source signals for this page."}
                </DialogDescription>
              </DialogHeader>

              {selectedRow && (
                <div className="grid gap-4 md:grid-cols-2">
                  <DetailBlock title="Fetch result">
                    <DetailLine label="Status" value={formatStatusLabel(selectedRow.statusCode)} />
                    <DetailLine label="Status code" value={selectedRow.statusCode ? String(selectedRow.statusCode) : "No response"} />
                    <DetailLine label="Content type" value={selectedRow.contentType || "Missing"} />
                    <DetailLine label="Response time" value={selectedRow.responseTimeMs != null ? `${formatNumber(selectedRow.responseTimeMs)} ms` : "Missing"} />
                    <DetailLine label="Crawled" value={formatRelativeTime(selectedRow.crawledAt)} />
                    <DetailLine label="Error" value={selectedRow.errorMessage || "None"} />
                  </DetailBlock>

                  <DetailBlock title="Indexability">
                    <DetailLine label="Noindex" value={selectedRow.noindex ? "Yes" : "No"} />
                    <DetailLine label="Canonical" value={selectedRow.canonicalUrl || "Not set"} />
                    <DetailLine label="Final URL" value={selectedRow.finalUrl || "Same as requested"} />
                    <DetailLine label="Page key" value={selectedRow.pageKey || "Missing"} />
                    <DetailLine label="Normalized URL" value={selectedRow.normalizedUrl || "Missing"} />
                  </DetailBlock>

                  <DetailBlock title="Content signals">
                    <DetailLine label="Title" value={selectedRow.title || "Missing"} />
                    <DetailLine label="Meta description" value={selectedRow.metaDescription || "Missing"} />
                    <DetailLine label="H1" value={selectedRow.h1Text || "Missing"} />
                    <DetailLine label="H1 count" value={formatNumber(selectedRow.h1Count || 0)} />
                    <DetailLine label="H2 count" value={formatNumber(selectedRow.h2Count || 0)} />
                    <DetailLine label="Words" value={formatNumber(selectedRow.wordCount || 0)} />
                  </DetailBlock>

                  <DetailBlock title="Discovery and links">
                    <DetailLine label="Depth" value={formatNumber(selectedRow.depth || 0)} />
                    <DetailLine label="Discovered from" value={selectedRow.discoveredFrom || "seed"} />
                    <DetailLine label="Discovered from URL" value={selectedRow.discoveredFromUrl || "Missing"} />
                    <DetailLine label="Inlinks" value={formatNumber(selectedRow.inboundLinkCount ?? selectedRow.internalLinkCount ?? 0)} />
                    <DetailLine label="Outlinks" value={formatNumber(selectedRow.outgoingLinkCount || 0)} />
                    <DetailLine label="Discovered" value={formatRelativeTime(selectedRow.discoveredAt)} />
                  </DetailBlock>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}
