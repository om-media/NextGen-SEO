import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Download, Loader2, Search } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchCrawlJobs, type CrawlJob } from "@/src/services/crawlService";
import { fetchPageReconciliation, type PageReconciliationRow, type PageReconciliationResponse, type ReconciliationStatus } from "@/src/services/reconciliationService";

type ReconciliationViewProps = {
  dateRange: DateRange;
  ga4PropertyId?: string | null;
  siteUrl: string;
};

const pageSize = 100;
const exportBatchSize = 5000;
const numberFormatter = new Intl.NumberFormat("en-US");

const statusOptions: Array<{ label: string; value: ReconciliationStatus }> = [
  { label: "Issues", value: "issues" },
  { label: "All URLs", value: "all" },
  { label: "Matched", value: "matched" },
  { label: "Missing crawl", value: "missing-crawl" },
  { label: "Missing GSC", value: "missing-gsc" },
  { label: "Missing GA4", value: "missing-ga4" },
  { label: "Crawl errors", value: "crawl-errors" },
  { label: "Noindex", value: "noindex" },
  { label: "Canonical", value: "canonical" },
];

const flagLabels: Record<string, string> = {
  canonical_mismatch: "Canonical mismatch",
  crawl_error: "Crawl error",
  high_impressions_no_clicks: "High impressions, no clicks",
  missing_in_crawl: "Missing crawl",
  missing_in_ga4: "Missing GA4",
  missing_in_gsc: "Missing GSC",
  noindex: "Noindex",
};

function toIsoDate(value: Date | undefined, fallback: Date) {
  return format(value || fallback, "yyyy-MM-dd");
}

function formatNumber(value: number | null | undefined) {
  return numberFormatter.format(Number(value || 0));
}

function formatPercent(value: number | null | undefined) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function exportCsv(filename: string, rows: PageReconciliationRow[]) {
  if (rows.length === 0) return;
  const flattened = rows.map((row) => ({
    pageKey: row.pageKey,
    url: row.representativeUrl,
    flags: row.flags.map((flag) => flagLabels[flag] || flag).join("; "),
    gscClicks: row.gsc?.clicks ?? "",
    gscImpressions: row.gsc?.impressions ?? "",
    gscCtr: row.gsc?.ctr ?? "",
    gscPosition: row.gsc?.position ?? "",
    ga4Sessions: row.ga4?.sessions ?? "",
    ga4PageViews: row.ga4?.pageViews ?? "",
    ga4BounceRate: row.ga4?.bounceRate ?? "",
    crawlStatus: row.crawl?.statusCode ?? "",
    crawlTitle: row.crawl?.title ?? "",
    crawlCanonical: row.crawl?.canonicalUrl ?? "",
    crawlNoindex: row.crawl?.noindex ?? "",
    crawledAt: row.crawl?.crawledAt ?? "",
  }));
  const headers = Object.keys(flattened[0]);
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [headers, ...flattened.map((row) => headers.map((header) => row[header as keyof typeof row]))]
    .map((line) => line.map(escape).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_12px_28px_rgba(15,61,46,0.04)]">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-foreground">{formatNumber(value)}</div>
    </div>
  );
}

