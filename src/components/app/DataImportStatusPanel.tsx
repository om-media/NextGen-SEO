import { Button } from "@/components/ui/button";
import {
  fetchDataCoverage,
  fetchWarehouseJobs,
  queueMissingCoverageSync,
  retryFailedCoverageSync,
  type CoverageDataset,
  type DataCoverageResponse,
  type WarehouseJobSummary,
} from "@/src/services/dataCoverageService";
import { format, formatDistanceToNow, parseISO } from "date-fns";
import { AlertTriangle, CheckCircle2, Clock3, Database, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";

type DataSource = "gsc" | "bing" | "ga4" | "blended";

type DataImportStatusPanelProps = {
  dataSource: DataSource;
  dateRange: DateRange;
  ga4PropertyId?: string | null;
  onCoverageChange?: () => void;
  refreshKey?: number;
  siteUrl: string;
};

const formatWholeNumber = (value: number) => new Intl.NumberFormat("en-US").format(value);

function getIsoDateRange(dateRange: DateRange) {
  if (!dateRange.from || !dateRange.to) return null;
  return {
    endDate: format(dateRange.to, "yyyy-MM-dd"),
    startDate: format(dateRange.from, "yyyy-MM-dd"),
  };
}

function formatDate(value?: string | null) {
  if (!value) return "Not started";
  try {
    return format(parseISO(value), "MMM d, HH:mm");
  } catch {
    return value;
  }
}

function formatDateDistance(value?: string | null) {
  if (!value) return null;
  try {
    return `${formatDistanceToNow(parseISO(value), { addSuffix: true })}`;
  } catch {
    return null;
  }
}

function formatDurationMs(value?: number | null) {
  if (!Number.isFinite(value || NaN)) return null;
  const ms = Math.max(0, Number(value));
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWaitEstimate(value?: number | null) {
  if (!Number.isFinite(value || NaN)) return null;
  const ms = Math.max(0, Number(value));
  if (ms < 60_000) return "under 1 minute";
  if (ms < 60 * 60_000) {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(ms / (60 * 60_000));
  const minutes = Math.round((ms % (60 * 60_000)) / 60_000);
  return minutes > 0
    ? `about ${hours}h ${minutes}m`
    : `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

function getDatasetStats(coverage: DataCoverageResponse | null, dataSource: DataSource) {
  if (!coverage) {
    return {
      expectedDateCount: 0,
      firstCoveredDate: null as string | null,
      lastCoveredDate: null as string | null,
      missingDateCount: 0,
      readyDateCount: 0,
      totalRows: 0,
    };
  }

  const datasets: CoverageDataset[] = [];

  if (dataSource === "gsc" || dataSource === "blended") {
    datasets.push(
      coverage.gsc.site,
      coverage.gsc.query,
      coverage.gsc.pageQuery,
    );
  }

  if ((dataSource === "ga4" || dataSource === "blended") && coverage.ga4.enabled) {
    datasets.push(coverage.ga4.pages);
  }

  if (dataSource === "ga4" && coverage.ga4.enabled) {
    datasets.push(coverage.ga4.dimensions);
    if (coverage.ga4.llm) datasets.push(coverage.ga4.llm);
  }

  const expectedDateCount = Math.max(...datasets.map((dataset) => dataset.expectedDateCount), 0);
  const readyDateCount = datasets.length > 0
    ? Math.min(...datasets.map((dataset) => dataset.coveredDateCount))
    : 0;
  const missingDateCount = datasets.length > 0
    ? Math.max(...datasets.map((dataset) => dataset.missingDateCount))
    : 0;
  const coveredLastDates = datasets.map((dataset) => dataset.lastCoveredDate).filter(Boolean).sort() as string[];
  const coveredFirstDates = datasets.map((dataset) => dataset.firstCoveredDate).filter(Boolean).sort() as string[];

  return {
    expectedDateCount,
    firstCoveredDate: coveredFirstDates[0] || null,
    lastCoveredDate: coveredLastDates[0] || null,
    missingDateCount,
    readyDateCount,
    totalRows: datasets.reduce((sum, dataset) => sum + dataset.totalRows, 0),
  };
}

function getJobLabel(job: WarehouseJobSummary) {
  if (job.targetStartDate && job.targetStartDate !== job.targetDate) {
    return `${job.targetStartDate} to ${job.targetDate}`;
  }
  return job.targetDate;
}

function getStatusClasses(status: string) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "running") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "queued" || status === "retrying") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "error") return "border-red-200 bg-red-50 text-red-700";
  return "border-border bg-muted text-muted-foreground";
}

export function DataImportStatusPanel({
  dataSource,
  dateRange,
  ga4PropertyId,
  onCoverageChange,
  refreshKey = 0,
  siteUrl,
}: DataImportStatusPanelProps) {
  const [coverage, setCoverage] = useState<DataCoverageResponse | null>(null);
  const [jobs, setJobs] = useState<WarehouseJobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionState, setActionState] = useState<"idle" | "importing" | "retrying">("idle");
  const [pollKey, setPollKey] = useState(0);
  const autoImportKeys = useRef(new Set<string>());

  const range = useMemo(() => getIsoDateRange(dateRange), [dateRange]);
  const stats = getDatasetStats(coverage, dataSource);
  const activeJobCount = Number(coverage?.warehouseJobs.queued || 0)
    + Number(coverage?.warehouseJobs.retrying || 0)
    + Number(coverage?.warehouseJobs.running || 0);
  const failedJobCount = Number(coverage?.warehouseJobs.error || 0);

  useEffect(() => {
    if (!siteUrl || !range || (dataSource !== "gsc" && dataSource !== "blended" && dataSource !== "ga4")) {
      setCoverage(null);
      setJobs([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      fetchDataCoverage({
        endDate: range.endDate,
        propertyId: dataSource === "blended" || dataSource === "ga4" ? ga4PropertyId : null,
        siteUrl,
        startDate: range.startDate,
      }),
      fetchWarehouseJobs({ limit: 6, siteUrl }),
    ])
      .then(([nextCoverage, nextJobs]) => {
        if (cancelled) return;
        setCoverage(nextCoverage);
        setJobs(nextJobs);

        const activeJobCount = Number(nextCoverage.warehouseJobs.queued || 0)
          + Number(nextCoverage.warehouseJobs.retrying || 0)
          + Number(nextCoverage.warehouseJobs.running || 0);
        if (activeJobCount > 0) {
          window.setTimeout(() => {
            if (!cancelled) setPollKey((key) => key + 1);
          }, 10_000);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setCoverage(null);
          setJobs([]);
          setError(err.message || "Failed to load import status");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dataSource, ga4PropertyId, pollKey, range, refreshKey, siteUrl]);

  useEffect(() => {
    if (!siteUrl || !range || !coverage || loading || actionState !== "idle") return;
    if (stats.missingDateCount <= 0 || activeJobCount > 0 || failedJobCount > 0) return;

    const key = [
      dataSource,
      siteUrl,
      ga4PropertyId || "",
      range.startDate,
      range.endDate,
      stats.missingDateCount,
    ].join("|");
    if (autoImportKeys.current.has(key)) return;
    autoImportKeys.current.add(key);

    let cancelled = false;
    setActionState("importing");
    setError(null);
    queueMissingCoverageSync({
      endDate: range.endDate,
      maxDates: 486,
      propertyId: dataSource === "blended" || dataSource === "ga4" ? ga4PropertyId : null,
      siteUrl,
      startDate: range.startDate,
    })
      .then(() => {
        if (cancelled) return;
        onCoverageChange?.();
        setPollKey((keyValue) => keyValue + 1);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message || "Failed to start automatic import");
        }
      })
      .finally(() => {
        if (!cancelled) setActionState("idle");
      });

    return () => {
      cancelled = true;
    };
  }, [actionState, activeJobCount, coverage, dataSource, failedJobCount, ga4PropertyId, loading, onCoverageChange, range, siteUrl, stats.missingDateCount]);

  if (!siteUrl || !range || (dataSource !== "gsc" && dataSource !== "blended" && dataSource !== "ga4")) {
    return null;
  }

  const progressValue = stats.expectedDateCount > 0
    ? Math.round((stats.readyDateCount / stats.expectedDateCount) * 100)
    : 0;
  const visibleJobs = jobs.filter((job) => job.status !== "superseded");
  const latestJob = visibleJobs[0] || null;
  const latestTimedJob = visibleJobs.find((job) => Number.isFinite(Number(job.metrics?.totalMs))) || null;
  const latestJobDistance = formatDateDistance(latestJob?.updatedAt);
  const latestTotalDuration = formatDurationMs(latestJob?.metrics?.totalMs);
  const latestApiDuration = formatDurationMs(latestJob?.metrics?.apiMs);
  const latestWriteDuration = formatDurationMs(latestJob?.metrics?.writeMs);
  const latestTimedDuration = Number(latestTimedJob?.metrics?.totalMs || 0);
  const estimatedRemainingMs = activeJobCount > 0 && latestTimedDuration > 0
    ? activeJobCount * latestTimedDuration
    : null;
  const estimatedRemaining = formatWaitEstimate(estimatedRemainingMs);
  const estimateText = activeJobCount > 0
    ? estimatedRemaining
      ? `Estimated wait ${estimatedRemaining}, based on the latest completed import job. Large sites and Google API throttling can change this.`
      : "Estimated wait will appear after the first import job completes."
    : null;

  const status = actionState === "importing" && stats.missingDateCount > 0
    ? "starting"
    : loading && !coverage
    ? "checking"
    : activeJobCount > 0
      ? "importing"
      : failedJobCount > 0
        ? "attention"
        : stats.missingDateCount > 0
          ? "missing"
          : "ready";

  const statusCopy = {
    attention: {
      icon: <AlertTriangle className="h-4 w-4 text-red-600" />,
      label: "Import needs review",
      text: `${failedJobCount} import ${failedJobCount === 1 ? "job has" : "jobs have"} failed in this range.`,
    },
    checking: {
      icon: <RefreshCw className="h-4 w-4 animate-spin text-primary" />,
      label: "Checking stored data",
      text: "Reading the stored reporting coverage for this date range.",
    },
    starting: {
      icon: <RefreshCw className="h-4 w-4 animate-spin text-primary" />,
      label: "Starting import",
      text: "The app is starting the missing historical import automatically.",
    },
    importing: {
      icon: <RefreshCw className="h-4 w-4 animate-spin text-primary" />,
      label: "Preparing in background",
      text: "Stored reports stay available while the app fills in missing source data.",
    },
    missing: {
      icon: <Clock3 className="h-4 w-4 text-amber-600" />,
      label: "Preparing automatically",
      text: "The app will fill missing source data in the background. No export, upload, or manual import is needed.",
    },
    ready: {
      icon: <CheckCircle2 className="h-4 w-4 text-primary" />,
      label: "Ready",
      text: "Stored reporting data covers the selected date range.",
    },
  }[status];

  const handleImportMissing = async () => {
    setActionState("importing");
    setError(null);
    try {
      await queueMissingCoverageSync({
        endDate: range.endDate,
        maxDates: 486,
        propertyId: dataSource === "blended" || dataSource === "ga4" ? ga4PropertyId : null,
        siteUrl,
        startDate: range.startDate,
      });
      onCoverageChange?.();
      setPollKey((key) => key + 1);
    } catch (err: any) {
      setError(err.message || "Failed to start missing-days import");
    } finally {
      setActionState("idle");
    }
  };

  const handleRetryFailed = async () => {
    setActionState("retrying");
    setError(null);
    try {
      await retryFailedCoverageSync({
        endDate: range.endDate,
        maxJobs: 60,
        siteUrl,
        startDate: range.startDate,
      });
      onCoverageChange?.();
      setPollKey((key) => key + 1);
    } catch (err: any) {
      setError(err.message || "Failed to retry failed imports");
    } finally {
      setActionState("idle");
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-card/95 p-4 shadow-[0_12px_34px_rgba(15,61,46,0.05)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
              <Database className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Source data readiness</h3>
              <p className="text-xs text-muted-foreground">
                {range.startDate} to {range.endDate}
                {latestJobDistance ? ` · last import update ${latestJobDistance}` : ""}
              </p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
              {statusCopy.icon}
              {statusCopy.label}
            </span>
          </div>

          <p className="mt-3 text-sm text-muted-foreground">{statusCopy.text}</p>
          {estimateText && (
            <p className="mt-1 text-xs text-muted-foreground">{estimateText}</p>
          )}

          <div className="mt-4">
            <div className="flex flex-wrap gap-2">
              <span className="text-xs font-medium text-foreground">
                {formatWholeNumber(stats.readyDateCount)} / {formatWholeNumber(stats.expectedDateCount)} days ready
              </span>
              <span className="ml-auto text-xs text-muted-foreground">{progressValue}%</span>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressValue}%` }} />
              </div>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 gap-2 sm:grid-cols-5 lg:w-[640px]">
          <StatusMetric label="Missing" value={formatWholeNumber(stats.missingDateCount)} />
          <StatusMetric label="Queued" value={formatWholeNumber(Number(coverage?.warehouseJobs.queued || 0) + Number(coverage?.warehouseJobs.retrying || 0))} />
          <StatusMetric label="Running" value={formatWholeNumber(Number(coverage?.warehouseJobs.running || 0))} />
          <StatusMetric label="Failed" tone={failedJobCount > 0 ? "danger" : "default"} value={formatWholeNumber(failedJobCount)} />
          <StatusMetric label="Est. wait" value={activeJobCount > 0 ? estimatedRemaining || "Learning" : "Ready"} />
        </div>
      </div>

      {(error || latestJob || stats.missingDateCount > 0 || failedJobCount > 0) && (
        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : latestJob ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Latest job</span>
                <span className={`rounded-full border px-2 py-0.5 font-medium ${getStatusClasses(latestJob.status)}`}>
                  {latestJob.status}
                </span>
                <span>{getJobLabel(latestJob)}</span>
                <span>{formatDate(latestJob.updatedAt)}</span>
                {latestJob.rowsSynced !== undefined && latestJob.rowsSynced !== null && (
                  <span>{formatWholeNumber(Number(latestJob.rowsSynced || 0))} rows</span>
                )}
                {latestTotalDuration && <span>{latestTotalDuration} total</span>}
                {latestApiDuration && <span>API {latestApiDuration}</span>}
                {latestWriteDuration && <span>write {latestWriteDuration}</span>}
                {latestJob.lastError && <span className="text-destructive">{latestJob.lastError}</span>}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No import jobs have run for this site yet.</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {failedJobCount > 0 && (
              <Button
                className="rounded-xl"
                disabled={actionState !== "idle"}
                onClick={handleRetryFailed}
                size="sm"
                variant="outline"
              >
                <RotateCcw className={`h-3.5 w-3.5 ${actionState === "retrying" ? "animate-spin" : ""}`} />
                Retry failed
              </Button>
            )}
            {stats.missingDateCount === 0 ? (
              <Button
                className="rounded-xl"
                disabled
                size="sm"
                variant="outline"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Range ready
              </Button>
            ) : (
            <Button
              className="rounded-xl"
              disabled={actionState !== "idle" || activeJobCount > 0}
              onClick={handleImportMissing}
              size="sm"
              variant="default"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${actionState === "importing" ? "animate-spin" : ""}`} />
              {actionState === "importing"
                ? "Starting"
                : activeJobCount > 0
                  ? "Preparing"
                  : "Prepare now"}
            </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function StatusMetric({
  label,
  tone = "default",
  value,
}: {
  label: string;
  tone?: "default" | "danger";
  value: string;
}) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${tone === "danger" ? "border-red-200 bg-red-50 text-red-700" : "border-border bg-background text-foreground"}`}>
      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
