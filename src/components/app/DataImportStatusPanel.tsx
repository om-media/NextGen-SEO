import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { useEffect, useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";

type DataSource = "gsc" | "bing" | "ga4" | "blended";

type DataImportStatusPanelProps = {
  compact?: boolean;
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
      latestAvailableDate: null as string | null,
      unavailableDateCount: 0,
    };
  }

  const datasets: CoverageDataset[] = [];

  if (dataSource === "gsc" || dataSource === "blended") {
    datasets.push(
      coverage.gsc.site,
      coverage.gsc.query,
      coverage.gsc.pageQuery,
      coverage.gsc.country,
    );
  }

  if ((dataSource === "ga4" || dataSource === "blended") && coverage.ga4.enabled) {
    datasets.push(coverage.ga4.pages);
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
    lastCoveredDate: coveredLastDates[coveredLastDates.length - 1] || null,
    missingDateCount,
    readyDateCount,
    totalRows: datasets.reduce((sum, dataset) => sum + dataset.totalRows, 0),
    latestAvailableDate: coverage.dateRange.latestAvailableDate || coveredLastDates[coveredLastDates.length - 1] || null,
    unavailableDateCount: Number(coverage.dateRange.unavailableDateCount || 0),
  };
}

function getJobLabel(job: WarehouseJobSummary) {
  if (job.targetStartDate && job.targetStartDate !== job.targetDate) {
    return `${job.targetStartDate} to ${job.targetDate}`;
  }
  return job.targetDate;
}

function getJobStatusLabel(status: string) {
  if (status === "retrying") return "Retrying after a failed attempt";
  if (status === "running") return "Running now";
  if (status === "queued") return "Queued for the worker";
  if (status === "error") return "Failed — action needed";
  if (status === "completed") return "Completed";
  return status;
}

function getJobErrorCopy(error?: string | null) {
  if (!error) return null;
  if (/sufficient permission|permission denied|forbidden/i.test(error)) {
    return "Google rejected access to this property. Reconnect Google Data or choose a property your account can access.";
  }
  return error;
}

function isJobForDataSource(job: WarehouseJobSummary, dataSource: DataSource) {
  if (dataSource === "gsc") return job.jobType === "daily-sync" || job.jobType === "core-range-sync";
  return ["daily-sync", "core-range-sync", "ga4-page-range-sync"].includes(job.jobType);
}

function getStatusClasses(status: string) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "running") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "queued" || status === "retrying") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "error") return "border-red-200 bg-red-50 text-red-700";
  return "border-border bg-muted text-muted-foreground";
}

