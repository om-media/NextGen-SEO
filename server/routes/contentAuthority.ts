import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import { canAccessSite } from '../accessControl.js';
import {
  getContentAuthorityPageEvidence,
  getContentAuthorityReadiness,
  listContentAuthorityPages,
  listContentAuthorityTemplates,
} from '../services/contentAuthority.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString } from '../validation.js';
import { parseBoundedInteger } from '../routeValidation.js';

async function ensureSiteAccess(db: AppDatabase, ownerId: string, siteUrl: string) {
  return canAccessSite(db, ownerId, siteUrl);
}

export function registerContentAuthorityRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

  app.get('/api/content-authority/readiness', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    try {
      if (!(await ensureSiteAccess(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      res.json(await getContentAuthorityReadiness(db, ownerId, { crawlJobId: asTrimmedString(req.query.crawlJobId), siteUrl }));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load content authority readiness' });
    }
  });

  app.get('/api/content-authority/pages', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    const limit = parseBoundedInteger(req.query.limit, { defaultValue: 50, max: 500, min: 1 });
    const offset = parseBoundedInteger(req.query.offset, { defaultValue: 0, max: 1_000_000, min: 0 });
    if (!limit.ok || !offset.ok) return res.status(400).json({ error: 'Invalid pagination' });

    try {
      if (!(await ensureSiteAccess(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      res.json(await listContentAuthorityPages(db, ownerId, {
        crawlJobId: asTrimmedString(req.query.crawlJobId),
        limit: limit.value,
        offset: offset.value,
        search: asTrimmedString(req.query.search),
        siteUrl,
      }));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load content authority pages' });
    }
  });

  app.get('/api/content-authority/pages/:pageKey/evidence', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const pageKey = asTrimmedString(req.params.pageKey);
    if (!siteUrl || !pageKey) return res.status(400).json({ error: 'Missing siteUrl or pageKey' });

    try {
      if (!(await ensureSiteAccess(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      const result = await getContentAuthorityPageEvidence(db, ownerId, {
        crawlJobId: asTrimmedString(req.query.crawlJobId),
        pageKey,
        siteUrl,
      });
      if (!result.found) {
        return res.status(404).json({ error: 'Content authority evidence was not found for this page.', meta: result.meta });
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load content authority page evidence' });
    }
  });

  app.get('/api/content-authority/templates', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    try {
      if (!(await ensureSiteAccess(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      res.json(await listContentAuthorityTemplates(db, ownerId, { crawlJobId: asTrimmedString(req.query.crawlJobId), siteUrl }));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load content authority templates' });
    }
  });
}
