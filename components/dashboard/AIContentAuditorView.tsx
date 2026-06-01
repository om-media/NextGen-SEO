import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import Markdown from "react-markdown";
import { AlertCircle, Download, FileSearch, Info, Loader2, RefreshCw, Sparkles } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { generateContentAuditBrief, isAiProviderUnavailableError } from "@/src/services/aiService";
import { fetchCrawlPages, type CrawlPageRow } from "@/src/services/crawlService";
import { GscApiService, type GscSearchAnalyticsRow } from "@/src/services/gscService";

type AIContentAuditorViewProps = {
  dateRange: DateRange;
  siteUrl: string;
  useLiveData: boolean;
};

type AuditFocus = "all" | "critical" | "metadata" | "thin" | "search_opportunity" | "internal_links";

type AuditRow = {
  clicks: number;
  ctr: number;
  h1Count: number;
  impressions: number;
  inboundLinks: number;
  issues: string[];
  metaDescription: string | null;
  pageKey: string;
  position: number;
  score: number;
  statusCode: number | null;
  title: string | null;
  url: string;
  wordCount: number;
};

const formatNumber = (value: number) => new Intl.NumberFormat("en-US").format(Math.round(value || 0));
const formatPercent = (value: number) => `${((value || 0) * 100).toFixed(1)}%`;
const formatDecimal = (value: number) => (value ? value.toFixed(1) : "-");

function formatDate(value: Date | undefined, fallbackDaysAgo: number) {
  const date = value || new Date(Date.now() - fallbackDaysAgo * 24 * 60 * 60 * 1000);
  return format(date, "yyyy-MM-dd");
}

function normalizePageKey(value: string) {
  try {
    const url = new URL(value);
    return `${url.pathname || "/"}`.replace(/\/+$/, "") || "/";
  } catch {
    return value.replace(/^https?:\/\/[^/]+/i, "").replace(/\/+$/, "") || "/";
  }
}

function scoreRow(row: CrawlPageRow, gsc: GscSearchAnalyticsRow | undefined): AuditRow {
  const issues: string[] = [];
  const statusCode = row.statusCode ?? null;
  const titleLength = row.title?.trim().length || 0;
  const metaLength = row.metaDescription?.trim().length || 0;
  const inboundLinks = row.inboundLinkCount ?? row.internalLinkCount ?? 0;
  const clicks = gsc?.clicks || 0;
  const impressions = gsc?.impressions || 0;
  const ctr = gsc?.ctr || 0;
  const position = gsc?.position || 0;

  if (!statusCode || statusCode >= 400) issues.push("Fetch error");
  if (statusCode && statusCode >= 300 && statusCode < 400) issues.push("Redirect");
  if (row.noindex) issues.push("Noindex");
  if (!titleLength) issues.push("Missing title");
  if (titleLength > 0 && (titleLength < 25 || titleLength > 70)) issues.push("Title length");
  if (!metaLength) issues.push("Missing meta");
  if (row.h1Count !== 1) issues.push("H1 structure");
  if ((row.wordCount || 0) < 350) issues.push("Thin content");
  if (inboundLinks <= 1) issues.push("Low internal links");
  if (impressions >= 500 && ctr < 0.02) issues.push("Low CTR opportunity");
  if (impressions >= 200 && position >= 8 && position <= 20) issues.push("Striking distance");

  const severity = issues.reduce((total, issue) => {
    if (issue === "Fetch error" || issue === "Noindex") return total + 22;
    if (issue === "Missing title" || issue === "Missing meta") return total + 14;
    if (issue === "Low CTR opportunity" || issue === "Striking distance") return total + 12;
    return total + 8;
  }, 0);

  return {
    clicks,
    ctr,
    h1Count: row.h1Count || 0,
    impressions,
    inboundLinks,
    issues,
    metaDescription: row.metaDescription,
    pageKey: row.pageKey || normalizePageKey(row.url),
    position,
    score: Math.max(0, 100 - severity),
    statusCode,
    title: row.title,
    url: row.url,
    wordCount: row.wordCount || 0,
  };
}

