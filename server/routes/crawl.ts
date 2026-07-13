import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isNonEmptyString } from '../validation.js';
import { cancelCrawlJob, compareCrawlJobs, getCrawlJobs, getCrawlLinks, getCrawlPages, getCrawlStatus, queueCrawlJob, type CrawlIssueFilter } from '../services/crawl.js';
import { getPlanCrawlLimits } from '../../shared/plans.js';
import { canAccessSite } from '../accessControl.js';

type CrawlQueueJobRow = {
  completedAt: string | null;
  id: string;
  nextRunAt: string | null;
  siteUrl: string;
  startedAt: string | null;
  status: string;
  updatedAt: string | null;
};

export type CrawlQueueMetadata = {
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

type BuildCrawlQueueMetadataOptions = {
  activeJobs: CrawlQueueJobRow[];
  autoRefreshMs?: number;
  completedJobs: CrawlQueueJobRow[];
  now?: number;
  targetJob: Pick<CrawlQueueJobRow, 'id' | 'status'> | null;
};

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

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

function toBoundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function getCrawlJobWorkerCount() {
  return toBoundedInteger(process.env.CRAWL_JOB_CONCURRENCY ?? process.env.CRAWL_JOB_WORKERS, 2, 1, 16);
}

function durationSeconds(job: CrawlQueueJobRow) {
  const startedAt = toTimestamp(job.startedAt || job.updatedAt);
  const completedAt = toTimestamp(job.completedAt || job.updatedAt);
  if (startedAt === null || completedAt === null || completedAt <= startedAt) {
    return null;
  }
  return Math.max(1, Math.round((completedAt - startedAt) / 1000));
}

function queueWorkloadState(activeCount: number, workerCapacity: number): CrawlQueueMetadata['workloadState'] {
  if (activeCount <= 0) return 'idle';
  if (activeCount <= workerCapacity) return 'normal';
  if (activeCount <= workerCapacity * 2) return 'busy';
  return 'backlogged';
}

function isoAfterSeconds(now: number, seconds: number | null) {
  if (seconds === null) return null;
  return new Date(now + seconds * 1000).toISOString();
}

function remainingDurationSeconds(job: CrawlQueueJobRow | null, now: number, estimatedDurationSeconds: number | null) {
  if (!job || estimatedDurationSeconds === null) {
    return null;
  }
  const startedAt = toTimestamp(job.startedAt || job.updatedAt);
  if (startedAt === null) {
    return estimatedDurationSeconds;
  }
  const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return Math.max(30, estimatedDurationSeconds - elapsedSeconds);
}

function findSoonestSlotIndex(slotAvailability: number[]) {
  let nextIndex = 0;
  for (let index = 1; index < slotAvailability.length; index += 1) {
    if (slotAvailability[index] < slotAvailability[nextIndex]) {
      nextIndex = index;
    }
  }
  return nextIndex;
}

export function buildCrawlQueueMetadata(options: BuildCrawlQueueMetadataOptions): CrawlQueueMetadata {
  const now = options.now ?? Date.now();
  const workerCapacity = getCrawlJobWorkerCount();
  const runningJobs = options.activeJobs
    .filter((job) => job.status === 'running')
    .sort((left, right) => (toTimestamp(left.startedAt || left.updatedAt) || 0) - (toTimestamp(right.startedAt || right.updatedAt) || 0));
  const queuedJobs = options.activeJobs
    .filter((job) => job.status === 'queued' || job.status === 'retrying')
    .sort((left, right) => {
      const leftQueueTime = toTimestamp(left.nextRunAt || left.updatedAt) || 0;
      const rightQueueTime = toTimestamp(right.nextRunAt || right.updatedAt) || 0;
      return leftQueueTime - rightQueueTime;
    });
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
  const blockingRunningCount = (targetStatus === 'queued' || targetStatus === 'retrying') && workspaceRunning >= workerCapacity
    ? 1
    : 0;
  const position = targetStatus === 'running'
    ? 1
    : (targetStatus === 'queued' || targetStatus === 'retrying') && options.targetJob
      ? blockingRunningCount + queuedAhead + 1
      : null;

  const targetRemainingSeconds = targetStatus === 'running'
    ? remainingDurationSeconds(targetActiveJob, now, estimatedDurationSeconds)
    : null;

  let estimatedStartInSeconds: number | null = targetStatus === 'running' ? 0 : null;
  let estimatedCompletionInSeconds: number | null = targetRemainingSeconds;
  if ((targetStatus === 'queued' || targetStatus === 'retrying') && estimatedDurationSeconds !== null && options.targetJob) {
    const slotAvailability = Array.from({ length: workerCapacity }, () => 0);
    for (const runningJob of runningJobs) {
      const remaining = remainingDurationSeconds(runningJob, now, estimatedDurationSeconds) ?? estimatedDurationSeconds;
      const slotIndex = findSoonestSlotIndex(slotAvailability);
      slotAvailability[slotIndex] = slotAvailability[slotIndex] + remaining;
    }

    for (const queuedJob of queuedJobs) {
      const slotIndex = findSoonestSlotIndex(slotAvailability);
      const startInSeconds = slotAvailability[slotIndex];
      if (queuedJob.id === options.targetJob.id) {
        estimatedStartInSeconds = startInSeconds;
        estimatedCompletionInSeconds = startInSeconds + estimatedDurationSeconds;
        break;
      }
      slotAvailability[slotIndex] = startInSeconds + estimatedDurationSeconds;
    }
  }

  const jobsAhead = blockingRunningCount + queuedAhead;

  let message = 'Workspace crawl queue is idle.';
  if (targetStatus === 'running') {
    message = workspaceQueued > 0
      ? `This crawl is running now. ${workspaceQueued} more crawl ${workspaceQueued === 1 ? 'job is' : 'jobs are'} queued in this workspace.`
      : 'This crawl is running now. No other crawl jobs are queued in this workspace.';
  } else if ((targetStatus === 'queued' || targetStatus === 'retrying') && position !== null) {
    message = jobsAhead > 0
      ? `${jobsAhead} crawl ${jobsAhead === 1 ? 'job is' : 'jobs are'} ahead of this site before it can start.`
      : 'This crawl is next in the workspace queue.';
  } else if (workspaceActive > 0) {
    message = `${workspaceQueued} crawl ${workspaceQueued === 1 ? 'job is' : 'jobs are'} queued and ${workspaceRunning} ${workspaceRunning === 1 ? 'is' : 'are'} running elsewhere in this workspace.`;
  }

  return {
    autoRefreshMs: options.autoRefreshMs ?? 5000,
    estimatedCompletionAt: isoAfterSeconds(now, estimatedCompletionInSeconds),
    estimatedCompletionInSeconds,
    estimatedDurationSeconds,
    estimatedStartInSeconds,
    message,
    position,
    queuedAhead: targetStatus === 'queued' || targetStatus === 'retrying' ? queuedAhead : 0,
    recentCompletedCount: completedDurations.length,
    runningAhead: blockingRunningCount,
    workloadState: queueWorkloadState(workspaceActive, workerCapacity),
    workspaceActive,
    workspaceQueued,
    workspaceRunning,
  };
}

function uniqueJobsById(jobs: CrawlQueueJobRow[]) {
  const seen = new Set<string>();
  const unique: CrawlQueueJobRow[] = [];
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    unique.push(job);
  }
  return unique;
}

