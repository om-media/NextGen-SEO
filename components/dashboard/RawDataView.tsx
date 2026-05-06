import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Download, Loader2, Search } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchCrawlJobs, fetchCrawlLinks, fetchCrawlPages, type CrawlIssueFilter, type CrawlJob, type CrawlLinkRow, type CrawlPageRow } from "@/src/services/crawlService";
import { fetchRawGa4PageRows, fetchRawGa4ReportRows, fetchRawGscRows, type RawGa4Kind, type RawGa4PageRow, type RawGa4ReportRow, type RawGscKind, type RawGscRow, type RawPage } from "@/src/services/rawDataService";
import { DataCoveragePanel } from "@/components/dashboard/DataCoveragePanel";

type RawDataViewProps = {
  dateRange: DateRange;
  ga4PropertyId?: string | null;
  siteUrl: string;
};

type Source = "gsc" | "ga4" | "crawl";
type CrawlRawKind = "pages" | "links";

const pageSize = 100;
const exportBatchSize = 5000;
const formatNumber = (value: number | null | undefined) => new Intl.NumberFormat("en-US").format(Number(value || 0));
const formatPercent = (value: number | null | undefined) => `${(Number(value || 0) * 100).toFixed(2)}%`;
const ga4PageKinds = new Set<RawGa4Kind>(["page", "page_date"]);

function toIsoDate(value: Date | undefined, fallback: Date) {
  return format(value || fallback, "yyyy-MM-dd");
}

function exportCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [headers, ...rows.map((row) => headers.map((header) => row[header]))]
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

