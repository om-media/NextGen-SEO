import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { AlertCircle, CheckCircle2, Download, ExternalLink, FileText, Link2, Loader2, Play, RefreshCw, RotateCcw, Search, StopCircle, XCircle } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  cancelInternalLinkJob,
  estimateInternalLinkAnalysis,
  fetchInternalLinkProviderSettings,
  fetchInternalLinkProviderStatus,
  fetchInternalLinkJobs,
  fetchInternalLinkOpportunities,
  rerunInternalLinkJob,
  startInternalLinkAnalysis,
  startWorkspaceInternalLinkAnalysis,
  updateInternalLinkOpportunity,
  type InternalLinkAnalysisEstimate,
  type InternalLinkAnalysisJob,
  type InternalLinkOpportunity,
  type InternalLinkProviderSetting,
  type InternalLinkProviderStatus,
} from '@/src/services/internalLinksService';
import { fetchCrawlStatus, startCrawl, type CrawlJob, type CrawlSummary } from '@/src/services/crawlService';
import type { QueueMetadata } from '@/src/services/queueMetadata';

type InternalLinksViewProps = {
  dateRange: DateRange;
  siteUrl: string;
};

type OpportunityGroup = {
  sourceTitle: string;
  sourceUrl: string;
  rows: InternalLinkOpportunity[];
};

const embeddingProviderOptions = [
  { label: 'Built-in BGE-M3', model: 'BAAI/bge-m3', value: 'local' },
  { label: 'Ollama', model: 'bge-m3', value: 'ollama' },
  { label: 'Local rules fallback', model: 'local-rules', value: 'local-rules' },
  { label: 'OpenAI', model: 'text-embedding-3-small', value: 'openai' },
  { label: 'Cohere', model: 'embed-v4.0', value: 'cohere' },
  { label: 'Jina', model: 'jina-embeddings-v3', value: 'jina' },
  { label: 'Voyage', model: 'voyage-3-lite', value: 'voyage' },
];

const reviewProviderOptions = [
  { label: 'Local rules', model: 'rules-editorial-v1', value: 'local' },
  { label: 'Ollama judge', model: 'llama3.1', value: 'ollama' },
  { label: 'OpenAI', model: 'gpt-4o-mini', value: 'openai' },
  { label: 'Gemini', model: 'gemini-2.5-flash', value: 'gemini' },
  { label: 'Anthropic', model: 'claude-3-5-haiku-latest', value: 'anthropic' },
  { label: 'OpenRouter', model: 'openrouter/auto', value: 'openrouter' },
];

function isHostedEmbeddingProvider(value: string) {
  return value !== 'local' && value !== 'local-rules' && value !== 'ollama';
}

function defaultEmbeddingModel(value: string) {
  return embeddingProviderOptions.find((option) => option.value === value)?.model || 'BAAI/bge-m3';
}

function modelFromSettings(settings: InternalLinkProviderSetting[], provider: string, modelType: 'embedding' | 'review') {
  if (provider === 'local' || provider === 'local-rules') return null;
  const setting = settings.find((entry) => entry.provider === provider && entry.enabled);
  return modelType === 'embedding' ? setting?.embeddingModel || null : setting?.reviewModel || null;
}

function providerConfigured(settings: InternalLinkProviderSetting[], provider: string) {
  if (provider === 'local' || provider === 'local-rules') return true;
  const setting = settings.find((entry) => entry.provider === provider && entry.enabled);
  return !!setting && (!!setting.baseUrl || !!setting.hasApiKey || !!setting.embeddingModel || !!setting.reviewModel);
}

function isHostedReviewProvider(value: string) {
  return value !== 'local' && value !== 'local-rules' && value !== 'ollama';
}

function defaultReviewModel(value: string) {
  return reviewProviderOptions.find((option) => option.value === value)?.model || 'rules-editorial-v1';
}

function semanticRuntimeLabel(value: string) {
  return value === 'ollama' ? 'Ollama' : 'BGE-M3';
}

const pageSize = 200;
const formatNumber = (value: number) => new Intl.NumberFormat('en-US').format(Math.round(value || 0));
const formatMoney = (value: number | null | undefined) => `$${Number(value || 0).toFixed(4)}`;

function vectorStoreLabel(estimate: InternalLinkAnalysisEstimate | null) {
  const store = estimate?.vectorStore;
  if (!store) return 'Checking...';
  if (store.provider === 'pgvector' && store.available) return store.indexed ? 'pgvector · HNSW' : 'pgvector';
  return 'JSON cache fallback';
}

function formatDate(value: Date | undefined, fallbackDaysAgo: number) {
  const date = value || new Date(Date.now() - fallbackDaysAgo * 24 * 60 * 60 * 1000);
  return format(date, 'yyyy-MM-dd');
}

function typeLabel(value: string) {
  if (value === 'orphan-risk') return 'Orphan risk';
  if (value === 'striking-distance') return 'Striking distance';
  if (value === 'visibility-gap') return 'Visibility gap';
  return 'Link gap';
}

function statusLabel(value: string) {
  if (value === 'implemented') return 'Implemented';
  if (value === 'approved') return 'Approved';
  if (value === 'rejected') return 'Rejected';
  if (value === 'stale') return 'Stale';
  return 'New';
}

