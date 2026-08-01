import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import { canAccessSite } from '../accessControl.js';
import { getTopicalAuthorityReport } from '../services/topicalAuthority.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString } from '../validation.js';
import { parseBoundedInteger } from '../routeValidation.js';

export function registerTopicalAuthorityRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

  app.get('/api/topical-authority/clusters', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    const limit = parseBoundedInteger(req.query.limit, { defaultValue: 50, max: 200, min: 1 });
    const offset = parseBoundedInteger(req.query.offset, { defaultValue: 0, max: 1_000_000, min: 0 });
    if (!limit.ok || !offset.ok) return res.status(400).json({ error: 'Invalid pagination' });

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      res.json(await getTopicalAuthorityReport(db, ownerId, {
        limit: limit.value,
        offset: offset.value,
        search: asTrimmedString(req.query.search),
        siteUrl,
        status: asTrimmedString(req.query.status),
      }));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to load topical authority evidence.' });
    }
  });
}
