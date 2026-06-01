import { useEffect, useMemo, useState, type ReactNode } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { AlertTriangle, ArrowDown, ArrowUp, BarChart3, Download, ExternalLink, Filter, FileText, Search, Sparkles } from "lucide-react";
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
  | "bounceRate"
  | "crawlStatus"
  | "depth"
  | "inlinks"
  | "wordCount";

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
  if (column === "crawlStatus") return getCrawlStatus(row).label.toLowerCase();
  if (column === "depth") return row.crawl?.depth ?? 0;
  if (column === "inlinks") return row.crawl?.inboundLinkCount ?? 0;
  if (column === "wordCount") return row.crawl?.wordCount ?? 0;
  return row.ga4?.bounceRate ?? 0;
}

function getChange(current: number, previous: number) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

function downloadCsv(rows: BlendedPagePerformanceRow[]) {
  const headers = [
    "Page",
    "GSC Clicks",
    "GSC Impressions",
    "GSC CTR",
    "Visible Queries",
    "GA4 Sessions",
    "GA4 Page Views",
    "GA4 Bounce Rate",
    "Crawl Status",
    "HTTP Status",
    "Indexability",
    "Title",
    "Title Length",
    "Meta Description",
    "Meta Description Length",
    "H1",
    "H1 Count",
    "H2 Count",
    "Depth",
    "Inlinks",
    "Internal Links",
    "Outlinks",
    "Word Count",
    "Response Time Ms",
    "Opportunity / Status",
  ];

  const escape = (value: string | number) => {
    const normalized = String(value);
    return /[",\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
  };

  const body = rows.map((row) => [
    row.page,
    row.gsc?.clicks ?? 0,
    row.gsc?.impressions ?? 0,
    row.gsc ? `${(row.gsc.ctr * 100).toFixed(2)}%` : "",
    row.gsc?.queryCount ?? 0,
    row.ga4?.sessions ?? "",
    row.ga4?.pageViews ?? "",
    row.ga4 ? `${(row.ga4.bounceRate * 100).toFixed(2)}%` : "",
    getCrawlStatus(row).label,
    row.crawl?.statusCode ?? "",
    getIndexabilityStatus(row).label,
    row.crawl?.title ?? "",
    row.crawl?.titleLength ?? "",
    row.crawl?.metaDescription ?? "",
    row.crawl?.metaDescriptionLength ?? "",
    row.crawl?.h1Text ?? "",
    row.crawl?.h1Count ?? "",
    row.crawl?.h2Count ?? "",
    row.crawl?.depth ?? "",
    row.crawl?.inboundLinkCount ?? "",
    row.crawl?.internalLinkCount ?? "",
    row.crawl?.outgoingLinkCount ?? "",
    row.crawl?.wordCount ?? "",
    row.crawl?.responseTimeMs ?? "",
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
  if (row.issueInsight.severity !== "none") {
    return {
      className:
        row.issueInsight.severity === "high"
          ? "bg-[#FEF2F2] text-[#B91C1C]"
          : row.issueInsight.severity === "medium"
            ? "bg-[#FFF2E8] text-[#C2410C]"
            : "bg-[#F8FAF9] text-[#647067]",
      label: row.issueInsight.label,
    };
  }

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
  const crawl = row.crawl;
  if (!crawl) {
    return {
      className: "bg-[#F8FAF9] text-[#647067]",
      detail: "No crawl row",
      label: "Not crawled",
    };
  }

  const statusCode = crawl.statusCode ?? 0;
  if (crawl.errorMessage || (statusCode > 0 && statusCode !== 200)) {
    return {
      className: "bg-[#FEF2F2] text-[#B91C1C]",
      detail: crawl.errorMessage || "Non-200 status",
      label: statusCode ? `${statusCode}` : "Error",
    };
  }

  if (crawl.noindex) {
    return {
      className: "bg-[#F4ECFF] text-[#6D28D9]",
      detail: "Excluded by meta/robots",
      label: "Noindex",
    };
  }

  if (!crawl.hasTitle || !crawl.hasMetaDescription || crawl.h1Count !== 1) {
    const missing = [
      !crawl.hasTitle ? "title" : null,
      !crawl.hasMetaDescription ? "meta" : null,
      crawl.h1Count !== 1 ? "H1" : null,
    ].filter(Boolean);
    return {
      className: "bg-[#FFF2E8] text-[#C2410C]",
      detail: missing.join(", "),
      label: "Metadata",
    };
  }

  if (crawl.canonicalUrl && crawl.finalUrl && crawl.canonicalUrl !== crawl.finalUrl) {
    return {
      className: "bg-[#EAF2FF] text-[#2F7DF6]",
      detail: "Canonical differs",
      label: "Canonical",
    };
  }

  return {
    className: "bg-[#EAF4EC] text-[#0F3D2E]",
    detail: `${formatNumber(crawl.inboundLinkCount)} inlinks`,
    label: "OK",
  };
}

function getIndexabilityStatus(row: BlendedPagePerformanceRow) {
  const crawl = row.crawl;
  if (!crawl) {
    return {
      className: "bg-[#F8FAF9] text-[#647067]",
      label: "Unknown",
    };
  }

  if (crawl.noindex) {
    return {
      className: "bg-[#F4ECFF] text-[#6D28D9]",
      label: "Noindex",
    };
  }

  if (crawl.canonicalUrl && crawl.finalUrl && crawl.canonicalUrl !== crawl.finalUrl) {
    return {
      className: "bg-[#EAF2FF] text-[#2F7DF6]",
      label: "Canonicalized",
    };
  }

  return {
    className: "bg-[#EAF4EC] text-[#0F3D2E]",
    label: "Indexable",
  };
}

function getLengthState(value: number, low: number, high: number) {
  if (!value) {
    return {
      className: "text-[#B91C1C]",
      label: "Missing",
    };
  }

  if (value < low) {
    return {
      className: "text-[#C2410C]",
      label: `${formatNumber(value)} short`,
    };
  }

  if (value > high) {
    return {
      className: "text-[#C2410C]",
      label: `${formatNumber(value)} long`,
    };
  }

  return {
    className: "text-[#0F3D2E]",
    label: `${formatNumber(value)} ok`,
  };
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

function DetailBlock({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="rounded-2xl border border-[#E6ECE8] bg-white p-4">
      <h4 className="text-sm font-semibold text-[#0F172A]">{title}</h4>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function DetailItem({
  label,
  value,
  valueClassName = "text-[#0F172A]",
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 border-b border-[#F0F3F1] pb-2 last:border-0 last:pb-0">
      <span className="text-xs font-medium uppercase tracking-[0.12em] text-[#647067]">{label}</span>
      <span className={`max-w-[70%] break-words text-right text-sm font-medium ${valueClassName}`}>{value}</span>
    </div>
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
  const [analyticsFilter, setAnalyticsFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRow, setSelectedRow] = useState<BlendedPagePerformanceRow | null>(null);
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
      analyticsFilter,
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
            analyticsFilter,
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
    analyticsFilter,
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
        analyticsFilter,
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
      <div className="grid gap-4 lg:grid-cols-6">
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
          sublabel={hasGa4Rows ? "Matched by page path" : "Automatic GA4 collection in progress"}
          value={hasGa4Rows ? formatCompact(totals.sessions) : "Collecting"}
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
        <MetricCard
          accentClass="bg-[#FEF2F2] text-[#B91C1C]"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Crawl issues"
          sublabel={`${formatNumber(sourceMeta?.totals.crawledPages ?? 0)} pages in latest crawl`}
          value={formatCompact(sourceMeta?.totals.crawlIssuePages ?? 0)}
        />
      </div>

      {!hasGa4Rows && ga4PropertyId && (
        <div className="rounded-2xl border border-[#D9E5DE] bg-[#F4FAF6] p-4 text-sm text-[#34483E]">
          GA4 is connected, but page-level GA4 data has not been warehoused for this range yet. The app collects landing-page metrics automatically as the warehouse refreshes.
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
            GSC refreshed through {sourceMeta.freshness.gsc.latestDate || "pending"} - {formatNumber(sourceMeta.freshness.gsc.rowCount)} rows
          </span>
          <span className="rounded-full border border-[#E6ECE8] bg-white px-3 py-1.5">
            GA4 refreshed through {sourceMeta.freshness.ga4.latestDate || "pending"} - {formatNumber(sourceMeta.freshness.ga4.rowCount)} rows
          </span>
          <span className="rounded-full border border-[#E6ECE8] bg-white px-3 py-1.5">
            Crawl refreshed {sourceMeta.freshness.crawl.completedAt || "pending"} - {formatNumber(sourceMeta.freshness.crawl.rowCount)} rows
          </span>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <section className="rounded-2xl border border-[#E6ECE8] bg-white shadow-[0_16px_42px_rgba(15,61,46,0.055)]">
          <div className="flex flex-col gap-4 border-b border-[#E6ECE8] p-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#0F172A]">Top Pages ({filteredTotal})</h3>
              <p className="mt-1 text-sm text-[#647067]">
                Blends Search Console visibility, GA4 engagement, and crawl inventory by canonical page path.
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
              <Select value={analyticsFilter} onValueChange={(value) => { setAnalyticsFilter(value); setPage(1); }}>
                <SelectTrigger className="h-11 w-full rounded-xl border-[#E6ECE8] bg-white lg:w-[220px]">
                  <SelectValue placeholder="Analytics focus" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All analytics states</SelectItem>
                  <SelectItem value="low-ctr">Low CTR opportunities</SelectItem>
                  <SelectItem value="missing-ga4">Missing GA4 data</SelectItem>
                  <SelectItem value="crawl-issues">Crawl issues</SelectItem>
                  <SelectItem value="crawl-errors">Crawl errors</SelectItem>
                  <SelectItem value="metadata-gaps">Metadata gaps</SelectItem>
                  <SelectItem value="indexability">Indexability issues</SelectItem>
                  <SelectItem value="not-crawled">Not in crawl</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="secondary" className="h-11 rounded-xl bg-[#EEF3F0] text-[#0F172A]" disabled>
                <Filter className="mr-2 h-4 w-4" />
                Filters
              </Button>
            </div>

            <div className="overflow-hidden rounded-2xl border border-[#E6ECE8]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1900px] text-sm">
                  <thead className="bg-[#FBFCFB] text-xs font-semibold text-[#34483E]">
                    <tr>
                      <th className="sticky left-0 z-20 w-[360px] min-w-[360px] border-r border-[#E6ECE8] bg-[#FBFCFB] px-4 py-3 text-left">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("page")}>
                          Page {sortIndicator("page")}
                        </button>
                      </th>
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
                      <th className="px-4 py-3 text-right">Crawl</th>
                      <th className="px-4 py-3 text-right">Indexability</th>
                      <th className="px-4 py-3 text-right">Title</th>
                      <th className="px-4 py-3 text-right">Meta</th>
                      <th className="px-4 py-3 text-right">H1</th>
                      <th className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("depth")}>
                          Depth {sortIndicator("depth")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("inlinks")}>
                          Inlinks {sortIndicator("inlinks")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1" onClick={() => handleSort("wordCount")}>
                          Words {sortIndicator("wordCount")}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">Opportunity / Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={17} className="px-4 py-16 text-center text-[#647067]">
                          Loading blended page data...
                        </td>
                      </tr>
                    ) : paginatedRows.length === 0 ? (
                      <tr>
                        <td colSpan={17} className="px-4 py-16 text-center text-[#647067]">
                          No page rows match this view.
                        </td>
                      </tr>
                    ) : (
                      paginatedRows.map((row) => {
                        const compareRow = compareByPageKey.get(row.pageKey);
                        const clickChange = getChange(row.gsc?.clicks ?? 0, compareRow?.gsc?.clicks ?? 0);
                        const sessionChange = getChange(row.ga4?.sessions ?? 0, compareRow?.ga4?.sessions ?? 0);
                        const opportunityStatus = getOpportunityStatus(row);
                        const crawlStatus = getCrawlStatus(row);
                        const indexabilityStatus = getIndexabilityStatus(row);
                        const titleState = getLengthState(row.crawl?.titleLength ?? 0, 30, 65);
                        const metaState = getLengthState(row.crawl?.metaDescriptionLength ?? 0, 70, 170);

                        return (
                          <tr key={row.pageKey || row.page} className="group border-t border-[#E6ECE8] hover:bg-[#F8FAF9]">
                            <td className="sticky left-0 z-10 border-r border-[#E6ECE8] bg-white px-4 py-4 group-hover:bg-[#F8FAF9]">
                              <div className="w-[328px]">
                                <button
                                  type="button"
                                  className="block max-w-full truncate text-left font-semibold text-[#24443A] hover:text-[#0F3D2E] hover:underline"
                                  onClick={() => setSelectedRow(row)}
                                >
                                  {getPageTitle(row.page)}
                                </button>
                                <div className="mt-1 truncate text-xs text-[#647067]">{getDisplayPath(row.page)}</div>
                              </div>
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
                              <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${crawlStatus.className}`}>
                                {crawlStatus.label}
                              </span>
                              <div className="mt-1 text-xs text-[#647067]">{crawlStatus.detail}</div>
                            </td>
                            <td className="px-4 py-4 text-right">
                              <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${indexabilityStatus.className}`}>
                                {indexabilityStatus.label}
                              </span>
                            </td>
                            <td className="px-4 py-4 text-right">
                              <div className={`text-xs font-semibold ${titleState.className}`}>{titleState.label}</div>
                              <div className="mt-1 max-w-[140px] truncate text-xs text-[#647067]" title={row.crawl?.title || ""}>
                                {row.crawl?.title || "-"}
                              </div>
                            </td>
                            <td className="px-4 py-4 text-right">
                              <div className={`text-xs font-semibold ${metaState.className}`}>{metaState.label}</div>
                              <div className="mt-1 max-w-[150px] truncate text-xs text-[#647067]" title={row.crawl?.metaDescription || ""}>
                                {row.crawl?.metaDescription || "-"}
                              </div>
                            </td>
                            <td className="px-4 py-4 text-right">
                              <div className={row.crawl?.h1Count === 1 ? "text-xs font-semibold text-[#0F3D2E]" : "text-xs font-semibold text-[#C2410C]"}>
                                {row.crawl ? `${formatNumber(row.crawl.h1Count)} H1` : "-"}
                              </div>
                              <div className="mt-1 max-w-[120px] truncate text-xs text-[#647067]" title={row.crawl?.h1Text || ""}>
                                {row.crawl?.h1Text || "-"}
                              </div>
                            </td>
                            <td className="px-4 py-4 text-right">{row.crawl ? formatNumber(row.crawl.depth) : "-"}</td>
                            <td className="px-4 py-4 text-right">
                              <div>{row.crawl ? formatNumber(row.crawl.inboundLinkCount) : "-"}</div>
                              <div className="mt-1 text-xs text-[#647067]">{row.crawl ? `${formatNumber(row.crawl.outgoingLinkCount)} out` : ""}</div>
                            </td>
                            <td className="px-4 py-4 text-right">{row.crawl ? formatNumber(row.crawl.wordCount) : "-"}</td>
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

      <Dialog open={Boolean(selectedRow)} onOpenChange={(open) => !open && setSelectedRow(null)}>
        <DialogContent className="max-h-[88vh] w-[calc(100vw-32px)] max-w-6xl overflow-y-auto p-0 sm:max-w-6xl">
          {selectedRow && (
            <>
              <DialogHeader className="border-b border-[#E6ECE8] bg-white px-6 py-5">
                <div className="flex flex-col gap-4 pr-8 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <DialogTitle className="text-xl">Page review</DialogTitle>
                    <DialogDescription className="mt-2 break-all">
                      {selectedRow.crawl?.finalUrl || selectedRow.crawl?.url || selectedRow.page}
                    </DialogDescription>
                  </div>
                  <a
                    href={selectedRow.crawl?.finalUrl || selectedRow.crawl?.url || selectedRow.page}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 w-fit items-center justify-center gap-2 rounded-xl border border-[#E6ECE8] bg-white px-3 text-sm font-medium text-[#0F172A] shadow-sm transition-colors hover:bg-[#F8FAF9]"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open page
                  </a>
                </div>
              </DialogHeader>

              <div className="grid gap-4 bg-[#FBFCFB] p-5 lg:grid-cols-2">
                <DetailBlock title="Search demand">
                  <DetailItem label="Clicks" value={formatNumber(selectedRow.gsc?.clicks ?? 0)} />
                  <DetailItem label="Impressions" value={formatNumber(selectedRow.gsc?.impressions ?? 0)} />
                  <DetailItem label="CTR" value={selectedRow.gsc ? formatPercent(selectedRow.gsc.ctr) : "-"} />
                  <DetailItem label="Position" value={selectedRow.gsc ? selectedRow.gsc.position.toFixed(1) : "-"} />
                  <DetailItem label="Visible queries" value={formatNumber(selectedRow.gsc?.queryCount ?? 0)} />
                </DetailBlock>

                <DetailBlock title="Engagement">
                  <DetailItem label="Sessions" value={selectedRow.ga4 ? formatNumber(selectedRow.ga4.sessions) : "-"} />
                  <DetailItem label="Users" value={selectedRow.ga4 ? formatNumber(selectedRow.ga4.totalUsers) : "-"} />
                  <DetailItem label="Page views" value={selectedRow.ga4 ? formatNumber(selectedRow.ga4.pageViews) : "-"} />
                  <DetailItem label="Bounce rate" value={selectedRow.ga4 ? formatPercent(selectedRow.ga4.bounceRate) : "-"} />
                  <DetailItem label="Events" value={selectedRow.ga4 ? formatNumber(selectedRow.ga4.eventCount) : "-"} />
                </DetailBlock>

                <DetailBlock title="Crawl fetch">
                  <DetailItem label="Status" value={getCrawlStatus(selectedRow).label} />
                  <DetailItem label="HTTP" value={selectedRow.crawl?.statusCode ?? "-"} />
                  <DetailItem label="Response" value={selectedRow.crawl ? `${formatNumber(selectedRow.crawl.responseTimeMs)} ms` : "-"} />
                  <DetailItem label="Content type" value={selectedRow.crawl?.contentType || "-"} />
                  <DetailItem label="Depth" value={selectedRow.crawl ? formatNumber(selectedRow.crawl.depth) : "-"} />
                  <DetailItem label="Words" value={selectedRow.crawl ? formatNumber(selectedRow.crawl.wordCount) : "-"} />
                </DetailBlock>

                <DetailBlock title="Indexability">
                  <DetailItem label="State" value={getIndexabilityStatus(selectedRow).label} />
                  <DetailItem label="Noindex" value={selectedRow.crawl ? (selectedRow.crawl.noindex ? "Yes" : "No") : "-"} />
                  <DetailItem label="Final URL" value={selectedRow.crawl?.finalUrl || "-"} />
                  <DetailItem label="Canonical" value={selectedRow.crawl?.canonicalUrl || "-"} />
                </DetailBlock>

                <DetailBlock title="Content elements">
                  <DetailItem label="Title" value={selectedRow.crawl?.title || "-"} />
                  <DetailItem label="Title length" value={getLengthState(selectedRow.crawl?.titleLength ?? 0, 30, 65).label} />
                  <DetailItem label="Meta" value={selectedRow.crawl?.metaDescription || "-"} />
                  <DetailItem label="Meta length" value={getLengthState(selectedRow.crawl?.metaDescriptionLength ?? 0, 70, 170).label} />
                  <DetailItem label="H1" value={selectedRow.crawl?.h1Text || "-"} />
                  <DetailItem label="Headings" value={selectedRow.crawl ? `${formatNumber(selectedRow.crawl.h1Count)} H1 / ${formatNumber(selectedRow.crawl.h2Count)} H2` : "-"} />
                </DetailBlock>

                <DetailBlock title="Internal linking">
                  <DetailItem label="Inlinks" value={selectedRow.crawl ? formatNumber(selectedRow.crawl.inboundLinkCount) : "-"} />
                  <DetailItem label="Internal links" value={selectedRow.crawl ? formatNumber(selectedRow.crawl.internalLinkCount) : "-"} />
                  <DetailItem label="Outlinks" value={selectedRow.crawl ? formatNumber(selectedRow.crawl.outgoingLinkCount) : "-"} />
                  <DetailItem label="Crawled" value={selectedRow.crawl?.crawledAt || "-"} />
                </DetailBlock>

                <section className="rounded-2xl border border-[#E6ECE8] bg-white p-4 lg:col-span-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getOpportunityStatus(selectedRow).className}`}>
                      {getOpportunityStatus(selectedRow).label}
                    </span>
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getCrawlStatus(selectedRow).className}`}>
                      {getCrawlStatus(selectedRow).label}
                    </span>
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getIndexabilityStatus(selectedRow).className}`}>
                      {getIndexabilityStatus(selectedRow).label}
                    </span>
                  </div>
                  <div className="mt-4 space-y-2 text-sm text-[#34483E]">
                    {selectedRow.issueInsight.reasons.map((reason) => (
                      <p key={reason}>{reason}</p>
                    ))}
                    {selectedRow.crawl?.errorMessage && <p>{selectedRow.crawl.errorMessage}</p>}
                  </div>
                </section>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
