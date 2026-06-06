import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { canAccessSite } from '../accessControl.js';
import { isNonEmptyString } from '../validation.js';

function parseStringArray(value: unknown) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter((value) => value.trim()).map((value) => value.trim())));
}

const toNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

export function registerWorkspaceCrudRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

  app.get('/api/workspace/sites/status', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    try {
      const user = await db.get<any>('SELECT tier, unlockedSites, knownSites, activatedSiteUrl, activatedGa4PropertyId FROM users WHERE id = ?', [ownerId]);
      if (!user) {
        return res.status(404).json({ error: 'Account not found' });
      }

      const sites = uniqueStrings([
        ...parseStringArray(user.unlockedSites),
        ...parseStringArray(user.knownSites),
        user.activatedSiteUrl || '',
      ]);

      const rows = [];
      for (const siteUrl of sites) {
        const isAccessibleSite = await canAccessSite(db, ownerId, siteUrl);
        const warehouse = await db.get<any>(`
          SELECT
            MIN(date) AS earliestMetricDate,
            MAX(date) AS lastMetricDate,
            COUNT(DISTINCT date) AS metricDayCount,
            COUNT(*) AS rowCount
          FROM gsc_site_metrics
          WHERE ownerId = ? AND siteUrl = ?
        `, [ownerId, siteUrl]);
        const syncStatus = await db.get<any>('SELECT * FROM warehouse_sync_status WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]);
        const importJobs = await db.get<any>(`
          SELECT
            SUM(CASE WHEN status != 'superseded' THEN 1 ELSE 0 END) AS total,
            SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
            SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END) AS retrying,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            MAX(updatedAt) AS latestUpdatedAt
          FROM warehouse_jobs
          WHERE ownerId = ? AND siteUrl = ?
            AND jobType IN ('daily-sync', 'core-range-sync', 'ga4-dimension-range-sync', 'ga4-llm-range-sync')
        `, [ownerId, siteUrl]);
        const latestImportJob = await db.get<any>(`
          SELECT status, targetStartDate, targetDate, rowsSynced, lastError, updatedAt
          FROM warehouse_jobs
          WHERE ownerId = ? AND siteUrl = ?
            AND jobType IN ('daily-sync', 'core-range-sync', 'ga4-dimension-range-sync', 'ga4-llm-range-sync')
            AND status != 'superseded'
          ORDER BY updatedAt DESC
          LIMIT 1
        `, [ownerId, siteUrl]);
        const latestCrawl = await db.get<any>(`
          SELECT *
          FROM crawl_jobs
          WHERE ownerId = ? AND siteUrl = ?
          ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
          LIMIT 1
        `, [ownerId, siteUrl]);
        const crawlSummary = latestCrawl
          ? await db.get<any>(`
            SELECT
              COUNT(*) AS totalPages,
              SUM(CASE WHEN statusCode BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS successPages,
              SUM(CASE WHEN statusCode >= 400 OR statusCode IS NULL THEN 1 ELSE 0 END) AS errorPages,
              SUM(CASE WHEN noindex = 1 THEN 1 ELSE 0 END) AS noindexPages
            FROM crawl_pages
            WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
          `, [ownerId, siteUrl, latestCrawl.id])
          : null;

        rows.push({
          crawl: latestCrawl ? {
            completedAt: latestCrawl.completedAt || null,
            crawledCount: toNumber(latestCrawl.crawledCount),
            discoveredCount: toNumber(latestCrawl.discoveredCount),
            errorCount: toNumber(latestCrawl.errorCount),
            id: latestCrawl.id,
            lastError: latestCrawl.lastError || null,
            renderMode: latestCrawl.renderMode || 'html',
            startedAt: latestCrawl.startedAt || null,
            status: latestCrawl.status || 'unknown',
            summary: {
              errorPages: toNumber(crawlSummary?.errorPages),
              noindexPages: toNumber(crawlSummary?.noindexPages),
              successPages: toNumber(crawlSummary?.successPages),
              totalPages: toNumber(crawlSummary?.totalPages),
            },
            updatedAt: latestCrawl.updatedAt || null,
          } : null,
          isDefault: siteUrl === user.activatedSiteUrl,
          isUnlocked: isAccessibleSite,
          siteUrl,
          warehouse: {
            earliestMetricDate: warehouse?.earliestMetricDate || null,
            lastMetricDate: warehouse?.lastMetricDate || syncStatus?.lastSyncDate || null,
            metricDayCount: toNumber(warehouse?.metricDayCount),
            rowCount: toNumber(warehouse?.rowCount),
            status: syncStatus?.status || (warehouse?.lastMetricDate ? 'synced' : 'empty'),
            updatedAt: syncStatus?.lastUpdated || null,
            jobs: {
              completed: toNumber(importJobs?.completed),
              error: toNumber(importJobs?.error),
              latest: latestImportJob ? {
                lastError: latestImportJob.lastError || null,
                rowsSynced: toNumber(latestImportJob.rowsSynced),
                status: latestImportJob.status || 'unknown',
                targetDate: latestImportJob.targetDate || null,
                targetStartDate: latestImportJob.targetStartDate || null,
                updatedAt: latestImportJob.updatedAt || null,
              } : null,
              latestUpdatedAt: importJobs?.latestUpdatedAt || null,
              queued: toNumber(importJobs?.queued),
              retrying: toNumber(importJobs?.retrying),
              running: toNumber(importJobs?.running),
              total: toNumber(importJobs?.total),
            },
          },
        });
      }

      rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.siteUrl.localeCompare(b.siteUrl));

      res.json({
        ga4PropertyId: user.activatedGa4PropertyId || null,
        sites: rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load workspace site status' });
    }
  });

  app.get('/api/projects', authRequired, async (req: AuthedRequest, res) => {
    try {
      const rows = await db.all('SELECT * FROM projects WHERE ownerId = ?', [req.authUser!.uid]);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects', authRequired, async (req: AuthedRequest, res) => {
    const { id, name, domain, createdAt } = req.body;
    if (!isNonEmptyString(id)) return res.status(400).json({ error: 'Invalid id' });
    if (!isNonEmptyString(name)) return res.status(400).json({ error: 'Invalid name' });
    if (!isNonEmptyString(domain)) return res.status(400).json({ error: 'Invalid domain' });
    if (createdAt !== undefined && createdAt !== null && !isNonEmptyString(createdAt)) return res.status(400).json({ error: 'Invalid createdAt' });
    try {
      await db.run('INSERT INTO projects (id, name, domain, ownerId, createdAt) VALUES (?, ?, ?, ?, ?)', [id, name, domain, req.authUser!.uid, createdAt]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:id', authRequired, async (req: AuthedRequest, res) => {
    try {
      const result = await db.run('DELETE FROM projects WHERE id = ? AND ownerId = ?', [req.params.id, req.authUser!.uid]);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Project not found' });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/filters', authRequired, async (req: AuthedRequest, res) => {
    const projectId = req.query.projectId;
    if (projectId !== undefined && !isNonEmptyString(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
    try {
      const rows = projectId
        ? await db.all('SELECT * FROM filters WHERE ownerId = ? AND projectId = ?', [req.authUser!.uid, projectId])
        : await db.all('SELECT * FROM filters WHERE ownerId = ?', [req.authUser!.uid]);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/filters', authRequired, async (req: AuthedRequest, res) => {
    const { id, name, projectId, configuration, createdAt } = req.body;
    if (!isNonEmptyString(id)) return res.status(400).json({ error: 'Invalid id' });
    if (!isNonEmptyString(name)) return res.status(400).json({ error: 'Invalid name' });
    if (!isNonEmptyString(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
    if (!isNonEmptyString(configuration)) return res.status(400).json({ error: 'Invalid configuration' });
    if (createdAt !== undefined && createdAt !== null && !isNonEmptyString(createdAt)) return res.status(400).json({ error: 'Invalid createdAt' });
    try {
      await db.run('INSERT INTO filters (id, name, projectId, ownerId, configuration, createdAt) VALUES (?, ?, ?, ?, ?, ?)', [id, name, projectId, req.authUser!.uid, configuration, createdAt]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/filters/:id', authRequired, async (req: AuthedRequest, res) => {
    try {
      const result = await db.run('DELETE FROM filters WHERE id = ? AND ownerId = ?', [req.params.id, req.authUser!.uid]);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Filter not found' });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