function formatQueueWait(seconds: number | null) {
  if (seconds === null) return 'Learning from recent runs';
  if (seconds < 60) return 'Under a minute';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `About ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `About ${hours}h ${remainder}m` : `About ${hours}h`;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return 'Not started';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { day: 'numeric', hour: '2-digit', minute: '2-digit', month: 'short' });
}

function jobProgress(job: InternalLinkAnalysisJob) {
  const total = Math.max(Number(job.progressTotal || 0), 0);
  const done = Math.max(Number(job.progressCompleted || 0), 0);
  if (job.status === 'completed') return '100%';
  if (job.status === 'error' || job.status === 'canceled') return 'stopped';
  if (!total) return '0%';
  return `${Math.min(99, Math.round((done / total) * 100))}%`;
}

function jobProgressDetail(job: InternalLinkAnalysisJob) {
  const done = Math.max(Number(job.progressCompleted || 0), 0);
  const total = Math.max(Number(job.progressTotal || 0), 0);
  if (job.status === 'completed') return `${formatNumber(done)} recommendations`;
  if (job.status === 'error' || job.status === 'canceled') return done ? `${formatNumber(done)} saved before stop` : 'No recommendations saved';
  return `${formatNumber(done)} / ${formatNumber(total)}`;
}

function crawlProcessedCount(job: CrawlJob | null) {
  if (!job) return 0;
  return Math.min(
    Math.max(Number(job.discoveredCount || 0), 0),
    Math.max(Number(job.crawledCount || 0), 0) + Math.max(Number(job.errorCount || 0), 0) + Math.max(Number(job.skippedCount || 0), 0),
  );
}

function crawlProgress(job: CrawlJob | null) {
  const total = Math.max(Number(job?.discoveredCount || 0), 0);
  if (!total) return 0;
  return Math.min(100, Math.round((crawlProcessedCount(job) / total) * 100));
}

function isActiveCrawl(job: CrawlJob | null) {
  return !!job && ['queued', 'retrying', 'running'].includes(job.status);
}

function statusClass(value: string) {
  if (value === 'implemented') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (value === 'approved') return 'border-blue-200 bg-blue-50 text-blue-700';
  if (value === 'rejected') return 'border-red-200 bg-red-50 text-red-700';
  if (value === 'stale') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-border bg-muted text-muted-foreground';
}

function scoreBreakdownItems(row: InternalLinkOpportunity) {
  const score = row.scoreBreakdown;
  return [
    ['Target need', score.targetNeed],
    ['Source authority', score.sourceAuthority],
    ['Topic match', score.topicMatch],
    ['Semantic boost', score.semanticBoost],
    ['Anchor quality', score.anchorQuality],
    ['Safety', score.safety],
  ] as Array<[string, number]>;
}

function formatScoreBreakdown(row: InternalLinkOpportunity) {
  const items = scoreBreakdownItems(row).map(([label, value]) => `${label}: ${Math.round(value)}`);
  if (row.scoreBreakdown.diversityPenalty > 0) items.push(`Diversity penalty: -${Math.round(row.scoreBreakdown.diversityPenalty)}`);
  return items.join('; ');
}

function scoreNotes(row: InternalLinkOpportunity) {
  return row.scoreBreakdown.notes.filter((note) => note.trim()).join(' ');
}

function modelVersionBadges(modelVersion: string | null | undefined) {
  const value = modelVersion || '';
  const badges: string[] = [];
  if (value.includes('semantic:local:BAAI/bge-m3') || value.includes('semantic:local:bge-m3') || value.includes('semantic:ollama:bge-m3')) badges.push('BGE-M3');
  if (value.includes('retrieval:pgvector')) badges.push('pgvector');
  if (value.includes('retrieval:memory')) badges.push('memory retrieval');
  if (value.includes('retrieval:lexical')) badges.push('lexical retrieval');
  const cache = value.match(/cache:(\d+\/\d+)/);
  if (cache?.[1]) badges.push(`cache ${cache[1]}`);
  const judge = value.match(/judge:([^:]+):([^:]+):accepted:(\d+\/\d+)/);
  if (judge) badges.push(`${judge[1]} judge ${judge[3]}`);
  if (value.includes('not-connected')) badges.push('fallback');
  return badges;
}

function jobUsageDetail(job: InternalLinkAnalysisJob) {
  const embeddingTokens = Number(job.actualEmbeddingTokens || 0);
  const reviewTokens = Number(job.actualReviewTokens || 0);
  if (!embeddingTokens && !reviewTokens) return '0 fresh AI tokens';
  return `${formatNumber(embeddingTokens)} embed tokens · ${formatNumber(reviewTokens)} review tokens`;
}
function highlightAnchor(row: InternalLinkOpportunity) {
  const sentence = row.source.sentence;
  const start = Math.max(0, Math.min(row.anchorStart, sentence.length));
  const end = Math.max(start, Math.min(row.anchorEnd, sentence.length));
  if (!sentence || end <= start) return sentence || row.anchorText;
  return (
    <>
      {sentence.slice(0, start)}
      <mark className="rounded bg-yellow-200 px-1 font-semibold text-foreground">{sentence.slice(start, end)}</mark>
      {sentence.slice(end)}
    </>
  );
}

function downloadTextFile(contents: string, filename: string, type: string) {
  const blob = new Blob([contents], { type });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

function exportCsv(rows: InternalLinkOpportunity[]) {
  const headers = ['Status', 'Source URL', 'Source Title', 'Source Sentence', 'Anchor Text', 'Target URL', 'Target Title', 'Reader Benefit', 'User Note', 'Confidence', 'Priority Score', 'Score Breakdown', 'Score Notes'];
  const escape = (value: unknown) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = rows.map((row) => [row.status, row.source.url, row.source.title || '', row.source.sentence, row.anchorText, row.target.url, row.target.title || '', row.readerBenefit, row.userNote || '', row.confidence, row.priorityScore, formatScoreBreakdown(row), scoreNotes(row)]);
  const csv = [headers, ...body].map((line) => line.map(escape).join(',')).join('\n');
  downloadTextFile(csv, `internal-link-editorial-brief-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8;');
}

function exportMarkdown(groups: OpportunityGroup[]) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    '# Internal link editorial brief',
    '',
    `Exported: ${today}`,
    '',
  ];

  for (const group of groups) {
    lines.push(`## ${group.sourceTitle}`, '', `Source: ${group.sourceUrl}`, '');
    for (const row of group.rows) {
      lines.push(
        `### ${row.anchorText}`,
        '',
        `- Status: ${statusLabel(row.status)}`,
        `- Target: ${row.target.title || row.target.url}`,
        `- Target URL: ${row.target.url}`,
        `- Confidence: ${row.confidence}`,
        `- Opportunity: ${typeLabel(row.opportunityType)}`,
        `- Priority score: ${row.priorityScore}`,
        `- Score breakdown: ${formatScoreBreakdown(row)}`,
        `- Reader benefit: ${row.readerBenefit}`,
        `- Source sentence: ${row.source.sentence}`,
      );
      if (scoreNotes(row)) lines.push(`- Score notes: ${scoreNotes(row)}`);
      if (row.userNote?.trim()) lines.push(`- User note: ${row.userNote.trim()}`);
      lines.push('');
    }
  }

  downloadTextFile(lines.join('\n'), `internal-link-editorial-brief-${today}.md`, 'text/markdown;charset=utf-8;');
}

