import type { Express, Request, Response } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isIsoDateString, isNonEmptyString } from '../validation.js';
import {
  buildGoogleOauthUrl,
  clearGoogleRefreshToken,
  exchangeGoogleCodeForTokens,
  getStoredGoogleRefreshToken,
  googleApiFetchJson,
  storeGoogleRefreshToken,
  verifyGoogleOauthState,
} from '../services/googleAuth.js';
import { canAccessGa4Property, canAccessSite } from '../accessControl.js';

function sendOauthPopupResponse(res: Response, success: boolean, message: string) {
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
    <p>${message}</p>
  </body>
</html>`);
}

function positiveIntegerOrUndefined(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

export function registerGoogleRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

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
      const userId = verifyGoogleOauthState(state);
      const tokens = await exchangeGoogleCodeForTokens(req, code);
      if (!tokens.refresh_token) {
        const existingRefreshToken = await getStoredGoogleRefreshToken(db, userId);
        if (existingRefreshToken) {
          return sendOauthPopupResponse(res, true, 'Google account connection is already saved. You can close this window.');
        }

        return sendOauthPopupResponse(res, false, 'Google did not return a refresh token. Please try again.');
      }

      await storeGoogleRefreshToken(db, userId, tokens.refresh_token);
      return sendOauthPopupResponse(res, true, 'Google account connected successfully. You can close this window.');
    } catch (err: any) {
      return sendOauthPopupResponse(res, false, err.message || 'Google connection failed.');
    }
  });

  app.get('/api/google/gsc/sites', authRequired, async (req: AuthedRequest, res) => {
    try {
      const data = await googleApiFetchJson(db, req.authUser!.uid, 'https://www.googleapis.com/webmasters/v3/sites');
      res.json(data.siteEntry || []);
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
