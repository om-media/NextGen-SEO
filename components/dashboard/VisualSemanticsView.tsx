import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  LayoutTemplate,
  Loader2,
  Network,
  Search,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ContentAuthorityService,
  type AuthorityConfidence,
  type ContentAuthorityMeta,
  type ContentAuthorityPage,
  type ContentAuthorityPageEvidence,
  type ContentAuthorityTemplate,
} from '@/src/services/visualSemanticsService';
import {
  createVisualSemanticsRequestFence,
  getVisualSemanticsEvidenceKey,
  getVisualSemanticsWorkspaceKey,
} from './visualSemanticsRequestFence';

const PAGE_SIZE = 50;

function percent(value: number | null | undefined) {
  return `${Math.round((value || 0) * 100)}%`;
}

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value);
}

function confidenceBadge(confidence: AuthorityConfidence) {
  const className = confidence.label === 'high'
    ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
    : confidence.label === 'medium'
      ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
      : confidence.label === 'low'
        ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
        : 'bg-muted text-muted-foreground';
  return <Badge className={className} variant="ghost">{confidence.label === 'unknown' ? 'Not scored' : `${confidence.label} ${percent(confidence.value)}`}</Badge>;
}

function AuthoritySkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading visual semantics evidence">
      <div className="rounded-xl border border-border bg-card p-5">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-3 h-3 w-full max-w-2xl" />
        <Skeleton className="mt-5 h-2 w-full" />
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        {Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="mb-3 h-10 w-full last:mb-0" />)}
      </div>
    </div>
  );
}

function ReadinessSummary({ meta }: { meta: ContentAuthorityMeta }) {
  const coverage = Math.round((meta.coverage.profileCoverage + meta.coverage.regionCoverage + meta.coverage.templateCoverage) / 3 * 100);
  const stateLabel = meta.status === 'ready' ? 'Evidence ready' : meta.status === 'partial' ? 'Partial evidence' : meta.status === 'pending' ? 'Analysis in progress' : meta.status === 'failed' ? 'Analysis needs attention' : 'Crawl required';

  return (
    <section className="rounded-xl border border-border bg-card" aria-labelledby="authority-readiness-title">
      <div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
            <Network className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="authority-readiness-title" className="font-semibold text-foreground">{stateLabel}</h2>
              {confidenceBadge(meta.confidence)}
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{meta.message}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4 lg:shrink-0">
          <div><span className="block text-xs text-muted-foreground">Pages</span><strong>{compact(meta.counts.pageCount)}</strong></div>
          <div><span className="block text-xs text-muted-foreground">Regions</span><strong>{compact(meta.counts.regionCount)}</strong></div>
          <div><span className="block text-xs text-muted-foreground">Templates</span><strong>{compact(meta.counts.templateCount)}</strong></div>
          <div><span className="block text-xs text-muted-foreground">Coverage</span><strong>{coverage}%</strong></div>
        </div>
      </div>
      <div className="border-t border-border px-5 py-3">
        <Progress value={coverage} aria-label={`${coverage}% evidence coverage`} className="h-1.5" />
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>Page roles {percent(meta.coverage.profileCoverage)}</span>
          <span>Semantic regions {percent(meta.coverage.regionCoverage)}</span>
          <span>Template families {percent(meta.coverage.templateCoverage)}</span>
        </div>
      </div>
    </section>
  );
}

