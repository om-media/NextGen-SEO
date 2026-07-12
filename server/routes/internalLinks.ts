import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import { canAccessSite } from '../accessControl.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isIsoDateString, isNonEmptyString } from '../validation.js';
import { cancelInternalLinkAnalysisJob, estimateInternalLinkAnalysis, getInternalLinkOpportunities, listInternalLinkAnalysisJobs, queueInternalLinkAnalysis, rerunInternalLinkAnalysisJob, updateInternalLinkOpportunityStatus } from '../services/internalLinks.js';
import { deleteInternalLinkProviderSettings, getInternalLinkProviderSettings, listInternalLinkProviderSettings, upsertInternalLinkProviderSettings } from '../services/internalLinkProviderSettings.js';

type ParsedAnalysisInput = {
  embeddingModel: string | null;
  embeddingProvider: string;
  endDate: string;
  maxHostedSpend: number | null;
  maxPages: number | null;
  maxRecommendations: number | null;
  maxSentencesPerPage: number | null;
  provider: string;
  reviewModel: string | null;
  reviewProvider: string;
  siteUrl: string;
  startDate: string;
};

type InternalLinkJobState = {
  id: string;
  siteUrl: string;
  status: string;
};
type WorkspaceSiteUser = {
  activatedSiteUrl?: string | null;
  knownSites?: string | null;
  unlockedSites?: string | null;
};

type WorkspaceQueueFailure = {
  error: string;
  siteUrl: string;
};

type InternalLinkQueueJobRow = {
  completedAt: string | null;
  id: string;
  siteUrl: string;
  startedAt: string | null;
  status: string;
  updatedAt: string | null;
};

export type InternalLinkQueueMetadata = {
  autoRefreshMs: number;
  estimatedCompletionAt: string | null;
  estimatedCompletionInSeconds: number | null;
  estimatedDurationSeconds: number | null;
  estimatedStartInSeconds: number | null;
  message: string;
  position: number | null;
  queuedAhead: number;
  recentCompletedCount: number;
  runningAhead: number;
  workloadState: 'idle' | 'normal' | 'busy' | 'backlogged';
  workspaceActive: number;
  workspaceQueued: number;
  workspaceRunning: number;
};

type BuildInternalLinkQueueMetadataOptions = {
  activeJobs: InternalLinkQueueJobRow[];
  autoRefreshMs?: number;
  completedJobs: InternalLinkQueueJobRow[];
  now?: number;
  targetJob: Pick<InternalLinkQueueJobRow, 'id' | 'status'> | null;
};

function toTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function medianSeconds(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function durationSeconds(job: InternalLinkQueueJobRow) {
  const startedAt = toTimestamp(job.startedAt || job.updatedAt);
  const completedAt = toTimestamp(job.completedAt || job.updatedAt);
  if (startedAt === null || completedAt === null || completedAt <= startedAt) {
    return null;
  }
  return Math.max(1, Math.round((completedAt - startedAt) / 1000));
}

function queueWorkloadState(activeCount: number): InternalLinkQueueMetadata['workloadState'] {
  if (activeCount <= 0) return 'idle';
  if (activeCount <= 1) return 'normal';
  if (activeCount <= 3) return 'busy';
  return 'backlogged';
}

function isoAfterSeconds(now: number, seconds: number | null) {
  if (seconds === null) return null;
  return new Date(now + seconds * 1000).toISOString();
}

export function buildInternalLinkQueueMetadata(options: BuildInternalLinkQueueMetadataOptions): InternalLinkQueueMetadata {
  const now = options.now ?? Date.now();
  const runningJobs = options.activeJobs
    .filter((job) => job.status === 'running')
    .sort((left, right) => (toTimestamp(left.startedAt || left.updatedAt) || 0) - (toTimestamp(right.startedAt || right.updatedAt) || 0));
  const queuedJobs = options.activeJobs
    .filter((job) => job.status === 'queued')
    .sort((left, right) => (toTimestamp(left.updatedAt) || 0) - (toTimestamp(right.updatedAt) || 0));
  const completedDurations = options.completedJobs
    .map(durationSeconds)
    .filter((value): value is number => value !== null && value > 0);
  const estimatedDurationSeconds = medianSeconds(completedDurations);
  const workspaceQueued = queuedJobs.length;
  const workspaceRunning = runningJobs.length;
  const workspaceActive = workspaceQueued + workspaceRunning;
  const targetStatus = (options.targetJob?.status || '').toLowerCase();
  const targetActiveJob = options.targetJob ? options.activeJobs.find((job) => job.id === options.targetJob?.id) || null : null;
  const queuedAheadIndex = options.targetJob ? queuedJobs.findIndex((job) => job.id === options.targetJob!.id) : -1;
  const queuedAhead = queuedAheadIndex >= 0 ? queuedAheadIndex : 0;
  const runningAhead = targetStatus === 'queued' ? workspaceRunning : 0;
  const position = targetStatus === 'running'
    ? 1
    : targetStatus === 'queued' && options.targetJob
      ? runningAhead + queuedAhead + 1
      : null;
  const remainingRunningSeconds = estimatedDurationSeconds === null
    ? null
    : runningJobs.reduce((total, job) => {
      if (job.id === options.targetJob?.id && targetStatus === 'running') {
        return total;
      }
      const startedAt = toTimestamp(job.startedAt || job.updatedAt);
      if (startedAt === null) return total + estimatedDurationSeconds;
      const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1000));
      return total + Math.max(30, estimatedDurationSeconds - elapsedSeconds);
    }, 0);
  const estimatedStartInSeconds = targetStatus === 'running'
    ? 0
    : targetStatus === 'queued' && estimatedDurationSeconds !== null
      ? (remainingRunningSeconds || 0) + queuedAhead * estimatedDurationSeconds
      : null;
  const estimatedCompletionInSeconds = targetStatus === 'running'
    ? estimatedDurationSeconds === null
      ? null
      : Math.max(30, estimatedDurationSeconds - Math.max(0, Math.round((now - (toTimestamp(targetActiveJob?.startedAt || targetActiveJob?.updatedAt) || now)) / 1000)))
    : estimatedStartInSeconds === null || estimatedDurationSeconds === null
      ? null
      : estimatedStartInSeconds + estimatedDurationSeconds;
  const jobsAhead = runningAhead + queuedAhead;

  let message = 'Workspace internal link queue is idle.';
  if (targetStatus === 'running') {
    message = workspaceQueued > 0
      ? `This internal link analysis is running now. ${workspaceQueued} more analysis ${workspaceQueued === 1 ? 'job is' : 'jobs are'} queued in this workspace.`
      : 'This internal link analysis is running now. No other analysis jobs are queued in this workspace.';
  } else if (targetStatus === 'queued' && position !== null) {
    message = jobsAhead > 0
      ? `${jobsAhead} analysis ${jobsAhead === 1 ? 'job is' : 'jobs are'} ahead of this site in the workspace queue.`
      : 'This internal link analysis is next in the workspace queue.';
  } else if (workspaceActive > 0) {
    message = `${workspaceQueued} analysis ${workspaceQueued === 1 ? 'job is' : 'jobs are'} queued and ${workspaceRunning} ${workspaceRunning === 1 ? 'is' : 'are'} running elsewhere in this workspace.`;
  }

  return {
    autoRefreshMs: options.autoRefreshMs ?? 4000,
    estimatedCompletionAt: isoAfterSeconds(now, estimatedCompletionInSeconds),
    estimatedCompletionInSeconds,
    estimatedDurationSeconds,
    estimatedStartInSeconds,
    message,
    position,
    queuedAhead: targetStatus === 'queued' ? queuedAhead : 0,
    recentCompletedCount: completedDurations.length,
    runningAhead,
    workloadState: queueWorkloadState(workspaceActive),
    workspaceActive,
    workspaceQueued,
    workspaceRunning,
  };
}

function uniqueJobsById(jobs: InternalLinkQueueJobRow[]) {
  const seen = new Set<string>();
  const unique: InternalLinkQueueJobRow[] = [];
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    unique.push(job);
  }
  return unique;
}

