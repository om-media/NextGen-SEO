import { DatePicker } from "@/components/ui/date-picker";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/src/lib/authFetch";
import { format, parseISO } from "date-fns";
import { CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { DateRange } from "react-day-picker";

type DataSource = "gsc" | "bing" | "ga4" | "blended";

type AppToolbarProps = {
  activeMenu: string;
  compareDateRange: DateRange;
  currentSiteUrl: string;
  dataSource: DataSource;
  dateRange: DateRange;
  firstName?: string;
  isCompareMode: boolean;
  onCompareFromDateChange: (date: Date | undefined) => void;
  onCompareToDateChange: (date: Date | undefined) => void;
  onFromDateChange: (date: Date | undefined) => void;
  onGscSyncComplete?: () => void;
  onOpenRawData?: () => void;
  onToDateChange: (date: Date | undefined) => void;
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
  isCompareMode,
  onCompareFromDateChange,
  onCompareToDateChange,
  onFromDateChange,
  onGscSyncComplete,
  onOpenRawData,
  onToDateChange,
  rawDataAvailable = false,
  setIsCompareMode,
}: AppToolbarProps) {
  const sectionCopy = getSectionCopy(activeMenu, dataSource);
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
      onGscSyncComplete?.();
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
              <GscSyncStatusBadge dateRange={dateRange} refreshKey={syncRefreshKey} siteUrl={currentSiteUrl} />
              <button
                className="flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium text-foreground shadow-[0_8px_20px_rgba(15,61,46,0.06)] transition hover:bg-background"
                disabled={syncActionState === "queueing"}
                onClick={handleRefreshResults}
                type="button"
              >
                <RefreshCw className={`h-4 w-4 ${syncActionState === "queueing" ? "animate-spin" : ""}`} />
                {syncActionState === "queueing" ? "Queueing sync" : "Refresh results"}
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

function GscSyncStatusBadge({ dateRange, refreshKey, siteUrl }: { dateRange: DateRange; refreshKey: number; siteUrl: string }) {
  const [coverage, setCoverage] = useState<{
    coveredDateCount: number;
    expectedDateCount: number;
    lastCoveredDate: string | null;
    missingDateCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!siteUrl) {
      setCoverage(null);
      return;
    }

    const range = getIsoDateRange(dateRange);
    let cancelled = false;
    setLoading(true);

    const request = range
      ? authFetch(`/api/warehouse/coverage?siteUrl=${encodeURIComponent(siteUrl)}&startDate=${range.startDate}&endDate=${range.endDate}`)
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
          if (range && status?.gsc?.site) {
            setCoverage({
              coveredDateCount: status.gsc.site.coveredDateCount || 0,
              expectedDateCount: status.gsc.site.expectedDateCount || 0,
              lastCoveredDate: status.gsc.site.lastCoveredDate || null,
              missingDateCount: status.gsc.site.missingDateCount || 0,
            });
          } else {
            setCoverage({
              coveredDateCount: status.lastMetricDate ? 1 : 0,
              expectedDateCount: status.lastMetricDate ? 1 : 0,
              lastCoveredDate: status.lastMetricDate || null,
              missingDateCount: 0,
            });
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
  }, [dateRange, refreshKey, siteUrl]);

  const lastMetricDate = coverage?.lastCoveredDate || null;
  const isPartial = Boolean(coverage && coverage.expectedDateCount > 0 && coverage.coveredDateCount < coverage.expectedDateCount);
  const label = loading
    ? "Checking coverage"
    : lastMetricDate
      ? isPartial
        ? `Partial: ${coverage?.coveredDateCount}/${coverage?.expectedDateCount} days through ${format(parseISO(lastMetricDate), "MMM d")}`
        : `Analyzed through ${format(parseISO(lastMetricDate), "MMM d")}`
      : "Preparing data";

  return (
    <div className="flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium text-muted-foreground shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
      {lastMetricDate ? (
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