function PageEvidenceSheet({ evidence, loading, open, onOpenChange }: { evidence: ContentAuthorityPageEvidence | null; loading: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const page = evidence?.page;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle>{page?.crawl.title || 'Page evidence'}</SheetTitle>
          <SheetDescription className="break-all">{page?.crawl.url || 'Loading stored semantic evidence...'}</SheetDescription>
        </SheetHeader>
        {loading ? (
          <div className="space-y-3 p-4"><Skeleton className="h-20 w-full" /><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></div>
        ) : page ? (
          <div className="space-y-5 p-4">
            <div className="flex flex-wrap items-center gap-2">
              {confidenceBadge(page.confidence)}
              {page.pageType && <Badge variant="outline">{page.pageType}</Badge>}
              {page.primaryTask && <Badge variant="secondary">{page.primaryTask}</Badge>}
            </div>
            <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3 text-sm">
              <div><dt className="text-xs text-muted-foreground">Status</dt><dd className="mt-1 font-medium">{page.crawl.statusCode || 'Unknown'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Words</dt><dd className="mt-1 font-medium">{page.crawl.wordCount?.toLocaleString() || 'Unknown'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Depth</dt><dd className="mt-1 font-medium">{page.crawl.depth ?? 'Unknown'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Regions</dt><dd className="mt-1 font-medium">{page.regions.length}</dd></div>
            </dl>
            <section aria-labelledby="semantic-regions-title">
              <h3 id="semantic-regions-title" className="font-semibold text-foreground">Semantic regions</h3>
              <p className="mt-1 text-sm text-muted-foreground">Visible page sections ranked by their semantic evidence.</p>
              <div className="mt-3 divide-y divide-border rounded-lg border border-border">
                {page.regions.length ? page.regions.map((region, index) => (
                  <article key={`${region.regionIndex}-${index}`} className="p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{region.regionRole || 'unclassified'}</Badge>
                        {region.headingChain.length > 0 && <span className="text-xs text-muted-foreground">{region.headingChain.join(' / ')}</span>}
                      </div>
                      <span className="text-xs font-medium text-muted-foreground">{region.confidence === null ? 'No confidence' : percent(region.confidence)}</span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-foreground">{region.text || 'No extracted text.'}</p>
                    {region.selector && <code className="mt-2 block break-all text-xs text-muted-foreground">{region.selector}</code>}
                  </article>
                )) : <p className="p-4 text-sm text-muted-foreground">No semantic regions were stored for this page.</p>}
              </div>
            </section>
          </div>
        ) : (
          <div className="p-4 text-sm text-muted-foreground">Page evidence is unavailable.</div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function VisualSemanticsView({
  onOpenCrawlInventory,
  siteUrl,
}: {
  onOpenCrawlInventory?: () => void;
  siteUrl: string;
}) {
  const [activeView, setActiveView] = useState<'pages' | 'templates'>('pages');
  const [meta, setMeta] = useState<ContentAuthorityMeta | null>(null);
  const [pages, setPages] = useState<ContentAuthorityPage[]>([]);
  const [templates, setTemplates] = useState<ContentAuthorityTemplate[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<ContentAuthorityPageEvidence | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const requestFence = useRef(createVisualSemanticsRequestFence()).current;
  const currentSiteUrl = useRef(siteUrl);
  currentSiteUrl.current = siteUrl;

  useEffect(() => {
    requestFence.cancelAll();
    setActiveView('pages');
    setMeta(null);
    setPages([]);
    setTemplates([]);
    setTotal(0);
    setOffset(0);
    setSearch('');
    setDebouncedSearch('');
    setLoading(true);
    setError(null);
    setSelectedEvidence(null);
    setEvidenceOpen(false);
    setEvidenceLoading(false);
  }, [requestFence, siteUrl]);

  useEffect(() => () => requestFence.cancelAll(), [requestFence]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => setOffset(0), [siteUrl, debouncedSearch]);

  useEffect(() => {
    const selectionKey = getVisualSemanticsWorkspaceKey({
      activeView,
      offset,
      search: debouncedSearch,
      siteUrl,
    });
    const ticket = requestFence.begin('workspace', selectionKey);
    const isCurrent = () => currentSiteUrl.current === siteUrl
      && requestFence.isCurrent('workspace', ticket, selectionKey);
    setLoading(true);
    setError(null);
    const load = activeView === 'pages'
      ? Promise.all([
          ContentAuthorityService.getReadiness(siteUrl),
          ContentAuthorityService.getPages(siteUrl, { limit: PAGE_SIZE, offset, search: debouncedSearch }),
        ]).then(([readiness, result]) => {
          if (!isCurrent()) return;
          setMeta(readiness);
          setPages(result.rows);
          setTotal(result.page.total);
        })
      : Promise.all([
          ContentAuthorityService.getReadiness(siteUrl),
          ContentAuthorityService.getTemplates(siteUrl),
        ]).then(([readiness, result]) => {
          if (!isCurrent()) return;
          setMeta(readiness);
          setTemplates(result.rows);
          setTotal(result.rows.length);
        });

    load.catch((cause) => {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : 'Content authority evidence could not be loaded.');
    }).finally(() => {
      if (isCurrent()) setLoading(false);
    });

    return () => requestFence.cancel('workspace');
  }, [activeView, debouncedSearch, offset, requestFence, siteUrl]);

  const inspectPage = async (pageKey: string) => {
    const requestSiteUrl = siteUrl;
    const selectionKey = getVisualSemanticsEvidenceKey(requestSiteUrl, pageKey);
    const ticket = requestFence.begin('evidence', selectionKey);
    const isCurrent = () => currentSiteUrl.current === requestSiteUrl
      && requestFence.isCurrent('evidence', ticket, selectionKey);
    setEvidenceOpen(true);
    setEvidenceLoading(true);
    setSelectedEvidence(null);
    try {
      const evidence = await ContentAuthorityService.getPageEvidence(requestSiteUrl, pageKey);
      if (!isCurrent()) return;
      setSelectedEvidence(evidence);
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : 'Page evidence could not be loaded.');
      setEvidenceOpen(false);
    } finally {
      if (isCurrent()) setEvidenceLoading(false);
    }
  };

  const handleEvidenceOpenChange = (open: boolean) => {
    setEvidenceOpen(open);
    if (!open) {
      requestFence.cancel('evidence');
      setEvidenceLoading(false);
      setSelectedEvidence(null);
    }
  };

  if (loading && !meta) return <AuthoritySkeleton />;

  return (
    <div className="space-y-4">
      {error && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div><p className="font-semibold">Visual semantics evidence could not be loaded</p><p className="mt-1">{error}</p></div>
        </div>
      )}
      {meta && <ReadinessSummary meta={meta} />}

      <section className="overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="authority-workspace-title">
        <div className="flex flex-col gap-4 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 id="authority-workspace-title" className="font-semibold text-foreground">Visual semantics evidence</h2>
            <p className="mt-1 text-sm text-muted-foreground">Inspect page purpose, centerpiece regions, and repeated template structure from the latest stored crawl.</p>
          </div>
          <div className="inline-flex w-fit rounded-lg bg-muted p-1" aria-label="Authority evidence view">
            <Button size="sm" variant={activeView === 'pages' ? 'outline' : 'ghost'} onClick={() => setActiveView('pages')}><FileSearch />Pages</Button>
            <Button size="sm" variant={activeView === 'templates' ? 'outline' : 'ghost'} onClick={() => setActiveView('templates')}><LayoutTemplate />Templates</Button>
          </div>
        </div>

        {activeView === 'pages' && (
          <div className="border-b border-border p-4">
            <label className="relative block max-w-xl">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search analyzed pages" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search URL or title" className="pl-9" />
              <span className="sr-only">Search analyzed pages</span>
            </label>
          </div>
        )}

        {loading ? (
          <div className="space-y-3 p-5" role="status"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading stored evidence</div>{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-10 w-full" />)}</div>
        ) : activeView === 'pages' ? (
          pages.length ? (
            <>
              <Table>
                <TableHeader><TableRow><TableHead>Page</TableHead><TableHead>Purpose</TableHead><TableHead>Semantic evidence</TableHead><TableHead>Template</TableHead><TableHead>Confidence</TableHead><TableHead className="w-12"><span className="sr-only">Inspect</span></TableHead></TableRow></TableHeader>
                <TableBody>{pages.map((page) => (
                  <TableRow key={page.pageKey}>
                    <TableCell className="max-w-[360px]"><p className="truncate font-medium text-foreground" title={page.title || page.url || page.pageKey}>{page.title || page.url || page.pageKey}</p><p className="mt-1 truncate text-xs text-muted-foreground" title={page.url || page.pageKey}>{page.url || page.pageKey}</p></TableCell>
                    <TableCell><p className="font-medium">{page.pageType || 'Unclassified'}</p><p className="mt-1 text-xs text-muted-foreground">{page.primaryTask || 'No primary task'}</p></TableCell>
                    <TableCell><p className="font-medium">{page.regions.count} regions</p><p className="mt-1 max-w-[240px] truncate text-xs text-muted-foreground">{page.topEvidence?.role || 'No centerpiece'}{page.topEvidence?.text ? ` · ${page.topEvidence.text}` : ''}</p></TableCell>
                    <TableCell><p className="font-medium">{page.template ? `${page.template.memberCount} pages` : 'Unique'}</p><p className="mt-1 max-w-[180px] truncate text-xs text-muted-foreground">{page.template?.urlSkeleton || 'No template family'}</p></TableCell>
                    <TableCell>{confidenceBadge(page.confidence)}</TableCell>
                    <TableCell><Button variant="ghost" size="icon-sm" onClick={() => void inspectPage(page.pageKey)} aria-label={`Inspect evidence for ${page.title || page.url || page.pageKey}`}><ChevronRight /></Button></TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
              <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <span>Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()} pages</span>
                <div className="flex gap-2"><Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft />Previous</Button><Button variant="outline" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next<ChevronRight /></Button></div>
              </div>
            </>
          ) : <div className="px-5 py-14 text-center"><FileSearch className="mx-auto h-6 w-6 text-muted-foreground" /><h3 className="mt-3 font-semibold">No analyzed pages found</h3><p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">{search ? 'No stored pages match this search.' : meta?.message || 'Run a crawl to collect visual semantics evidence.'}</p>{!search && onOpenCrawlInventory && <Button className="mt-4" variant="outline" onClick={onOpenCrawlInventory}>Open Crawl Inventory</Button>}</div>
        ) : templates.length ? (
          <Table>
            <TableHeader><TableRow><TableHead>Template family</TableHead><TableHead>Pages</TableHead><TableHead>Common page purpose</TableHead><TableHead>Exemplar evidence</TableHead><TableHead>Confidence</TableHead></TableRow></TableHeader>
            <TableBody>{templates.map((template) => (
              <TableRow key={template.templateKey}>
                <TableCell className="max-w-[360px]"><p className="font-medium">{template.urlSkeleton || 'Unlabelled template'}</p><p className="mt-1 truncate text-xs text-muted-foreground">{template.templateKey}</p></TableCell>
                <TableCell className="font-medium">{template.memberCount.toLocaleString()}</TableCell>
                <TableCell><p className="font-medium">{template.evidence.pageTypes[0]?.value || 'Mixed'}</p><p className="mt-1 text-xs text-muted-foreground">{template.evidence.primaryTasks[0]?.value || 'No dominant task'}</p></TableCell>
                <TableCell className="max-w-[360px]"><p className="truncate text-sm">{template.topEvidence?.text || 'No exemplar region stored'}</p><p className="mt-1 text-xs text-muted-foreground">{template.evidence.exemplarRegions} exemplar regions</p></TableCell>
                <TableCell>{confidenceBadge(template.confidence)}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        ) : <div className="px-5 py-14 text-center"><LayoutTemplate className="mx-auto h-6 w-6 text-muted-foreground" /><h3 className="mt-3 font-semibold">No template families found</h3><p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">Template families appear after stored crawl pages have enough repeated structure to classify.</p></div>}
      </section>

      <PageEvidenceSheet evidence={selectedEvidence} loading={evidenceLoading} open={evidenceOpen} onOpenChange={handleEvidenceOpenChange} />
    </div>
  );
}