function groupRows(rows: InternalLinkOpportunity[]): OpportunityGroup[] {
  const groups = new Map<string, OpportunityGroup>();
  for (const row of rows) {
    const key = row.source.url;
    const group = groups.get(key) || { sourceTitle: row.source.title || row.source.url, sourceUrl: row.source.url, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => b.rows.length - a.rows.length || a.sourceTitle.localeCompare(b.sourceTitle));
}

export function InternalLinksView({ dateRange, siteUrl }: InternalLinksViewProps) {
  const [rows, setRows] = useState<InternalLinkOpportunity[]>([]);
  const [jobs, setJobs] = useState<InternalLinkAnalysisJob[]>([]);
  const [activeJob, setActiveJob] = useState<InternalLinkAnalysisJob | null>(null);
  const [queue, setQueue] = useState<QueueMetadata | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [totals, setTotals] = useState({ highPriority: 0, implemented: 0, opportunities: 0, ready: 0, stale: 0 });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<InternalLinkAnalysisEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [crawlJob, setCrawlJob] = useState<CrawlJob | null>(null);
  const [crawlQueue, setCrawlQueue] = useState<QueueMetadata | null>(null);
  const [crawlSummary, setCrawlSummary] = useState<CrawlSummary | null>(null);
  const [crawlLoading, setCrawlLoading] = useState(false);
  const [providerSettings, setProviderSettings] = useState<InternalLinkProviderSetting[]>([]);
  const [providerSettingsLoading, setProviderSettingsLoading] = useState(false);
  const [embeddingStatus, setEmbeddingStatus] = useState<InternalLinkProviderStatus | null>(null);
  const [embeddingStatusLoading, setEmbeddingStatusLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [batchStarting, setBatchStarting] = useState(false);
  const [crawlStarting, setCrawlStarting] = useState(false);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [noteSavingId, setNoteSavingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [confidence, setConfidence] = useState('all');
  const [status, setStatus] = useState('all');
  const [opportunityType, setOpportunityType] = useState('all');
  const [targetFolder, setTargetFolder] = useState('all');
  const [embeddingProvider, setEmbeddingProvider] = useState('local');
  const [embeddingModel, setEmbeddingModel] = useState('BAAI/bge-m3');
  const [reviewProvider, setReviewProvider] = useState('local');
  const [reviewModel, setReviewModel] = useState('rules-editorial-v1');
  const [hostedSpendCap, setHostedSpendCap] = useState('1.00');

  const startDate = useMemo(() => formatDate(dateRange.from, 28), [dateRange.from]);
  const endDate = useMemo(() => formatDate(dateRange.to || dateRange.from, 0), [dateRange.from, dateRange.to]);
  const groups = useMemo(() => groupRows(rows), [rows]);
  const isRunning = activeJob?.status === 'queued' || activeJob?.status === 'running';
  const crawlRunning = isActiveCrawl(crawlJob);
  const embeddingConfigured = providerConfigured(providerSettings, embeddingProvider);
  const reviewConfigured = providerConfigured(providerSettings, reviewProvider);
  const usesLocalSemanticEmbedding = embeddingProvider === 'local' || embeddingProvider === 'ollama';
  const usableSentenceCount = Number(estimate?.estimatedLocalUnits || 0);
  const recrawlSignal = [message, estimateError].filter(Boolean).join(' ').toLowerCase();
  const needsFreshCrawl = recrawlSignal.includes('recrawl') || recrawlSignal.includes('sentence-level context') || recrawlSignal.includes('run a crawl') || (!!estimate && usableSentenceCount <= 0);
  const analysisBlockedByCrawl = crawlRunning || crawlStarting || needsFreshCrawl;
  const getDraftNote = (row: InternalLinkOpportunity) => noteDrafts[row.id] ?? row.userNote ?? '';

  const loadJobs = async () => {
    if (!siteUrl) return;
    const result = await fetchInternalLinkJobs(siteUrl);
    setJobs(result.jobs);
    setQueue(result.queue ?? null);
    setActiveJob((current) => current && result.jobs.some((job) => job.id === current.id) ? result.jobs.find((job) => job.id === current.id) || current : result.jobs[0] || null);
  };

  const loadRows = async () => {
    if (!siteUrl) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchInternalLinkOpportunities({
        confidence,
        endDate,
        jobId: activeJob?.id || null,
        limit: pageSize,
        offset: 0,
        opportunityType,
        query: searchTerm,
        siteUrl,
        startDate,
        status,
        targetFolder,
      });
      setRows(result.rows);
      setQueue(result.queue ?? null);
      setFolders(result.meta.folders || []);
      setTotals(result.meta.totals);
      setMessage(result.meta.message);
      if (result.job) setActiveJob(result.job);
    } catch (err: any) {
      setError(err.message || 'Failed to load internal link opportunities');
    } finally {
      setLoading(false);
    }
  };

  const loadCrawlStatus = async () => {
    if (!siteUrl) return;
    setCrawlLoading(true);
    try {
      const result = await fetchCrawlStatus(siteUrl);
      setCrawlJob(result.job);
      setCrawlQueue(result.queue ?? null);
      setCrawlSummary(result.summary);
    } catch (err: any) {
      setError(err.message || 'Failed to load crawl status');
    } finally {
      setCrawlLoading(false);
    }
  };

  const loadProviderSettings = async () => {
    setProviderSettingsLoading(true);
    try {
      const result = await fetchInternalLinkProviderSettings();
      setProviderSettings(result.settings);
    } catch (err: any) {
      setError(err.message || 'Failed to load internal link provider settings');
    } finally {
      setProviderSettingsLoading(false);
    }
  };

  const loadEmbeddingStatus = async () => {
    if (!usesLocalSemanticEmbedding) {
      setEmbeddingStatus(null);
      return null;
    }

    setEmbeddingStatusLoading(true);
    try {
      const result = await fetchInternalLinkProviderStatus(embeddingProvider, embeddingModel);
      setEmbeddingStatus(result.status);
      return result.status;
    } finally {
      setEmbeddingStatusLoading(false);
    }
  };

  const ensureEmbeddingProviderReady = async () => {
    if (!usesLocalSemanticEmbedding) return true;
    const runtimeLabel = semanticRuntimeLabel(embeddingProvider);

    try {
      const status = await loadEmbeddingStatus();
      if (status?.available) return true;
      const message = status?.message || `${runtimeLabel} is unavailable.`;
      setError(message);
      toast.error(`${runtimeLabel} is not ready`, { description: message });
      return false;
    } catch (err: any) {
      const message = err.message || `Unable to verify the ${runtimeLabel} provider.`;
      setError(message);
      toast.error(`${runtimeLabel} check failed`, { description: message });
      return false;
    }
  };

  const selectEmbeddingProvider = (value: string) => {
    setEmbeddingProvider(value);
    setEmbeddingModel(modelFromSettings(providerSettings, value, 'embedding') || defaultEmbeddingModel(value));
  };

  const selectReviewProvider = (value: string) => {
    setReviewProvider(value);
    setReviewModel(modelFromSettings(providerSettings, value, 'review') || defaultReviewModel(value));
  };
  const loadEstimate = async () => {
    if (!siteUrl) return;
    setEstimateLoading(true);
    setEstimateError(null);
    try {
      const result = await estimateInternalLinkAnalysis({
        embeddingModel,
        embeddingProvider,
        endDate,
        maxHostedSpend: isHostedEmbeddingProvider(embeddingProvider) || isHostedReviewProvider(reviewProvider) ? Number(hostedSpendCap || 0) : 0,
        maxPages: 1000,
        maxRecommendations: 500,
        maxSentencesPerPage: 50,
        reviewModel,
        reviewProvider,
        siteUrl,
        startDate,
      });
      setEstimate(result.estimate);
    } catch (err: any) {
      setEstimate(null);
      setEstimateError(err.message || 'Run a crawl to estimate internal link analysis.');
    } finally {
      setEstimateLoading(false);
    }
  };
  const handleStartFreshCrawl = async () => {
    setCrawlStarting(true);
    setError(null);
    try {
      const result = await startCrawl({
        renderMode: 'html',
        siteUrl,
        startUrl: siteUrl,
      });
      setCrawlJob(result.job);
      setCrawlQueue(result.queue ?? null);
      setCrawlSummary(null);
      void loadEstimate().catch(() => {});
      setMessage(result.job.status === 'completed'
        ? 'Fresh crawl is available. Run internal link analysis again.'
        : 'Fresh crawl queued. This page will update while the crawler collects sentence-level context.');
      toast.success(result.job.status === 'completed' ? 'Fresh crawl ready' : 'Fresh crawl queued', {
        description: result.job.status === 'completed'
          ? 'Run internal link analysis again to use the new sentence extraction.'
          : 'The crawler is collecting sentence-level context for this site.',
      });
    } catch (err: any) {
      setError(err.message || 'Failed to start fresh crawl');
      toast.error('Fresh crawl failed to start', { description: err.message || 'Unable to queue crawl.' });
    } finally {
      setCrawlStarting(false);
    }
  };
  const handleStartAnalysis = async () => {
    setStarting(true);
    setError(null);
    try {
      if (!(await ensureEmbeddingProviderReady())) return;
      const result = await startInternalLinkAnalysis({
        embeddingModel,
        embeddingProvider,
        endDate,
        maxHostedSpend: isHostedEmbeddingProvider(embeddingProvider) || isHostedReviewProvider(reviewProvider) ? Number(hostedSpendCap || 0) : 0,
        maxPages: 1000,
        maxRecommendations: 500,
        maxSentencesPerPage: 50,
        reviewModel,
        reviewProvider,
        siteUrl,
        startDate,
      });
      setActiveJob(result.job);
      setQueue(result.queue ?? null);
      toast.success('Internal link analysis queued', { description: embeddingProvider === 'local-rules' ? 'The lexical fallback worker will process this site in the background.' : 'The BGE-M3 semantic worker will process this site in the background.' });
      await loadJobs();
      await loadRows();
    } catch (err: any) {
      setError(err.message || 'Failed to start analysis');
      toast.error('Analysis failed to start', { description: err.message || 'Unable to queue internal link analysis.' });
    } finally {
      setStarting(false);
    }
  };

  const handleWorkspaceAnalysis = async () => {
    setBatchStarting(true);
    setError(null);
    try {
      if (!(await ensureEmbeddingProviderReady())) return;
      const result = await startWorkspaceInternalLinkAnalysis({
        embeddingModel,
        embeddingProvider,
        endDate,
        maxHostedSpend: isHostedEmbeddingProvider(embeddingProvider) || isHostedReviewProvider(reviewProvider) ? Number(hostedSpendCap || 0) : 0,
        maxPages: 1000,
        maxRecommendations: 500,
        maxSentencesPerPage: 50,
        reviewModel,
        reviewProvider,
        siteUrl,
        startDate,
      });

      toast.success('Workspace analysis queued', {
        description: `${formatNumber(result.totals.queued)} queued, ${formatNumber(result.totals.skipped)} already active, ${formatNumber(result.totals.failures)} skipped.` ,
      });
      await loadJobs();
      await loadRows();
    } catch (err: any) {
      setError(err.message || 'Failed to queue workspace analysis');
      toast.error('Workspace analysis failed', { description: err.message || 'Unable to queue workspace analysis.' });
    } finally {
      setBatchStarting(false);
    }
  };
  const cancelJob = async (job: InternalLinkAnalysisJob) => {
    setJobActionId(job.id);
    try {
      const result = await cancelInternalLinkJob(job.id);
      setActiveJob(result.job);
      setQueue(result.queue ?? null);
      toast.success('Analysis canceled');
      await loadJobs();
      await loadRows();
    } catch (err: any) {
      toast.error('Cancel failed', { description: err.message || 'Unable to cancel analysis.' });
    } finally {
      setJobActionId(null);
    }
  };

  const rerunJob = async (job: InternalLinkAnalysisJob) => {
    setJobActionId(job.id);
    try {
      const result = await rerunInternalLinkJob(job.id);
      setActiveJob(result.job);
      setQueue(result.queue ?? null);
      toast.success('Analysis queued again', { description: 'The rerun uses the same provider, limits, and date range.' });
      await loadJobs();
      await loadRows();
    } catch (err: any) {
      toast.error('Rerun failed', { description: err.message || 'Unable to rerun analysis.' });
    } finally {
      setJobActionId(null);
    }
  };
  const saveNote = async (row: InternalLinkOpportunity) => {
    const nextNote = getDraftNote(row);
    const normalizedNote = nextNote.trim() ? nextNote : null;
    if ((row.userNote || '') === (normalizedNote || '')) return;

    setNoteSavingId(row.id);
    try {
      const result = await updateInternalLinkOpportunity({ id: row.id, note: normalizedNote, status: row.status });
      setRows((current) => current.map((entry) => entry.id === row.id ? result.opportunity : entry));
      setNoteDrafts((current) => ({ ...current, [row.id]: result.opportunity.userNote || '' }));
      toast.success('Note saved');
    } catch (err: any) {
      toast.error('Note failed to save', { description: err.message || 'Unable to update recommendation note.' });
    } finally {
      setNoteSavingId(null);
    }
  };

  const updateStatus = async (row: InternalLinkOpportunity, nextStatus: string) => {
    const nextNote = getDraftNote(row);
    try {
      const result = await updateInternalLinkOpportunity({ id: row.id, note: nextNote.trim() ? nextNote : null, status: nextStatus });
      setRows((current) => current.map((entry) => entry.id === row.id ? result.opportunity : entry));
      setNoteDrafts((current) => ({ ...current, [row.id]: result.opportunity.userNote || '' }));
      toast.success(nextStatus === 'implemented' ? 'Marked implemented' : 'Recommendation updated', {
        description: nextStatus === 'implemented' ? 'A site annotation was created for this internal link.' : undefined,
      });
      await loadRows();
    } catch (err: any) {
      toast.error('Update failed', { description: err.message || 'Unable to update recommendation.' });
    }
  };

  useEffect(() => {
    setActiveJob(null);
    setJobs([]);
    setRows([]);
    loadJobs().catch((err) => setError(err.message || 'Failed to load analysis jobs'));
    loadCrawlStatus().catch((err) => setError(err.message || 'Failed to load crawl status'));
    loadProviderSettings().catch((err) => setError(err.message || 'Failed to load internal link provider settings'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteUrl]);

  useEffect(() => {
    if (!providerSettings.length) return;
    setEmbeddingModel((current) => current === defaultEmbeddingModel(embeddingProvider) ? modelFromSettings(providerSettings, embeddingProvider, 'embedding') || current : current);
    setReviewModel((current) => current === defaultReviewModel(reviewProvider) ? modelFromSettings(providerSettings, reviewProvider, 'review') || current : current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerSettings]);

  useEffect(() => {
    if (!usesLocalSemanticEmbedding) {
      setEmbeddingStatus(null);
      return;
    }

    loadEmbeddingStatus().catch((err) => {
      setEmbeddingStatus({
        available: false,
        baseUrl: '',
        dimensions: null,
        message: err.message || 'Unable to check local BGE-M3.',
        model: embeddingModel,
        modelAvailable: false,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddingProvider, embeddingModel, providerSettings]);

  useEffect(() => {
    loadRows().catch((err) => setError(err.message || 'Failed to load internal link opportunities'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteUrl, startDate, endDate, activeJob?.id, searchTerm, confidence, status, opportunityType, targetFolder]);

  useEffect(() => {
    loadEstimate().catch((err) => setEstimateError(err.message || 'Failed to estimate internal link analysis'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteUrl, startDate, endDate, embeddingProvider, embeddingModel, reviewProvider, reviewModel, hostedSpendCap]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => {
      loadJobs().catch(() => {});
      loadRows().catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, siteUrl, activeJob?.id]);

  useEffect(() => {
    if (!crawlRunning) return;
    const timer = window.setInterval(() => {
      loadCrawlStatus().catch(() => {});
      loadEstimate().catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crawlRunning, siteUrl, crawlJob?.id]);

  const hostedEstimate = estimate?.totalHostedCost ?? (activeJob ? (activeJob.estimatedHostedEmbeddingCost || 0) + (activeJob.estimatedHostedReviewCost || 0) : 0);
  const hostedSpendCapNumber = Number(hostedSpendCap || 0);
  const hostedSpendBlocked = (isHostedEmbeddingProvider(embeddingProvider) || isHostedReviewProvider(reviewProvider)) && !!estimate && hostedEstimate > hostedSpendCapNumber;

  const visibleTotals = rows.length
    ? rows.reduce((summary, row) => {
        summary.opportunities += 1;
        if (row.status === 'implemented') summary.implemented += 1;
        if (row.priorityScore >= 84) summary.highPriority += 1;
        if (row.confidence !== 'low' && !row.stale && row.status !== 'implemented') summary.ready += 1;
        return summary;
      }, { highPriority: 0, implemented: 0, opportunities: 0, ready: 0 })
    : totals;
  const crawlStatusLabel = crawlLoading && !crawlJob
    ? 'Loading...'
    : crawlRunning
      ? crawlJob?.status || 'Crawling'
      : usableSentenceCount > 0
        ? 'Sentence context ready'
        : crawlJob?.status || 'No crawl found';
  const crawlProcessedLabel = crawlJob
    ? `${formatNumber(crawlProcessedCount(crawlJob))} / ${formatNumber(crawlJob.discoveredCount || 0)} URLs`
    : usableSentenceCount > 0
      ? 'Latest crawl indexed'
      : 'Not started';

  const metrics = [
    ['Recommendations', visibleTotals.opportunities],
    ['Ready', visibleTotals.ready],
    ['High priority', visibleTotals.highPriority],
    ['Implemented', visibleTotals.implemented],
  ];

  return (
    <div className="space-y-5">
      <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardHeader className="flex flex-col gap-4 border-b border-border/70 pb-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-primary" />
              <CardTitle className="text-xl">Internal links</CardTitle>
              {activeJob && <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass(activeJob.status)}`}>{activeJob.status}</span>}
            </div>
            <CardDescription className="max-w-3xl">
              Editorial internal link recommendations grouped by source article, with exact anchor placement and reader-benefit rationale.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <Select
              value={embeddingProvider}
              onValueChange={selectEmbeddingProvider}
            >
              <SelectTrigger className="h-10 w-[160px] rounded-xl border-border bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                {embeddingProviderOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input className="h-10 w-[190px] rounded-xl border-border bg-card" onChange={(event) => setEmbeddingModel(event.target.value)} value={embeddingModel} />
            <Select
              value={reviewProvider}
              onValueChange={selectReviewProvider}
            >
              <SelectTrigger className="h-10 w-[150px] rounded-xl border-border bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                {reviewProviderOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input className="h-10 w-[170px] rounded-xl border-border bg-card" onChange={(event) => setReviewModel(event.target.value)} value={reviewModel} />
            {(isHostedEmbeddingProvider(embeddingProvider) || isHostedReviewProvider(reviewProvider)) && (
              <Input
                aria-label="Max hosted spend"
                className="h-10 w-[120px] rounded-xl border-border bg-card"
                min="0"
                onChange={(event) => setHostedSpendCap(event.target.value)}
                step="0.01"
                type="number"
                value={hostedSpendCap}
              />
            )}
            <Button className="h-10 rounded-xl" onClick={handleStartAnalysis} disabled={starting || batchStarting || isRunning || hostedSpendBlocked || analysisBlockedByCrawl}>
              {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Analyze site
            </Button>
            <Button className="h-10 rounded-xl" variant="outline" onClick={handleWorkspaceAnalysis} disabled={starting || batchStarting || isRunning || hostedSpendBlocked || analysisBlockedByCrawl}>
              {batchStarting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Analyze workspace
            </Button>
            <Button className="h-10 rounded-xl" variant="outline" onClick={() => { loadJobs(); loadRows(); }} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
            <Button className="h-10 rounded-xl" variant="outline" onClick={() => exportCsv(rows)} disabled={!rows.length}>
              <Download className="mr-2 h-4 w-4" />
              CSV
            </Button>
            <Button className="h-10 rounded-xl" variant="outline" onClick={() => exportMarkdown(groups)} disabled={!rows.length}>
              <FileText className="mr-2 h-4 w-4" />
              Markdown
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"><AlertCircle className="mr-2 inline-block h-4 w-4" />{error}</div>}
          {message && (
            <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 md:flex-row md:items-center md:justify-between">
              <span>{message}</span>
              {needsFreshCrawl && (
                <Button className="h-9 rounded-xl border-amber-300 bg-white text-amber-900 hover:bg-amber-100" size="sm" variant="outline" onClick={handleStartFreshCrawl} disabled={crawlStarting || crawlRunning}>
                  {crawlStarting || crawlRunning ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                  Start fresh crawl
                </Button>
              )}
            </div>
          )}

          <div className="grid gap-3 rounded-2xl border border-border bg-background p-4 text-sm md:grid-cols-[1fr_1fr_1fr_auto] md:items-center">
            <div>
              <span className="text-muted-foreground">Crawl status</span>
              <div className="font-semibold text-foreground">{crawlStatusLabel}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Processed</span>
              <div className="font-semibold text-foreground">{crawlProcessedLabel}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Usable sentences</span>
              <div className="font-semibold text-foreground">{estimateLoading ? 'Estimating...' : `${formatNumber(usableSentenceCount)} sentences`}</div>
            </div>
            <Button className="h-9 rounded-xl" size="sm" variant={needsFreshCrawl ? 'default' : 'outline'} onClick={handleStartFreshCrawl} disabled={crawlStarting || crawlRunning}>
              {crawlStarting || crawlRunning ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              {crawlRunning ? 'Crawling...' : 'Start fresh crawl'}
            </Button>
            {crawlJob && (
              <div className="h-2 overflow-hidden rounded-full bg-muted md:col-span-4">
                <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${crawlProgress(crawlJob)}%` }} />
              </div>
            )}
            {crawlQueue && crawlRunning && (
              <div className="text-xs text-muted-foreground md:col-span-4">
                {crawlQueue.position ? `Crawl queue position ${crawlQueue.position}. ` : ''}{crawlQueue.message}
                {' '}{formatQueueWait(crawlJob?.status === 'running' ? crawlQueue.estimatedCompletionInSeconds : crawlQueue.estimatedStartInSeconds)}.
              </div>
            )}
            {crawlSummary && <div className="text-xs text-muted-foreground md:col-span-4">{formatNumber(crawlSummary.successPages)} successful pages, {formatNumber(crawlSummary.errorPages)} error pages, {formatNumber(crawlJob?.skippedCount || 0)} skipped.</div>}
            {crawlJob?.lastError && <div className="text-xs text-red-700 md:col-span-4">{crawlJob.lastError}</div>}
          </div>
          {queue && isRunning && (
            <div className="grid gap-3 border-y border-border py-4 text-sm md:grid-cols-4">
              <div>
                <span className="text-muted-foreground">Queue position</span>
                <div className="font-semibold text-foreground">{queue.position ? `Position ${queue.position}` : activeJob?.status === 'running' ? 'Running now' : 'Preparing'}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Workspace queue</span>
                <div className="font-semibold text-foreground">{formatNumber(queue.workspaceQueued)} queued · {formatNumber(queue.workspaceRunning)} running</div>
              </div>
              <div>
                <span className="text-muted-foreground">Workload</span>
                <div className="font-semibold capitalize text-foreground">{queue.workloadState}</div>
              </div>
              <div>
                <span className="text-muted-foreground">{activeJob?.status === 'running' ? 'Remaining' : 'Estimated start'}</span>
                <div className="font-semibold text-foreground">{formatQueueWait(activeJob?.status === 'running' ? queue.estimatedCompletionInSeconds : queue.estimatedStartInSeconds)}</div>
              </div>
              <div className="text-xs text-muted-foreground md:col-span-4">{queue.message}</div>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-4">
            {metrics.map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-border bg-background p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(Number(value))}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-3 rounded-2xl border border-border bg-background p-4 text-sm md:grid-cols-5">
            <div>
              <span className="text-muted-foreground">Provider</span>
              <div className="font-semibold text-foreground">{embeddingProvider} · {embeddingModel || 'default'}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {providerSettingsLoading ? 'Loading saved settings...' : embeddingConfigured ? 'Saved defaults active' : 'Using run defaults'}
              </div>
              {usesLocalSemanticEmbedding && (
                <div className={'mt-1 text-xs font-medium ' + (embeddingStatus?.available ? 'text-emerald-700' : embeddingStatusLoading ? 'text-muted-foreground' : 'text-amber-700')}>
                  {embeddingStatusLoading ? `Checking ${semanticRuntimeLabel(embeddingProvider)}...` : embeddingStatus?.available ? `${semanticRuntimeLabel(embeddingProvider)} ready` : `${semanticRuntimeLabel(embeddingProvider)} unavailable`}
                </div>
              )}
            </div>
            <div><span className="text-muted-foreground">Estimated workload</span><div className="font-semibold text-foreground">{estimateLoading ? 'Estimating...' : estimate ? `${formatNumber(estimate.estimatedLocalUnits || 0)} sentences` : 'No crawl estimate'}</div></div>
            <div><span className="text-muted-foreground">Vector DB</span><div className="font-semibold text-foreground" title={estimate?.vectorStore?.reason}>{vectorStoreLabel(estimate)}</div></div>
            <div><span className="text-muted-foreground">Hosted estimate</span><div className="font-semibold text-foreground">{formatMoney(hostedEstimate)}</div></div>
            <div><span className="text-muted-foreground">Actual spend</span><div className="font-semibold text-foreground">{formatMoney(activeJob?.actualCost)}</div></div>
            <div className="text-xs text-muted-foreground md:col-span-5">Review: {reviewProvider} · {reviewModel || 'default'} · {providerSettingsLoading ? 'checking settings' : reviewConfigured ? 'saved defaults active' : 'run defaults'}</div>
            {usesLocalSemanticEmbedding && embeddingStatus && !embeddingStatus.available && (
              <div className="flex flex-col gap-2 text-xs text-amber-700 md:col-span-5 md:flex-row md:items-center md:justify-between">
                <span>{embeddingStatus.message}</span>
                <Button className="h-8 shrink-0 rounded-xl" size="sm" variant="outline" onClick={() => loadEmbeddingStatus()} disabled={embeddingStatusLoading}>
                  {embeddingStatusLoading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                  Retry provider
                </Button>
              </div>
            )}
            {estimateError && <div className="text-xs text-amber-700 md:col-span-5">{estimateError}</div>}
            {hostedSpendBlocked && <div className="text-xs text-red-700 md:col-span-5">Estimated hosted cost exceeds the max spend cap. Increase the cap or choose Built-in BGE-M3.</div>}
          </div>

          {jobs.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-border bg-background">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <div className="font-semibold text-foreground">Analysis queue</div>
                  <div className="text-xs text-muted-foreground">Recent runs for this site, including canceled and failed jobs.</div>
                </div>
                <span className="text-xs text-muted-foreground">{jobs.length} shown</span>
              </div>
              <div className="divide-y divide-border">
                {jobs.slice(0, 5).map((job) => {
                  const canCancel = job.status === 'queued' || job.status === 'running';
                  const busy = jobActionId === job.id;
                  return (
                    <div key={job.id} className="grid gap-3 px-4 py-3 text-sm lg:grid-cols-[1fr_160px_130px_190px] lg:items-center">
                      <button className="min-w-0 text-left" onClick={() => setActiveJob(job)} type="button">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass(job.status)}`}>{job.status}</span>
                          <span className="font-semibold text-foreground">{job.embeddingProvider || 'local'} · {job.embeddingModel || 'rules'} · review {job.reviewProvider || 'local'} · {job.reviewModel || 'rules'}</span>
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">{job.startDate} to {job.endDate} · updated {formatTimestamp(job.updatedAt)}</div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">{jobUsageDetail(job)}</div>
                        {job.lastError && <div className="mt-1 line-clamp-1 text-xs text-amber-700">{job.lastError}</div>}
                      </button>
                      <div className="text-muted-foreground"><span className="font-semibold text-foreground">{jobProgress(job)}</span> complete</div>
                      <div className="text-muted-foreground">{jobProgressDetail(job)}</div>
                      <div className="flex gap-2 lg:justify-end">
                        <Button className="h-8 rounded-xl" size="sm" variant="outline" onClick={() => rerunJob(job)} disabled={busy || isRunning}>
                          {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-2 h-3.5 w-3.5" />}
                          Rerun
                        </Button>
                        <Button className="h-8 rounded-xl" size="sm" variant="ghost" onClick={() => cancelJob(job)} disabled={busy || !canCancel}>
                          {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <StopCircle className="mr-2 h-3.5 w-3.5" />}
                          Cancel
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid gap-2 lg:grid-cols-[1fr_180px_170px_210px_180px]">
            <div className="relative">
              <Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
              <Input className="h-11 rounded-xl border-border bg-card pl-10" onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search source, sentence, target, or anchor..." value={searchTerm} />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-11 rounded-xl border-border bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="implemented">Implemented</SelectItem>
                <SelectItem value="stale">Stale</SelectItem>
              </SelectContent>
            </Select>
            <Select value={confidence} onValueChange={setConfidence}>
              <SelectTrigger className="h-11 rounded-xl border-border bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All confidence</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
            <Select value={opportunityType} onValueChange={setOpportunityType}>
              <SelectTrigger className="h-11 rounded-xl border-border bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All opportunities</SelectItem>
                <SelectItem value="link-gap">Link gaps</SelectItem>
                <SelectItem value="orphan-risk">Orphan risk</SelectItem>
                <SelectItem value="striking-distance">Striking distance</SelectItem>
                <SelectItem value="visibility-gap">Visibility gaps</SelectItem>
              </SelectContent>
            </Select>
            <Select value={targetFolder} onValueChange={setTargetFolder}>
              <SelectTrigger className="h-11 rounded-xl border-border bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All folders</SelectItem>
                {folders.map((folder) => <SelectItem key={folder} value={folder}>{folder}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />Loading recommendations...</div>
      ) : groups.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">Run analysis after a fresh crawl to generate screenshot-style internal link recommendations.</div>
      ) : groups.map((group) => (
        <Card key={group.sourceUrl} className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
          <div className="flex flex-col gap-3 border-b border-border bg-background px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="font-semibold text-foreground">In “{group.sourceTitle}” <span className="ml-2 text-sm font-medium text-muted-foreground">{group.rows.length} link{group.rows.length === 1 ? '' : 's'}</span></div>
            <a className="inline-flex items-center gap-1 text-sm font-medium text-primary" href={group.sourceUrl} target="_blank" rel="noreferrer">open post <ExternalLink className="h-3.5 w-3.5" /></a>
          </div>
          <div className="grid border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground md:grid-cols-[1.35fr_0.9fr_1.2fr_260px]">
            <div>Anchor text to use</div>
            <div>Link it to</div>
            <div>Why a reader here benefits</div>
            <div className="text-right">Workflow</div>
          </div>
          {group.rows.map((row) => {
            const draftNote = getDraftNote(row);
            const noteChanged = draftNote !== (row.userNote || '');
            const noteSaving = noteSavingId === row.id;

            return (
              <div key={row.id} className="grid gap-4 border-b border-border px-4 py-4 last:border-b-0 md:grid-cols-[1.35fr_0.9fr_1.2fr_260px]">
                <div>
                  <div className="mb-2 font-semibold text-foreground">“{row.anchorText}”</div>
                  <p className="text-sm leading-6 text-muted-foreground">{highlightAnchor(row)}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <span className={`rounded-full border px-2.5 py-1 ${statusClass(row.status)}`}>{statusLabel(row.status)}</span>
                    <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-muted-foreground">{row.confidence} confidence</span>
                    <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-muted-foreground">{typeLabel(row.opportunityType)}</span>
                    {modelVersionBadges(row.modelVersion).map((badge) => (
                      <span key={badge} className="rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 text-primary">{badge}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <a className="font-semibold leading-6 text-primary hover:underline" href={row.target.url} target="_blank" rel="noreferrer">{row.target.title || row.target.url} <ExternalLink className="inline h-3.5 w-3.5" /></a>
                  <div className="mt-2 break-all text-xs text-muted-foreground">{row.target.url}</div>
                </div>
                <div className="space-y-3 text-sm leading-6 text-muted-foreground">
                  <p>{row.readerBenefit}</p>
                  <div className="rounded-xl border border-border bg-background p-3">
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                      <span className="font-semibold uppercase tracking-[0.12em] text-muted-foreground">Score</span>
                      <span className="font-semibold text-foreground">{Math.round(row.scoreBreakdown.total || row.priorityScore)}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      {scoreBreakdownItems(row).map(([label, value]) => (
                        <div key={label} className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground">{label}</span>
                          <span className="font-medium text-foreground">{Math.round(value)}</span>
                        </div>
                      ))}
                      {row.scoreBreakdown.diversityPenalty > 0 && (
                        <div className="col-span-2 flex items-center justify-between gap-2 border-t border-border pt-1 text-amber-700">
                          <span>Diversity penalty</span>
                          <span className="font-medium">-{Math.round(row.scoreBreakdown.diversityPenalty)}</span>
                        </div>
                      )}
                    </div>
                    {scoreNotes(row) && <p className="mt-2 border-t border-border pt-2 text-xs leading-5 text-muted-foreground">{scoreNotes(row)}</p>}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Textarea
                    aria-label={`Editorial note for ${row.anchorText}`}
                    className="min-h-[74px] resize-none rounded-xl border-border bg-background text-sm"
                    onChange={(event) => setNoteDrafts((current) => ({ ...current, [row.id]: event.target.value }))}
                    placeholder="Editorial note..."
                    value={draftNote}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Button className="h-8 rounded-xl" size="sm" variant="outline" onClick={() => saveNote(row)} disabled={!noteChanged || noteSaving}>
                      {noteSaving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <FileText className="mr-2 h-3.5 w-3.5" />}
                      Save note
                    </Button>
                    <Button className="h-8 rounded-xl" size="sm" variant="outline" onClick={() => updateStatus(row, 'approved')} disabled={row.status === 'approved' || row.status === 'implemented'}><CheckCircle2 className="mr-2 h-3.5 w-3.5" />Approve</Button>
                  </div>
                  <Button className="h-9 w-full rounded-xl" size="sm" onClick={() => updateStatus(row, 'implemented')} disabled={row.status === 'implemented'}><CheckCircle2 className="mr-2 h-4 w-4" />Mark complete</Button>
                  <Button className="h-9 w-full rounded-xl" size="sm" variant="ghost" onClick={() => updateStatus(row, 'rejected')} disabled={row.status === 'rejected' || row.status === 'implemented'}><XCircle className="mr-2 h-4 w-4" />Reject</Button>
                </div>
              </div>
            );
          })}
        </Card>
      ))}
    </div>
  );
}



































