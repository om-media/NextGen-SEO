import { DatePicker } from "@/components/ui/date-picker";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { WarehouseSync } from "@/components/dashboard/WarehouseSync";
import type { DateRange } from "react-day-picker";

type DataSource = "gsc" | "bing" | "ga4";

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
  onToDateChange: (date: Date | undefined) => void;
  setIsCompareMode: (value: boolean) => void;
  setUseLiveData: (value: boolean) => void;
  useLiveData: boolean;
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
  onToDateChange,
  setIsCompareMode,
  setUseLiveData,
  useLiveData,
}: AppToolbarProps) {
  const sectionCopy = getSectionCopy(activeMenu, dataSource);
  const showDataControls = activeMenu !== "Settings" && activeMenu !== "AI Content Auditor";

  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#E6ECE8] bg-white px-5 py-4 shadow-[0_12px_36px_rgba(15,61,46,0.04)] sm:px-6">
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[52%] overflow-hidden opacity-55 [mask-image:linear-gradient(to_right,transparent_0%,black_28%,black_100%)] lg:block">
        <img
          src="/images/hero-mountains.png"
          alt=""
          className="absolute bottom-[-14px] right-[-22px] h-[122%] w-[122%] object-contain object-right-bottom"
        />
      </div>
      <div className="relative flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
      <div className="max-w-[460px] shrink-0">
        <p className="text-sm font-medium text-[#0F172A]">Good afternoon, {firstName || "there"}!</p>
        <h2 className="mt-2 max-w-md text-[30px] font-semibold leading-[1.08] tracking-[-0.02em] text-[#0F172A] text-balance sm:text-[32px]">
          {sectionCopy.title}
        </h2>
        <p className="mt-2 max-w-[58ch] text-sm leading-[1.55] text-[#647067] text-pretty">
          {sectionCopy.description}
        </p>
      </div>
      {showDataControls ? (
      <div className="flex w-full flex-col items-start gap-2 xl:min-w-[760px] xl:items-end">
        <div className="flex w-full flex-wrap items-center gap-2 xl:justify-end">
          {dataSource === "gsc" && (
            <>
              <div className="[&>button]:h-9 [&>button]:rounded-xl [&>button]:border-[#E6ECE8] [&>button]:shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
                <WarehouseSync siteUrl={currentSiteUrl} />
              </div>
              <div className="flex h-9 items-center gap-2 rounded-xl border border-[#E6ECE8] bg-white px-3 shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
                <Switch id="warehouse-mode" checked={useLiveData} onCheckedChange={setUseLiveData} />
                <Label htmlFor="warehouse-mode" className="text-sm font-medium cursor-pointer whitespace-nowrap">
                  Live Data
                </Label>
              </div>
            </>
          )}
          <div className="flex h-9 items-center gap-2 rounded-xl border border-[#E6ECE8] bg-white px-3 shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
            <Switch id="compare-mode" checked={isCompareMode} onCheckedChange={setIsCompareMode} />
            <Label htmlFor="compare-mode" className="text-sm font-medium cursor-pointer">
              Compare
            </Label>
          </div>
          <div className="[&>button]:h-9 [&>button]:rounded-xl [&>button]:border-[#E6ECE8] [&>button]:bg-white [&>button]:shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
            <DatePicker date={dateRange.from} setDate={onFromDateChange} label="From" />
          </div>
          <span className="text-muted-foreground text-sm font-medium px-1">to</span>
          <div className="[&>button]:h-9 [&>button]:rounded-xl [&>button]:border-[#E6ECE8] [&>button]:bg-white [&>button]:shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
            <DatePicker date={dateRange.to} setDate={onToDateChange} label="To" />
          </div>
        </div>
        {isCompareMode && (
          <div className="flex flex-wrap items-center gap-1 self-start rounded-xl border border-dashed border-[#E6ECE8] bg-white/70 p-1 shadow-[0_8px_20px_rgba(15,61,46,0.04)] xl:self-end sm:gap-2">
            <span className="text-muted-foreground text-sm font-medium px-1 sm:px-2">vs</span>
            <DatePicker date={compareDateRange.from} setDate={onCompareFromDateChange} label="Compare From" />
            <span className="text-muted-foreground text-sm font-medium px-1 sm:px-2">to</span>
            <DatePicker date={compareDateRange.to} setDate={onCompareToDateChange} label="Compare To" />
          </div>
        )}
      </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          <span className="rounded-full border border-[#DDEAE2] bg-[#EAF4EC] px-3 py-1.5 text-xs font-semibold text-[#0F3D2E]">
            Workspace controls live here
          </span>
          <span className="rounded-full border border-[#E6ECE8] bg-white px-3 py-1.5 text-xs font-medium text-[#647067] shadow-[0_8px_20px_rgba(15,61,46,0.04)]">
            No date range needed
          </span>
        </div>
      )}
      </div>
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
      description: "Track visits from ChatGPT, Perplexity, Gemini, Copilot, and other emerging answer engines.",
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

  return {
    title: "Your SEO performance at a glance",
    description: "Track performance, compare ranges, and discover opportunities without losing your working context.",
  };
}