async function getInternalLinkQueueMetadata(
  db: AppDatabase,
  ownerId: string,
  targetJob: Pick<InternalLinkQueueJobRow, 'id' | 'siteUrl' | 'status'> | null,
) {
  const [activeJobs, siteCompletedJobs, workspaceCompletedJobs] = await Promise.all([
    db.all<InternalLinkQueueJobRow>(
      `
        SELECT id, siteUrl, status, startedAt, updatedAt, completedAt
        FROM internal_link_analysis_jobs
        WHERE ownerId = ? AND status IN ('queued', 'running')
      `,
      [ownerId],
    ),
    targetJob?.siteUrl
      ? db.all<InternalLinkQueueJobRow>(
        `
          SELECT id, siteUrl, status, startedAt, updatedAt, completedAt
          FROM internal_link_analysis_jobs
          WHERE ownerId = ? AND siteUrl = ? AND status = 'completed'
          ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
          LIMIT 6
        `,
        [ownerId, targetJob.siteUrl],
      )
      : Promise.resolve([]),
    db.all<InternalLinkQueueJobRow>(
      `
        SELECT id, siteUrl, status, startedAt, updatedAt, completedAt
        FROM internal_link_analysis_jobs
        WHERE ownerId = ? AND status = 'completed'
        ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
        LIMIT 12
      `,
      [ownerId],
    ),
  ]);

  return buildInternalLinkQueueMetadata({
    activeJobs,
    completedJobs: uniqueJobsById([...siteCompletedJobs, ...workspaceCompletedJobs]).slice(0, 12),
    targetJob,
  });
}

function parseStringArray(value: unknown) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()) : [];
  } catch {
    return [];
  }
}

async function getWorkspaceSiteUrls(db: AppDatabase, ownerId: string) {
  const user = await db.get<WorkspaceSiteUser>('SELECT activatedSiteUrl, knownSites, unlockedSites FROM users WHERE id = ?', [ownerId]);
  if (!user) return [];
  return Array.from(new Set([
    ...(user.activatedSiteUrl?.trim() ? [user.activatedSiteUrl.trim()] : []),
    ...parseStringArray(user.knownSites),
    ...parseStringArray(user.unlockedSites),
  ])).filter(Boolean).sort();
}

const cancelableJobStatuses = new Set(['queued', 'running']);
const terminalJobStatuses = new Set(['completed', 'error', 'canceled']);

function parseOptionalNumber(value: unknown, field: string, options: { integer?: boolean; max?: number; min?: number } = {}) {
  if (value === undefined || value === null || value === '') return { value: null as number | null };
  const number = Number(value);
  const min = options.min ?? 0;

  if (!Number.isFinite(number) || number < min || (options.integer && !Number.isInteger(number)) || (options.max !== undefined && number > options.max)) {
    const range = options.max === undefined ? `at least ${min}` : `between ${min} and ${options.max}`;
    return { error: `${field} must be ${options.integer ? 'an integer' : 'a number'} ${range}.` };
  }

  return { value: number };
}

function parseAnalysisInput(body: any): { error: string } | { input: ParsedAnalysisInput } {
  const siteUrl = asTrimmedString(body?.siteUrl);
  const startDate = asTrimmedString(body?.startDate);
  const endDate = asTrimmedString(body?.endDate);

  if (!isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
    return { error: 'Missing or invalid siteUrl, startDate, or endDate.' };
  }

  if (startDate > endDate) {
    return { error: 'startDate must be on or before endDate.' };
  }

  const maxHostedSpend = parseOptionalNumber(body?.maxHostedSpend, 'maxHostedSpend');
  const maxPages = parseOptionalNumber(body?.maxPages, 'maxPages', { integer: true, max: 10000, min: 1 });
  const maxRecommendations = parseOptionalNumber(body?.maxRecommendations, 'maxRecommendations', { integer: true, max: 2000, min: 1 });
  const maxSentencesPerPage = parseOptionalNumber(body?.maxSentencesPerPage, 'maxSentencesPerPage', { integer: true, max: 250, min: 1 });
  const invalidNumber = [maxHostedSpend, maxPages, maxRecommendations, maxSentencesPerPage].find((result) => result.error);

  if (invalidNumber?.error) {
    return { error: invalidNumber.error };
  }

  return {
    input: {
      embeddingModel: asTrimmedString(body?.embeddingModel) || null,
      embeddingProvider: asTrimmedString(body?.embeddingProvider) || 'local',
      endDate,
      maxHostedSpend: maxHostedSpend.value,
      maxPages: maxPages.value,
      maxRecommendations: maxRecommendations.value,
      maxSentencesPerPage: maxSentencesPerPage.value,
      provider: asTrimmedString(body?.provider) || 'local',
      reviewModel: asTrimmedString(body?.reviewModel) || null,
      reviewProvider: asTrimmedString(body?.reviewProvider) || 'local',
      siteUrl,
      startDate,
    },
  };
}