function exportCsv(rows: AuditRow[]) {
  const headers = ["URL", "Score", "Issues", "Clicks", "Impressions", "CTR", "Position", "Words", "Inlinks", "Status", "Title", "Meta Description"];
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = rows.map((row) => [
    row.url,
    row.score,
    row.issues.join("; "),
    row.clicks,
    row.impressions,
    row.ctr,
    row.position,
    row.wordCount,
    row.inboundLinks,
    row.statusCode || "",
    row.title || "",
    row.metaDescription || "",
  ]);
  const csv = [headers, ...body].map((line) => line.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `content-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

export function AIContentAuditorView({ dateRange, siteUrl, useLiveData }: AIContentAuditorViewProps) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [brief, setBrief] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [briefNotice, setBriefNotice] = useState<string | null>(null);
  const [focus, setFocus] = useState<AuditFocus>("all");
  const [loading, setLoading] = useState(false);
  const [briefLoading, setBriefLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const filteredRows = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !query || row.url.toLowerCase().includes(query) || row.title?.toLowerCase().includes(query);
      if (!matchesSearch) return false;
      if (focus === "critical") return row.issues.some((issue) => issue === "Fetch error" || issue === "Noindex");
      if (focus === "metadata") return row.issues.some((issue) => issue.includes("title") || issue.includes("meta") || issue.includes("H1"));
      if (focus === "thin") return row.issues.includes("Thin content");
      if (focus === "search_opportunity") return row.issues.some((issue) => issue === "Low CTR opportunity" || issue === "Striking distance");
      if (focus === "internal_links") return row.issues.includes("Low internal links");
      return true;
    });
  }, [focus, rows, searchTerm]);

  const summary = useMemo(() => {
    const total = rows.length;
    const issuePages = rows.filter((row) => row.issues.length > 0).length;
    const opportunityPages = rows.filter((row) => row.issues.some((issue) => issue === "Low CTR opportunity" || issue === "Striking distance")).length;
    const averageScore = total ? rows.reduce((sum, row) => sum + row.score, 0) / total : 0;
    return { averageScore, issuePages, opportunityPages, total };
  }, [rows]);

  const loadAudit = async () => {
    if (!siteUrl) return;
    setLoading(true);
    setError(null);
    try {
      const crawl = await fetchCrawlPages({ limit: 5000, offset: 0, siteUrl });
      const startDate = formatDate(dateRange.from, 28);
      const endDate = formatDate(dateRange.to || dateRange.from, 0);
      let gscRows: GscSearchAnalyticsRow[] = [];
      try {
        gscRows = await new GscApiService(null).querySearchAnalytics(siteUrl, startDate, endDate, ["page"], undefined, useLiveData);
      } catch {
        gscRows = [];
      }
      const gscByKey = new Map(gscRows.map((row) => [normalizePageKey(String(row.keys?.[0] || "")), row]));
      const auditRows = crawl.rows
        .map((row) => scoreRow(row, gscByKey.get(row.pageKey || normalizePageKey(row.url))))
        .sort((a, b) => a.score - b.score || b.impressions - a.impressions);
      setRows(auditRows);
    } catch (err: any) {
      setError(err.message || "Failed to load content audit");
    } finally {
      setLoading(false);
    }
  };

  const loadBrief = async () => {
    setBriefLoading(true);
    setError(null);
    setBriefNotice(null);
    try {
      const payload = rows.slice(0, 40).map((row) => ({
        clicks: row.clicks,
        ctr: row.ctr,
        impressions: row.impressions,
        issues: row.issues,
        position: row.position,
        score: row.score,
        title: row.title,
        url: row.url,
        wordCount: row.wordCount,
      }));
      setBrief(await generateContentAuditBrief(payload, siteUrl));
    } catch (err: any) {
      if (isAiProviderUnavailableError(err)) {
        setBrief("");
        setBriefNotice(err.message);
        return;
      }
      setError(err.message || "Failed to generate AI brief");
    } finally {
      setBriefLoading(false);
    }
  };

  useEffect(() => {
    loadAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteUrl, dateRange.from, dateRange.to, useLiveData]);

  return (
    <div className="space-y-5">
      <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardHeader className="flex flex-col gap-4 border-b border-border/70 pb-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <CardTitle className="text-xl">AI content auditor</CardTitle>
            </div>
            <CardDescription className="max-w-3xl">
              Prioritize pages using crawl quality, metadata, internal links, and page-level search demand from the selected date range.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button className="h-10 rounded-xl" variant="outline" onClick={loadAudit} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
            <Button className="h-10 rounded-xl" variant="outline" onClick={() => exportCsv(filteredRows)} disabled={!filteredRows.length}>
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
            <Button className="h-10 rounded-xl" onClick={loadBrief} disabled={!rows.length || briefLoading}>
              {briefLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
              Generate brief
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <AlertCircle className="mr-2 inline-block h-4 w-4" />
              {error}
            </div>
          )}

          {briefNotice && (
            <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{briefNotice}</span>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-border bg-background p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Pages audited</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(summary.total)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-background p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Avg score</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">{formatDecimal(summary.averageScore)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-background p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Pages with issues</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(summary.issuePages)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-background p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Search opportunities</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(summary.opportunityPages)}</p>
            </div>
          </div>

          {brief && (
            <div className="prose prose-sm max-w-none rounded-2xl border border-border bg-background p-5 text-foreground">
              <Markdown>{brief}</Markdown>
            </div>
          )}

          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex w-full flex-col gap-2 md:max-w-3xl md:flex-row">
              <div className="relative flex-1">
                <FileSearch className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
                <Input className="h-11 rounded-xl border-border bg-card pl-10" onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search URL or title..." value={searchTerm} />
              </div>
              <Select value={focus} onValueChange={(value) => setFocus(value as AuditFocus)}>
                <SelectTrigger className="h-11 rounded-xl border-border bg-card md:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All pages</SelectItem>
                  <SelectItem value="critical">Critical blockers</SelectItem>
                  <SelectItem value="metadata">Metadata issues</SelectItem>
                  <SelectItem value="thin">Thin content</SelectItem>
                  <SelectItem value="search_opportunity">Search opportunities</SelectItem>
                  <SelectItem value="internal_links">Internal links</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="text-sm text-muted-foreground">{formatNumber(filteredRows.length)} matching pages</div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border">
            <div className="overflow-x-auto">
              <Table className="min-w-[1320px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[24%]">Page</TableHead>
                    <TableHead>Score</TableHead>
                    <TableHead>Issues</TableHead>
                    <TableHead>Clicks</TableHead>
                    <TableHead>Impressions</TableHead>
                    <TableHead>CTR</TableHead>
                    <TableHead>Position</TableHead>
                    <TableHead>Words</TableHead>
                    <TableHead>Inlinks</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                        <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
                        Loading content audit...
                      </TableCell>
                    </TableRow>
                  ) : filteredRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                        Run a crawl first, then return here to audit content quality.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredRows.map((row) => (
                      <TableRow key={row.url}>
                        <TableCell className="max-w-0 truncate font-medium text-foreground" title={row.url}>
                          <div className="truncate">{row.title || "Untitled"}</div>
                          <div className="truncate text-xs font-normal text-muted-foreground">{row.url}</div>
                        </TableCell>
                        <TableCell>
                          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-foreground">{Math.round(row.score)}</span>
                        </TableCell>
                        <TableCell className="max-w-[300px]">
                          <div className="flex flex-wrap gap-1.5">
                            {row.issues.length ? row.issues.slice(0, 4).map((issue) => (
                              <span key={issue} className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">{issue}</span>
                            )) : <span className="text-sm text-muted-foreground">No priority issues</span>}
                          </div>
                        </TableCell>
                        <TableCell>{formatNumber(row.clicks)}</TableCell>
                        <TableCell>{formatNumber(row.impressions)}</TableCell>
                        <TableCell>{formatPercent(row.ctr)}</TableCell>
                        <TableCell>{formatDecimal(row.position)}</TableCell>
                        <TableCell>{formatNumber(row.wordCount)}</TableCell>
                        <TableCell>{formatNumber(row.inboundLinks)}</TableCell>
                        <TableCell>{row.statusCode || "-"}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