async function getCrawlQueueMetadata(
  db: AppDatabase,
  ownerId: string,
  targetJob: Pick<CrawlQueueJobRow, 'id' | 'siteUrl' | 'status'> | null,
) {
  const [activeJobs, siteCompletedJobs, workspaceCompletedJobs] = await Promise.all([
    db.all<CrawlQueueJobRow>(
      `
        SELECT id, siteUrl, status, startedAt, updatedAt, completedAt, nextRunAt
        FROM crawl_jobs
        WHERE ownerId = ? AND status IN ('queued', 'retrying', 'running')
      `,
      [ownerId],
    ),
    targetJob?.siteUrl
      ? db.all<CrawlQueueJobRow>(
        `
          SELECT id, siteUrl, status, startedAt, updatedAt, completedAt, nextRunAt
          FROM crawl_jobs
          WHERE ownerId = ? AND siteUrl = ? AND status = 'completed'
          ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
          LIMIT 6
        `,
        [ownerId, targetJob.siteUrl],
      )
      : Promise.resolve([]),
    db.all<CrawlQueueJobRow>(
      `
        SELECT id, siteUrl, status, startedAt, updatedAt, completedAt, nextRunAt
        FROM crawl_jobs
        WHERE ownerId = ? AND status = 'completed'
        ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
        LIMIT 12
      `,
      [ownerId],
    ),
  ]);

  return buildCrawlQueueMetadata({
    activeJobs,
    completedJobs: uniqueJobsById([...siteCompletedJobs, ...workspaceCompletedJobs]).slice(0, 12),
    targetJob,
  });
}