async function getActiveInternalLinkJob(db: AppDatabase, ownerId: string, siteUrl: string) {
  return db.get<InternalLinkJobState>(
    `SELECT id, siteUrl, status
     FROM internal_link_analysis_jobs
     WHERE ownerId = ? AND siteUrl = ? AND status IN ('queued', 'running')
     ORDER BY updatedAt DESC
     LIMIT 1`,
    [ownerId, siteUrl],
  );
}

function isUniqueConstraintError(error: any) {
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  return code === '23505' || code.includes('SQLITE_CONSTRAINT') || message.includes('unique constraint') || message.includes('duplicate key');
}

async function sendActiveJobConflict(db: AppDatabase, res: any, ownerId: string, siteUrl: string) {
  const activeJob = await getActiveInternalLinkJob(db, ownerId, siteUrl);
  const job = activeJob || { id: '', siteUrl, status: 'queued' };
  return res.status(409).json({
    error: 'An internal link analysis is already queued or running for this site.',
    job,
    queue: await getInternalLinkQueueMetadata(db, ownerId, job),
  });
}

type LocalEmbeddingProviderStatus = {
  available: boolean;
  baseUrl: string;
  dimensions: number | null;
  message: string;
  model: string;
  modelAvailable: boolean;
};

function ollamaModelKey(value: string) {
  return value.trim().toLowerCase().replace(/:latest$/, '');
}