export function ReconciliationView({ dateRange, ga4PropertyId, siteUrl }: ReconciliationViewProps) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<ReconciliationStatus>("issues");
  const [crawlJobs, setCrawlJobs] = useState<CrawlJob[]>([]);
  const [selectedCrawlJobId, setSelectedCrawlJobId] = useState("");
  const [data, setData] = useState<PageReconciliationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const startDate = useMemo(() => toIsoDate(dateRange?.from, new Date()), [dateRange?.from]);
  const endDate = useMemo(() => toIsoDate(dateRange?.to, new Date()), [dateRange?.to]);
  const rows = data?.rows || [];
  const page = data?.page || { limit: pageSize, offset: 0, total: 0 };
  const totals = data?.meta.totals || { crawlErrors: 0, issues: 0, missingCrawl: 0, missingGa4: 0, missingGsc: 0, total: 0 };
  const currentPage = Math.floor(page.offset / page.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(page.total / page.limit));

  useEffect(() => {
    setOffset(0);
  }, [endDate, ga4PropertyId, search, selectedCrawlJobId, siteUrl, startDate, status]);

  useEffect(() => {
    if (!siteUrl) return;
    fetchCrawlJobs(siteUrl)
      .then((result) => {
        setCrawlJobs(result.jobs);
        if (!selectedCrawlJobId && result.jobs[0]) {
          setSelectedCrawlJobId(result.jobs[0].id);
        }
      })
      .catch(() => setCrawlJobs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteUrl]);

  useEffect(() => {
    if (!siteUrl) return;
    setLoading(true);
    setError(null);
    fetchPageReconciliation({
      crawlJobId: selectedCrawlJobId || null,
      endDate,
      limit: pageSize,
      offset,
      propertyId: ga4PropertyId || null,
      search,
      siteUrl,
      startDate,
      status,
    })
      .then(setData)
      .catch((err: any) => setError(err.message || "Failed to load reconciliation data"))
      .finally(() => setLoading(false));
  }, [endDate, ga4PropertyId, offset, search, selectedCrawlJobId, siteUrl, startDate, status]);

  const exportAllRows = async () => {
    if (!siteUrl) return;
    setExporting(true);
    setError(null);

    try {
      const allRows: PageReconciliationRow[] = [];
      let nextOffset = 0;
      let total = 0;

      do {
        const result = await fetchPageReconciliation({
          crawlJobId: selectedCrawlJobId || null,
          endDate,
          limit: exportBatchSize,
          offset: nextOffset,
          propertyId: ga4PropertyId || null,
          search,
          siteUrl,
          startDate,
          status,
        });
        allRows.push(...result.rows);
        total = result.page.total;
        nextOffset += result.page.limit;
      } while (nextOffset < total);

      exportCsv(`page-reconciliation-${startDate}-${endDate}.csv`, allRows);
    } catch (err: any) {
      setError(err.message || "Failed to export reconciliation data");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardHeader className="border-b border-border">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle>Page reconciliation</CardTitle>
              <CardDescription className="mt-2 max-w-3xl">
                Join GSC visibility, GA4 behavior, and crawler inventory by normalized page path. Use this to find pages that disappear between exports.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Select value={selectedCrawlJobId || "__latest__"} onValueChange={(value) => setSelectedCrawlJobId(value === "__latest__" ? "" : value)}>
                <SelectTrigger className="h-10 w-[280px] rounded-xl">
                  <SelectValue placeholder="Latest crawl" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__latest__">Latest crawl</SelectItem>
                  {crawlJobs.map((job) => (
                    <SelectItem key={job.id} value={job.id}>
                      {`${job.status} - ${job.startedAt || job.updatedAt || job.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" className="rounded-xl" disabled={loading || exporting || page.total === 0} onClick={exportAllRows}>
                {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Export all filtered rows
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Filtered URLs" value={totals.total} />
            <StatCard label="Issues" value={totals.issues} />
            <StatCard label="Missing crawl" value={totals.missingCrawl} />
            <StatCard label="Missing GSC" value={totals.missingGsc} />
            <StatCard label="Missing GA4" value={totals.missingGa4} />
            <StatCard label="Crawl errors" value={totals.crawlErrors} />
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative max-w-xl flex-1">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input className="h-11 rounded-xl pl-10" placeholder="Search URL, title, or canonical..." value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <Select value={status} onValueChange={(value) => setStatus(value as ReconciliationStatus)}>
              <SelectTrigger className="h-11 w-[220px] rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

          <div className="overflow-hidden rounded-2xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Page</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead className="text-right">GSC</TableHead>
                  <TableHead className="text-right">GA4</TableHead>
                  <TableHead>Crawl</TableHead>
                  <TableHead>Canonical</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                      Reconciling page data...
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No reconciliation rows found.</TableCell>
                  </TableRow>
                ) : rows.map((row) => (
                  <TableRow key={row.pageKey}>
                    <TableCell className="max-w-[440px]">
                      <div className="truncate font-medium text-foreground" title={row.representativeUrl}>{row.representativeUrl}</div>
                      <div className="mt-1 truncate text-xs text-muted-foreground" title={row.pageKey}>{row.pageKey}</div>
                    </TableCell>
                    <TableCell className="max-w-[300px]">
                      <div className="flex flex-wrap gap-1.5">
                        {row.flags.length === 0 ? (
                          <Badge variant="secondary">Matched</Badge>
                        ) : row.flags.map((flag) => (
                          <Badge key={flag} variant={flag === "crawl_error" ? "destructive" : "outline"}>
                            {flagLabels[flag] || flag}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {row.gsc ? (
                        <div>
                          <div className="font-medium">{formatNumber(row.gsc.clicks)} clicks</div>
                          <div className="text-xs text-muted-foreground">{formatNumber(row.gsc.impressions)} impressions</div>
                        </div>
                      ) : <span className="text-muted-foreground">Missing</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.ga4 ? (
                        <div>
                          <div className="font-medium">{formatNumber(row.ga4.sessions)} sessions</div>
                          <div className="text-xs text-muted-foreground">{formatNumber(row.ga4.pageViews)} views, {formatPercent(row.ga4.bounceRate)} bounce</div>
                        </div>
                      ) : <span className="text-muted-foreground">Missing</span>}
                    </TableCell>
                    <TableCell>
                      {row.crawl ? (
                        <div>
                          <div className="font-medium">{row.crawl.statusCode || "Error"}</div>
                          <div className="max-w-[220px] truncate text-xs text-muted-foreground" title={row.crawl.title || ""}>{row.crawl.title || "Untitled"}</div>
                        </div>
                      ) : <span className="text-muted-foreground">Missing</span>}
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate" title={row.crawl?.canonicalUrl || ""}>
                      {row.crawl?.canonicalUrl || "Not set"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              Showing {page.total === 0 ? 0 : page.offset + 1} to {Math.min(page.offset + page.limit, page.total)} of {formatNumber(page.total)} URLs
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - page.limit))}>Previous</Button>
              <span className="text-sm font-medium">Page {currentPage} of {totalPages}</span>
              <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setOffset(page.offset + page.limit)}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
