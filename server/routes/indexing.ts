import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isIsoDateString, isNonEmptyString, isStringArray } from '../validation.js';
import { googleApiFetchJson } from '../services/googleAuth.js';
import { canAccessSite } from '../accessControl.js';

type SyncJob = {
  current: number;
  total: number;
  status: 'running' | 'completed' | 'error';
  message?: string;
};

export function registerIndexingRoutes(
  app: Express,
  db: AppDatabase,
  syncJobs: Map<string, SyncJob>,
  getSyncJobKey: (ownerId: string, siteUrl: string) => string,
) {
  const authRequired = requireAuth(db);

  app.get('/api/indexing/grid', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const isLive = req.query.isLive;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    if (startDate !== undefined && !isIsoDateString(startDate)) return res.status(400).json({ error: 'Invalid startDate' });
    if (endDate !== undefined && !isIsoDateString(endDate)) return res.status(400).json({ error: 'Invalid endDate' });
    if (isLive !== undefined && isLive !== 'true' && isLive !== 'false') return res.status(400).json({ error: 'Invalid isLive flag' });
    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      let gscPages: any[] = [];
      const start = startDate ? String(startDate) : '2000-01-01';
      const end = endDate ? String(endDate) : '2099-12-31';

      if (isLive === 'true') {
        try {
          const json = await googleApiFetchJson(
            db,
            ownerId,
            `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
            {
              method: 'POST',
              body: JSON.stringify({
                startDate: start,
                endDate: end,
                dimensions: ['page'],
                rowLimit: 5000,
              }),
            },
          );
          if (json.rows) {
            gscPages = json.rows.map((r: any) => ({
              url: r.keys[0],
              clicks: r.clicks,
              impressions: r.impressions,
            }));
          }
        } catch (e) {
          console.error('GSC Live Fetch Error in Indexing:', e);
        }
      } else {
        gscPages = await db.all(
          'SELECT page as url, SUM(clicks) as clicks, SUM(impressions) as impressions FROM gsc_page_query_metrics WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? GROUP BY page',
          [ownerId, siteUrl, start, end],
        ) as any[];
      }

      const logs = await db.all(`
        SELECT urlPath, MAX(timestamp) as lastCrawl
        FROM server_logs
        WHERE ownerId = ? AND siteUrl = ?
          AND botType = 'Googlebot'
          AND urlPath NOT LIKE '%/.%'
          AND urlPath NOT LIKE '%.php'
          AND urlPath NOT LIKE '%.env%'
          AND urlPath NOT LIKE '%.bak'
        GROUP BY urlPath
      `, [ownerId, siteUrl]) as any[];
      const inspections = await db.all(
        'SELECT url, inspectionResult, coverageState, lastInspectionTime FROM url_inspection_cache WHERE ownerId = ? AND siteUrl = ?',
        [ownerId, siteUrl],
      ) as any[];

      const urlMap = new Map<string, any>();
      const baseHost = siteUrl.replace(/\/$/, '');
      const isHttp = baseHost.startsWith('http');

      for (const p of gscPages) {
        if (p.url.includes('#')) continue;
        if (p.url.match(/\.(jpg|jpeg|png|gif|svg|webp|pdf|css|js|txt)$/i)) continue;

        let cleanedUrl = p.url;
        try {
          const parsed = new URL(p.url);
          cleanedUrl = parsed.origin + parsed.pathname;
        } catch {}

        if (!cleanedUrl.endsWith('/')) {
          cleanedUrl += '/';
        }

        if (urlMap.has(cleanedUrl)) {
          const existing = urlMap.get(cleanedUrl);
          existing.clicks += p.clicks;
          existing.impressions += p.impressions;
          urlMap.set(cleanedUrl, existing);
        } else {
          urlMap.set(cleanedUrl, {
            url: cleanedUrl,
            clicks: p.clicks,
            impressions: p.impressions,
            lastCrawl: null,
            inspectionResult: null,
            coverageState: null,
            lastInspectionTime: null,
          });
        }
      }

      for (const l of logs) {
        let fullUrl = l.urlPath;
        if (fullUrl.includes('#') || fullUrl.match(/\.(jpg|jpeg|png|gif|svg|webp|pdf|css|js|txt)$/i)) continue;

        if (isHttp && fullUrl.startsWith('/')) {
          fullUrl = `${baseHost}${fullUrl}`;
        } else if (!isHttp && !fullUrl.startsWith('http')) {
          fullUrl = `https://${baseHost.replace('sc-domain:', '')}${fullUrl.startsWith('/') ? '' : '/'}${fullUrl}`;
        }

        try {
          const parsedLogUrl = new URL(fullUrl);
          fullUrl = parsedLogUrl.origin + parsedLogUrl.pathname;
        } catch {}

        if (!fullUrl.endsWith('/')) {
          fullUrl += '/';
        }

        let cleanDate = l.lastCrawl;
        if (typeof cleanDate === 'string' && cleanDate.includes('/')) {
          cleanDate = cleanDate.replace(':', ' ').replace(/\//g, ' ');
          cleanDate = new Date(cleanDate).toISOString();
        }

        if (urlMap.has(fullUrl)) {
          urlMap.get(fullUrl)!.lastCrawl = cleanDate;
        } else {
          urlMap.set(fullUrl, {
            url: fullUrl,
            clicks: 0,
            impressions: 0,
            lastCrawl: cleanDate,
            inspectionResult: null,
            coverageState: null,
            lastInspectionTime: null,
          });
        }
      }

      for (const i of inspections) {
        let cleanUrl = i.url;
        try {
          const parsedInsp = new URL(i.url);
          cleanUrl = parsedInsp.origin + parsedInsp.pathname;
        } catch {}

        if (!cleanUrl.endsWith('/')) {
          cleanUrl += '/';
        }

        if (urlMap.has(cleanUrl)) {
          const existing = urlMap.get(cleanUrl)!;
          existing.inspectionResult = i.inspectionResult ? JSON.parse(i.inspectionResult) : null;
          existing.coverageState = i.coverageState;
          existing.lastInspectionTime = i.lastInspectionTime;
        } else {
          urlMap.set(cleanUrl, {
            url: cleanUrl,
            clicks: 0,
            impressions: 0,
            lastCrawl: null,
            inspectionResult: i.inspectionResult ? JSON.parse(i.inspectionResult) : null,
            coverageState: i.coverageState,
            lastInspectionTime: i.lastInspectionTime,
          });
        }
      }

      res.json(Array.from(urlMap.values()));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/indexing/seed-urls', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, urls } = req.body;
    if (!isNonEmptyString(siteUrl) || !isStringArray(urls)) return res.status(400).json({ error: 'Invalid payload' });

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      let added = 0;
      await db.transaction(async () => {
        for (let u of urls) {
          if (typeof u !== 'string' || !u.startsWith('http')) continue;

          try {
            const parsed = new URL(u);
            u = parsed.origin + parsed.pathname;
          } catch {}

          if (!u.endsWith('/')) u += '/';

          const result = await db.run(`
            INSERT INTO url_inspection_cache (ownerId, siteUrl, url, lastInspectionTime)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(ownerId, siteUrl, url) DO NOTHING
          `, [ownerId, siteUrl, u, new Date(0).toISOString()]);
          if (result.changes > 0) added++;
        }
      })();

      res.json({ success: true, added });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/indexing/inspect', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, inspectionUrl } = req.body;
    if (!isNonEmptyString(siteUrl) || !isNonEmptyString(inspectionUrl)) return res.status(400).json({ error: 'Missing required fields' });

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const data = await googleApiFetchJson(
        db,
        ownerId,
        'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
        {
          method: 'POST',
          body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: 'en-US' }),
        },
      );

      const coverageState = data?.inspectionResult?.indexStatusResult?.coverageState || 'Unknown';
      const resultStr = JSON.stringify(data.inspectionResult || {});
      const now = new Date().toISOString();

      await db.run(`
        INSERT INTO url_inspection_cache (ownerId, siteUrl, url, inspectionResult, coverageState, lastInspectionTime)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(ownerId, siteUrl, url) DO UPDATE SET
          inspectionResult=excluded.inspectionResult,
          coverageState=excluded.coverageState,
          lastInspectionTime=excluded.lastInspectionTime
      `, [ownerId, siteUrl, inspectionUrl, resultStr, coverageState, now]);

      res.json({ success: true, coverageState, inspectionResult: data.inspectionResult, lastInspectionTime: now });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/indexing/auto-sync/start', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, uninspectedUrls } = req.body;
    if (!isNonEmptyString(siteUrl) || !isStringArray(uninspectedUrls)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!(await canAccessSite(db, ownerId, siteUrl))) {
      return res.status(403).json({ error: 'This site is not activated for your workspace.' });
    }

    const jobKey = getSyncJobKey(ownerId, siteUrl);
    const existingJob = syncJobs.get(jobKey);
    if (existingJob && existingJob.status === 'running') {
      return res.json({ success: true, message: 'Job already running', alreadyRunning: true });
    }

    syncJobs.set(jobKey, { current: 0, total: uninspectedUrls.length, status: 'running' });
    res.json({ success: true, message: 'Sync started in background', alreadyRunning: false });

    (async () => {
      let current = 0;
      for (const url of uninspectedUrls) {
        try {
          try {
            const data = await googleApiFetchJson(
              db,
              ownerId,
              'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
              {
                method: 'POST',
                body: JSON.stringify({ inspectionUrl: url, siteUrl, languageCode: 'en-US' }),
              },
            );

            const coverageState = data?.inspectionResult?.indexStatusResult?.coverageState || 'Unknown';
            const resultStr = JSON.stringify(data.inspectionResult || {});
            const now = new Date().toISOString();

            await db.run(`
              INSERT INTO url_inspection_cache (ownerId, siteUrl, url, inspectionResult, coverageState, lastInspectionTime)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(ownerId, siteUrl, url) DO UPDATE SET
                inspectionResult=excluded.inspectionResult,
                coverageState=excluded.coverageState,
                lastInspectionTime=excluded.lastInspectionTime
            `, [ownerId, siteUrl, url, resultStr, coverageState, now]);
          } catch (error: any) {
            const status = error.status;
            const errorData = error.payload || {};
            if (status === 429) {
              console.warn(`GSC Quota exceeded during auth-sync for ${siteUrl}`);
              syncJobs.set(jobKey, { current, total: uninspectedUrls.length, status: 'error', message: "Google's 2,000 URL daily limit reached. Remaining URLs paused until tomorrow." });
              return;
            }
            if (status === 401) {
              console.warn(`GSC Session Expired during auth-sync for ${siteUrl}:`, errorData);
              syncJobs.set(jobKey, { current, total: uninspectedUrls.length, status: 'error', message: 'Google connection expired or was revoked. Please reconnect your Google account.' });
              return;
            }
            if (status === 403) {
              const apiMsg = (errorData as any)?.error?.message || '';
              const reason = (errorData as any)?.error?.errors?.[0]?.reason || '';
              if (reason.includes('rateLimitExceeded') || apiMsg.toLowerCase().includes('quota')) {
                syncJobs.set(jobKey, { current, total: uninspectedUrls.length, status: 'error', message: `API Quota Exceeded: ${apiMsg}` });
                return;
              }
              console.warn(`Skipping ${url} due to 403 Permission Denied:`, apiMsg);
            }
            console.error(`Inspection failed for ${url}:`, errorData);
          }
        } catch (e: any) {
          console.error(`Auto-sync error for ${url}:`, e.message);
        }

        current++;
        syncJobs.set(jobKey, { current, total: uninspectedUrls.length, status: 'running' });
        await new Promise((r) => setTimeout(r, 150));
      }

      syncJobs.set(jobKey, { current, total: uninspectedUrls.length, status: 'completed' });
    })();
  });

  app.get('/api/indexing/auto-sync/status', authRequired, async (req: AuthedRequest, res) => {
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    if (!(await canAccessSite(db, req.authUser!.uid, siteUrl))) {
      return res.status(403).json({ error: 'This site is not activated for your workspace.' });
    }

    const job = syncJobs.get(getSyncJobKey(req.authUser!.uid, siteUrl));
    if (!job) {
      return res.json({ status: 'none' });
    }

    res.json(job);
  });
}
