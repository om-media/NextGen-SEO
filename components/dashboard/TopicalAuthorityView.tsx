import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Layers3,
  Search,
  Target,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  TopicalAuthorityService,
  type TopicalAuthorityCluster,
  type TopicalAuthorityReport,
  type TopicalAuthorityStatus,
} from '@/src/services/topicalAuthorityService';

const PAGE_SIZE = 50;

const whole = (value: number) => new Intl.NumberFormat().format(Math.round(value || 0));
const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value || 0);
const percent = (value: number) => `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
const position = (value: number) => value ? value.toFixed(1) : '—';

const STATUS_COPY: Record<TopicalAuthorityStatus, { label: string; className: string }> = {
  leading: { label: 'Leading', className: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200' },
  established: { label: 'Established', className: 'bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200' },
  emerging: { label: 'Emerging', className: 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200' },
  gap: { label: 'Coverage gap', className: 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200' },
};

function StatusBadge({ status }: { status: TopicalAuthorityStatus }) {
  const copy = STATUS_COPY[status];
  return <Badge className={copy.className} variant="ghost">{copy.label}</Badge>;
}

function LoadingState() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading topical authority evidence">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-xl" />)}
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="mt-3 h-12 w-full" />)}
      </div>
    </div>
  );
}

function EvidenceBreakdown({ cluster }: { cluster: TopicalAuthorityCluster }) {
  const rows = [
    ['Search visibility', cluster.evidence.visibility, 40],
    ['Demand capture', cluster.evidence.demandCapture, 25],
    ['Content depth', cluster.evidence.depth, 20],
    ['Internal support', cluster.evidence.internalSupport, 15],
  ] as const;
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div><p className="font-semibold">Evidence score</p><p className="text-xs text-muted-foreground">Transparent app diagnostic, not a Google metric.</p></div>
        <strong className="text-2xl">{cluster.evidence.total}</strong>
      </div>
      {rows.map(([label, value, maximum]) => (
        <div key={label}>
          <div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">{label}</span><span>{value}/{maximum}</span></div>
          <Progress value={(value / maximum) * 100} className="h-1.5" aria-label={`${label}: ${value} of ${maximum}`} />
        </div>
      ))}
    </div>
  );
}

function ClusterSheet({ cluster, onOpenChange }: { cluster: TopicalAuthorityCluster | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={Boolean(cluster)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="border-b border-border pr-12">
          <div className="mb-2 flex flex-wrap items-center gap-2">{cluster && <StatusBadge status={cluster.status} />}</div>
          <SheetTitle>{cluster?.label || 'Topic cluster'}</SheetTitle>
          <SheetDescription>{cluster ? `${whole(cluster.impressions)} impressions across ${cluster.pageCount} ranking pages and ${cluster.queryCount} observed queries.` : ''}</SheetDescription>
        </SheetHeader>
        {cluster && (
          <div className="space-y-5 p-4">
            <EvidenceBreakdown cluster={cluster} />
            {cluster.issues.length > 0 && (
              <section aria-labelledby="topic-actions-title">
                <h3 id="topic-actions-title" className="font-semibold">Why this topic needs attention</h3>
                <div className="mt-2 divide-y divide-border rounded-lg border border-border">
                  {cluster.issues.map((issue) => <p key={issue} className="flex gap-2 p-3 text-sm"><CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />{issue}</p>)}
                </div>
              </section>
            )}
            <section aria-labelledby="topic-queries-title">
              <h3 id="topic-queries-title" className="font-semibold">Observed queries</h3>
              <div className="mt-2 overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader><TableRow><TableHead>Query</TableHead><TableHead>Impressions</TableHead><TableHead>Clicks</TableHead><TableHead>Position</TableHead></TableRow></TableHeader>
                  <TableBody>{cluster.queries.map((query) => <TableRow key={query.query}><TableCell className="font-medium">{query.query}</TableCell><TableCell>{whole(query.impressions)}</TableCell><TableCell>{whole(query.clicks)}</TableCell><TableCell>{position(query.position)}</TableCell></TableRow>)}</TableBody>
                </Table>
              </div>
            </section>
            <section aria-labelledby="topic-pages-title">
              <h3 id="topic-pages-title" className="font-semibold">Ranking pages</h3>
              <div className="mt-2 divide-y divide-border rounded-lg border border-border">
                {cluster.pages.map((page) => (
                  <article key={page.pageKey} className="p-3">
                    <p className="truncate font-medium" title={page.title}>{page.title}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={page.url}>{page.url}</p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{whole(page.impressions)} impressions</span><span>Position {position(page.position)}</span><span>{page.inboundLinks} internal links in</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function TopicalAuthorityView({ siteUrl }: { siteUrl: string }) {
  const [report, setReport] = useState<TopicalAuthorityReport | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<TopicalAuthorityCluster | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => setOffset(0), [debouncedSearch, siteUrl, status]);

  useEffect(() => {
    setReport(null);
    setSelectedCluster(null);
    setSearch('');
    setDebouncedSearch('');
  }, [siteUrl]);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    TopicalAuthorityService.getClusters(siteUrl, { limit: PAGE_SIZE, offset, search: debouncedSearch, status })
      .then((next) => { if (id === requestId.current) setReport(next); })
      .catch((cause) => { if (id === requestId.current) setError(cause instanceof Error ? cause.message : 'Topical authority evidence could not be loaded.'); })
      .finally(() => { if (id === requestId.current) setLoading(false); });
  }, [debouncedSearch, offset, siteUrl, status]);

  if (loading && !report) return <LoadingState />;

  const summary = report?.summary;
  const strongClusters = (summary?.statusCounts.leading || 0) + (summary?.statusCounts.established || 0);

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="font-semibold">Topical authority evidence could not be loaded</p><p className="mt-1">{error}</p></div></div>}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Topical authority summary">
        {[
          { label: 'Observed topics', value: summary?.clusters || 0, detail: 'From stored GSC query relationships', icon: Layers3 },
          { label: 'Leading / established', value: strongClusters, detail: 'Topics currently visible on page one', icon: Target },
          { label: 'Coverage gaps', value: summary?.statusCounts.gap || 0, detail: 'Demand with weak visibility', icon: CircleDot },
          { label: 'Ranking pages', value: summary?.pages || 0, detail: 'Pages contributing topic evidence', icon: BookOpen },
        ].map((item) => <div key={item.label} className="rounded-xl border border-border bg-card p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-sm text-muted-foreground">{item.label}</p><strong className="mt-2 block text-2xl text-foreground">{compact(item.value)}</strong></div><item.icon className="h-4 w-4 text-primary" /></div><p className="mt-2 text-xs text-muted-foreground">{item.detail}</p></div>)}
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="topical-clusters-title">
        <div className="flex flex-col gap-4 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div><h2 id="topical-clusters-title" className="font-semibold">Topical coverage</h2><p className="mt-1 text-sm text-muted-foreground">Topics observed in stored Search Console data, with crawl and internal-link evidence layered onto ranking performance.</p></div>
          {report?.meta.dateRange.startDate && <Badge variant="outline">Stored history {report.meta.dateRange.startDate} to {report.meta.dateRange.endDate}</Badge>}
        </div>
        <div className="grid gap-2 border-b border-border p-4 md:grid-cols-[minmax(0,1fr)_220px]">
          <label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search topic clusters" className="pl-9" placeholder="Search topics, queries, or pages" value={search} onChange={(event) => setSearch(event.target.value)} /><span className="sr-only">Search topic clusters</span></label>
          <Select value={status} onValueChange={setStatus}><SelectTrigger aria-label="Filter topic status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All topic states</SelectItem><SelectItem value="leading">Leading</SelectItem><SelectItem value="established">Established</SelectItem><SelectItem value="emerging">Emerging</SelectItem><SelectItem value="gap">Coverage gaps</SelectItem></SelectContent></Select>
        </div>

        {loading ? <div className="space-y-3 p-5" role="status"><p className="text-sm text-muted-foreground">Loading stored topic evidence</p>{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-11 w-full" />)}</div> : report?.rows.length ? (
          <>
            <Table>
              <TableHeader><TableRow><TableHead>Topic cluster</TableHead><TableHead>Status</TableHead><TableHead>Search demand</TableHead><TableHead>Visibility</TableHead><TableHead>Depth</TableHead><TableHead>Internal support</TableHead><TableHead>Evidence</TableHead><TableHead className="w-12"><span className="sr-only">Inspect</span></TableHead></TableRow></TableHeader>
              <TableBody>{report.rows.map((cluster) => <TableRow key={cluster.key}><TableCell className="max-w-[300px]"><p className="truncate font-medium" title={cluster.label}>{cluster.label}</p><p className="mt-1 text-xs text-muted-foreground">{cluster.queryCount} queries</p></TableCell><TableCell><StatusBadge status={cluster.status} /></TableCell><TableCell><p className="font-medium">{compact(cluster.impressions)}</p><p className="mt-1 text-xs text-muted-foreground">{whole(cluster.clicks)} clicks · {percent(cluster.ctr)} CTR</p></TableCell><TableCell><p className="font-medium">Position {position(cluster.position)}</p><p className="mt-1 text-xs text-muted-foreground">{cluster.evidence.visibility}/40 evidence</p></TableCell><TableCell><p className="font-medium">{cluster.pageCount} pages</p><p className="mt-1 text-xs text-muted-foreground">{cluster.evidence.depth}/20 evidence</p></TableCell><TableCell><p className="font-medium">{cluster.support.inboundLinks} links in</p><p className="mt-1 text-xs text-muted-foreground">{cluster.evidence.internalSupport}/15 evidence</p></TableCell><TableCell><strong>{cluster.evidence.total}</strong><span className="text-muted-foreground">/100</span></TableCell><TableCell><Button size="icon-sm" variant="ghost" aria-label={`Inspect topic ${cluster.label}`} onClick={() => setSelectedCluster(cluster)}><ArrowRight /></Button></TableCell></TableRow>)}</TableBody>
            </Table>
            <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span>Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, report.page.total)} of {whole(report.page.total)} topics</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft />Previous</Button><Button size="sm" variant="outline" disabled={offset + PAGE_SIZE >= report.page.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next<ChevronRight /></Button></div></div>
          </>
        ) : <div className="px-5 py-16 text-center"><Layers3 className="mx-auto h-6 w-6 text-muted-foreground" /><h3 className="mt-3 font-semibold">No topic evidence found</h3><p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">{search || status !== 'all' ? 'No stored topic clusters match these filters.' : 'Topical authority appears after Search Console page-query data has been warehoused for this site.'}</p></div>}
      </section>

      {report && <p className="px-1 text-xs leading-5 text-muted-foreground">{report.meta.methodology}</p>}
      <ClusterSheet cluster={selectedCluster} onOpenChange={(open) => { if (!open) setSelectedCluster(null); }} />
    </div>
  );
}
