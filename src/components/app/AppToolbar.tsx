import { DatePicker } from "@/components/ui/date-picker";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/src/lib/authFetch";
import { format } from "date-fns";
import { AlertTriangle, Database, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";

type DataSource = "gsc" | "bing" | "ga4" | "blended";

type AppToolbarProps = {
  activeMenu: string;
  compareDateRange: DateRange;
  currentSiteUrl: string;
  dataSource: DataSource;
  dateRange: DateRange;
  firstName?: string;
  ga4PropertyId?: string | null;
  gscSyncVersion?: number;
  isCompareMode: boolean;
  onCompareFromDateChange: (date: Date | undefined) => void;
  onCompareToDateChange: (date: Date | undefined) => void;
  onFromDateChange: (date: Date | undefined) => void;
  onOpenRawData?: () => void;
  onToDateChange: (date: Date | undefined) => void;
  onWarehouseCoverageChange?: () => void;
  rawDataAvailable?: boolean;
  setIsCompareMode: (value: boolean) => void;
};

type ToolbarCoverageSnapshot = {
  activeDateCount: number;
  activeJobCount: number;
  coveredDateCount: number;
  errorJobCount: number;
  expectedDateCount: number;
  hasGa4Gaps: boolean;
  hasGscGaps: boolean;
  latestAvailableDate: string | null;
  lastCoveredDate: string | null;
  missingDateCount: number;
  unavailableDateCount: number;
};

export function AppToolbar({
  activeMenu,
  compareDateRange,
  currentSiteUrl,
  dataSource,
  dateRange,
  firstName,
  ga4PropertyId,
  gscSyncVersion = 0,
  isCompareMode,
  onCompareFromDateChange,
  onCompareToDateChange,
  onFromDateChange,
  onOpenRawData,
  onToDateChange,
  onWarehouseCoverageChange,
  rawDataAvailable = false,
  setIsCompareMode,
}: AppToolbarProps) {
  const sectionCopy = getSectionCopy(activeMenu, dataSource);
  const reportingGa4PropertyId = dataSource === "blended" || dataSource === "ga4" ? ga4PropertyId : null;
  const isDashboard = activeMenu === "Dashboard";
  const [syncRefreshKey, setSyncRefreshKey] = useState(0);
  const [syncActionState, setSyncActionState] = useState<"idle" | "queueing">("idle");
  const [toolbarCoverage, setToolbarCoverage] = useState<ToolbarCoverageSnapshot | null>(null);
  const toolbarCoverageScopeKey = `${dataSource}|${currentSiteUrl}|${reportingGa4PropertyId || ""}|${dateRange.from?.toISOString() || ""}|${dateRange.to?.toISOString() || ""}`;

  useEffect(() => {
    setToolbarCoverage(null);
  }, [toolbarCoverageScopeKey]);

  const handleRefreshResults = async () => {
    const range = getIsoDateRange(dateRange);
    setSyncActionState("queueing");
    try {
      if (currentSiteUrl && range) {
        await authFetch("/api/warehouse/jobs/missing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              endDate: range.endDate,
              propertyId: reportingGa4PropertyId || undefined,
              maxDates: 486,
              siteUrl: currentSiteUrl,
              startDate: range.startDate,
            }),
        });
      }
    } catch (error) {
      console.warn("Failed to queue missing warehouse sync jobs", error);
    } finally {
      setSyncRefreshKey((key) => key + 1);
      setSyncActionState("idle");
    }
  };
  const toolbarHasActiveImport = Number(toolbarCoverage?.activeJobCount || 0) > 0;
  const toolbarNeedsDataAttention = Boolean(
    toolbarCoverage &&
    (toolbarCoverage.missingDateCount > 0 || toolbarCoverage.errorJobCount > 0),
  );
  const showImportControl = syncActionState === "queueing" || toolbarHasActiveImport || toolbarNeedsDataAttention;
  const importButtonDisabled = syncActionState === "queueing" || toolbarHasActiveImport;
  const importButtonLabel = syncActionState === "queueing"
    ? "Queueing update"
    : toolbarHasActiveImport
      ? "Syncing in background"
      : toolbarCoverage?.errorJobCount
        ? "Retry data update"
        : "Update data";

  return (
    <div className="premium-panel relative overflow-hidden rounded-2xl border border-border px-5 py-4 sm:px-6">
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[52%] overflow-hidden opacity-55 [mask-image:linear-gradient(to_right,transparent_0%,black_28%,black_100%)] lg:block">
        <img
          src="/images/hero-mountains.png"
          alt=""
          className="absolute bottom-[-14px] right-[-22px] h-[122%] w-[122%] object-contain object-right-bottom dark:hidden"
        />
        <div className="absolute inset-0 hidden dark:block bg-[linear-gradient(135deg,rgba(255,255,255,0.06)_0%,rgba(255,255,255,0.025)_38%,rgba(255,255,255,0)_72%)] opacity-80" />
        <div className="absolute inset-x-0 bottom-0 hidden h-1/2 dark:block bg-[linear-gradient(180deg,transparent_0%,rgba(255,255,255,0.02)_100%)]" />
      </div>
      <div className="relative flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
      <div className="max-w-[460px] shrink-0">
        <p className="text-sm font-medium text-foreground">Good afternoon, {firstName || "there"}!</p>
        <h2 className="mt-2 max-w-md text-[30px] font-semibold leading-[1.08] tracking-[-0.02em] text-foreground text-balance sm:text-[32px]">
          {sectionCopy.title}
        </h2>
        <p className="mt-2 max-w-[58ch] text-sm leading-[1.55] text-muted-foreground text-pretty">
          {sectionCopy.description}
        </p>
      </div>
      <div className="flex w-full flex-col items-start gap-2 xl:min-w-[760px] xl:items-end">
        <div className="flex w-full flex-wrap items-center gap-2 xl:justify-end">
          {isDashboard && (dataSource === "gsc" || dataSource === "blended" || dataSource === "ga4") && (
            <>
              <GscSyncStatusBadge
                dataSource={dataSource}
                dateRange={dateRange}
                ga4PropertyId={reportingGa4PropertyId}
                onCoverageLoaded={setToolbarCoverage}
                onCoverageProgress={onWarehouseCoverageChange}
                refreshKey={syncRefreshKey + gscSyncVersion}
                siteUrl={currentSiteUrl}
              />
              {showImportControl && (
                <button
                  className="flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium text-foreground shadow-[0_8px_20px_rgba(15,61,46,0.06)] transition hover:bg-background disabled:cursor-default disabled:opacity-75"
                  disabled={importButtonDisabled}
                  onClick={handleRefreshResults}
                  title={dataSource === "blended"
                    ? "Refresh missing Search Console and Analytics days for the selected range."
                    : dataSource === "ga4"
                      ? "Refresh missing Analytics pages and breakdowns for the selected range."
                      : "Refresh missing Search Console days for the selected range."}
                  type="button"
                >
                  <RefreshCw className={`h-4 w-4 ${syncActionState === "queueing" || toolbarHasActiveImport ? "animate-spin" : ""}`} />
                  {importButtonLabel}
                </button>
              )}
              {rawDataAvailable && onOpenRawData && (
                <button
                  className="flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium text-foreground shadow-[0_8px_20px_rgba(15,61,46,0.06)] transition hover:bg-background"
                  onClick={onOpenRawData}
                  title="Open stored source data for this workspace."
                  type="button"
                >
                  <Database className="h-4 w-4" />
                  Source data
                </button>
              )}
            </>
          )}
          <div className="grid w-full min-w-0 grid-cols-2 gap-2 sm:w-auto sm:grid-cols-[auto_auto_auto_auto] sm:items-center">
            <div className="col-span-2 flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 shadow-[0_8px_20px_rgba(15,61,46,0.06)] sm:col-span-1">
              <Switch id="compare-mode" checked={isCompareMode} onCheckedChange={setIsCompareMode} />
              <Label htmlFor="compare-mode" className="text-sm font-medium cursor-pointer">
                Compare
              </Label>
            </div>
            <div className="min-w-0 [&>button]:h-9 [&>button]:w-full [&>button]:min-w-0 [&>button]:overflow-hidden [&>button]:rounded-xl [&>button]:border-border [&>button]:bg-card [&>button]:shadow-[0_8px_20px_rgba(15,61,46,0.06)] sm:[&>button]:w-auto sm:[&>button]:min-w-[160px]">
              <DatePicker date={dateRange.from} setDate={onFromDateChange} label="From" />
            </div>
            <span className="hidden text-sm font-medium px-1 text-muted-foreground sm:block">to</span>
            <div className="min-w-0 [&>button]:h-9 [&>button]:w-full [&>button]:min-w-0 [&>button]:overflow-hidden [&>button]:rounded-xl [&>button]:border-border [&>button]:bg-card [&>button]:shadow-[0_8px_20px_rgba(15,61,46,0.06)] sm:[&>button]:w-auto sm:[&>button]:min-w-[160px]">
              <DatePicker date={dateRange.to} setDate={onToDateChange} label="To" />
            </div>
          </div>
        </div>
        {isCompareMode && (
          <div className="grid w-full grid-cols-2 gap-2 self-start rounded-xl border border-dashed border-border bg-card/70 p-1 shadow-[0_8px_20px_rgba(15,61,46,0.04)] xl:self-end sm:w-auto sm:grid-cols-[auto_auto_auto_auto] sm:items-center">
            <span className="col-span-2 text-sm font-medium px-2 text-muted-foreground sm:col-span-1">vs</span>
            <div className="min-w-0 [&>button]:h-9 [&>button]:w-full [&>button]:min-w-0 sm:[&>button]:w-auto sm:[&>button]:min-w-[160px]">
              <DatePicker date={compareDateRange.from} setDate={onCompareFromDateChange} label="Compare From" />
            </div>
            <span className="hidden text-sm font-medium px-1 text-muted-foreground sm:block">to</span>
            <div className="min-w-0 [&>button]:h-9 [&>button]:w-full [&>button]:min-w-0 sm:[&>button]:w-auto sm:[&>button]:min-w-[160px]">
              <DatePicker date={compareDateRange.to} setDate={onCompareToDateChange} label="Compare To" />
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function getIsoDateRange(dateRange: DateRange) {
  if (!dateRange.from || !dateRange.to) return null;
  return {
    endDate: format(dateRange.to, "yyyy-MM-dd"),
    startDate: format(dateRange.from, "yyyy-MM-dd"),
  };
}

const formatWholeNumber = (value: number) => new Intl.NumberFormat("en-US").format(value);

function GscSyncStatusBadge({
  dataSource,
  dateRange,
  ga4PropertyId,
  onCoverageLoaded,
  onCoverageProgress,
  refreshKey,
  siteUrl,
}: {
  dataSource: DataSource;
  dateRange: DateRange;
  ga4PropertyId?: string | null;
  onCoverageLoaded?: (coverage: ToolbarCoverageSnapshot | null) => void;
  onCoverageProgress?: () => void;
  refreshKey: number;
  siteUrl: string;
}) {
  const [coverage, setCoverage] = useState<ToolbarCoverageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const lastCoverageSnapshot = useRef<{
    activeJobCount: number;
    coveredDateCount: number;
    errorJobCount: number;
    lastCoveredDate: string | null;
    missingDateCount: number;
  } | null>(null);
  const coverageScopeKey = `${siteUrl}|${ga4PropertyId || ""}|${dateRange.from?.toISOString() || ""}|${dateRange.to?.toISOString() || ""}`;

  useEffect(() => {
    lastCoverageSnapshot.current = null;
  }, [coverageScopeKey]);

  useEffect(() => {
    if (!siteUrl) {
      setCoverage(null);
      onCoverageLoaded?.(null);
      return;
    }

    const range = getIsoDateRange(dateRange);
    let cancelled = false;
    setLoading(true);

    const request = range
      ? authFetch(`/api/warehouse/coverage?${new URLSearchParams({
          endDate: range.endDate,
          ...(ga4PropertyId ? { propertyId: ga4PropertyId } : {}),
          siteUrl,
          startDate: range.startDate,
        }).toString()}`)
      : authFetch(`/api/warehouse/status?siteUrl=${encodeURIComponent(siteUrl)}`);

    request
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to load sync status");
        }
        return response.json();
      })
      .then((status) => {
        if (!cancelled) {
          let activeJobCount = 0;
          let nextCoverage: typeof coverage = null;
          if (range && status?.gsc?.site) {
            const includeGsc = dataSource === "gsc" || dataSource === "blended";
            const includeGa4Pages = (dataSource === "ga4" || dataSource === "blended") && Boolean(status?.ga4?.enabled);
            const includeGa4Dimensions = dataSource === "ga4" && Boolean(status?.ga4?.enabled);
            const datasets = [
              ...(includeGsc ? [
                status.gsc.site,
                status.gsc.query,
                status.gsc.pageQuery,
              ] : []),
              ...(includeGa4Pages ? [status.ga4.pages] : []),
              ...(includeGa4Dimensions ? [status.ga4.dimensions] : []),
            ].filter(Boolean);
            activeJobCount = Number(status?.warehouseJobs?.queued || 0)
              + Number(status?.warehouseJobs?.running || 0)
              + Number(status?.warehouseJobs?.retrying || 0);
            const gscMissingDateCount = includeGsc ? Math.max(
              Number(status?.gsc?.site?.missingDateCount || 0),
              Number(status?.gsc?.query?.missingDateCount || 0),
              Number(status?.gsc?.pageQuery?.missingDateCount || 0),
            ) : 0;
            const ga4MissingDateCount = status?.ga4?.enabled
              ? Math.max(
                includeGa4Pages ? Number(status?.ga4?.pages?.missingDateCount || 0) : 0,
                includeGa4Dimensions ? Number(status?.ga4?.dimensions?.missingDateCount || 0) : 0,
              )
              : 0;
            const coveredDateCounts = datasets.map((dataset: any) => Number(dataset?.coveredDateCount || 0));
            const expectedDateCounts = datasets.map((dataset: any) => Number(dataset?.expectedDateCount || 0));
            const lastCoveredDates = datasets
              .map((dataset: any) => dataset?.lastCoveredDate)
              .filter(Boolean)
              .sort();
            nextCoverage = {
              activeDateCount: Number(status?.warehouseJobs?.activeDateCount || 0),
              activeJobCount,
              coveredDateCount: coveredDateCounts.length > 0 ? Math.min(...coveredDateCounts) : 0,
              errorJobCount: Number(status?.warehouseJobs?.error || 0),
              expectedDateCount: expectedDateCounts.length > 0 ? Math.max(...expectedDateCounts) : 0,
              hasGa4Gaps: ga4MissingDateCount > 0,
              hasGscGaps: gscMissingDateCount > 0,
              latestAvailableDate: status?.dateRange?.latestAvailableDate || null,
              lastCoveredDate: lastCoveredDates[0] || null,
              missingDateCount: Math.max(gscMissingDateCount, ga4MissingDateCount),
              unavailableDateCount: Number(status?.dateRange?.unavailableDateCount || 0),
            };
          } else {
            nextCoverage = {
              activeDateCount: 0,
              activeJobCount: 0,
              coveredDateCount: status.lastMetricDate ? 1 : 0,
              errorJobCount: 0,
              expectedDateCount: status.lastMetricDate ? 1 : 0,
              hasGa4Gaps: false,
              hasGscGaps: false,
              latestAvailableDate: null,
              lastCoveredDate: status.lastMetricDate || null,
              missingDateCount: 0,
              unavailableDateCount: 0,
            };
          }

          setCoverage(nextCoverage);
          onCoverageLoaded?.(nextCoverage);
          if (nextCoverage) {
            const previous = lastCoverageSnapshot.current;
            const completedBackgroundWork = Boolean(
              previous &&
              previous.activeJobCount > 0 &&
              nextCoverage.activeJobCount === 0 &&
              (
                previous.coveredDateCount !== nextCoverage.coveredDateCount ||
                previous.errorJobCount !== nextCoverage.errorJobCount ||
                previous.lastCoveredDate !== nextCoverage.lastCoveredDate ||
                previous.missingDateCount !== nextCoverage.missingDateCount
              ),
            );

            if (completedBackgroundWork) {
              onCoverageProgress?.();
            }

            lastCoverageSnapshot.current = {
              activeJobCount: nextCoverage.activeJobCount,
              coveredDateCount: nextCoverage.coveredDateCount,
              errorJobCount: nextCoverage.errorJobCount,
              lastCoveredDate: nextCoverage.lastCoveredDate,
              missingDateCount: nextCoverage.missingDateCount,
            };

          }

          if (activeJobCount > 0) {
            window.setTimeout(() => {
              if (!cancelled) {
                setPollKey((key) => key + 1);
              }
            }, 10_000);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCoverage(null);
          onCoverageLoaded?.(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dataSource, dateRange, ga4PropertyId, onCoverageLoaded, pollKey, refreshKey, siteUrl]);

  const activeJobCount = coverage?.activeJobCount || 0;
  const activeDateCount = coverage?.activeDateCount || 0;
  const errorJobCount = coverage?.errorJobCount || 0;
  const importSource = coverage?.hasGscGaps && coverage.hasGa4Gaps
    ? "Search Console and Analytics"
    : coverage?.hasGa4Gaps
      ? "Analytics"
      : coverage?.hasGscGaps
        ? "Search Console"
        : "reporting";
  let label = "Syncing in background";
  let statusTitle = "Checking stored reporting coverage for this date range.";
  if (loading) {
    return null;
  } else if (activeJobCount > 0) {
    label = "Syncing in background";
    statusTitle = activeDateCount > 0
      ? `The app is importing ${importSource} data for ${formatWholeNumber(activeDateCount)} day${activeDateCount === 1 ? "" : "s"}. Existing dashboard rows stay visible while this finishes.`
      : `The app is importing ${importSource} data. Existing dashboard rows stay visible while this finishes.`;
  } else if (errorJobCount > 0) {
    label = "Data needs attention";
    statusTitle = `${errorJobCount} data import ${errorJobCount === 1 ? "job needs" : "jobs need"} attention for the selected range.`;
  } else {
    return null;
  }

  return (
    <div
      className="flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium text-muted-foreground shadow-[0_8px_20px_rgba(15,61,46,0.06)]"
      title={statusTitle}
    >
      {activeJobCount > 0 ? (
        <RefreshCw className="h-4 w-4 animate-spin text-primary" />
      ) : (
        <AlertTriangle className="h-4 w-4 text-amber-600" />
      )}
      <span className="whitespace-nowrap">{label}</span>
    </div>
  );
}

function getSectionCopy(activeMenu: string, dataSource: DataSource) {
  if (activeMenu === "Rank Tracker") {
    return {
      title: "Track keyword movement with clarity",
      description: "Monitor rankings, spot visibility shifts, and keep keyword work tied to the active workspace.",
    };
  }

  if (activeMenu === "Server Logs") {
    return {
      title: "See how crawlers use your site",
      description: "Review crawl activity, bot errors, and technical SEO signals from server log data.",
    };
  }

  if (activeMenu === "Page Indexing") {
    return {
      title: "Understand what Google can index",
      description: "Combine Search Console, URL inspection, and crawl signals to find indexing risks faster.",
    };
  }

  if (activeMenu === "LLM Traffic") {
    return {
      title: "Measure AI referral visibility",
      description: "Track visits from ChatGPT, Perplexity, Copilot, and other emerging answer engines.",
    };
  }

  if (activeMenu === "AI Content Auditor") {
    return {
      title: "Audit content opportunities",
      description: "Review content quality signals and prioritize pages that need clearer, stronger SEO intent.",
    };
  }

  if (activeMenu === "Raw Data") {
    return {
      title: "Inspect stored source rows",
      description: "Review the stored Search Console, Analytics, and crawl rows that power the workspace reports.",
    };
  }

  if (activeMenu === "Reconciliation") {
    return {
      title: "Reconcile source conflicts",
      description: "Compare search, analytics, and crawl evidence so mismatched pages are easier to resolve.",
    };
  }

  if (activeMenu === "Settings") {
    return {
      title: "Manage your workspace",
      description: "Update profile details, workspace defaults, and connected data sources.",
    };
  }

  if (dataSource === "bing") {
    return {
      title: "Bing visibility at a glance",
      description: "Track Bing Webmaster performance once your API key and verified sites are connected.",
    };
  }

  if (dataSource === "ga4") {
    return {
      title: "Analytics performance at a glance",
      description: "Review sessions, users, pages, events, and traffic sources for the selected GA4 property.",
    };
  }

  if (dataSource === "blended") {
    return {
      title: "Pages performance at a glance",
      description: "Blend Search Console visibility with GA4 engagement at page level, without mixing query ownership.",
    };
  }

  return {
    title: "Your SEO performance at a glance",
    description: "Review Google Search Console search visibility: clicks, impressions, CTR, position, and visible queries.",
  };
}
