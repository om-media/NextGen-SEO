import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { requireAuth } from '../auth.js';
import { syncRankTrackingForSite } from '../services/rankTracking.js';
import type { AuthedRequest } from '../types.js';
import {
  asTrimmedString,
  isAllowedDevice,
  isNonEmptyString,
  isPlainObject,
  isStringArray,
  isStringRecord,
} from '../validation.js';

export function registerRankTrackingRoutes(app: Express, db: Database.Database) {
  app.get('/api/rank-tracking/keywords', requireAuth, (req: AuthedRequest, res) => {
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    try {
      const keywords = db.prepare('SELECT * FROM tracked_keywords WHERE ownerId = ? AND siteUrl = ? ORDER BY createdAt DESC').all(req.authUser!.uid, siteUrl);

      const enriched = (keywords as any[]).map((kw: any) => {
        const latestRank = db.prepare('SELECT position, rankingUrl, date FROM keyword_rankings WHERE keywordId = ? ORDER BY date DESC LIMIT 1').get(kw.id) as any;
        return {
          ...kw,
          currentPosition: latestRank ? latestRank.position : null,
          rankingUrl: latestRank ? latestRank.rankingUrl : null,
          lastUpdated: latestRank ? latestRank.date : null,
        };
      });
      res.json(enriched);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/rank-tracking/keywords', requireAuth, (req: AuthedRequest, res) => {
    const { siteUrl, keywords, location, device, tags, targetDomain, initialPositions } = req.body;
    if (!isNonEmptyString(siteUrl) || !isStringArray(keywords)) return res.status(400).json({ error: 'Invalid payload' });
    if (location !== undefined && location !== null && !isNonEmptyString(location)) return res.status(400).json({ error: 'Invalid location' });
    if (device !== undefined && device !== null && !isAllowedDevice(device)) return res.status(400).json({ error: 'Invalid device' });
    if (tags !== undefined && tags !== null && typeof tags !== 'string') return res.status(400).json({ error: 'Invalid tags' });
    if (targetDomain !== undefined && targetDomain !== null && !isNonEmptyString(targetDomain)) return res.status(400).json({ error: 'Invalid targetDomain' });
    if (initialPositions !== undefined && !isStringRecord(initialPositions) && !isPlainObject(initialPositions)) return res.status(400).json({ error: 'Invalid initialPositions' });

    try {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO tracked_keywords (id, siteUrl, ownerId, keyword, location, device, tags, targetDomain, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const rankStmt = db.prepare(`
        INSERT OR REPLACE INTO keyword_rankings (keywordId, date, position, rankingUrl)
        VALUES (?, ?, ?, ?)
      `);

      const today = new Date().toISOString().split('T')[0];

      const insertMany = db.transaction((kws: string[]) => {
        let inserted = 0;
        let skipped = 0;

        for (const kw of kws) {
          const kStr = kw.trim();
          if (!kStr) {
            skipped += 1;
            continue;
          }

          const id = crypto.randomUUID();
          const result = stmt.run(
            id,
            siteUrl,
            req.authUser!.uid,
            kStr,
            location || 'US',
            device || 'desktop',
            tags || '',
            targetDomain || '',
            new Date().toISOString(),
          );

          if (result.changes === 0) {
            skipped += 1;
            continue;
          }

          inserted += 1;

          if (isPlainObject(initialPositions) && initialPositions[kStr] !== undefined) {
            const initialPosition = Number(initialPositions[kStr]);
            if (Number.isFinite(initialPosition)) {
              rankStmt.run(id, today, Math.round(initialPosition), null);
            }
          }
        }

        return { inserted, skipped };
      });

      const result = insertMany(keywords);
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/rank-tracking/keywords/:id', requireAuth, (req: AuthedRequest, res) => {
    try {
      const keyword = db.prepare('SELECT id FROM tracked_keywords WHERE id = ? AND ownerId = ?').get(req.params.id, req.authUser!.uid) as { id: string } | undefined;
      if (!keyword) {
        return res.status(404).json({ error: 'Keyword not found' });
      }
      db.prepare('DELETE FROM tracked_keywords WHERE id = ? AND ownerId = ?').run(req.params.id, req.authUser!.uid);
      db.prepare('DELETE FROM keyword_rankings WHERE keywordId = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/rank-tracking/history', requireAuth, (req: AuthedRequest, res) => {
    const keywordId = asTrimmedString(req.query.keywordId);
    if (!keywordId) return res.status(400).json({ error: 'Missing keywordId' });
    try {
      const keyword = db.prepare('SELECT id FROM tracked_keywords WHERE id = ? AND ownerId = ?').get(keywordId, req.authUser!.uid) as { id: string } | undefined;
      if (!keyword) {
        return res.status(404).json({ error: 'Keyword not found' });
      }
      const history = db.prepare('SELECT * FROM keyword_rankings WHERE keywordId = ? ORDER BY date ASC').all(keywordId);
      res.json(history);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/rank-tracking/sync', requireAuth, async (req: AuthedRequest, res) => {
    const { siteUrl, force, gscHints } = req.body;
    if (!isNonEmptyString(siteUrl)) return res.status(400).json({ error: 'Missing siteUrl' });
    if (force !== undefined && typeof force !== 'boolean') return res.status(400).json({ error: 'Invalid force flag' });
    if (gscHints !== undefined && !isPlainObject(gscHints)) return res.status(400).json({ error: 'Invalid gscHints' });

    try {
      const result = await syncRankTrackingForSite(db, req.authUser!.uid, siteUrl, { force, gscHints });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
