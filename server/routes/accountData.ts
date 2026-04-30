import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth, requireMatchingParam } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isAllowedAnnotationType, isIsoDateString, isNonEmptyString, isStringArray } from '../validation.js';
import { getPlanPropertyLimit } from '../../shared/plans.js';

export function registerAccountDataRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);
  app.get('/api/users/:id', authRequired, requireMatchingParam('id'), async (req, res) => {
    try {
      const user = await db.get<any>('SELECT * FROM users WHERE id = ?', [req.params.id]);
      if (user) {
        user.unlockedSites = JSON.parse(user.unlockedSites || '[]');
        user.knownSites = JSON.parse(user.knownSites || '[]');
        user.onboardingCompleted = Boolean(user.onboardingCompleted);
        user.activatedSiteUrl = user.activatedSiteUrl || null;
        user.activatedGa4PropertyId = user.activatedGa4PropertyId || null;
        user.activatedGa4DisplayName = user.activatedGa4DisplayName || null;
        user.googleConnected = Boolean(user.gscRefreshToken);
        user.billingStatus = user.billingStatus === 'trialing' ? 'active' : (user.billingStatus || 'active');
        user.subscriptionId = user.subscriptionId || null;
        user.trialEndsAt = user.trialEndsAt || null;
        user.currentPeriodEnd = user.currentPeriodEnd || null;
        delete user.gscRefreshToken;

        const limit = getPlanPropertyLimit(user.tier);
        if (limit !== null && user.unlockedSites.length > limit) {
          user.unlockedSites = user.unlockedSites.slice(0, limit);
          await db.run('UPDATE users SET unlockedSites = ? WHERE id = ?', [JSON.stringify(user.unlockedSites), req.params.id]);
        }

        res.json(user);
      } else {
        res.status(404).json({ error: 'User not found' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/users', authRequired, async (req: AuthedRequest, res) => {
    const { email, name, avatarUrl, createdAt } = req.body;
    if (!isNonEmptyString(email)) return res.status(400).json({ error: 'Invalid email' });
    if (name !== undefined && name !== null && typeof name !== 'string') return res.status(400).json({ error: 'Invalid name' });
    if (avatarUrl !== undefined && avatarUrl !== null && typeof avatarUrl !== 'string') return res.status(400).json({ error: 'Invalid avatarUrl' });
    if (createdAt !== undefined && createdAt !== null && !isNonEmptyString(createdAt)) return res.status(400).json({ error: 'Invalid createdAt' });
    try {
      const id = req.authUser!.uid;
      await db.run(`
        INSERT INTO users (
          id, email, name, company, avatarUrl, bio, tier, unlockedSites, createdAt, bingApiKey, onboardingCompleted, activatedSiteUrl, activatedGa4PropertyId, activatedGa4DisplayName, billingStatus, subscriptionId, trialEndsAt, currentPeriodEnd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `, [id, email, name || null, null, avatarUrl || null, null, 'free', JSON.stringify([]), createdAt, null, 0, null, null, null, 'active', null, null, null]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/profile', authRequired, requireMatchingParam('id'), async (req, res) => {
    const { name, company, avatarUrl, bio } = req.body;
    if (name !== undefined && name !== null && typeof name !== 'string') return res.status(400).json({ error: 'Invalid name' });
    if (company !== undefined && company !== null && typeof company !== 'string') return res.status(400).json({ error: 'Invalid company' });
    if (avatarUrl !== undefined && avatarUrl !== null && typeof avatarUrl !== 'string') return res.status(400).json({ error: 'Invalid avatarUrl' });
    if (bio !== undefined && bio !== null && typeof bio !== 'string') return res.status(400).json({ error: 'Invalid bio' });

    try {
      await db.run('UPDATE users SET name = ?, company = ?, avatarUrl = ?, bio = ? WHERE id = ?', [name || null, company || null, avatarUrl || null, bio || null, req.params.id]);
      res.json({
        success: true,
        profile: {
          name: name || null,
          company: company || null,
          avatarUrl: avatarUrl || null,
          bio: bio || null,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/onboarding', authRequired, requireMatchingParam('id'), async (req, res) => {
    const { onboardingCompleted, activatedSiteUrl, activatedGa4PropertyId, activatedGa4DisplayName } = req.body;
    if (typeof onboardingCompleted !== 'boolean') {
      return res.status(400).json({ error: 'Invalid onboardingCompleted' });
    }
    if (activatedSiteUrl !== undefined && activatedSiteUrl !== null && !isNonEmptyString(activatedSiteUrl)) {
      return res.status(400).json({ error: 'Invalid activatedSiteUrl' });
    }
    if (activatedGa4PropertyId !== undefined && activatedGa4PropertyId !== null && !isNonEmptyString(activatedGa4PropertyId)) {
      return res.status(400).json({ error: 'Invalid activatedGa4PropertyId' });
    }
    if (activatedGa4DisplayName !== undefined && activatedGa4DisplayName !== null && typeof activatedGa4DisplayName !== 'string') {
      return res.status(400).json({ error: 'Invalid activatedGa4DisplayName' });
    }

    try {
      const user = await db.get<any>('SELECT tier, unlockedSites, onboardingCompleted FROM users WHERE id = ?', [req.params.id]);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      let unlockedSites = JSON.parse(user.unlockedSites || '[]');

      if (onboardingCompleted && activatedSiteUrl) {
        const limit = getPlanPropertyLimit(user.tier);

        if (!Boolean(user.onboardingCompleted)) {
          unlockedSites = limit === null ? [activatedSiteUrl] : [activatedSiteUrl].slice(0, limit);
        } else if (!unlockedSites.includes(activatedSiteUrl)) {
          unlockedSites = [activatedSiteUrl, ...unlockedSites];
          if (limit !== null) {
            unlockedSites = unlockedSites.slice(0, limit);
          }
        }
      }

      await db.run('UPDATE users SET onboardingCompleted = ?, activatedSiteUrl = ?, activatedGa4PropertyId = ?, activatedGa4DisplayName = ?, unlockedSites = ? WHERE id = ?', [
          onboardingCompleted ? 1 : 0,
          activatedSiteUrl || null,
          activatedGa4PropertyId || null,
          activatedGa4DisplayName || null,
          JSON.stringify(unlockedSites),
          req.params.id,
        ]);
      res.json({
        success: true,
        onboardingCompleted,
        activatedSiteUrl: activatedSiteUrl || null,
        activatedGa4PropertyId: activatedGa4PropertyId || null,
        activatedGa4DisplayName: activatedGa4DisplayName || null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/default-site', authRequired, requireMatchingParam('id'), async (req, res) => {
    const { activatedSiteUrl } = req.body;
    if (!isNonEmptyString(activatedSiteUrl)) {
      return res.status(400).json({ error: 'Invalid activatedSiteUrl' });
    }

    try {
      await db.run('UPDATE users SET activatedSiteUrl = ? WHERE id = ?', [activatedSiteUrl, req.params.id]);
      res.json({ success: true, activatedSiteUrl });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/default-ga4-property', authRequired, requireMatchingParam('id'), async (req, res) => {
    const { activatedGa4PropertyId, activatedGa4DisplayName } = req.body;
    if (!isNonEmptyString(activatedGa4PropertyId)) {
      return res.status(400).json({ error: 'Invalid activatedGa4PropertyId' });
    }
    if (activatedGa4DisplayName !== undefined && activatedGa4DisplayName !== null && typeof activatedGa4DisplayName !== 'string') {
      return res.status(400).json({ error: 'Invalid activatedGa4DisplayName' });
    }

    try {
      await db.run('UPDATE users SET activatedGa4PropertyId = ?, activatedGa4DisplayName = ? WHERE id = ?', [activatedGa4PropertyId, activatedGa4DisplayName || null, req.params.id]);
      res.json({
        success: true,
        activatedGa4PropertyId,
        activatedGa4DisplayName: activatedGa4DisplayName || null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/unlock', authRequired, requireMatchingParam('id'), async (req, res) => {
    const { siteUrl } = req.body;
    if (!isNonEmptyString(siteUrl)) return res.status(400).json({ error: 'Invalid siteUrl' });
    try {
      const user = await db.get<any>('SELECT * FROM users WHERE id = ?', [req.params.id]);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const unlockedSites = JSON.parse(user.unlockedSites || '[]');
      if (!unlockedSites.includes(siteUrl)) {
        unlockedSites.push(siteUrl);
        await db.run('UPDATE users SET unlockedSites = ? WHERE id = ?', [JSON.stringify(unlockedSites), req.params.id]);
      }
      res.json({ success: true, unlockedSites });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/tier', authRequired, requireMatchingParam('id'), (_req, res) => {
    return res.status(403).json({ error: 'Tier changes must be handled by an admin flow' });
  });

  app.put('/api/users/:id/billing', authRequired, requireMatchingParam('id'), async (req, res) => {
    const { billingStatus, subscriptionId, trialEndsAt, currentPeriodEnd } = req.body;
    const allowedStatuses = new Set(['trialing', 'active', 'past_due', 'canceled', 'incomplete']);

    if (!isNonEmptyString(billingStatus) || !allowedStatuses.has(billingStatus)) {
      return res.status(400).json({ error: 'Invalid billingStatus' });
    }
    if (subscriptionId !== undefined && subscriptionId !== null && typeof subscriptionId !== 'string') {
      return res.status(400).json({ error: 'Invalid subscriptionId' });
    }
    if (trialEndsAt !== undefined && trialEndsAt !== null && !isNonEmptyString(trialEndsAt)) {
      return res.status(400).json({ error: 'Invalid trialEndsAt' });
    }
    if (currentPeriodEnd !== undefined && currentPeriodEnd !== null && !isNonEmptyString(currentPeriodEnd)) {
      return res.status(400).json({ error: 'Invalid currentPeriodEnd' });
    }

    try {
      await db.run('UPDATE users SET billingStatus = ?, subscriptionId = ?, trialEndsAt = ?, currentPeriodEnd = ? WHERE id = ?', [billingStatus, subscriptionId || null, trialEndsAt || null, currentPeriodEnd || null, req.params.id]);
      res.json({
        success: true,
        billing: {
          billingStatus,
          subscriptionId: subscriptionId || null,
          trialEndsAt: trialEndsAt || null,
          currentPeriodEnd: currentPeriodEnd || null,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/bing-key', authRequired, requireMatchingParam('id'), async (req, res) => {
    const { bingApiKey } = req.body;
    if (bingApiKey !== undefined && bingApiKey !== null && typeof bingApiKey !== 'string') {
      return res.status(400).json({ error: 'Invalid bingApiKey' });
    }
    try {
      await db.run('UPDATE users SET bingApiKey = ? WHERE id = ?', [bingApiKey, req.params.id]);
      res.json({ success: true, bingApiKey });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/known-sites', authRequired, requireMatchingParam('id'), async (req, res) => {
    const { knownSites } = req.body;
    if (!isStringArray(knownSites)) return res.status(400).json({ error: 'Invalid knownSites' });
    try {
      await db.run('UPDATE users SET knownSites = ? WHERE id = ?', [JSON.stringify(knownSites), req.params.id]);
      res.json({ success: true, knownSites });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/annotations/:userId', authRequired, requireMatchingParam('userId'), async (req, res) => {
    try {
      const siteUrl = req.query.siteUrl;
      if (siteUrl !== undefined && siteUrl !== 'null' && !isNonEmptyString(siteUrl)) {
        return res.status(400).json({ error: 'Invalid siteUrl' });
      }

      const annotations = siteUrl && siteUrl !== 'null'
        ? await db.all('SELECT * FROM annotations WHERE userId = ? AND (siteUrl = ? OR siteUrl IS NULL) ORDER BY date DESC', [req.params.userId, siteUrl as string])
        : await db.all('SELECT * FROM annotations WHERE userId = ? ORDER BY date DESC', [req.params.userId]);
      res.json(annotations);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/annotations/:userId', authRequired, requireMatchingParam('userId'), async (req, res) => {
    const { id, siteUrl, date, title, description, type } = req.body;
    if (id !== undefined && id !== null && !isNonEmptyString(id)) return res.status(400).json({ error: 'Invalid id' });
    if (siteUrl !== undefined && siteUrl !== null && !isNonEmptyString(siteUrl)) return res.status(400).json({ error: 'Invalid siteUrl' });
    if (!isIsoDateString(date)) return res.status(400).json({ error: 'Invalid date' });
    if (!isNonEmptyString(title)) return res.status(400).json({ error: 'Invalid title' });
    if (description !== undefined && description !== null && typeof description !== 'string') return res.status(400).json({ error: 'Invalid description' });
    if (type !== undefined && type !== null && !isAllowedAnnotationType(type)) return res.status(400).json({ error: 'Invalid type' });
    try {
      await db.run(`
        INSERT INTO annotations (id, userId, siteUrl, date, title, description, type, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id || crypto.randomUUID(),
        req.params.userId,
        siteUrl || null,
        date,
        title,
        description || '',
        type || 'user',
        new Date().toISOString(),
      ]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/annotations/:userId/:id', authRequired, requireMatchingParam('userId'), async (req, res) => {
    try {
      await db.run('DELETE FROM annotations WHERE id = ? AND userId = ?', [req.params.id, req.params.userId]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/bing/sites', authRequired, async (req: AuthedRequest, res) => {
    try {
      const user = await db.get<any>('SELECT bingApiKey FROM users WHERE id = ?', [req.authUser!.uid]);
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

  app.get('/api/bing/stats', authRequired, async (req: AuthedRequest, res) => {
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    try {
      const user = await db.get<any>('SELECT bingApiKey FROM users WHERE id = ?', [req.authUser!.uid]);
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
