import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import type { AppDatabase } from '../database.js';
import { createUserSession, requireAuth, setSessionCookie } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isIsoDateString, isNonEmptyString } from '../validation.js';
import {
  buildGoogleAppAuthUrl,
  buildGoogleOauthUrl,
  clearGoogleRefreshToken,
  exchangeGoogleCodeForTokens,
  fetchGoogleUserInfo,
  getStoredGoogleRefreshToken,
  googleApiFetchJson,
  storeGoogleRefreshToken,
  verifyGoogleOauthState,
  verifyGoogleOauthStatePayload,
} from '../services/googleAuth.js';
import { queueWarehouseBootstrapJobs } from '../services/warehouseJobs.js';
import type { UserRow } from './auth.js';
import { canAccessGa4Property, canAccessSite } from '../accessControl.js';
import { resolveWorkspaceGa4Property } from '../services/ga4Mappings.js';
import { getInitialRegistrationTier } from '../services/registrationTier.js';

function sendOauthPopupResponse(res: Response, success: boolean, message: string) {
  const escapedMessage = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const payload = JSON.stringify({
    source: 'nextgen-seo-google-oauth',
    success,
    message,
  });

  res
    .status(success ? 200 : 400)
    .type('html')
    .send(`<!doctype html>
<html>
  <body style="font-family: system-ui; padding: 24px;">
    <script>
      (function () {
        var payload = ${payload};
        if (window.opener) {
          window.opener.postMessage(payload, window.location.origin);
          window.close();
        }
      })();
    </script>
    <p>${escapedMessage}</p>
  </body>
</html>`);
}

