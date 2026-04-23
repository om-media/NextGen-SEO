import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { requireAuth, requireMatchingParam } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isAllowedAnnotationType, isIsoDateString, isNonEmptyString, isStringArray } from '../validation.js';

export function registerAccountDataRoutes(app: Express, db: Database.Database) {
  app.get('/api/users/:id', requireAuth, requireMatchingParam('id'), (req, res) => {
    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
      if (user) {
        user.unlockedSites = JSON.parse(user.unlockedSites || '[]');
        user.knownSites = JSON.parse(user.knownSites || '[]');

        const limit = user.tier === 'free' ? 1 : user.tier === 'pro' ? 3 : Infinity;
        if (user.unlockedSites.length > limit) {
          user.unlockedSites = user.unlockedSites.slice(0, limit);
          db.prepare('UPDATE users SET unlockedSites = ? WHERE id = ?').run(JSON.stringify(user.unlockedSites), req.params.id);
        }

        res.json(user);
      } else {
        res.status(404).json({ error: 'User not found' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/users', requireAuth, (req: AuthedRequest, res) => {
    const { email, createdAt } = req.body;
    if (!isNonEmptyString(email)) return res.status(400).json({ error: 'Invalid email' });
    if (createdAt !== undefined && createdAt !== null && !isNonEmptyString(createdAt)) return res.status(400).json({ error: 'Invalid createdAt' });
    try {
      const id = req.authUser!.uid;
      db.prepare('INSERT OR IGNORE INTO users (id, email, tier, unlockedSites, createdAt, bingApiKey) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, email, 'free', JSON.stringify([]), createdAt, null);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/unlock', requireAuth, requireMatchingParam('id'), (req, res) => {
    const { siteUrl } = req.body;
    if (!isNonEmptyString(siteUrl)) return res.status(400).json({ error: 'Invalid siteUrl' });
    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
      if (!user) return res.status(404).json({ error: 'User not found' });

      const unlockedSites = JSON.parse(user.unlockedSites || '[]');
      if (!unlockedSites.includes(siteUrl)) {
        unlockedSites.push(siteUrl);
        db.prepare('UPDATE users SET unlockedSites = ? WHERE id = ?').run(JSON.stringify(unlockedSites), req.params.id);
      }
      res.json({ success: true, unlockedSites });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/tier', requireAuth, requireMatchingParam('id'), (_req, res) => {
    return res.status(403).json({ error: 'Tier changes must be handled by an admin flow' });
  });

  app.put('/api/users/:id/bing-key', requireAuth, requireMatchingParam('id'), (req, res) => {
    const { bingApiKey } = req.body;
    if (bingApiKey !== undefined && bingApiKey !== null && typeof bingApiKey !== 'string') {
      return res.status(400).json({ error: 'Invalid bingApiKey' });
    }
    try {
      db.prepare('UPDATE users SET bingApiKey = ? WHERE id = ?').run(bingApiKey, req.params.id);
      res.json({ success: true, bingApiKey });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/known-sites', requireAuth, requireMatchingParam('id'), (req, res) => {
    const { knownSites } = req.body;
    if (!isStringArray(knownSites)) return res.status(400).json({ error: 'Invalid knownSites' });
    try {
      db.prepare('UPDATE users SET knownSites = ? WHERE id = ?').run(JSON.stringify(knownSites), req.params.id);
      res.json({ success: true, knownSites });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/annotations/:userId', requireAuth, requireMatchingParam('userId'), (req, res) => {
    try {
      const siteUrl = req.query.siteUrl;
      if (siteUrl !== undefined && siteUrl !== 'null' && !isNonEmptyString(siteUrl)) {
        return res.status(400).json({ error: 'Invalid siteUrl' });
      }

      const annotations = siteUrl && siteUrl !== 'null'
        ? db.prepare('SELECT * FROM annotations WHERE userId = ? AND (siteUrl = ? OR siteUrl IS NULL) ORDER BY date DESC').all(req.params.userId, siteUrl as string)
        : db.prepare('SELECT * FROM annotations WHERE userId = ? ORDER BY date DESC').all(req.params.userId);
      res.json(annotations);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/annotations/:userId', requireAuth, requireMatchingParam('userId'), (req, res) => {
    const { id, siteUrl, date, title, description, type } = req.body;
    if (id !== undefined && id !== null && !isNonEmptyString(id)) return res.status(400).json({ error: 'Invalid id' });
    if (siteUrl !== undefined && siteUrl !== null && !isNonEmptyString(siteUrl)) return res.status(400).json({ error: 'Invalid siteUrl' });
    if (!isIsoDateString(date)) return res.status(400).json({ error: 'Invalid date' });
    if (!isNonEmptyString(title)) return res.status(400).json({ error: 'Invalid title' });
    if (description !== undefined && description !== null && typeof description !== 'string') return res.status(400).json({ error: 'Invalid description' });
    if (type !== undefined && type !== null && !isAllowedAnnotationType(type)) return res.status(400).json({ error: 'Invalid type' });
    try {
      db.prepare(`
        INSERT INTO annotations (id, userId, siteUrl, date, title, description, type, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id || crypto.randomUUID(),
        req.params.userId,
        siteUrl || null,
        date,
        title,
        description || '',
        type || 'user',
        new Date().toISOString(),
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/annotations/:userId/:id', requireAuth, requireMatchingParam('userId'), (req, res) => {
    try {
      db.prepare('DELETE FROM annotations WHERE id = ? AND userId = ?').run(req.params.id, req.params.userId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/bing/sites', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const user = db.prepare('SELECT bingApiKey FROM users WHERE id = ?').get(req.authUser!.uid) as any;
      if (!user || !user.bingApiKey) {
        return res.status(400).json({ error: 'Bing API key not configured' });
      }

      const response = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${user.bingApiKey}`);
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/bing/stats', requireAuth, async (req: AuthedRequest, res) => {
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    try {
      const user = db.prepare('SELECT bingApiKey FROM users WHERE id = ?').get(req.authUser!.uid) as any;
      if (!user || !user.bingApiKey) {
        return res.status(400).json({ error: 'Bing API key not configured' });
      }

      const response = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${user.bingApiKey}`);
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