function normalizeCrawlSiteHost(value: string | null | undefined) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  try {
    const candidate = isHttpUrl(trimmed)
      ? trimmed
      : 'https://' + trimmed.replace(/^sc-domain:/i, '').replace(/^https?:\/\//i, '');
    return new URL(candidate).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return trimmed
      .replace(/^sc-domain:/i, '')
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }
}

function resolveStartUrl(siteUrl: string, startUrl: string | null | undefined) {
  const candidates = [startUrl, siteUrl].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (isHttpUrl(trimmed)) {
      return trimmed;
    }

    const stripped = trimmed.replace(/^sc-domain:/i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (stripped) {
      return `https://${stripped}/`;
    }
  }

  return '';
}

function isStartUrlAllowedForSite(siteUrl: string, startUrl: string) {
  const normalizedSiteHost = normalizeCrawlSiteHost(siteUrl);
  const normalizedStartHost = normalizeCrawlSiteHost(startUrl);
  return Boolean(normalizedSiteHost && normalizedStartHost && normalizedSiteHost === normalizedStartHost);
}

function parseCrawlIssueFilter(value: unknown): CrawlIssueFilter | null {
  const issue = String(value || '').trim();
  if (
    issue === 'issues' ||
    issue === 'success' ||
    issue === 'redirect' ||
    issue === 'error' ||
    issue === 'no_response' ||
    issue === 'noindex' ||
    issue === 'orphan' ||
    issue === 'missing_title' ||
    issue === 'missing_meta' ||
    issue === 'canonicalized'
  ) {
    return issue;
  }
  return null;
}