export function DataImportStatusPanel({
  compact = false,
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
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const range = useMemo(() => getIsoDateRange(dateRange), [dateRange]);
  const importSources = dataSource === "gsc"
    ? ["gsc"]
    : dataSource === "blended"
      ? ["gsc", "ga4-pages"]
      : ["ga4-pages"];
  const stats = getDatasetStats(coverage, dataSource);
  const selectedSourceJobs = coverage?.sourceJobs
    ? dataSource === "gsc"
      ? [coverage.sourceJobs.gsc]
      : dataSource === "blended"
        ? [coverage.sourceJobs.gsc, coverage.sourceJobs.ga4Pages]
        : [coverage.sourceJobs.ga4Pages]
    : [];
  const activeJobCount = selectedSourceJobs.length > 0
    ? selectedSourceJobs.reduce((sum, source) => sum + Number(source.queued || 0) + Number(source.retrying || 0) + Number(source.running || 0), 0)
    : Number(coverage?.warehouseJobs.queued || 0) + Number(coverage?.warehouseJobs.retrying || 0) + Number(coverage?.warehouseJobs.running || 0);
  const failedJobCount = selectedSourceJobs.length > 0
    ? selectedSourceJobs.reduce((sum, source) => sum + Number(source.error || 0), 0)
    : Number(coverage?.warehouseJobs.error || 0);
  const staleActiveCount = Number(coverage?.warehouseJobs.staleActiveCount || 0);
  const staleSince = coverage?.warehouseJobs.staleSince || null;
  const activeDateCount = Number(coverage?.warehouseJobs.activeDateCount || 0);

  useEffect(() => {
    if (!siteUrl || !range || (dataSource !== "gsc" && dataSource !== "blended" && dataSource !== "ga4")) {
      setCoverage(null);
      setJobs([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setActionNotice(null);

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


  if (!siteUrl || !range || (dataSource !== "gsc" && dataSource !== "blended" && dataSource !== "ga4")) {
    return null;
  }

  const progressValue = stats.expectedDateCount > 0
    ? Math.round((stats.readyDateCount / stats.expectedDateCount) * 100)
    : 0;
  const visibleJobs = jobs.filter((job) => job.status !== "superseded");
  const sourceJobs = visibleJobs.filter((job) => {
    const jobStart = job.targetStartDate || job.targetDate;
    return isJobForDataSource(job, dataSource) && jobStart <= range.endDate && job.targetDate >= range.startDate;
  });
  const latestJob = sourceJobs[0] || null;
  const latestTimedJob = sourceJobs.find((job) => Number.isFinite(Number(job.metrics?.totalMs))) || null;
  const latestJobDistance = formatDateDistance(latestJob?.updatedAt);
  const staleSinceDistance = formatDateDistance(staleSince);
  const latestTotalDuration = formatDurationMs(latestJob?.metrics?.totalMs);
  const latestApiDuration = formatDurationMs(latestJob?.metrics?.apiMs);
  const latestWriteDuration = formatDurationMs(latestJob?.metrics?.writeMs);
  const latestTimedDuration = Number(latestTimedJob?.metrics?.totalMs || 0);
  const estimatedRemainingMs = activeJobCount > 0 && latestTimedDuration > 0
    ? activeJobCount * latestTimedDuration
    : null;
  const estimatedRemaining = formatWaitEstimate(estimatedRemainingMs);
  const unscheduledMissingDateCount = Math.max(stats.missingDateCount - activeDateCount, 0);
  const estimateText = staleActiveCount > 0
    ? null
    : activeJobCount > 0
    ? estimatedRemaining
      ? `Estimated wait ${estimatedRemaining}, based on the latest completed import job. Large sites and Google API throttling can change this.`
      : "Estimated wait will appear after the first import job completes."
    : null;

  const status = actionState === "importing" && stats.missingDateCount > 0
    ? "starting"
    : loading && !coverage
    ? "checking"
    : staleActiveCount > 0
      ? "stalled"
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
      icon: <RefreshCw className="h-4 w-4 motion-safe:animate-spin motion-reduce:animate-none text-primary" />,
      label: "Checking stored data",
      text: "Reading the stored reporting coverage for this date range.",
    },
    starting: {
      icon: <RefreshCw className="h-4 w-4 motion-safe:animate-spin motion-reduce:animate-none text-primary" />,
      label: "Starting import",
      text: "Starting an import for the missing source data now.",
    },
    stalled: {
      icon: <AlertTriangle className="h-4 w-4 text-amber-600" />,
      label: "Import appears stalled",
      text: `No warehouse worker heartbeat has been received${staleSinceDistance ? ` ${staleSinceDistance}` : " recently"}. No new data is being recorded; the import may need the worker to restart.`,
    },
    importing: {
      icon: <RefreshCw className="h-4 w-4 motion-safe:animate-spin motion-reduce:animate-none text-primary" />,
      label: "Import in progress",
      text: `${formatWholeNumber(stats.missingDateCount)} missing ${stats.missingDateCount === 1 ? "day" : "days"}; ${formatWholeNumber(activeDateCount)} ${activeDateCount === 1 ? "day is" : "days are"} queued or running${unscheduledMissingDateCount > 0 ? `, and ${formatWholeNumber(unscheduledMissingDateCount)} ${unscheduledMissingDateCount === 1 ? "day is" : "days are"} still waiting to be scheduled` : ""}. Stored reports stay available while the app fills in source data. This panel checks again every 10 seconds.`,
    },
    missing: {
      icon: <Clock3 className="h-4 w-4 text-amber-600" />,
      label: "Missing data",
      text: `${formatWholeNumber(stats.missingDateCount)} ${stats.missingDateCount === 1 ? "day is" : "days are"} missing and no import is running. Choose Prepare now to start the missing-day import.`,
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
      const result = await queueMissingCoverageSync({
        endDate: range.endDate,
        maxDates: 486,
        propertyId: dataSource === "blended" || dataSource === "ga4" ? ga4PropertyId : null,
        siteUrl,
        sources: importSources,
        startDate: range.startDate,
      });
      setActionNotice(result.queued > 0 ? `Queued ${formatWholeNumber(result.queued)} import ${result.queued === 1 ? "job" : "jobs"} for missing dates. Completed data was left untouched.` : "No new missing-date jobs were queued.");
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
      const result = await retryFailedCoverageSync({
        endDate: range.endDate,
        maxJobs: 60,
        siteUrl,
        startDate: range.startDate,
      });
      setActionNotice(result.retried > 0 ? `Retrying ${formatWholeNumber(result.retried)} failed import ${result.retried === 1 ? "job" : "jobs"} only. Completed days and successful jobs were left untouched.` : "No failed import jobs matched this date range.");
      onCoverageChange?.();
      setPollKey((key) => key + 1);
    } catch (err: any) {
      setError(err.message || "Failed to retry failed imports");
    } finally {
      setActionState("idle");
    }
  };

  const statusIndicatorClass = status === "ready"
    ? "bg-emerald-500"
    : status === "stalled" || status === "attention"
      ? "bg-red-500"
      : "bg-amber-400";

  const panel = (
    <section
      aria-busy={loading || (activeJobCount > 0 && staleActiveCount === 0)}
      aria-labelledby="source-data-readiness-heading"
      style={{ width: "100%" }}
      className="rounded-2xl border border-border bg-card/95 p-4 shadow-[0_12px_34px_rgba(15,61,46,0.05)]"
    >
      <div className={compact ? "flex flex-col gap-4" : "flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
              <Database className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground" id="source-data-readiness-heading">Source data readiness</h3>
              <p className="text-xs text-muted-foreground">
                {format(parseISO(range.startDate), "MMM d, yyyy")} to {format(parseISO(range.endDate), "MMM d, yyyy")}
                {latestJobDistance ? ` · last import update ${latestJobDistance}` : ""}
              </p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
              {statusCopy.icon}
              {statusCopy.label}
            </span>
          </div>

          <p aria-live="polite" className="mt-3 text-sm text-muted-foreground" role="status">{statusCopy.text}</p>
          {actionNotice && <p aria-live="polite" className="mt-2 text-sm font-medium text-primary" role="status">{actionNotice}</p>}
          {stats.latestAvailableDate && stats.latestAvailableDate < range.endDate && (
            <p className="mt-1 text-xs text-amber-700">
              Source data is currently available through {format(parseISO(stats.latestAvailableDate), "MMM d, yyyy")}.
              {stats.unavailableDateCount > 0
                ? ` ${formatWholeNumber(stats.unavailableDateCount)} ${stats.unavailableDateCount === 1 ? "requested date is" : "requested dates are"} not published yet.`
                : ` ${format(parseISO(range.endDate), "MMM d, yyyy")} is not available yet.`}
            </p>
          )}
          {estimateText && (
            <p className="mt-1 text-xs text-muted-foreground">{estimateText}</p>
          )}

          <div className="mt-4">
            <div className="flex flex-wrap gap-2">
              <span className="text-xs font-medium text-foreground">
                {formatWholeNumber(stats.readyDateCount)} / {formatWholeNumber(stats.expectedDateCount)} days ready
              </span>
              <span className="ml-auto text-xs text-muted-foreground">{progressValue}%</span>
              <div
                aria-label="Source data coverage"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={progressValue}
                aria-valuetext={`${formatWholeNumber(stats.readyDateCount)} of ${formatWholeNumber(stats.expectedDateCount)} requested days ready`}
                className="h-1 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
              >
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressValue}%` }} />
              </div>
            </div>
          </div>
        </div>

        <div className={compact ? "grid min-w-0 w-full gap-2 sm:grid-cols-5" : "grid min-w-0 gap-2 sm:grid-cols-5 lg:w-[640px]"}>
          <StatusMetric label="Missing" value={formatWholeNumber(stats.missingDateCount)} />
          <StatusMetric label="Queued" value={formatWholeNumber(Number(coverage?.warehouseJobs.queued || 0) + Number(coverage?.warehouseJobs.retrying || 0))} />
          <StatusMetric label="Running" value={formatWholeNumber(Number(coverage?.warehouseJobs.running || 0))} />
          <StatusMetric label="Failed" tone={failedJobCount > 0 ? "danger" : "default"} value={formatWholeNumber(failedJobCount)} />
          <StatusMetric label="Est. wait" value={staleActiveCount > 0 ? "Stalled" : activeJobCount > 0 ? estimatedRemaining || "Learning" : "Ready"} />
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
                  {getJobStatusLabel(latestJob.status)}
                </span>
                <span>{getJobLabel(latestJob)}</span>
                <span>{formatDate(latestJob.updatedAt)}</span>
                {latestJob.rowsSynced !== undefined && latestJob.rowsSynced !== null && (
                  <span>{formatWholeNumber(Number(latestJob.rowsSynced || 0))} rows</span>
                )}
                {latestTotalDuration && <span>{latestTotalDuration} total</span>}
                {latestApiDuration && <span>API {latestApiDuration}</span>}
                {latestWriteDuration && <span>write {latestWriteDuration}</span>}
                {getJobErrorCopy(latestJob.lastError) && <span className="text-destructive">{getJobErrorCopy(latestJob.lastError)}</span>}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No import jobs have run for this site yet.</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {staleActiveCount > 0 && (
              <Button
                className="rounded-xl"
                disabled={actionState !== "idle"}
                onClick={() => setPollKey((key) => key + 1)}
                size="sm"
                variant="outline"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Check again
              </Button>
            )}
            {failedJobCount > 0 && (
              <Button
                className="rounded-xl"
                disabled={actionState !== "idle"}
                onClick={handleRetryFailed}
                size="sm"
                variant="outline"
              >
                <RotateCcw className={`h-3.5 w-3.5 ${actionState === "retrying" ? "motion-safe:animate-spin motion-reduce:animate-none" : ""}`} />
                {actionState === "retrying" ? "Retrying failed" : "Retry failed"}
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
              <RefreshCw className={`h-3.5 w-3.5 ${actionState === "importing" ? "motion-safe:animate-spin motion-reduce:animate-none" : ""}`} />
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

  if (!compact) return panel;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label={`Data readiness: ${statusCopy.label}`}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card shadow-sm transition hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            title={`Data readiness: ${statusCopy.label}`}
            type="button"
          >
            <span aria-hidden="true" className={`h-3 w-3 rounded-full ${statusIndicatorClass} ${activeJobCount > 0 && staleActiveCount === 0 ? "motion-safe:animate-pulse motion-reduce:animate-none" : ""}`} />
            <span className="sr-only">{statusCopy.label}</span>
          </button>
        }
      />
      <DropdownMenuContent align="end" className="max-h-[calc(100vh-1rem)] min-w-0 overflow-y-auto p-0" style={{ maxWidth: "calc(100vw - 1rem)", width: "min(720px, calc(100vw - 1rem))" }}>
        {panel}
      </DropdownMenuContent>
    </DropdownMenu>
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
