import { useEffect, useMemo, useState, type ReactNode } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { ArrowDown, ArrowUp, BarChart3, Download, Eye, Filter, FileText, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  fetchBlendedPagePerformance,
  type BlendedPagePerformanceResponse,
  type BlendedPagePerformanceRow,
} from "@/src/services/blendedService";

type BlendedPagesViewProps = {
  compareDateRange?: DateRange;
  dateRange?: DateRange;
  ga4PropertyId?: string | null;
  isCompareMode?: boolean;
  siteUrl: string;
};

type SortColumn =
  | "page"
  | "clicks"
  | "impressions"
  | "ctr"
  | "queryCount"
  | "sessions"
  | "pageViews"
  | "bounceRate";

type SortDirection = "asc" | "desc";

const PAGE_SIZE = 100;

const formatCompact = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" }).format(value);

const formatNumber = (value: number) => new Intl.NumberFormat("en-US").format(Math.round(value));

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

const toFiniteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

function getDateStrings(dateRange?: DateRange) {
  if (!dateRange?.from || !dateRange.to) return null;
  return {
    endDate: format(dateRange.to, "yyyy-MM-dd"),
    startDate: format(dateRange.from, "yyyy-MM-dd"),
  };
}

function getPageTitle(page: string) {
  try {
    const url = new URL(page);
    const path = url.pathname === "/" ? "Home" : url.pathname.split("/").filter(Boolean).pop() || "Page";
    return path
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    const normalized = page.replace(/^https?:\/\//, "").replace(/^www\./, "");
    const path = normalized.split("/").filter(Boolean).pop() || normalized || "Page";
    return path
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}

function getDisplayPath(page: string) {
  try {
    const url = new URL(page);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return page.replace(/^https?:\/\//, "");
  }
}

function getFolderKey(pageKey: string) {
  if (!pageKey || pageKey === "/") return "/";
  const parts = pageKey.split("/").filter(Boolean);
  return parts.length > 1 ? `/${parts[0]}/` : "/";
}

function getSortValue(row: BlendedPagePerformanceRow, column: SortColumn) {
  if (column === "page") return row.page.toLowerCase();
  if (column === "clicks") return row.gsc?.clicks ?? 0;
  if (column === "impressions") return row.gsc?.impressions ?? 0;
  if (column === "ctr") return row.gsc?.ctr ?? 0;
  if (column === "queryCount") return row.gsc?.queryCount ?? 0;
  if (column === "sessions") return row.ga4?.sessions ?? 0;
  if (column === "pageViews") return row.ga4?.pageViews ?? 0;
  return row.ga4?.bounceRate ?? 0;
}

function getChange(current: number, previous: number) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

function downloadCsv(rows: BlendedPagePerformanceRow[]) {
  const headers = [
    "Page",
    "Crawl Status",
    "Crawl Title",
    "Crawl Meta Description",
    "SEO Issue",
    "Recommended Action",
    "Issue Reasons",
    "GSC Clicks",
    "GSC Impressions",
    "GSC CTR",
    "Visible Queries",
    "GA4 Sessions",
    "GA4 Page Views",
    "GA4 Bounce Rate",
    "Opportunity / Status",
  ];

  const escape = (value: string | number) => {
    const normalized = String(value);
    return /[",\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
  };

  const body = rows.map((row) => [
    row.page,
    getCrawlStatus(row).label,
    row.crawl?.title || "",
    row.crawl?.metaDescription || "",
    row.issueInsight.label,
    row.issueInsight.action,
    row.issueInsight.reasons.join(" | "),
    row.gsc?.clicks ?? 0,
    row.gsc?.impressions ?? 0,
    row.gsc ? `${(row.gsc.ctr * 100).toFixed(2)}%` : "",
    row.gsc?.queryCount ?? 0,
    row.ga4?.sessions ?? "",
    row.ga4?.pageViews ?? "",
    row.ga4 ? `${(row.ga4.bounceRate * 100).toFixed(2)}%` : "",
    getOpportunityStatus(row).label,
  ]);

  const csv = [headers, ...body].map((line) => line.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nextgen-seo-blended-pages-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

function getOpportunityStatus(row: BlendedPagePerformanceRow) {
  const impressions = row.gsc?.impressions ?? 0;
  const clicks = row.gsc?.clicks ?? 0;
  const ctr = row.gsc?.ctr ?? 0;
  const sessions = row.ga4?.sessions ?? 0;
  const bounceRate = row.ga4?.bounceRate ?? 0;

  if (!row.ga4) {
    return {
      className: "bg-[#F8FAF9] text-[#647067]",
      label: "GA4 not matched",
    };
  }

  if (impressions >= 500 && ctr < 0.02) {
    return {
      className: "bg-[#FFF2E8] text-[#C2410C]",
      label: "CTR opportunity",
    };
  }

  if (clicks >= 20 && sessions >= 20 && bounceRate >= 0.7) {
    return {
      className: "bg-[#FEF2F2] text-[#B91C1C]",
      label: "Engagement risk",
    };
  }

  if (sessions >= 25 && impressions < 250) {
    return {
      className: "bg-[#F4ECFF] text-[#6D28D9]",
      label: "Visibility gap",
    };
  }

  return {
    className: "bg-[#EAF4EC] text-[#0F3D2E]",
    label: "Stable",
  };
}

function getCrawlStatus(row: BlendedPagePerformanceRow) {
  if (!row.crawl) {
    return {
      className: "bg-[#F8FAF9] text-[#647067]",
      label: "Not crawled",
    };
  }

  if (row.crawl.errorMessage || (row.crawl.statusCode && row.crawl.statusCode >= 400)) {
    return {
      className: "bg-[#FEF2F2] text-[#B91C1C]",
      label: "Crawl issue",
    };
  }

  if (row.crawl.noindex) {
    return {
      className: "bg-[#F4ECFF] text-[#6D28D9]",
      label: "Noindex",
    };
  }

  if (!row.crawl.title || !row.crawl.metaDescription) {
    return {
      className: "bg-[#FFF2E8] text-[#C2410C]",
      label: "Metadata gap",
    };
  }

  return {
    className: "bg-[#EAF4EC] text-[#0F3D2E]",
    label: row.crawl.statusCode && row.crawl.statusCode >= 300 ? "Redirect" : row.crawl.statusCode ? `${row.crawl.statusCode} OK` : "Crawled",
  };
}

function getSeverityClass(severity: BlendedPagePerformanceRow["issueInsight"]["severity"]) {
  if (severity === "high") return "bg-[#FEF2F2] text-[#B91C1C]";
  if (severity === "medium") return "bg-[#FFF2E8] text-[#C2410C]";
  if (severity === "low") return "bg-[#F8FAF9] text-[#647067]";
  return "bg-[#EAF4EC] text-[#0F3D2E]";
}

function MetricCard({
  accentClass,
  icon,
  label,
  sublabel,
  value,
}: {
  accentClass: string;
  icon: ReactNode;
  label: string;
  sublabel: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-[#E6ECE8] bg-white p-5 shadow-[0_10px_28px_rgba(15,61,46,0.045)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[#34483E]">{label}</p>
          <p className="mt-4 text-3xl font-semibold tracking-[-0.03em] text-[#0F172A]">{value}</p>
        </div>
        <div className={`flex h-11 w-11 items-center justify-center rounded-full ${accentClass}`}>{icon}</div>
      </div>
      <p className="mt-3 text-xs text-[#647067]">{sublabel}</p>
    </div>
  );
}

function ChangeBadge({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) {
    return <span className="text-xs text-[#647067]">No compare</span>;
  }

  const isGood = invert ? value <= 0 : value >= 0;
  const Icon = value >= 0 ? ArrowUp : ArrowDown;

  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${isGood ? "text-[#15803D]" : "text-[#DC2626]"}`}>
      <Icon className="h-3 w-3" />
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

export function BlendedPagesView({
  compareDateRange,
  dateRange,
  ga4PropertyId,
  isCompareMode = false,
  siteUrl,
}: BlendedPagesViewProps) {
  const [compareRows, setCompareRows] = useState<BlendedPagePerformanceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<BlendedPagePerformanceResponse["page"] | null>(null);
  const [rows, setRows] = useState<BlendedPagePerformanceRow[]>([]);
  const [issueFilter, setIssueFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCrawlRow, setSelectedCrawlRow] = useState<BlendedPagePerformanceRow | null>(null);
  const [sourceMeta, setSourceMeta] = useState<BlendedPagePerformanceResponse["meta"] | null>(null);
  const [sortColumn, setSortColumn] = useState<SortColumn>("clicks");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [trafficFilter, setTrafficFilter] = useState("all");

  const dateStrings = getDateStrings(dateRange);
  const compareDateStrings = getDateStrings(compareDateRange);

  useEffect(() => {
    if (!siteUrl || !dateStrings) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    const primaryPromise = fetchBlendedPagePerformance({
      endDate: dateStrings.endDate,
      ga4PropertyId,
      issueFilter,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      search: searchTerm,
      siteUrl,
      sortColumn,
      sortDirection,
      startDate: dateStrings.startDate,
      trafficFilter,
    });

    const comparePromise =
      isCompareMode && compareDateStrings
        ? fetchBlendedPagePerformance({
            endDate: compareDateStrings.endDate,
            ga4PropertyId,
            issueFilter,
            limit: PAGE_SIZE,
            offset: (page - 1) * PAGE_SIZE,
            search: searchTerm,
            siteUrl,
            sortColumn,
            sortDirection,
            startDate: compareDateStrings.startDate,
            trafficFilter,
          }).catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] });

    Promise.all([primaryPromise, comparePromise])
      .then(([primary, compare]) => {
        if (!isMounted) return;
        setRows(primary.rows || []);
        setCompareRows(compare.rows || []);
        setPageInfo(primary.page || null);
        setSourceMeta(primary.meta);
      })
      .catch((err: Error) => {
        if (!isMounted) return;
        setError(err.message || "Failed to fetch blended page data");
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [
    compareDateStrings?.endDate,
    compareDateStrings?.startDate,
    dateStrings?.endDate,
    dateStrings?.startDate,
    ga4PropertyId,
    issueFilter,
    isCompareMode,
    page,
    searchTerm,
    siteUrl,
    sortColumn,
    sortDirection,
    trafficFilter,
  ]);

  const compareByPageKey = useMemo(() => new Map(compareRows.map((row) => [row.pageKey, row])), [compareRows]);

  const filteredTotal = pageInfo?.filteredTotal ?? rows.length;
  const totalRows = pageInfo?.total ?? rows.length;
  const pageCount = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));
  const paginatedRows = rows;
  const hasGa4Rows = (sourceMeta?.totals.ga4Pages ?? rows.filter((row) => row.ga4).length) > 0;

  const totals = useMemo(() => {
    if (sourceMeta?.totals) {
      return {
        bounceRate: sourceMeta.totals.bounceRate,
        clicks: sourceMeta.totals.clicks,
        ctr: sourceMeta.totals.ctr,
        events: sourceMeta.totals.eventCount,
        impressions: sourceMeta.totals.impressions,
        pageViews: sourceMeta.totals.pageViews,
        position: sourceMeta.totals.position,
        queryCount: sourceMeta.totals.queryCount,
        sessions: sourceMeta.totals.sessions,
        users: sourceMeta.totals.totalUsers,
        weightedBounce: 0,
        weightedPosition: 0,
      };
    }

    const aggregate = rows.reduce(
      (acc, row) => {
        acc.clicks += row.gsc?.clicks ?? 0;
        acc.impressions += row.gsc?.impressions ?? 0;
        acc.queryCount += row.gsc?.queryCount ?? 0;
        acc.weightedPosition += (row.gsc?.position ?? 0) * (row.gsc?.impressions ?? 0);
        acc.sessions += row.ga4?.sessions ?? 0;
        acc.users += row.ga4?.totalUsers ?? 0;
        acc.pageViews += row.ga4?.pageViews ?? 0;
        acc.events += row.ga4?.eventCount ?? 0;
        acc.weightedBounce += (row.ga4?.bounceRate ?? 0) * (row.ga4?.sessions ?? 0);
        return acc;
      },
      {
        clicks: 0,
        events: 0,
        impressions: 0,
        pageViews: 0,
        queryCount: 0,
        sessions: 0,
        users: 0,
        weightedBounce: 0,
        weightedPosition: 0,
      },
    );

    return {
      ...aggregate,
      bounceRate: aggregate.sessions ? aggregate.weightedBounce / aggregate.sessions : 0,
      ctr: aggregate.impressions ? aggregate.clicks / aggregate.impressions : 0,
      position: aggregate.impressions ? aggregate.weightedPosition / aggregate.impressions : 0,
    };
  }, [rows, sourceMeta?.totals]);

  const compareTotals = useMemo(() => {
    return compareRows.reduce(
      (acc, row) => {
        acc.clicks += row.gsc?.clicks ?? 0;
        acc.sessions += row.ga4?.sessions ?? 0;
        return acc;
      },
      { clicks: 0, sessions: 0 },
    );
  }, [compareRows]);

  const folderRows = useMemo(() => {
    if (sourceMeta?.topFolders) return sourceMeta.topFolders;

    const folders = new Map<string, { clicks: number; pages: number; sessions: number }>();
    rows.forEach((row) => {
      const key = getFolderKey(row.pageKey);
      const current = folders.get(key) || { clicks: 0, pages: 0, sessions: 0 };
      current.clicks += row.gsc?.clicks ?? 0;
      current.sessions += row.ga4?.sessions ?? 0;
      current.pages += 1;
      folders.set(key, current);
    });
    return Array.from(folders.entries())
      .map(([folder, value]) => ({ folder, ...value }))
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 6);
  }, [rows, sourceMeta?.topFolders]);

  const opportunities = useMemo(() => {
    if (sourceMeta?.topOpportunities) return sourceMeta.topOpportunities;

    return rows
      .filter((row) => (row.gsc?.impressions ?? 0) >= 100 && (row.gsc?.ctr ?? 0) < 0.02)
      .sort((a, b) => (b.gsc?.impressions ?? 0) - (a.gsc?.impressions ?? 0))
      .slice(0, 4);
  }, [rows, sourceMeta?.topOpportunities]);

  const technicalRisks = useMemo(() => {
    if (sourceMeta?.topTechnicalRisks) return sourceMeta.topTechnicalRisks;

    return rows
      .filter((row) => !row.crawl || row.crawl.errorMessage || (row.crawl.statusCode && row.crawl.statusCode >= 400) || row.crawl.noindex || !row.crawl.title || !row.crawl.metaDescription)
      .slice(0, 4);
  }, [rows, sourceMeta?.topTechnicalRisks]);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      setPage(1);
      return;
    }
    setSortColumn(column);
    setSortDirection(column === "bounceRate" ? "asc" : "desc");
    setPage(1);
  };

  const sortIndicator = (column: SortColumn) => {
    if (sortColumn !== column) return <span className="text-[#A8B3AC]">↕</span>;
    return sortDirection === "asc" ? "↑" : "↓";
  };

  const handleExportCsv = async () => {
    if (!dateStrings) return;

    const batchSize = 5000;
    const allRows: BlendedPagePerformanceRow[] = [];
    let offset = 0;
    let total = filteredTotal;

    while (offset < total || offset === 0) {
      const response = await fetchBlendedPagePerformance({
        endDate: dateStrings.endDate,
        ga4PropertyId,
        issueFilter,
        limit: batchSize,
        offset,
        search: searchTerm,
        siteUrl,
        sortColumn,
        sortDirection,
        startDate: dateStrings.startDate,
        trafficFilter,
      });
      allRows.push(...(response.rows || []));
      total = response.page?.filteredTotal ?? allRows.length;
      offset += batchSize;
      if (!response.rows?.length) break;
    }

    downloadCsv(allRows);
  };

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-600">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-5">
        <MetricCard
          accentClass="bg-[#EAF4EC] text-[#0F3D2E]"
          icon={<FileText className="h-5 w-5" />}
          label="Top pages"
          sublabel={`${formatNumber(sourceMeta?.totals.gscPages ?? rows.filter((row) => (row.gsc?.clicks ?? 0) > 0).length)} pages with GSC data`}
          value={formatNumber(totalRows)}
        />
        <MetricCard
          accentClass="bg-[#EAF2FF] text-[#2F7DF6]"
          icon={<ArrowUp className="h-5 w-5" />}
          label="GSC clicks"
          sublabel={isCompareMode ? `${getChange(totals.clicks, compareTotals.clicks)?.toFixed(1) ?? "0.0"}% vs compare` : "Current period"}
          value={formatCompact(totals.clicks)}
        />
        <MetricCard
          accentClass="bg-[#ECFEFF] text-[#0891B2]"
          icon={<BarChart3 className="h-5 w-5" />}
          label="GA4 sessions"
          sublabel={hasGa4Rows ? "Matched by page path" : "Run Sync Data to populate"}
          value={hasGa4Rows ? formatCompact(totals.sessions) : "Not synced"}
        />
        <MetricCard
          accentClass="bg-[#FFF2E8] text-[#F97316]"
          icon={<ArrowDown className="h-5 w-5" />}
          label="Bounce rate"
          sublabel={hasGa4Rows ? "Weighted by sessions" : "Waiting for GA4 warehouse"}
          value={hasGa4Rows ? formatPercent(totals.bounceRate) : "-"}
        />
        <MetricCard
          accentClass="bg-[#F4ECFF] text-[#7C3AED]"
          icon={<Sparkles className="h-5 w-5" />}
          label="Visible queries"
          sublabel="Summed across listed pages"
          value={formatCompact(totals.queryCount)}
        />
      </div>

      {!hasGa4Rows && ga4PropertyId && (
        <div className="rounded-2xl border border-[#D9E5DE] bg-[#F4FAF6] p-4 text-sm text-[#34483E]">
          GA4 is connected, but page-level GA4 data has not been warehoused for this range yet. Click <strong>Sync Data</strong> to pull GA4 landing-page metrics into the local warehouse.
        </div>
      )}

      {!ga4PropertyId && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-800">
          This blended view is currently GSC-only because no default GA4 property is assigned to the workspace. Choose a GA4 property in Settings to add sessions, page views, and bounce rate.
        </div>
      )}

      {sourceMeta && (
        <div className="flex flex-wrap gap-2 text-xs text-[#647067]">
          <span className="rounded-full border border-[#E6ECE8] bg-white px-3 py-1.5">
            GSC synced through {sourceMeta.freshness.gsc.latestDate || "not synced"} - {formatNumber(sourceMeta.freshness.gsc.rowCount)} rows
          </span>
          <span className="rounded-full border border-[#E6ECE8] bg-white px-3 py-1.5">
            GA4 synced through {sourceMeta.freshness.ga4.latestDate || "not synced"} - {formatNumber(sourceMeta.freshness.ga4.rowCount)} rows
          </span>
          <span className="rounded-full border border-[#E6ECE8] bg-white px-3 py-1.5">
            Crawl matched {formatNumber(sourceMeta.totals.crawlMatchedPages)} pages - {formatNumber(sourceMeta.totals.crawlIssuePages + sourceMeta.totals.metadataGapPages)} issues
          </span>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <section className="rounded-2xl border border-[#E6ECE8] bg-white shadow-[0_16px_42px_rgba(15,61,46,0.055)]">
          <div className="flex flex-col gap-4 border-b border-[#E6ECE8] p-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#0F172A]">Top Pages ({filteredTotal})</h3>
              <p className="mt-1 text-sm text-[#647067]">
                Blends Search Console visibility with GA4 engagement for matching page paths.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9 rounded-xl border-[#D8C8FF] bg-[#F7F3FF] text-[#6D28D9]"
                disabled
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Analyze with AI
              </Button>
              <Button variant="outline" size="sm" className="h-9 rounded-xl border-[#E6ECE8] bg-white" onClick={handleExportCsv}>
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </Button>
            </div>
          </div>

          <div className="space-y-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-3 h-4 w-4 text-[#8A968F]" />
                <Input
                  className="h-11 rounded-xl border-[#E6ECE8] bg-white pl-10"
                  onChange={(event) => {
                    setSearchTerm(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Filter pages..."
                  value={searchTerm}
                />
              </div>
              <Select value={trafficFilter} onValueChange={(value) => { setTrafficFilter(value); setPage(1); }}>
                <SelectTrigger className="h-11 w-full rounded-xl border-[#E6ECE8] bg-white lg:w-[180px]">
                  <SelectValue placeholder="Traffic source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All pages</SelectItem>
                  <SelectItem value="with-ga4">With GA4 data</SelectItem>
                  <SelectItem value="without-ga4">Missing GA4 data</SelectItem>
                </SelectContent>
              </Select>
              <Select value={issueFilter} onValueChange={(value) => { setIssueFilter(value); setPage(1); }}>
                <SelectTrigger className="h-11 w-full rounded-xl border-[#E6ECE8] bg-white lg:w-[220px]">
                  <SelectValue placeholder="SEO issue" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All SEO states</SelectItem>
                  <SelectItem value="crawl-issues">Crawl errors</SelectItem>
                  <SelectItem value="metadata-gaps">Missing metadata</SelectItem>
                  <SelectItem value="indexability">Indexability issues</SelectItem>
                  <SelectItem value="not-crawled">Not in latest crawl</SelectItem>
                  <SelectItem value="low-ctr">Low CTR opportunities</SelectItem>
                  <SelectItem value="missing-ga4">Missing GA4 data</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="secondary" className="h-11 rounded-xl bg-[#EEF3F0] text-[#0F172A]" disabled>
                <Filter className="mr-2 h-4 w-4" />
                Filters
              </Button>
            </div>

            <div className="overflow-hidden rounded-2xl border border-[#E6ECE8]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1600px] text-sm">
                  <thead className="bg-[#FBFCFB] text-xs font-semibold text-[#34483E]">
                    <tr>
                      <th className="sticky left-0 z-20 w-[360px] min-w-[360px] border-r border-[#E6ECE8] bg-[#FBFCFB] px-4 py-3 text-left">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("page")}>
                          Page {sortIndicator("page")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-left">Crawl</th>
                      <th className="px-4 py-3 text-left">Next action</th>
                      <th className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("clicks")}>
                          GSC Clicks {sortIndicator("clicks")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("impressions")}>
                          GSC Impressions {sortIndicator("impressions")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("ctr")}>
                          GSC CTR {sortIndicator("ctr")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("queryCount")}>
                          Visible Queries {sortIndicator("queryCount")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("sessions")}>
                          GA4 Sessions {sortIndicator("sessions")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("pageViews")}>
                          GA4 Page Views {sortIndicator("pageViews")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("bounceRate")}>
                          GA4 Bounce Rate {sortIndicator("bounceRate")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">Opportunity / Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={11} className="px-4 py-16 text-center text-[#647067]">
                          Loading blended page data...
                        </td>
                      </tr>
                    ) : paginatedRows.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="px-4 py-16 text-center text-[#647067]">
                          No page rows match this view.
                        </td>
                      </tr>
                    ) : (
                      paginatedRows.map((row) => {
                        const compareRow = compareByPageKey.get(row.pageKey);
                        const clickChange = getChange(row.gsc?.clicks ?? 0, compareRow?.gsc?.clicks ?? 0);
                        const sessionChange = getChange(row.ga4?.sessions ?? 0, compareRow?.ga4?.sessions ?? 0);
                        const crawlStatus = getCrawlStatus(row);
                        const opportunityStatus = getOpportunityStatus(row);

                        return (
                          <tr key={row.pageKey || row.page} className="group border-t border-[#E6ECE8] hover:bg-[#F8FAF9]">
                            <td className="sticky left-0 z-10 border-r border-[#E6ECE8] bg-white px-4 py-4 group-hover:bg-[#F8FAF9]">
                              <div className="w-[328px]">
                                <div className="truncate font-semibold text-[#24443A]">{getPageTitle(row.page)}</div>
                                <div className="mt-1 truncate text-xs text-[#647067]">{getDisplayPath(row.page)}</div>
                              </div>
                            </td>
                            <td className="px-4 py-4">
                              <button
                                className="inline-flex items-center gap-2 rounded-full border border-[#E6ECE8] bg-white px-2.5 py-1 text-xs font-semibold text-[#24443A] hover:bg-[#F8FAF9] disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={!row.crawl}
                                onClick={() => row.crawl && setSelectedCrawlRow(row)}
                              >
                                <Eye className="h-3.5 w-3.5" />
                                <span className={`rounded-full px-2 py-0.5 ${crawlStatus.className}`}>{crawlStatus.label}</span>
                              </button>
                            </td>
                            <td className="px-4 py-4">
                              <button
                                className="max-w-[260px] text-left"
                                onClick={() => row.crawl && setSelectedCrawlRow(row)}
                              >
                                <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getSeverityClass(row.issueInsight.severity)}`}>
                                  {row.issueInsight.label}
                                </span>
                                <div className="mt-1 truncate text-xs text-[#647067]" title={row.issueInsight.action}>
                                  {row.issueInsight.action}
                                </div>
                              </button>
                            </td>
                            <td className="px-4 py-4 text-right">
                              <div className="font-medium text-[#0F172A]">{formatNumber(row.gsc?.clicks ?? 0)}</div>
                              {isCompareMode && <ChangeBadge value={clickChange} />}
                            </td>
                            <td className="px-4 py-4 text-right">{formatNumber(row.gsc?.impressions ?? 0)}</td>
                            <td className="px-4 py-4 text-right">{row.gsc ? formatPercent(row.gsc.ctr) : "-"}</td>
                            <td className="px-4 py-4 text-right font-semibold text-[#6B5CFF]">{formatNumber(row.gsc?.queryCount ?? 0)}</td>
                            <td className="px-4 py-4 text-right">
                              <div>{row.ga4 ? formatNumber(row.ga4.sessions) : "-"}</div>
                              {isCompareMode && row.ga4 && <ChangeBadge value={sessionChange} />}
                            </td>
                            <td className="px-4 py-4 text-right">{row.ga4 ? formatNumber(row.ga4.pageViews) : "-"}</td>
                            <td className="px-4 py-4 text-right">{row.ga4 ? formatPercent(row.ga4.bounceRate) : "-"}</td>
                            <td className="px-4 py-4 text-right">
                              <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${opportunityStatus.className}`}>
                                {opportunityStatus.label}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-col gap-3 text-sm text-[#647067] sm:flex-row sm:items-center sm:justify-between">
              <span>
                Showing {filteredTotal === 0 ? 0 : (page - 1) * PAGE_SIZE + 1} to {Math.min(page * PAGE_SIZE, filteredTotal)} of {filteredTotal} pages
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="rounded-xl" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                  Previous
                </Button>
                <span className="text-[#0F172A]">Page {page} of {pageCount}</span>
                <Button variant="outline" size="sm" className="rounded-xl" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>
                  Next
                </Button>
              </div>
            </div>
          </div>
        </section>

        <aside className="space-y-5">
          <section className="rounded-2xl border border-[#E6ECE8] bg-white p-5 shadow-[0_16px_42px_rgba(15,61,46,0.055)]">
            <h3 className="text-lg font-semibold tracking-[-0.02em] text-[#0F172A]">Performance by Folder</h3>
            <p className="mt-1 text-sm text-[#647067]">Grouped from real page paths.</p>
            <div className="mt-5 space-y-3">
              {folderRows.map((folder) => (
                <div key={folder.folder} className="flex items-center justify-between gap-3 rounded-xl border border-[#E6ECE8] p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[#0F172A]">{folder.folder}</div>
                    <div className="text-xs text-[#647067]">{formatNumber(folder.pages)} pages</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-[#0F172A]">{formatCompact(folder.clicks)}</div>
                    <div className="text-xs text-[#647067]">{hasGa4Rows ? `${formatCompact(folder.sessions)} sessions` : "GSC only"}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-[#E6ECE8] bg-white p-5 shadow-[0_16px_42px_rgba(15,61,46,0.055)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold tracking-[-0.02em] text-[#0F172A]">Technical Risks</h3>
                <p className="mt-1 text-sm text-[#647067]">Prioritized from crawl plus search demand.</p>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {technicalRisks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#E6ECE8] p-4 text-sm text-[#647067]">
                  No crawl-linked technical risks in this view.
                </div>
              ) : (
                technicalRisks.map((row) => {
                  const crawlStatus = getCrawlStatus(row);
                  return (
                    <button
                      key={row.pageKey}
                      className="w-full rounded-xl border border-[#E6ECE8] p-4 text-left hover:bg-[#F8FAF9] disabled:cursor-not-allowed disabled:opacity-70"
                      disabled={!row.crawl}
                      onClick={() => row.crawl && setSelectedCrawlRow(row)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-[#0F172A]">{getPageTitle(row.page)}</div>
                          <p className="mt-1 text-xs leading-5 text-[#647067]">
                            {formatCompact(row.gsc?.impressions ?? 0)} impressions, {row.ga4 ? `${formatCompact(row.ga4.sessions)} sessions` : "GA4 not matched"}.
                          </p>
                          <p className="mt-2 text-xs font-medium leading-5 text-[#24443A]">{row.issueInsight.action}</p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${getSeverityClass(row.issueInsight.severity)}`}>
                          {row.issueInsight.label || crawlStatus.label}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-[#E6ECE8] bg-white p-5 shadow-[0_16px_42px_rgba(15,61,46,0.055)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold tracking-[-0.02em] text-[#0F172A]">Top Opportunities</h3>
                <p className="mt-1 text-sm text-[#647067]">High impressions, low CTR pages.</p>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {opportunities.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#E6ECE8] p-4 text-sm text-[#647067]">
                  No low-CTR opportunities in this filtered range.
                </div>
              ) : (
                opportunities.map((row) => (
                  <div key={row.pageKey} className="rounded-xl border border-[#E6ECE8] p-4">
                    <div className="font-semibold text-[#0F172A]">{getPageTitle(row.page)}</div>
                    <p className="mt-1 text-xs leading-5 text-[#647067]">
                      {formatCompact(row.gsc?.impressions ?? 0)} impressions at {formatPercent(row.gsc?.ctr ?? 0)} CTR.
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>

      <Dialog open={Boolean(selectedCrawlRow)} onOpenChange={(open) => !open && setSelectedCrawlRow(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Crawl source review</DialogTitle>
            <DialogDescription className="break-all">
              {selectedCrawlRow?.crawl?.url || selectedCrawlRow?.page || "Review crawl signals for this blended page."}
            </DialogDescription>
          </DialogHeader>

          {selectedCrawlRow?.crawl && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-[#E6ECE8] bg-white p-4 md:col-span-2">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#647067]">Review decision</div>
                    <div className="mt-2 text-lg font-semibold text-[#0F172A]">{selectedCrawlRow.issueInsight.label}</div>
                    <p className="mt-1 text-sm leading-6 text-[#34483E]">{selectedCrawlRow.issueInsight.action}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${getSeverityClass(selectedCrawlRow.issueInsight.severity)}`}>
                    {selectedCrawlRow.issueInsight.severity}
                  </span>
                </div>
                <ul className="mt-3 space-y-1 text-sm text-[#647067]">
                  {selectedCrawlRow.issueInsight.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>

              <div className="rounded-2xl border border-[#E6ECE8] bg-white p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#647067]">Technical status</div>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">Status</dt><dd className="text-right font-medium">{selectedCrawlRow.crawl.statusCode || "No response"}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">Noindex</dt><dd className="text-right font-medium">{selectedCrawlRow.crawl.noindex ? "Yes" : "No"}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">Canonical</dt><dd className="min-w-0 break-words text-right font-medium">{selectedCrawlRow.crawl.canonicalUrl || "Not set"}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">Final URL</dt><dd className="min-w-0 break-words text-right font-medium">{selectedCrawlRow.crawl.finalUrl || "Same as requested"}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">Error</dt><dd className="min-w-0 break-words text-right font-medium">{selectedCrawlRow.crawl.errorMessage || "None"}</dd></div>
                </dl>
              </div>

              <div className="rounded-2xl border border-[#E6ECE8] bg-white p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#647067]">On-page signals</div>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">Title</dt><dd className="min-w-0 break-words text-right font-medium">{selectedCrawlRow.crawl.title || "Missing"}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">Meta description</dt><dd className="min-w-0 break-words text-right font-medium">{selectedCrawlRow.crawl.metaDescription || "Missing"}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">H1</dt><dd className="min-w-0 break-words text-right font-medium">{selectedCrawlRow.crawl.h1Text || "Missing"}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">H1 count</dt><dd className="text-right font-medium">{formatNumber(selectedCrawlRow.crawl.h1Count)}</dd></div>
                </dl>
              </div>

              <div className="rounded-2xl border border-[#E6ECE8] bg-white p-4 md:col-span-2">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#647067]">Blended evidence</div>
                <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">GSC clicks</dt><dd className="font-medium">{formatNumber(selectedCrawlRow.gsc?.clicks ?? 0)}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">GSC impressions</dt><dd className="font-medium">{formatNumber(selectedCrawlRow.gsc?.impressions ?? 0)}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">GA4 sessions</dt><dd className="font-medium">{selectedCrawlRow.ga4 ? formatNumber(selectedCrawlRow.ga4.sessions) : "Not matched"}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-[#647067]">Links</dt><dd className="font-medium">{formatNumber(selectedCrawlRow.crawl.inboundLinkCount)} in / {formatNumber(selectedCrawlRow.crawl.outgoingLinkCount)} out</dd></div>
                </dl>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