export function registerCrawlRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

  app.post('/api/crawl/start', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, startUrl, sitemapUrl, maxDepth, maxPages, includeQueryStrings, renderMode, respectRobots, userAgent } = req.body;

    if (!isNonEmptyString(siteUrl)) {
      return res.status(400).json({ error: 'Invalid siteUrl' });
    }

    const user = await db.get<{ tier?: string | null }>('SELECT tier FROM users WHERE id = ?', [ownerId]);
    const resolvedStartUrl = resolveStartUrl(siteUrl, isNonEmptyString(startUrl) ? startUrl : null);
    const crawlLimits = getPlanCrawlLimits(user?.tier as any);

    if (!isHttpUrl(resolvedStartUrl)) {
      return res.status(400).json({
        error: 'A valid crawl start URL is required. Provide a full https:// URL or set a default site URL in the workspace.',
      });
    }

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      if (!isStartUrlAllowedForSite(siteUrl, resolvedStartUrl)) {
        return res.status(400).json({ error: 'The crawl start URL must stay on the selected workspace site host.' });
      }

      const current = await getCrawlStatus(db, ownerId, siteUrl);
      if (current.job && ['queued', 'retrying', 'running'].includes(current.job.status)) {
        return res.json({
          alreadyRunning: true,
          job: current.job,
          queue: await getCrawlQueueMetadata(db, ownerId, current.job),
          startUrl: current.job.startUrl,
          success: true,
        });
      }

      const job = await queueCrawlJob(db, {
        includeQueryStrings: includeQueryStrings === true,
        maxDepth: Number.isFinite(Number(maxDepth)) ? Math.min(Number(maxDepth), crawlLimits.maxDepth) : crawlLimits.maxDepth,
        maxPages: Number.isFinite(Number(maxPages)) ? Math.min(Number(maxPages), crawlLimits.maxPages) : crawlLimits.maxPages,
        ownerId,
        renderMode: renderMode === 'javascript' && crawlLimits.allowJavaScriptRendering ? 'javascript' : 'html',
        respectRobots: respectRobots === undefined ? undefined : respectRobots !== false,
        sitemapUrl: isNonEmptyString(sitemapUrl) ? sitemapUrl : null,
        siteUrl,
        startUrl: resolvedStartUrl,
        userAgent: isNonEmptyString(userAgent) ? userAgent : null,
      });

      res.json({ success: true, job, queue: await getCrawlQueueMetadata(db, ownerId, job), startUrl: resolvedStartUrl });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/crawl/status', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const jobId = asTrimmedString(req.query.jobId) || null;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const status = await getCrawlStatus(db, ownerId, siteUrl, jobId);
      res.json({ ...status, queue: await getCrawlQueueMetadata(db, ownerId, status.job) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/crawl/jobs', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 50) : 20;

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const { jobs } = await getCrawlJobs(db, ownerId, siteUrl, limit);
      const queueTarget = jobs.find((entry) => ['queued', 'retrying', 'running'].includes(entry.status)) || jobs[0] || null;
      res.json({ jobs, queue: await getCrawlQueueMetadata(db, ownerId, queueTarget) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/crawl/pages', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const jobId = asTrimmedString(req.query.jobId) || null;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 5000) : 50;
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(Number(req.query.offset), 0) : 0;
    const search = asTrimmedString(req.query.search) || null;
    const issue = parseCrawlIssueFilter(req.query.issue);

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const result = await getCrawlPages(db, ownerId, siteUrl, limit, offset, search, jobId, issue);
      res.json({ ...result, queue: await getCrawlQueueMetadata(db, ownerId, result.job) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/crawl/links', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const jobId = asTrimmedString(req.query.jobId);
    const search = asTrimmedString(req.query.search);
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 5000) : 100;
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(Number(req.query.offset), 0) : 0;

    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const result = await getCrawlLinks(db, ownerId, siteUrl, limit, offset, search, jobId);
      return res.json({ ...result, queue: await getCrawlQueueMetadata(db, ownerId, result.job) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to fetch crawl links' });
    }
  });

  app.get('/api/crawl/compare', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const baseJobId = asTrimmedString(req.query.baseJobId) || null;
    const compareJobId = asTrimmedString(req.query.compareJobId) || null;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const result = await compareCrawlJobs(db, ownerId, siteUrl, baseJobId, compareJobId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/crawl/cancel', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, jobId } = req.body || {};
    if (!isNonEmptyString(siteUrl) || !isNonEmptyString(jobId)) {
      return res.status(400).json({ error: 'Invalid crawl cancellation payload' });
    }

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const job = await cancelCrawlJob(db, ownerId, siteUrl, jobId);
      if (!job) {
        return res.status(404).json({ error: 'Crawl job not found' });
      }
      res.json({ job, queue: await getCrawlQueueMetadata(db, ownerId, job), success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to cancel crawl' });
    }
  });
}