function Pagination({ page, onPageChange }: { page: RawPage; onPageChange: (offset: number) => void }) {
  const currentPage = Math.floor(page.offset / page.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(page.total / page.limit));
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-muted-foreground">
        Showing {page.total === 0 ? 0 : page.offset + 1} to {Math.min(page.offset + page.limit, page.total)} of {formatNumber(page.total)} rows
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page.offset === 0} onClick={() => onPageChange(Math.max(0, page.offset - page.limit))}>
          Previous
        </Button>
        <span className="text-sm font-medium">Page {currentPage} of {totalPages}</span>
        <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => onPageChange(page.offset + page.limit)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function RawDataView({ dateRange, ga4PropertyId, siteUrl }: RawDataViewProps) {
  const [source, setSource] = useState<Source>("gsc");
  const [gscKind, setGscKind] = useState<RawGscKind>("page");
  const [ga4Kind, setGa4Kind] = useState<RawGa4Kind>("page");
  const [crawlKind, setCrawlKind] = useState<CrawlRawKind>("pages");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gscRows, setGscRows] = useState<RawGscRow[]>([]);
  const [ga4Rows, setGa4Rows] = useState<RawGa4PageRow[]>([]);
  const [ga4ReportRows, setGa4ReportRows] = useState<RawGa4ReportRow[]>([]);
  const [crawlRows, setCrawlRows] = useState<CrawlPageRow[]>([]);
  const [crawlLinkRows, setCrawlLinkRows] = useState<CrawlLinkRow[]>([]);
  const [page, setPage] = useState<RawPage>({ limit: pageSize, offset: 0, total: 0 });
  const [crawlJobs, setCrawlJobs] = useState<CrawlJob[]>([]);
  const [selectedCrawlJobId, setSelectedCrawlJobId] = useState("");
  const [crawlIssueFilter, setCrawlIssueFilter] = useState<CrawlIssueFilter>("all");

  const startDate = useMemo(() => toIsoDate(dateRange?.from, new Date()), [dateRange?.from]);
  const endDate = useMemo(() => toIsoDate(dateRange?.to, new Date()), [dateRange?.to]);

  useEffect(() => {
    setOffset(0);
  }, [source, gscKind, ga4Kind, crawlKind, search, siteUrl, ga4PropertyId, startDate, endDate, selectedCrawlJobId, crawlIssueFilter]);

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

    const load = async () => {
      if (source === "gsc") {
        const result = await fetchRawGscRows({ endDate, kind: gscKind, limit: pageSize, offset, search, siteUrl, startDate });
        setGscRows(result.rows);
        setGa4Rows([]);
        setCrawlRows([]);
        setPage(result.page);
        return;
      }

      if (source === "ga4") {
        if (!ga4PropertyId) {
          setGa4Rows([]);
          setGa4ReportRows([]);
          setPage({ limit: pageSize, offset: 0, total: 0 });
          return;
        }
        if (ga4PageKinds.has(ga4Kind)) {
          const result = await fetchRawGa4PageRows({ endDate, kind: ga4Kind, limit: pageSize, offset, propertyId: ga4PropertyId, search, startDate });
          setGa4Rows(result.rows);
          setGa4ReportRows([]);
          setGscRows([]);
          setCrawlRows([]);
          setPage(result.page);
          return;
        }

        const result = await fetchRawGa4ReportRows({
          endDate,
          kind: ga4Kind as Exclude<RawGa4Kind, "page" | "page_date">,
          limit: pageSize,
          offset,
          propertyId: ga4PropertyId,
          search,
          startDate,
        });
        setGa4ReportRows(result.rows);
        setGa4Rows([]);
        setGscRows([]);
        setCrawlRows([]);
        setPage(result.page);
        return;
      }

      if (crawlKind === "links") {
        const result = await fetchCrawlLinks({ jobId: selectedCrawlJobId || null, limit: pageSize, offset, search, siteUrl });
        setCrawlLinkRows(result.rows);
        setCrawlRows([]);
        setGscRows([]);
        setGa4Rows([]);
        setPage(result.page);
        return;
      }

      const result = await fetchCrawlPages({ issue: crawlIssueFilter, jobId: selectedCrawlJobId || null, limit: pageSize, offset, search, siteUrl });
      setCrawlRows(result.rows);
      setCrawlLinkRows([]);
      setGscRows([]);
      setGa4Rows([]);
      setPage(result.page);
    };

    load()
      .catch((err: any) => setError(err.message || "Failed to load raw rows"))
      .finally(() => setLoading(false));
  }, [crawlIssueFilter, crawlKind, endDate, ga4Kind, ga4PropertyId, gscKind, offset, search, selectedCrawlJobId, siteUrl, source, startDate]);

  const fetchAllRows = async <T,>(fetchPage: (nextOffset: number) => Promise<{ page: RawPage; rows: T[] }>) => {
    const rows: T[] = [];
    let nextOffset = 0;
    let total = 0;

    do {
      const result = await fetchPage(nextOffset);
      rows.push(...result.rows);
      total = result.page.total;
      nextOffset += result.page.limit;
    } while (nextOffset < total);

    return rows;
  };

  const exportRows = async () => {
    setExporting(true);
    setError(null);

    try {
      if (source === "gsc") {
        const rows = await fetchAllRows((nextOffset) => fetchRawGscRows({
          endDate,
          kind: gscKind,
          limit: exportBatchSize,
          offset: nextOffset,
          search,
          siteUrl,
          startDate,
        }));
        exportCsv(`raw-gsc-${gscKind}-${startDate}-${endDate}.csv`, rows as unknown as Record<string, unknown>[]);
      } else if (source === "ga4") {
        if (!ga4PropertyId) return;
        const rows = ga4PageKinds.has(ga4Kind)
          ? await fetchAllRows((nextOffset) => fetchRawGa4PageRows({
              endDate,
              kind: ga4Kind,
              limit: exportBatchSize,
              offset: nextOffset,
              propertyId: ga4PropertyId,
              search,
              startDate,
            }))
          : await fetchAllRows((nextOffset) => fetchRawGa4ReportRows({
              endDate,
              kind: ga4Kind as Exclude<RawGa4Kind, "page" | "page_date">,
              limit: exportBatchSize,
              offset: nextOffset,
              propertyId: ga4PropertyId,
              search,
              startDate,
            }));
        exportCsv(`raw-ga4-${ga4Kind}-${startDate}-${endDate}.csv`, rows as unknown as Record<string, unknown>[]);
      } else {
        if (crawlKind === "links") {
          const rows = await fetchAllRows((nextOffset) => fetchCrawlLinks({
            jobId: selectedCrawlJobId || null,
            limit: exportBatchSize,
            offset: nextOffset,
            search,
            siteUrl,
          }));
          exportCsv(`raw-crawl-links-${selectedCrawlJobId || "latest"}.csv`, rows as unknown as Record<string, unknown>[]);
        } else {
          const rows = await fetchAllRows((nextOffset) => fetchCrawlPages({
            issue: crawlIssueFilter,
            jobId: selectedCrawlJobId || null,
            limit: exportBatchSize,
            offset: nextOffset,
            search,
            siteUrl,
          }));
          exportCsv(`raw-crawl-pages-${selectedCrawlJobId || "latest"}.csv`, rows as unknown as Record<string, unknown>[]);
        }
      }
    } catch (err: any) {
      setError(err.message || "Failed to export raw rows");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
    <DataCoveragePanel dateRange={dateRange} ga4PropertyId={ga4PropertyId} siteUrl={siteUrl} />
    <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
      <CardHeader className="border-b border-border">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle>Raw data exports</CardTitle>
            <CardDescription className="mt-2 max-w-3xl">
              Export-parity workspace for raw warehouse rows. Use this when you would normally export GSC, GA4, or crawler rows into a spreadsheet.
            </CardDescription>
          </div>
          <Button variant="outline" className="rounded-xl" disabled={loading || exporting || page.total === 0} onClick={exportRows}>
            {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Export all filtered rows
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        <Tabs value={source} onValueChange={(value) => setSource(value as Source)}>
          <TabsList>
            <TabsTrigger value="gsc">GSC raw</TabsTrigger>
            <TabsTrigger value="ga4">GA4 raw</TabsTrigger>
            <TabsTrigger value="crawl">Crawl raw</TabsTrigger>
          </TabsList>

          <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative max-w-xl flex-1">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input className="h-11 rounded-xl pl-10" placeholder="Search raw rows..." value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <div className="flex flex-wrap gap-2">
              {source === "gsc" && (
                <Select value={gscKind} onValueChange={(value) => setGscKind(value as RawGscKind)}>
                  <SelectTrigger className="h-11 w-[210px] rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="page_query">Page + query rows</SelectItem>
                    <SelectItem value="page">Pages report</SelectItem>
                    <SelectItem value="query">Query rows</SelectItem>
                    <SelectItem value="site">Site/date rows</SelectItem>
                  </SelectContent>
                </Select>
              )}
              {source === "ga4" && (
                <Select value={ga4Kind} onValueChange={(value) => setGa4Kind(value as RawGa4Kind)}>
                  <SelectTrigger className="h-11 w-[210px] rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="page">Pages report</SelectItem>
                    <SelectItem value="page_date">Daily page rows</SelectItem>
                    <SelectItem value="event">Events</SelectItem>
                    <SelectItem value="traffic">Source / medium</SelectItem>
                    <SelectItem value="country">Countries</SelectItem>
                    <SelectItem value="city">Cities</SelectItem>
                    <SelectItem value="region">Regions</SelectItem>
                    <SelectItem value="device">Devices</SelectItem>
                    <SelectItem value="browser">Browsers</SelectItem>
                    <SelectItem value="operatingSystem">Operating systems</SelectItem>
                  </SelectContent>
                </Select>
              )}
              {source === "crawl" && (
                <>
                  <Select value={crawlKind} onValueChange={(value) => setCrawlKind(value as CrawlRawKind)}>
                    <SelectTrigger className="h-11 w-[180px] rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pages">Page rows</SelectItem>
                      <SelectItem value="links">Link rows</SelectItem>
                    </SelectContent>
                  </Select>
                  {crawlKind === "pages" && <Select value={crawlIssueFilter} onValueChange={(value) => setCrawlIssueFilter(value as CrawlIssueFilter)}>
                    <SelectTrigger className="h-11 w-[220px] rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All crawl rows</SelectItem>
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
                  </Select>}
                  <Select value={selectedCrawlJobId || "__latest__"} onValueChange={(value) => setSelectedCrawlJobId(value === "__latest__" ? "" : value)}>
                    <SelectTrigger className="h-11 w-[280px] rounded-xl">
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
                </>
              )}
            </div>
          </div>

          {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

          <TabsContent value="gsc">
            <div className="overflow-hidden rounded-2xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    {gscKind !== "site" && <TableHead>{gscKind === "query" ? "Query" : "Page"}</TableHead>}
                    {gscKind === "page_query" && <TableHead>Query</TableHead>}
                    {gscKind === "page" && <TableHead className="text-right">Queries</TableHead>}
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Impressions</TableHead>
                    <TableHead className="text-right">CTR</TableHead>
                    <TableHead className="text-right">Position</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow><TableCell colSpan={7} className="h-24 text-center"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading raw rows...</TableCell></TableRow>
                  ) : gscRows.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No raw GSC rows found.</TableCell></TableRow>
                  ) : gscRows.map((row, index) => (
                    <TableRow key={`${row.date}-${row.page || ""}-${row.query || ""}-${index}`}>
                      <TableCell>{row.date || "Total"}</TableCell>
                      {gscKind !== "site" && <TableCell className="max-w-[520px] truncate" title={gscKind === "query" ? row.query || "" : row.page || ""}>{gscKind === "query" ? row.query : row.page}</TableCell>}
                      {gscKind === "page_query" && <TableCell className="max-w-[320px] truncate" title={row.query || ""}>{row.query}</TableCell>}
                      {gscKind === "page" && <TableCell className="text-right">{formatNumber(row.queryCount)}</TableCell>}
                      <TableCell className="text-right">{formatNumber(row.clicks)}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.impressions)}</TableCell>
                      <TableCell className="text-right">{formatPercent(row.ctr)}</TableCell>
                      <TableCell className="text-right">{Number(row.position || 0).toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="ga4">
            <div className="overflow-hidden rounded-2xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Page path</TableHead>
                    <TableHead className="text-right">Sessions</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-right">Page views</TableHead>
                    <TableHead className="text-right">Bounce rate</TableHead>
                    <TableHead className="text-right">Events</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow><TableCell colSpan={7} className="h-24 text-center"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading raw rows...</TableCell></TableRow>
                  ) : !ga4PropertyId ? (
                    <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">Assign a GA4 property to this workspace first.</TableCell></TableRow>
                  ) : ga4PageKinds.has(ga4Kind) && ga4Rows.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No raw GA4 rows found.</TableCell></TableRow>
                  ) : ga4PageKinds.has(ga4Kind) ? ga4Rows.map((row, index) => (
                    <TableRow key={`${row.date}-${row.pageKey}-${index}`}>
                      <TableCell>{row.date || "Total"}</TableCell>
                      <TableCell className="max-w-[580px] truncate" title={row.pagePath}>{row.pagePath}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.sessions)}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.totalUsers)}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.pageViews)}</TableCell>
                      <TableCell className="text-right">{formatPercent(row.bounceRate)}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.eventCount)}</TableCell>
                    </TableRow>
                  )) : ga4ReportRows.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No raw GA4 rows found.</TableCell></TableRow>
                  ) : ga4ReportRows.map((row, index) => (
                    <TableRow key={`${row.dimension}-${row.dimensionValue}-${index}`}>
                      <TableCell>Total</TableCell>
                      <TableCell className="max-w-[580px] truncate" title={row.dimensionValue}>{row.dimensionValue}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.sessions)}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.totalUsers)}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.pageViews)}</TableCell>
                      <TableCell className="text-right">{formatPercent(row.bounceRate)}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.eventCount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="crawl">
            <div className="overflow-hidden rounded-2xl border border-border">
              {crawlKind === "links" ? <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>From URL</TableHead>
                    <TableHead>To URL</TableHead>
                    <TableHead>From page key</TableHead>
                    <TableHead>To page key</TableHead>
                    <TableHead className="text-right">Depth</TableHead>
                    <TableHead>Discovered</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow><TableCell colSpan={6} className="h-24 text-center"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading crawl links...</TableCell></TableRow>
                  ) : crawlLinkRows.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No raw crawl links found.</TableCell></TableRow>
                  ) : crawlLinkRows.map((row, index) => (
                    <TableRow key={`${row.jobId}-${row.fromUrl}-${row.toUrl}-${index}`}>
                      <TableCell className="max-w-[360px] truncate" title={row.fromUrl}>{row.fromUrl}</TableCell>
                      <TableCell className="max-w-[360px] truncate" title={row.toUrl}>{row.toUrl}</TableCell>
                      <TableCell className="max-w-[220px] truncate" title={row.fromPageKey}>{row.fromPageKey}</TableCell>
                      <TableCell className="max-w-[220px] truncate" title={row.toPageKey}>{row.toPageKey}</TableCell>
                      <TableCell className="text-right">{row.depth}</TableCell>
                      <TableCell>{row.discoveredAt || ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table> : <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>URL</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Canonical</TableHead>
                    <TableHead className="text-right">Depth</TableHead>
                    <TableHead className="text-right">Words</TableHead>
                    <TableHead>Crawled</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow><TableCell colSpan={7} className="h-24 text-center"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading raw rows...</TableCell></TableRow>
                  ) : crawlRows.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No raw crawl rows found.</TableCell></TableRow>
                  ) : crawlRows.map((row) => (
                    <TableRow key={`${row.jobId}-${row.normalizedUrl}`}>
                      <TableCell className="max-w-[520px] truncate" title={row.url}>{row.url}</TableCell>
                      <TableCell>{row.statusCode || "Error"}</TableCell>
                      <TableCell className="max-w-[280px] truncate" title={row.title || ""}>{row.title || "Untitled"}</TableCell>
                      <TableCell className="max-w-[320px] truncate" title={row.canonicalUrl || ""}>{row.canonicalUrl || "Not set"}</TableCell>
                      <TableCell className="text-right">{row.depth}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.wordCount)}</TableCell>
                      <TableCell>{row.crawledAt || ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>}
            </div>
          </TabsContent>
        </Tabs>

        <Pagination page={page} onPageChange={setOffset} />
      </CardContent>
    </Card>
    </div>
  );
}
