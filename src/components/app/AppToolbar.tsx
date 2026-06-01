import { DatePicker } from "@/components/ui/date-picker";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/src/lib/authFetch";
import { format, parseISO } from "date-fns";
import { CheckCircle2, Clock3, RefreshCw } from "lucide-react";
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
  const blendedGa4PropertyId = dataSource === "blended" ? ga4PropertyId : null;
  const showDataControls = activeMenu !== "Settings" && activeMenu !== "AI Content Auditor";
  const [syncRefreshKey, setSyncRefreshKey] = useState(0);
  const [syncActionState, setSyncActionState] = useState<"idle" | "queueing">("idle");

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
            propertyId: blendedGa4PropertyId || undefined,
            maxDates: 60,
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
      {showDataControls ? (
      <div className="flex w-full flex-col items-start gap-2 xl:min-w-[760px] xl:items-end">
        <div className="flex w-full flex-wrap items-center gap-2 xl:justify-end">
          {(dataSource === "gsc" || dataSource === "blended") && (
            <>
              <GscSyncStatusBadge
                dateRange={dateRange}
                ga4PropertyId={blendedGa4PropertyId}
                onCoverageProgress={onWarehouseCoverageChange}
                refreshKey={syncRefreshKey + gscSyncVersion}
                siteUrl={currentSiteUrl}
              />
              <button
                className="flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium text-foreground shadow-[0_8px_20px_rgba(15,61,46,0.06)] transition hover:bg-background"
                disabled={syncActionState === "queueing"}
                onClick={handleRefreshResults}
                title={dataSource === "blended"
                  ? "Queue missing GSC and GA4 warehouse data for reportable days in the selected date range."
                  : "Queue missing GSC warehouse data for reportable days in the selected date range."}
                type="button"
              >
                <RefreshCw className={`h-4 w-4 ${syncActionState === "queueing" ? "animate-spin" : ""}`} />
                {syncActionState === "queueing" ? "Queueing sync" : "Sync range"}
              </button>
              {rawDataAvailable && onOpenRawData && (
                <button
                  className="h-9 rounded-xl border border-border bg-card px-3 text-sm font-medium text-foreground shadow-[0_8px_20px_rgba(15,61,46,0.06)] transition hover:bg-background"
                  onClick={onOpenRawData}
                  type="button"
                >
                  Raw exports
                </button>
              )}
            </>
          )}
          <div className="flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
            <Switch id="compare-mode" checked={isCompareMode} onCheckedChange={setIsCompareMode} />
            <Label htmlFor="compare-mode" className="text-sm font-medium cursor-pointer">
              Compare
            </Label>
          </div>
          <div className="[&>button]:h-9 [&>button]:rounded-xl [&>button]:border-border [&>button]:bg-card [&>button]:shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
            <DatePicker date={dateRange.from} setDate={onFromDateChange} label="From" />
          </div>
          <span className="text-sm font-medium px-1 text-muted-foreground">to</span>
          <div className="[&>button]:h-9 [&>button]:rounded-xl [&>button]:border-border [&>button]:bg-card [&>button]:shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
            <DatePicker date={dateRange.to} setDate={onToDateChange} label="To" />
          </div>
        </div>
        {isCompareMode && (
          <div className="flex flex-wrap items-center gap-1 self-start rounded-xl border border-dashed border-border bg-card/70 p-1 shadow-[0_8px_20px_rgba(15,61,46,0.04)] xl:self-end sm:gap-2">
            <span className="text-sm font-medium px-1 text-muted-foreground sm:px-2">vs</span>
            <DatePicker date={compareDateRange.from} setDate={onCompareFromDateChange} label="Compare From" />
            <span className="text-sm font-medium px-1 text-muted-foreground sm:px-2">to</span>
            <DatePicker date={compareDateRange.to} setDate={onCompareToDateChange} label="Compare To" />
          </div>
        )}
      </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          <span className="rounded-full border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground">
            Workspace controls live here
          </span>
          <span className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-[0_8px_20px_rgba(15,61,46,0.04)]">
            No date range needed
          </span>
        </div>
      )}
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
  dateRange,
  ga4PropertyId,
  onCoverageProgress,
  refreshKey,
  siteUrl,
}: {
  dateRange: DateRange;
  ga4PropertyId?: string | null;
  onCoverageProgress?: () => void;
  refreshKey: number;
  siteUrl: string;
}) {
  const [coverage, setCoverage] = useState<{
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
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const lastCoverageSignature = useRef<string | null>(null);
  const coverageScopeKey = `${siteUrl}|${ga4PropertyId || ""}|${dateRange.from?.toISOString() || ""}|${dateRange.to?.toISOString() || ""}`;

  useEffect(() => {
    lastCoverageSignature.current = null;
  }, [coverageScopeKey]);

  useEffect(() => {
    if (!siteUrl) {
      setCoverage(null);
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
            activeJobCount = Number(status?.warehouseJobs?.queued || 0)
              + Number(status?.warehouseJobs?.running || 0)
              + Number(status?.warehouseJobs?.retrying || 0);
            const gscMissingDateCount = Math.max(
              Number(status?.gsc?.site?.missingDateCount || 0),
              Number(status?.gsc?.query?.missingDateCount || 0),
              Number(status?.gsc?.pageQuery?.missingDateCount || 0),
            );
            const ga4MissingDateCount = status?.ga4?.enabled
              ? Number(status?.ga4?.pages?.missingDateCount || 0)
              : 0;
            nextCoverage = {
              activeDateCount: Number(status?.warehouseJobs?.activeDateCount || 0),
              activeJobCount,
              coveredDateCount: status.gsc.site.coveredDateCount || 0,
              errorJobCount: Number(status?.warehouseJobs?.error || 0),
              expectedDateCount: status.gsc.site.expectedDateCount || 0,
              hasGa4Gaps: ga4MissingDateCount > 0,
              hasGscGaps: gscMissingDateCount > 0,
              latestAvailableDate: status?.dateRange?.latestAvailableDate || null,
              lastCoveredDate: status.gsc.site.lastCoveredDate || null,
              missingDateCount: status.gsc.site.missingDateCount || 0,
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
          if (nextCoverage) {
            const signature = [
              nextCoverage.activeDateCount,
              nextCoverage.activeJobCount,
              nextCoverage.coveredDateCount,
              nextCoverage.errorJobCount,
              nextCoverage.lastCoveredDate || "",
              nextCoverage.missingDateCount,
            ].join(":");
            if (lastCoverageSignature.current && lastCoverageSignature.current !== signature) {
              onCoverageProgress?.();
            }
            lastCoverageSignature.current = signature;
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
  }, [dateRange, ga4PropertyId, pollKey, refreshKey, siteUrl]);

  const lastMetricDate = coverage?.lastCoveredDate || null;
  const latestAvailableDate = coverage?.latestAvailableDate || lastMetricDate;
  const activeJobCount = coverage?.activeJobCount || 0;
  const activeDateCount = coverage?.activeDateCount || 0;
  const errorJobCount = coverage?.errorJobCount || 0;
  const unavailableDateCount = coverage?.unavailableDateCount || 0;
  const isPartial = Boolean(coverage && coverage.expectedDateCount > 0 && coverage.coveredDateCount < coverage.expectedDateCount);
  const backfillSource = coverage?.hasGscGaps && coverage.hasGa4Gaps
    ? "GSC/GA4"
    : coverage?.hasGa4Gaps
      ? "GA4"
      : coverage?.hasGscGaps
        ? "GSC"
        : "Warehouse";
  let label = "Preparing data";
  let statusTitle = "Checking stored reporting coverage for this date range.";
  if (loading) {
    label = "Checking coverage";
  } else if (activeJobCount > 0) {
    label = `Importing ${backfillSource} history`;
    statusTitle = activeDateCount > 0
      ? `Importing stored ${backfillSource} data for ${formatWholeNumber(activeDateCount)} selected day${activeDateCount === 1 ? "" : "s"}. Charts keep using available rows while this finishes.`
      : `Importing stored ${backfillSource} data. Charts keep using available rows while this finishes.`;
  } else if (errorJobCount > 0) {
    label = `${errorJobCount} sync issue${errorJobCount === 1 ? "" : "s"}`;
    statusTitle = "Some warehouse sync jobs for this selected date range need attention.";
  } else if (!lastMetricDate && latestAvailableDate && unavailableDateCount > 0) {
    label = `Available through ${format(parseISO(latestAvailableDate), "MMM d")}`;
    statusTitle = `Google Search Console data is delayed by about 2 days. ${unavailableDateCount} recent selected day${unavailableDateCount === 1 ? "" : "s"} will appear when Google publishes them.`;
  } else if (lastMetricDate) {
    label = isPartial
      ? `Partial: ${coverage?.coveredDateCount}/${coverage?.expectedDateCount} days through ${format(parseISO(lastMetricDate), "MMM d")}`
      : unavailableDateCount > 0 && latestAvailableDate
        ? `Current through ${format(parseISO(latestAvailableDate), "MMM d")}`
        : `Analyzed through ${format(parseISO(lastMetricDate), "MMM d")}`;
    statusTitle = isPartial
      ? "Stored warehouse data does not cover every day in the selected range yet."
      : unavailableDateCount > 0
        ? `Google Search Console data is delayed by about 2 days. ${unavailableDateCount} recent selected day${unavailableDateCount === 1 ? "" : "s"} will appear when Google publishes them.`
        : "Stored warehouse data covers the selected date range.";
  }

  return (
    <div
      className="flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium text-muted-foreground shadow-[0_8px_20px_rgba(15,61,46,0.06)]"
      title={statusTitle}
    >
      {activeJobCount > 0 ? (
        <RefreshCw className="h-4 w-4 text-primary" />
      ) : lastMetricDate ? (
        <CheckCircle2 className="h-4 w-4 text-primary" />
      ) : (
        <Clock3 className="h-4 w-4 text-amber-600" />
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

  if (activeMenu === "Settings") {
    return {
      title: "Manage your workspace",
      description: "Update profile details, plan access, workspace defaults, and connected data sources.",
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