async function getBuiltInEmbeddingProviderStatus(): Promise<LocalEmbeddingProviderStatus> {
  const baseUrl = (process.env.INTERNAL_LINK_EMBEDDING_WORKER_URL || 'http://127.0.0.1:8091').replace(/\/+$/, '');
  const model = process.env.INTERNAL_LINK_BUILT_IN_MODEL || 'BAAI/bge-m3';

  try {
    const response = await fetch(baseUrl + '/health/ready', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json().catch(() => null) as {
      dimensions?: number | null;
      error?: string | null;
      model?: string;
      status?: string;
    } | null;
    const available = response.ok && data?.status === 'ready' && Number(data?.dimensions) === 1024;

    return {
      available,
      baseUrl,
      dimensions: available ? 1024 : null,
      message: available
        ? 'Built-in BGE-M3 is ready.'
        : data?.status === 'loading'
          ? 'Built-in BGE-M3 is downloading or loading for the first run. Analysis will be available when preparation finishes.'
          : 'Built-in BGE-M3 is not ready' + (data?.error ? ': ' + data.error : '.'),
      model: data?.model || model,
      modelAvailable: available,
    };
  } catch (error: any) {
    return {
      available: false,
      baseUrl,
      dimensions: null,
      message: 'The built-in BGE-M3 worker is not running. Start it with "npm run local:services:up".',
      model,
      modelAvailable: false,
    };
  }
}

async function getOllamaEmbeddingProviderStatus(db: AppDatabase, ownerId: string, requestedModel: string | null): Promise<LocalEmbeddingProviderStatus> {
  const setting = await getInternalLinkProviderSettings(db, ownerId, 'ollama').catch(() => null);
  const baseUrl = (setting?.baseUrl || process.env.INTERNAL_LINK_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = requestedModel && requestedModel !== 'bge-m3-local'
    ? requestedModel
    : setting?.embeddingModel || 'bge-m3';

  if (setting?.enabled === false) {
    return {
      available: false,
      baseUrl,
      dimensions: null,
      message: 'The saved Ollama provider is disabled. Enable it in Settings before running BGE-M3 analysis.',
      model,
      modelAvailable: false,
    };
  }

  try {
    const response = await fetch(baseUrl + '/api/tags', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error('Ollama returned HTTP ' + response.status);
    }

    const data = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const expected = ollamaModelKey(model);
    const modelAvailable = (data.models || []).some((entry) => {
      const name = entry.name || entry.model || '';
      return ollamaModelKey(name) === expected;
    });

    return {
      available: modelAvailable,
      baseUrl,
      dimensions: modelAvailable ? 1024 : null,
      message: modelAvailable
        ? 'Ollama is reachable and ' + model + ' is installed.'
        : 'Ollama is reachable, but ' + model + ' is not installed. Run "ollama pull ' + model + '".',
      model,
      modelAvailable,
    };
  } catch (error: any) {
    return {
      available: false,
      baseUrl,
      dimensions: null,
      message: 'Ollama is not reachable at ' + baseUrl + '. Start Ollama, then retry the provider check.',
      model,
      modelAvailable: false,
    };
  }
}

export function registerInternalLinkRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

  app.get('/api/internal-links/provider-status', authRequired, async (req: AuthedRequest, res) => {
    const provider = (asTrimmedString(req.query.provider) || 'local').toLowerCase();
    const model = asTrimmedString(req.query.model);

    if (provider === 'local-rules') {
      return res.json({
        status: {
          available: true,
          baseUrl: 'local',
          dimensions: null,
          message: 'Local rules are available without an embedding runtime.',
          model: 'local-rules',
          modelAvailable: true,
        },
        success: true,
      });
    }

    if (provider !== 'local' && provider !== 'ollama') {
      return res.status(400).json({ error: 'Provider readiness checks currently support Built-in BGE-M3 and Ollama.' });
    }

    try {
      const status = provider === 'local'
        ? await getBuiltInEmbeddingProviderStatus()
        : await getOllamaEmbeddingProviderStatus(db, req.authUser!.uid, model);
      res.json({ status, success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to check local embedding provider' });
    }
  });

  app.get('/api/internal-links/provider-settings', authRequired, async (req: AuthedRequest, res) => {
    try {
      const settings = await listInternalLinkProviderSettings(db, req.authUser!.uid);
      res.json({ settings, success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load internal link provider settings' });
    }
  });

  app.put('/api/internal-links/provider-settings/:provider', authRequired, async (req: AuthedRequest, res) => {
    const provider = asTrimmedString(req.params.provider);
    if (!provider) return res.status(400).json({ error: 'Missing provider.' });

    try {
      const setting = await upsertInternalLinkProviderSettings(db, req.authUser!.uid, provider, {
        apiKey: req.body?.apiKey,
        baseUrl: req.body?.baseUrl,
        clearApiKey: req.body?.clearApiKey === true,
        embeddingModel: req.body?.embeddingModel,
        enabled: req.body?.enabled === undefined ? undefined : Boolean(req.body.enabled),
        reviewModel: req.body?.reviewModel,
      });
      res.json({ setting, success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to save internal link provider settings' });
    }
  });

  app.delete('/api/internal-links/provider-settings/:provider', authRequired, async (req: AuthedRequest, res) => {
    const provider = asTrimmedString(req.params.provider);
    if (!provider) return res.status(400).json({ error: 'Missing provider.' });

    try {
      const result = await deleteInternalLinkProviderSettings(db, req.authUser!.uid, provider);
      res.json({ ...result, success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete internal link provider settings' });
    }
  });

  app.post('/api/internal-links/estimate', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const parsed = parseAnalysisInput(req.body);

    if ('error' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      if (!(await canAccessSite(db, ownerId, parsed.input.siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const estimate = await estimateInternalLinkAnalysis(db, ownerId, parsed.input);
      res.json({ estimate, success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to estimate internal link analysis' });
    }
  });
  app.post('/api/internal-links/analyze-workspace', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const fallbackSiteUrl = asTrimmedString(req.body?.siteUrl) || 'workspace://all';
    const parsed = parseAnalysisInput({ ...req.body, siteUrl: fallbackSiteUrl });

    if ('error' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      const requestedSites: string[] = Array.isArray(req.body?.siteUrls)
        ? req.body.siteUrls.map((value: unknown) => asTrimmedString(value)).filter((value): value is string => Boolean(value))
        : [];
      const workspaceSites: string[] = requestedSites.length ? Array.from(new Set<string>(requestedSites)).sort() : await getWorkspaceSiteUrls(db, ownerId);
      const queued: any[] = [];
      const skipped: InternalLinkJobState[] = [];
      const failures: WorkspaceQueueFailure[] = [];

      for (const siteUrl of workspaceSites) {
        try {
          if (!(await canAccessSite(db, ownerId, siteUrl))) {
            failures.push({ siteUrl, error: 'Site is not activated for this workspace.' });
            continue;
          }

          const activeJob = await getActiveInternalLinkJob(db, ownerId, siteUrl);
          if (activeJob) {
            skipped.push(activeJob);
            continue;
          }

          const job = await queueInternalLinkAnalysis(db, ownerId, { ...parsed.input, siteUrl });
          if (job) queued.push(job);
        } catch (err: any) {
          if (isUniqueConstraintError(err)) {
            const activeJob = await getActiveInternalLinkJob(db, ownerId, siteUrl);
            if (activeJob) {
              skipped.push(activeJob);
              continue;
            }
          }
          failures.push({ siteUrl, error: err.message || 'Failed to queue site.' });
        }
      }

      res.json({ failures, queued, skipped, success: true, totals: { failures: failures.length, queued: queued.length, skipped: skipped.length, sites: workspaceSites.length } });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to queue workspace internal link analysis' });
    }
  });
  app.post('/api/internal-links/analyze', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const parsed = parseAnalysisInput(req.body);

    if ('error' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      if (!(await canAccessSite(db, ownerId, parsed.input.siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const activeJob = await getActiveInternalLinkJob(db, ownerId, parsed.input.siteUrl);
      if (activeJob) {
        return sendActiveJobConflict(db, res, ownerId, parsed.input.siteUrl);
      }

      const job = await queueInternalLinkAnalysis(db, ownerId, parsed.input);
      res.json({ job, queue: await getInternalLinkQueueMetadata(db, ownerId, job), success: true });
    } catch (err: any) {
      if (isUniqueConstraintError(err)) return sendActiveJobConflict(db, res, ownerId, parsed.input.siteUrl);
      res.status(500).json({ error: err.message || 'Failed to queue internal link analysis' });
    }
  });

  app.get('/api/internal-links/jobs', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 50) : 20;

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      const jobs = await listInternalLinkAnalysisJobs(db, ownerId, siteUrl, limit);
      const queueTarget = jobs.find((entry) => entry.status === 'queued' || entry.status === 'running') || jobs[0] || null;
      res.json({ jobs, queue: await getInternalLinkQueueMetadata(db, ownerId, queueTarget) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load internal link analysis jobs' });
    }
  });

  app.post('/api/internal-links/jobs/:id/cancel', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const jobId = asTrimmedString(req.params.id);
    if (!jobId) return res.status(400).json({ error: 'Missing job id' });

    try {
      const current = await db.get<InternalLinkJobState>(
        'SELECT id, siteUrl, status FROM internal_link_analysis_jobs WHERE id = ? AND ownerId = ?',
        [jobId, ownerId],
      );
      if (!current) return res.status(404).json({ error: 'Internal link analysis job not found' });
      if (!(await canAccessSite(db, ownerId, current.siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (!cancelableJobStatuses.has(current.status)) {
        return res.status(409).json({
          error: `Cannot cancel an internal link analysis job with status "${current.status}".`,
          job: current,
        });
      }
      const job = await cancelInternalLinkAnalysisJob(db, ownerId, jobId);
      res.json({ job, queue: await getInternalLinkQueueMetadata(db, ownerId, job), success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to cancel internal link analysis job' });
    }
  });

  app.post('/api/internal-links/jobs/:id/rerun', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const jobId = asTrimmedString(req.params.id);
    if (!jobId) return res.status(400).json({ error: 'Missing job id' });

    try {
      const current = await db.get<InternalLinkJobState>(
        'SELECT id, siteUrl, status FROM internal_link_analysis_jobs WHERE id = ? AND ownerId = ?',
        [jobId, ownerId],
      );
      if (!current) return res.status(404).json({ error: 'Internal link analysis job not found' });
      if (!(await canAccessSite(db, ownerId, current.siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (!terminalJobStatuses.has(current.status)) {
        return res.status(409).json({
          error: `Cannot rerun an internal link analysis job with status "${current.status}".`,
          job: current,
        });
      }
      const activeJob = await getActiveInternalLinkJob(db, ownerId, current.siteUrl);
      if (activeJob) {
        return sendActiveJobConflict(db, res, ownerId, current.siteUrl);
      }
      const job = await rerunInternalLinkAnalysisJob(db, ownerId, jobId);
      res.json({ job, queue: await getInternalLinkQueueMetadata(db, ownerId, job), success: true });
    } catch (err: any) {
      const current = await db.get<InternalLinkJobState>('SELECT id, siteUrl, status FROM internal_link_analysis_jobs WHERE id = ? AND ownerId = ?', [jobId, ownerId]);
      if (current && isUniqueConstraintError(err)) return sendActiveJobConflict(db, res, ownerId, current.siteUrl);
      res.status(500).json({ error: err.message || 'Failed to rerun internal link analysis job' });
    }
  });

  app.get('/api/internal-links/opportunities', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const startDate = asTrimmedString(req.query.startDate);
    const endDate = asTrimmedString(req.query.endDate);

    if (!isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Missing or invalid parameters' });
    }

    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 500) : 50;
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(Number(req.query.offset), 0) : 0;

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const result = await getInternalLinkOpportunities(db, ownerId, siteUrl, startDate, endDate, {
        confidence: asTrimmedString(req.query.confidence) || 'all',
        jobId: asTrimmedString(req.query.jobId) || null,
        limit,
        offset,
        opportunityType: asTrimmedString(req.query.opportunityType) || 'all',
        query: asTrimmedString(req.query.query) || '',
        status: asTrimmedString(req.query.status) || 'all',
        targetFolder: asTrimmedString(req.query.targetFolder) || 'all',
      });
      res.json({ ...result, queue: await getInternalLinkQueueMetadata(db, ownerId, result.job) });
    } catch (err: any) {
      console.error('[internal-links/opportunities] failed', err);
      res.status(500).json({ error: err.message || 'Failed to load internal link opportunities' });
    }
  });

  app.patch('/api/internal-links/opportunities/:id', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const opportunityId = asTrimmedString(req.params.id);
    const status = asTrimmedString(req.body?.status) || null;
    const note = req.body?.note === undefined || req.body?.note === null ? null : String(req.body.note);

    if (!opportunityId) return res.status(400).json({ error: 'Missing opportunity id' });

    try {
      const current = await db.get<{ siteUrl: string }>(
        'SELECT siteUrl FROM internal_link_opportunities WHERE id = ? AND ownerId = ?',
        [opportunityId, ownerId],
      );
      if (!current) return res.status(404).json({ error: 'Internal link opportunity not found' });
      if (!(await canAccessSite(db, ownerId, current.siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const updated = await updateInternalLinkOpportunityStatus(db, ownerId, opportunityId, { note, status });
      res.json({ opportunity: updated, success: true });
    } catch (err: any) {
      const message = err.message || 'Failed to update internal link opportunity';
      if (message.includes('Invalid internal link opportunity status')) {
        return res.status(400).json({ error: message });
      }
      if (message.includes('cannot be moved back')) {
        return res.status(409).json({ error: message });
      }
      res.status(500).json({ error: message });
    }
  });
}

