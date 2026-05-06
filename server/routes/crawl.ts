import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isNonEmptyString } from '../validation.js';
import { cancelCrawlJob, compareCrawlJobs, getCrawlJobs, getCrawlLinks, getCrawlPages, getCrawlStatus, queueCrawlJob, type CrawlIssueFilter } from '../services/crawl.js';
import { getPlanCrawlLimits } from '../../shared/plans.js';
import { canAccessSite } from '../accessControl.js';

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function resolveStartUrl(siteUrl: string, startUrl: string | null | undefined, activatedSiteUrl: string | null | undefined) {
  const candidates = [startUrl, siteUrl, activatedSiteUrl].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));
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

function parseCrawlIssueFilter(value: unknown): CrawlIssueFilter | null {
  const issue = String(value || '').trim();
  if (
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

    const user = await db.get<{ activatedSiteUrl?: string | null; tier?: string | null }>('SELECT activatedSiteUrl, tier FROM users WHERE id = ?', [ownerId]);
    const resolvedStartUrl = resolveStartUrl(siteUrl, isNonEmptyString(startUrl) ? startUrl : null, user?.activatedSiteUrl || null);
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

      const current = await getCrawlStatus(db, ownerId, siteUrl);
      if (current.job && ['queued', 'retrying', 'running'].includes(current.job.status)) {
        return res.json({ success: true, job: current.job, startUrl: current.job.startUrl, alreadyRunning: true });
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

      res.json({ success: true, job, startUrl: resolvedStartUrl });
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
      res.json(status);
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

      const jobs = await getCrawlJobs(db, ownerId, siteUrl, limit);
      res.json(jobs);
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
      res.json(result);
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
      return res.json(result);
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
      res.json({ job, success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to cancel crawl' });
    }
  });
}
