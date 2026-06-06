import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth, requireMatchingParam } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isAllowedAnnotationType, isIsoDateString, isNonEmptyString, isStringArray } from '../validation.js';
import { getPlanCrawlLimits } from '../../shared/plans.js';
import { getBingCacheStatus, listCachedBingQueryStats, syncBingQueryStats } from '../services/bingWarehouse.js';
import { getCrawlStatus, queueCrawlJob } from '../services/crawl.js';
import { queueWarehouseBootstrapJobs } from '../services/warehouseJobs.js';
import { canAccessSite } from '../accessControl.js';
import { resolveWorkspaceGa4Property, upsertWorkspaceGa4Mapping } from '../services/ga4Mappings.js';
import { getInitialRegistrationTier } from '../services/registrationTier.js';

export function registerAccountDataRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);
  const parseStoredSites = (value: unknown) => {
    if (typeof value !== 'string') return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
    } catch {
      return [];
    }
  };

  const uniqueSites = (values: string[]) => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

  const resolveCrawlStartUrl = (siteUrl: string) => {
    const trimmed = String(siteUrl || '').trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    const hostname = trimmed.replace(/^sc-domain:/i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return hostname ? `https://${hostname}/` : '';
  };

  const queueInitialCrawlIfNeeded = async (ownerId: string, siteUrl: string, tier: string | null | undefined) => {
    try {
      const startUrl = resolveCrawlStartUrl(siteUrl);
      if (!/^https?:\/\//i.test(startUrl)) return;

      const existing = await getCrawlStatus(db, ownerId, siteUrl);
      if (existing.job) return;

      const crawlLimits = getPlanCrawlLimits(tier as any);
      await queueCrawlJob(db, {
        includeQueryStrings: false,
        maxDepth: crawlLimits.maxDepth,
        maxPages: crawlLimits.maxPages,
        ownerId,
        renderMode: 'html',
        respectRobots: true,
        sitemapUrl: null,
        siteUrl,
        startUrl,
        userAgent: null,
      });
    } catch (err) {
      console.warn('Failed to queue initial crawl', { ownerId, siteUrl, err });
    }
  };

  const queueInitialWarehouseSyncIfPossible = async (ownerId: string, siteUrl: string, propertyId?: string | null) => {
    try {
      const user = await db.get<{ activatedGa4PropertyId?: string | null; activatedSiteUrl?: string | null; gscRefreshToken?: string | null }>(
        'SELECT activatedGa4PropertyId, activatedSiteUrl, gscRefreshToken FROM users WHERE id = ?',
        [ownerId],
      );
      if (!user?.gscRefreshToken) return;

      const activeSiteUrl = typeof user.activatedSiteUrl === 'string' ? user.activatedSiteUrl.trim() : '';
      if (propertyId) {
        await upsertWorkspaceGa4Mapping(db, { ownerId, propertyId, siteUrl });
      }
      const mappedPropertyId = await resolveWorkspaceGa4Property(db, ownerId, siteUrl);
      const activePropertyId = siteUrl === activeSiteUrl ? propertyId || mappedPropertyId || user.activatedGa4PropertyId || null : mappedPropertyId;
      await queueWarehouseBootstrapJobs(db, { ownerId, propertyId: activePropertyId, siteUrl });
    } catch (err) {
      console.warn('Failed to queue initial warehouse sync', { ownerId, siteUrl, err });
    }
  };

  const queueKnownSiteDataIfPossible = async (ownerId: string, knownSites: string[]) => {
    try {
      const user = await db.get<{
        activatedGa4PropertyId?: string | null;
        activatedSiteUrl?: string | null;
        gscRefreshToken?: string | null;
        tier?: string | null;
        unlockedSites?: string | null;
      }>(
        'SELECT activatedGa4PropertyId, activatedSiteUrl, gscRefreshToken, tier, unlockedSites FROM users WHERE id = ?',
        [ownerId],
      );
      if (!user) return;

      const activeSiteUrl = typeof user.activatedSiteUrl === 'string' ? user.activatedSiteUrl.trim() : '';
      const accessibleSites: string[] = [];

      for (const siteUrl of uniqueSites(knownSites)) {
        if (await canAccessSite(db, ownerId, siteUrl)) {
          accessibleSites.push(siteUrl);
        }
      }

      for (const siteUrl of accessibleSites) {
        await queueInitialCrawlIfNeeded(ownerId, siteUrl, user.tier);
        if (!user.gscRefreshToken) continue;
        const mappedPropertyId = await resolveWorkspaceGa4Property(db, ownerId, siteUrl);
        await queueWarehouseBootstrapJobs(db, {
          ownerId,
          propertyId: mappedPropertyId || (siteUrl === activeSiteUrl ? user.activatedGa4PropertyId || null : null),
          siteUrl,
        });
      }
    } catch (err) {
      console.warn('Failed to queue known site data priming', { ownerId, err });
    }
  };

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
        user.bingConnected = Boolean(user.bingApiKey);
        delete user.gscRefreshToken;
        delete user.bingApiKey;

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
      const initialTier = await getInitialRegistrationTier(db);
      await db.run(`
        INSERT INTO users (
          id, email, name, company, avatarUrl, bio, tier, unlockedSites, createdAt, bingApiKey, onboardingCompleted, activatedSiteUrl, activatedGa4PropertyId, activatedGa4DisplayName, billingStatus, subscriptionId, trialEndsAt, currentPeriodEnd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `, [id, email, name || null, null, avatarUrl || null, null, initialTier, JSON.stringify([]), createdAt, null, 0, null, null, null, 'active', null, null, null]);
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

      let unlockedSites = uniqueSites(parseStoredSites(user.unlockedSites));

      if (onboardingCompleted && activatedSiteUrl) {
        if (!Boolean(user.onboardingCompleted)) {
          unlockedSites = [activatedSiteUrl];
        } else if (!unlockedSites.includes(activatedSiteUrl)) {
          unlockedSites = [activatedSiteUrl, ...unlockedSites];
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
      if (onboardingCompleted && activatedSiteUrl) {
        await queueInitialCrawlIfNeeded(req.params.id, activatedSiteUrl, user.tier);
        await queueInitialWarehouseSyncIfPossible(req.params.id, activatedSiteUrl, activatedGa4PropertyId || null);
      }
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
      const user = await db.get<any>('SELECT tier, unlockedSites FROM users WHERE id = ?', [req.params.id]);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (!(await canAccessSite(db, req.params.id, activatedSiteUrl))) {
        return res.status(403).json({ error: 'Activate this site before making it the workspace default.' });
      }
      await db.run('UPDATE users SET activatedSiteUrl = ? WHERE id = ?', [activatedSiteUrl, req.params.id]);
      await queueInitialCrawlIfNeeded(req.params.id, activatedSiteUrl, user.tier);
      await queueInitialWarehouseSyncIfPossible(req.params.id, activatedSiteUrl);
      res.json({ success: true, activatedSiteUrl });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/default-ga4-property', authRequired, requireMatchingParam('id'), async (req, res) => {
    const { activatedGa4PropertyId, activatedGa4DisplayName, siteUrl } = req.body;
    if (!isNonEmptyString(activatedGa4PropertyId)) {
      return res.status(400).json({ error: 'Invalid activatedGa4PropertyId' });
    }
    if (activatedGa4DisplayName !== undefined && activatedGa4DisplayName !== null && typeof activatedGa4DisplayName !== 'string') {
      return res.status(400).json({ error: 'Invalid activatedGa4DisplayName' });
    }

    try {
      const user = await db.get<any>('SELECT activatedSiteUrl, knownSites, tier, unlockedSites FROM users WHERE id = ?', [req.params.id]);
      if (!user) return res.status(404).json({ error: 'User not found' });

      await db.run('UPDATE users SET activatedGa4PropertyId = ?, activatedGa4DisplayName = ? WHERE id = ?', [activatedGa4PropertyId, activatedGa4DisplayName || null, req.params.id]);
      const activeSiteUrl = isNonEmptyString(user.activatedSiteUrl) ? user.activatedSiteUrl.trim() : '';
      const mappedSiteUrl = isNonEmptyString(siteUrl) ? siteUrl.trim() : activeSiteUrl;
      if (mappedSiteUrl) {
        if (!(await canAccessSite(db, req.params.id, mappedSiteUrl))) {
          return res.status(403).json({ error: 'This site is not activated for your workspace.' });
        }
        await upsertWorkspaceGa4Mapping(db, {
          displayName: activatedGa4DisplayName || null,
          ownerId: req.params.id,
          propertyId: activatedGa4PropertyId,
          siteUrl: mappedSiteUrl,
        });
      }
      const sitesToBackfill = uniqueSites([
        ...parseStoredSites(user.unlockedSites),
        ...parseStoredSites(user.knownSites),
        ...(activeSiteUrl ? [activeSiteUrl] : []),
        ...(mappedSiteUrl ? [mappedSiteUrl] : []),
      ]);
      for (const siteUrl of sitesToBackfill) {
        if (!(await canAccessSite(db, req.params.id, siteUrl))) continue;
        const mappedPropertyId = await resolveWorkspaceGa4Property(db, req.params.id, siteUrl);
        await queueInitialWarehouseSyncIfPossible(
          req.params.id,
          siteUrl,
          mappedPropertyId || (siteUrl === activeSiteUrl ? activatedGa4PropertyId : null),
        );
      }
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

      const unlockedSites = uniqueSites(parseStoredSites(user.unlockedSites));
      if (!unlockedSites.includes(siteUrl)) {
        unlockedSites.push(siteUrl);
        await db.run('UPDATE users SET unlockedSites = ? WHERE id = ?', [JSON.stringify(unlockedSites), req.params.id]);
      }
      await queueInitialCrawlIfNeeded(req.params.id, siteUrl, user.tier);
      await queueInitialWarehouseSyncIfPossible(req.params.id, siteUrl);
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
      const normalized = typeof bingApiKey === 'string' ? bingApiKey.trim() : '';
      await db.run('UPDATE users SET bingApiKey = ? WHERE id = ?', [normalized || null, req.params.id]);
      res.json({ success: true, bingConnected: Boolean(normalized) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/known-sites', authRequired, requireMatchingParam('id'), async (req, res) => {
    const { knownSites } = req.body;
    if (!isStringArray(knownSites)) return res.status(400).json({ error: 'Invalid knownSites' });
    try {
      const user = await db.get<any>('SELECT activatedSiteUrl, knownSites, unlockedSites FROM users WHERE id = ?', [req.params.id]);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const existingAllowedSites = new Set(uniqueSites([
        ...parseStoredSites(user.knownSites),
        ...parseStoredSites(user.unlockedSites),
        ...(isNonEmptyString(user.activatedSiteUrl) ? [user.activatedSiteUrl] : []),
      ]));
      const normalizedKnownSites = uniqueSites(knownSites).filter((siteUrl) => existingAllowedSites.has(siteUrl));
      await db.run('UPDATE users SET knownSites = ? WHERE id = ?', [JSON.stringify(normalizedKnownSites), req.params.id]);
      void queueKnownSiteDataIfPossible(req.params.id, normalizedKnownSites);
      res.json({ success: true, knownSites: normalizedKnownSites });
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
      if (isNonEmptyString(siteUrl) && siteUrl !== 'null' && !(await canAccessSite(db, req.params.userId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
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
      if (isNonEmptyString(siteUrl) && !(await canAccessSite(db, req.params.userId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

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
      if (!(await canAccessSite(db, req.authUser!.uid, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const user = await db.get<any>('SELECT bingApiKey FROM users WHERE id = ?', [req.authUser!.uid]);
      if (!user || !user.bingApiKey) {
        return res.status(400).json({ error: 'Bing API key not configured' });
      }

      const [rows, status] = await Promise.all([
        listCachedBingQueryStats(db, req.authUser!.uid, siteUrl),
        getBingCacheStatus(db, req.authUser!.uid, siteUrl),
      ]);
      res.json({
        d: rows,
        meta: {
          cache: status,
          fromCache: true,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/bing/stats/sync', authRequired, async (req: AuthedRequest, res) => {
    const siteUrl = asTrimmedString(req.body?.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    try {
      if (!(await canAccessSite(db, req.authUser!.uid, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const user = await db.get<any>('SELECT bingApiKey FROM users WHERE id = ?', [req.authUser!.uid]);
      if (!user || !user.bingApiKey) {
        return res.status(400).json({ error: 'Bing API key not configured' });
      }

      const result = await syncBingQueryStats(db, {
        apiKey: user.bingApiKey,
        ownerId: req.authUser!.uid,
        siteUrl,
      });

      res.json({
        d: result.rows,
        meta: {
          cache: {
            isFresh: true,
            latestFetchedAt: result.fetchedAt,
            rowCount: result.rows.length,
          },
          fromCache: false,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
