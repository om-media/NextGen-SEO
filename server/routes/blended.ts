import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { isIsoDateString, isNonEmptyString } from '../validation.js';
import { canonicalPageKey } from '../reporting/url.js';
import { googleApiFetchJson } from '../services/googleAuth.js';

const toFiniteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const readField = (row: any, key: string) => row?.[key] ?? row?.[key.toLowerCase()];

const normalizeGa4Date = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const dateValue = value;
  if (isIsoDateString(dateValue)) return dateValue;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(dateValue);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

const fetchGa4LandingPages = async (
  db: AppDatabase,
  ownerId: string,
  propertyId: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
) => {
  const data = await googleApiFetchJson(
    db,
    ownerId,
    `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
    {
      method: 'POST',
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'screenPageViews' },
          { name: 'bounceRate' },
          { name: 'eventCount' },
        ],
        limit: '100000',
      }),
    },
  );

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const replaceAndInsert = db.transaction(async () => {
    await db.run(
      'DELETE FROM ga4_page_metrics WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?',
      [ownerId, propertyId, startDate, endDate],
    );

    for (const row of rows) {
      const date = normalizeGa4Date(row.dimensionValues?.[0]?.value);
      const pagePath = row.dimensionValues?.[1]?.value;
      if (!date || !isNonEmptyString(pagePath)) continue;

      const pageKey = canonicalPageKey(pagePath, siteUrl);
      await db.run(`
        INSERT INTO ga4_page_metrics (ownerId, propertyId, siteUrl, date, pagePath, pageKey, sessions, totalUsers, pageViews, bounceRate, eventCount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ownerId, propertyId, date, pageKey) DO UPDATE SET
          siteUrl=excluded.siteUrl,
          pagePath=excluded.pagePath,
          sessions=excluded.sessions,
          totalUsers=excluded.totalUsers,
          pageViews=excluded.pageViews,
          bounceRate=excluded.bounceRate,
          eventCount=excluded.eventCount
      `, [
        ownerId,
        propertyId,
        siteUrl,
        date,
        pagePath,
        pageKey,
        toFiniteNumber(row.metricValues?.[0]?.value),
        toFiniteNumber(row.metricValues?.[1]?.value),
        toFiniteNumber(row.metricValues?.[2]?.value),
        toFiniteNumber(row.metricValues?.[3]?.value),
        toFiniteNumber(row.metricValues?.[4]?.value),
      ]);
    }
  });

  await replaceAndInsert();
  return rows.length;
};

export function registerBlendedRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

  app.post('/api/blended/page-performance', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, ga4PropertyId, startDate, endDate, limit } = req.body;

    if (!isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Missing or invalid parameters' });
    }
    if (ga4PropertyId !== undefined && ga4PropertyId !== null && !isNonEmptyString(ga4PropertyId)) {
      return res.status(400).json({ error: 'Invalid ga4PropertyId' });
    }

    const rowLimit = Number.isFinite(Number(limit)) ? Math.min(Math.max(Number(limit), 1), 5000) : 500;

    try {
      const gscRows = await db.all<any>(`
        SELECT
          page,
          SUM(clicks) AS gscClicks,
          SUM(impressions) AS gscImpressions,
          CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END AS gscCtr,
          CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END AS gscPosition,
          COUNT(DISTINCT query) AS gscQueryCount
        FROM gsc_page_query_metrics
        WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
        GROUP BY page
        ORDER BY gscClicks DESC, gscImpressions DESC
        LIMIT ?
      `, [ownerId, siteUrl, startDate, endDate, rowLimit]);

      const gscFreshness = await db.get<any>(`
        SELECT
          MIN(date) AS earliestDate,
          MAX(date) AS latestDate,
          COUNT(*) AS rowCount
        FROM gsc_page_query_metrics
        WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
      `, [ownerId, siteUrl, startDate, endDate]);

      const warehouseStatus = await db.get<any>(`
        SELECT lastSyncDate, earliestSyncDate, status, lastUpdated
        FROM warehouse_sync_status
        WHERE ownerId = ? AND siteUrl = ?
      `, [ownerId, siteUrl]);

      const rowsByKey = new Map<string, any>();
      for (const row of gscRows) {
        const pageKey = canonicalPageKey(row.page, siteUrl);
        rowsByKey.set(pageKey, {
          page: row.page,
          pageKey,
          gsc: {
            clicks: toFiniteNumber(readField(row, 'gscClicks')),
            impressions: toFiniteNumber(readField(row, 'gscImpressions')),
            ctr: toFiniteNumber(readField(row, 'gscCtr')),
            position: toFiniteNumber(readField(row, 'gscPosition')),
            queryCount: toFiniteNumber(readField(row, 'gscQueryCount')),
          },
          ga4: null,
        });
      }

      let ga4Freshness: any = null;

      if (ga4PropertyId) {
        let ga4Rows = await db.all<any>(`
          SELECT
            pageKey,
            MIN(pagePath) AS pagePath,
            SUM(sessions) AS sessions,
            SUM(totalUsers) AS totalUsers,
            SUM(pageViews) AS pageViews,
            CASE WHEN SUM(sessions) > 0 THEN SUM(bounceRate * sessions)*1.0/SUM(sessions) ELSE 0 END AS bounceRate,
            SUM(eventCount) AS eventCount
          FROM ga4_page_metrics
          WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
          GROUP BY pageKey
        `, [ownerId, ga4PropertyId, startDate, endDate]);

        ga4Freshness = await db.get<any>(`
          SELECT
            MIN(date) AS earliestDate,
            MAX(date) AS latestDate,
            COUNT(*) AS rowCount
          FROM ga4_page_metrics
          WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
        `, [ownerId, ga4PropertyId, startDate, endDate]);

        if (toFiniteNumber(readField(ga4Freshness, 'rowCount')) === 0) {
          try {
            await fetchGa4LandingPages(db, ownerId, ga4PropertyId, siteUrl, startDate, endDate);

            ga4Rows = await db.all<any>(`
              SELECT
                pageKey,
                MIN(pagePath) AS pagePath,
                SUM(sessions) AS sessions,
                SUM(totalUsers) AS totalUsers,
                SUM(pageViews) AS pageViews,
                CASE WHEN SUM(sessions) > 0 THEN SUM(bounceRate * sessions)*1.0/SUM(sessions) ELSE 0 END AS bounceRate,
                SUM(eventCount) AS eventCount
              FROM ga4_page_metrics
              WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
              GROUP BY pageKey
            `, [ownerId, ga4PropertyId, startDate, endDate]);

            ga4Freshness = await db.get<any>(`
              SELECT
                MIN(date) AS earliestDate,
                MAX(date) AS latestDate,
                COUNT(*) AS rowCount
              FROM ga4_page_metrics
              WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
            `, [ownerId, ga4PropertyId, startDate, endDate]);
          } catch (error) {
            console.warn('[blended/page-performance] GA4 warehouse backfill skipped', error);
          }
        }

        for (const row of ga4Rows) {
          const pageKey = canonicalPageKey(readField(row, 'pageKey'));
          const existing = rowsByKey.get(pageKey) || {
            page: readField(row, 'pagePath'),
            pageKey,
            gsc: null,
            ga4: null,
          };
          existing.ga4 = {
            sessions: toFiniteNumber(row.sessions),
            totalUsers: toFiniteNumber(readField(row, 'totalUsers')),
            pageViews: toFiniteNumber(readField(row, 'pageViews')),
            bounceRate: toFiniteNumber(readField(row, 'bounceRate')),
            eventCount: toFiniteNumber(readField(row, 'eventCount')),
          };
          rowsByKey.set(pageKey, existing);
        }
      }

      const rows = Array.from(rowsByKey.values()).sort((a, b) => {
        const aClicks = toFiniteNumber(a.gsc?.clicks);
        const bClicks = toFiniteNumber(b.gsc?.clicks);
        if (aClicks !== bClicks) return bClicks - aClicks;
        return toFiniteNumber(b.ga4?.sessions) - toFiniteNumber(a.ga4?.sessions);
      });

      res.json({
        rows,
        meta: {
          siteUrl,
          ga4PropertyId: ga4PropertyId || null,
          startDate,
          endDate,
          sources: {
            gsc: true,
            ga4: Boolean(ga4PropertyId && toFiniteNumber(readField(ga4Freshness, 'rowCount')) > 0),
            bing: false,
          },
          freshness: {
            gsc: {
              earliestDate: readField(gscFreshness, 'earliestDate') || null,
              latestDate: readField(gscFreshness, 'latestDate') || null,
              rowCount: toFiniteNumber(readField(gscFreshness, 'rowCount')),
              syncStatus: warehouseStatus?.status || null,
              syncedThrough: readField(warehouseStatus, 'lastSyncDate') || null,
              historicalLimit: readField(warehouseStatus, 'earliestSyncDate') || null,
              lastUpdated: readField(warehouseStatus, 'lastUpdated') || null,
            },
            ga4: {
              earliestDate: readField(ga4Freshness, 'earliestDate') || null,
              latestDate: readField(ga4Freshness, 'latestDate') || null,
              rowCount: toFiniteNumber(readField(ga4Freshness, 'rowCount')),
            },
            bing: null,
          },
        },
      });
    } catch (err: any) {
      console.error('[blended/page-performance] failed', err);
      res.status(500).json({ error: err.message });
    }
  });
}