function positiveIntegerOrUndefined(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function parseStringArray(value: unknown) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function uniqueSites(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

type GoogleWarehouseBackfillSummary = {
  coreJobs: number;
  ga4DimensionJobs: number;
  llmJobs: number;
  siteCount: number;
  totalJobs: number;
};

const emptyGoogleWarehouseBackfillSummary = (): GoogleWarehouseBackfillSummary => ({
  coreJobs: 0,
  ga4DimensionJobs: 0,
  llmJobs: 0,
  siteCount: 0,
  totalJobs: 0,
});

function formatGoogleConnectionMessage(summary: GoogleWarehouseBackfillSummary, alreadySaved: boolean) {
  const prefix = alreadySaved ? 'Google account connection is already saved.' : 'Google account connected.';
  if (summary.siteCount === 0) {
    return `${prefix} Choose a site to start importing historical Search Console and GA4 data.`;
  }

  if (summary.totalJobs === 0) {
    return `${prefix} Historical imports are already queued or stored for ${summary.siteCount} site${summary.siteCount === 1 ? '' : 's'}.`;
  }

  const ga4Message = summary.ga4DimensionJobs + summary.llmJobs > 0
    ? ' Search Console, GA4, and LLM traffic history are queued.'
    : ' Search Console history is queued; choose a GA4 property to import GA4 history.';

  return `${prefix} ${summary.totalJobs} historical import job${summary.totalJobs === 1 ? '' : 's'} queued for ${summary.siteCount} site${summary.siteCount === 1 ? '' : 's'}.${ga4Message}`;
}

export function registerGoogleRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

  const queueGoogleWarehouseBackfillForWorkspaceSites = async (ownerId: string) => {
    const summary = emptyGoogleWarehouseBackfillSummary();
    try {
      const user = await db.get<{ activatedGa4PropertyId?: string | null; activatedSiteUrl?: string | null; knownSites?: string | null; tier?: string | null; unlockedSites?: string | null }>(
        'SELECT activatedGa4PropertyId, activatedSiteUrl, knownSites, tier, unlockedSites FROM users WHERE id = ?',
        [ownerId],
      );
      const activatedSiteUrl = isNonEmptyString(user?.activatedSiteUrl) ? user.activatedSiteUrl.trim() : null;
      const sitesToBackfill = uniqueSites([
        ...parseStringArray(user?.unlockedSites),
        ...(activatedSiteUrl ? [activatedSiteUrl] : []),
        ...parseStringArray(user?.knownSites),
      ]);
      for (const siteUrl of sitesToBackfill) {
        if (!(await canAccessSite(db, ownerId, siteUrl))) continue;
        const mappedPropertyId = await resolveWorkspaceGa4Property(db, ownerId, siteUrl);
        const activePropertyId = isNonEmptyString(user?.activatedGa4PropertyId) ? user.activatedGa4PropertyId.trim() : '';
        const propertyId = mappedPropertyId || (siteUrl === activatedSiteUrl && activePropertyId ? activePropertyId : null);
        const queued = await queueWarehouseBootstrapJobs(db, {
          ownerId,
          propertyId,
          siteUrl,
        });
        summary.siteCount += 1;
        summary.coreJobs += queued.core.length;
        summary.ga4DimensionJobs += queued.ga4Dimensions.length;
        summary.llmJobs += queued.llm.length;
        summary.totalJobs += queued.totalQueued;
      }
    } catch (err) {
      console.warn('Failed to queue Google warehouse backfill after connection', { ownerId, err });
    }
    return summary;
  };

  app.get('/api/auth/google/start', (_req, res) => {
    try {
      const authUrl = buildGoogleAppAuthUrl(_req as Request);
      res.json({ authUrl });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/google/oauth/start', authRequired, (req: AuthedRequest, res) => {
    try {
      const authUrl = buildGoogleOauthUrl(req as Request, req.authUser!.uid);
      res.json({ authUrl });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/google/oauth/callback', async (req: Request, res: Response) => {
    const code = asTrimmedString(req.query.code);
    const state = asTrimmedString(req.query.state);
    const error = asTrimmedString(req.query.error);

    if (error) {
      return sendOauthPopupResponse(res, false, `Google connection failed: ${error}`);
    }

    if (!code || !state) {
      return sendOauthPopupResponse(res, false, 'Missing Google OAuth callback parameters.');
    }

    try {
      const statePayload = verifyGoogleOauthStatePayload(state);
      const tokens = await exchangeGoogleCodeForTokens(req, code);

      if (statePayload.mode === 'app-auth') {
        const googleUser = await fetchGoogleUserInfo(tokens.access_token!);
        if (!googleUser.email_verified) {
          return sendOauthPopupResponse(res, false, 'Google account email is not verified.');
        }

        const normalizedEmail = googleUser.email!.trim().toLowerCase();
        let user = await db.get<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?)', [normalizedEmail]);

        if (user) {
          await db.run(
            `UPDATE users
             SET name = COALESCE(NULLIF(name, ''), ?),
                 avatarUrl = COALESCE(NULLIF(avatarUrl, ''), ?)
             WHERE id = ?`,
            [googleUser.name || null, googleUser.picture || null, user.id],
          );
          user = (await db.get<UserRow>('SELECT * FROM users WHERE id = ?', [user.id]))!;
        } else {
          const id = crypto.randomUUID();
          const createdAt = new Date().toISOString();
          const initialTier = await getInitialRegistrationTier(db);
          await db.run(`
            INSERT INTO users (
              id, email, passwordHash, authProvider, name, company, avatarUrl, bio, tier, unlockedSites, createdAt, bingApiKey, onboardingCompleted, activatedSiteUrl, billingStatus, subscriptionId, trialEndsAt, currentPeriodEnd
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            id,
            normalizedEmail,
            null,
            'google',
            googleUser.name || null,
            null,
            googleUser.picture || null,
            null,
            initialTier,
            JSON.stringify([]),
            createdAt,
            null,
            0,
            null,
            'active',
            null,
            null,
            null,
          ]);
          user = (await db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]))!;
        }

        const sessionToken = await createUserSession(db, user.id);
        setSessionCookie(res, sessionToken);
        return sendOauthPopupResponse(res, true, 'Google sign-in successful. You can close this window.');
      }

      const userId = verifyGoogleOauthState(state);
      if (!tokens.refresh_token) {
        const existingRefreshToken = await getStoredGoogleRefreshToken(db, userId);
        if (existingRefreshToken) {
          const summary = await queueGoogleWarehouseBackfillForWorkspaceSites(userId);
          return sendOauthPopupResponse(res, true, formatGoogleConnectionMessage(summary, true));
        }

        return sendOauthPopupResponse(res, false, 'Google did not return a refresh token. Please try again.');
      }

      await storeGoogleRefreshToken(db, userId, tokens.refresh_token);
      const summary = await queueGoogleWarehouseBackfillForWorkspaceSites(userId);
      return sendOauthPopupResponse(res, true, formatGoogleConnectionMessage(summary, false));
    } catch (err: any) {
      return sendOauthPopupResponse(res, false, err.message || 'Google connection failed.');
    }
  });

  app.get('/api/google/gsc/sites', authRequired, async (req: AuthedRequest, res) => {
    try {
      const data = await googleApiFetchJson(db, req.authUser!.uid, 'https://www.googleapis.com/webmasters/v3/sites');
      const siteEntries = Array.isArray(data.siteEntry) ? data.siteEntry : [];
      const knownSites = uniqueSites(siteEntries.map((site: any) => site?.siteUrl).filter(isNonEmptyString));
      if (knownSites.length > 0) {
        await db.run('UPDATE users SET knownSites = ? WHERE id = ?', [JSON.stringify(knownSites), req.authUser!.uid]);
        void queueGoogleWarehouseBackfillForWorkspaceSites(req.authUser!.uid);
      }
      res.json(siteEntries);
    } catch (err: any) {
      res.status(err.status || 500).json(err.payload || { error: err.message });
    }
  });

  app.post('/api/google/gsc/search-analytics', authRequired, async (req: AuthedRequest, res) => {
    const { siteUrl, startDate, endDate, dimensions, dimensionFilterGroups, rowLimit, startRow } = req.body;
    if (!isNonEmptyString(siteUrl)) return res.status(400).json({ error: 'Invalid siteUrl' });
    if (!isIsoDateString(startDate) || !isIsoDateString(endDate)) return res.status(400).json({ error: 'Invalid date range' });
    if (!Array.isArray(dimensions) || dimensions.some((dimension) => typeof dimension !== 'string')) {
      return res.status(400).json({ error: 'Invalid dimensions' });
    }

    try {
      if (!(await canAccessSite(db, req.authUser!.uid, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const data = await googleApiFetchJson(
        db,
        req.authUser!.uid,
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: 'POST',
          body: JSON.stringify({
            startDate,
            endDate,
            dimensions,
            dimensionFilterGroups,
            rowLimit,
            startRow,
          }),
        },
      );

      res.json(data);
    } catch (err: any) {
      res.status(err.status || 500).json(err.payload || { error: err.message });
    }
  });

  app.get('/api/google/ga4/properties', authRequired, async (req: AuthedRequest, res) => {
    try {
      const data = await googleApiFetchJson(db, req.authUser!.uid, 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries');
      res.json(data.accountSummaries || []);
    } catch (err: any) {
      res.status(err.status || 500).json(err.payload || { error: err.message });
    }
  });

  app.delete('/api/google/connection', authRequired, async (req: AuthedRequest, res) => {
    try {
      await clearGoogleRefreshToken(db, req.authUser!.uid);
      res.json({ success: true, googleConnected: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/google/ga4/run-report', authRequired, async (req: AuthedRequest, res) => {
    const { propertyId, startDate, endDate, dimensions, metrics, dimensionFilter, limit, offset } = req.body;
    if (!isNonEmptyString(propertyId)) return res.status(400).json({ error: 'Invalid propertyId' });
    if (!isIsoDateString(startDate) || !isIsoDateString(endDate)) return res.status(400).json({ error: 'Invalid date range' });
    if (!Array.isArray(dimensions) || dimensions.some((dimension) => typeof dimension !== 'string')) {
      return res.status(400).json({ error: 'Invalid dimensions' });
    }
    if (!Array.isArray(metrics) || metrics.some((metric) => typeof metric !== 'string')) {
      return res.status(400).json({ error: 'Invalid metrics' });
    }

    try {
      if (!(await canAccessGa4Property(db, req.authUser!.uid, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }

      const data = await googleApiFetchJson(
        db,
        req.authUser!.uid,
        `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
        {
          method: 'POST',
          body: JSON.stringify({
            dateRanges: [{ startDate, endDate }],
            dimensions: dimensions.map((name: string) => ({ name })),
            ...(positiveIntegerOrUndefined(limit) !== undefined ? { limit: positiveIntegerOrUndefined(limit) } : {}),
            metrics: metrics.map((name: string) => ({ name })),
            ...(positiveIntegerOrUndefined(offset) !== undefined ? { offset: positiveIntegerOrUndefined(offset) } : {}),
            ...(dimensionFilter ? { dimensionFilter } : {}),
          }),
        },
      );

      res.json(data);
    } catch (err: any) {
      res.status(err.status || 500).json(err.payload || { error: err.message });
    }
  });
}
