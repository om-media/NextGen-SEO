import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { isIsoDateString, isNonEmptyString } from '../validation.js';
import { canonicalPageKey } from '../reporting/url.js';
import { googleApiFetchJson } from '../services/googleAuth.js';
import { canAccessGa4Property, canAccessSite } from '../accessControl.js';

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

const getFolderKey = (pageKey: string) => {
  if (!pageKey || pageKey === '/') return '/';
  const parts = pageKey.split('/').filter(Boolean);
  return parts.length > 1 ? `/${parts[0]}/` : '/';
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
    const {
      endDate,
      ga4PropertyId,
      limit,
      offset,
      search,
      siteUrl,
      sortColumn,
      sortDirection,
      startDate,
      trafficFilter,
    } = req.body;

    if (!isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Missing or invalid parameters' });
    }
    if (ga4PropertyId !== undefined && ga4PropertyId !== null && !isNonEmptyString(ga4PropertyId)) {
      return res.status(400).json({ error: 'Invalid ga4PropertyId' });
    }

    const rowLimit = Number.isFinite(Number(limit)) ? Math.min(Math.max(Number(limit), 1), 5000) : 500;
    const rowOffset = Number.isFinite(Number(offset)) ? Math.max(Number(offset), 0) : 0;
    const normalizedSearch = isNonEmptyString(search) ? search.trim().toLowerCase() : '';
    const normalizedTrafficFilter = ['all', 'with-ga4', 'without-ga4'].includes(trafficFilter) ? trafficFilter : 'all';
    const normalizedSortColumn = [
      'page',
      'clicks',
      'impressions',
      'ctr',
      'queryCount',
      'sessions',
      'pageViews',
      'bounceRate',
    ].includes(sortColumn) ? sortColumn : 'clicks';
    const normalizedSortDirection = sortDirection === 'asc' ? 'asc' : 'desc';

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (isNonEmptyString(ga4PropertyId) && !(await canAccessGa4Property(db, ownerId, ga4PropertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }

      const gscRows = await db.all<any>(`
        SELECT
          COALESCE(NULLIF(pageKey, ''), page) AS pageKey,
          MIN(page) AS page,
          SUM(clicks) AS gscClicks,
          SUM(impressions) AS gscImpressions,
          CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END AS gscCtr,
          CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END AS gscPosition,
          COUNT(DISTINCT query) AS gscQueryCount
        FROM gsc_page_query_metrics
        WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
        GROUP BY COALESCE(NULLIF(pageKey, ''), page)
      `, [ownerId, siteUrl, startDate, endDate]);

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
        const pageKey = canonicalPageKey(readField(row, 'pageKey') || row.page, siteUrl);
        const existing = rowsByKey.get(pageKey) || {
          page: row.page,
          pageKey,
          gsc: {
            clicks: 0,
            impressions: 0,
            ctr: 0,
            position: 0,
            queryCount: 0,
          },
          ga4: null,
          crawl: null,
          weightedPosition: 0,
        };
        const clicks = toFiniteNumber(readField(row, 'gscClicks'));
        const impressions = toFiniteNumber(readField(row, 'gscImpressions'));
        existing.gsc.clicks += clicks;
        existing.gsc.impressions += impressions;
        existing.gsc.queryCount += toFiniteNumber(readField(row, 'gscQueryCount'));
        existing.weightedPosition += toFiniteNumber(readField(row, 'gscPosition')) * impressions;
        existing.gsc.ctr = existing.gsc.impressions > 0 ? existing.gsc.clicks / existing.gsc.impressions : 0;
        existing.gsc.position = existing.gsc.impressions > 0 ? existing.weightedPosition / existing.gsc.impressions : 0;
        rowsByKey.set(pageKey, existing);
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
            crawl: null,
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

      const latestCrawlJob = await db.get<any>(`
        SELECT id
        FROM crawl_jobs
        WHERE ownerId = ? AND siteUrl = ? AND status = 'completed'
          AND EXISTS (
            SELECT 1
            FROM crawl_pages
            WHERE crawl_pages.ownerId = crawl_jobs.ownerId
              AND crawl_pages.siteUrl = crawl_jobs.siteUrl
              AND crawl_pages.jobId = crawl_jobs.id
          )
        ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
        LIMIT 1
      `, [ownerId, siteUrl]);

      if (latestCrawlJob?.id) {
        const crawlRows = await db.all<any>(`
          SELECT
            url,
            pageKey,
            finalUrl,
            statusCode,
            title,
            metaDescription,
            canonicalUrl,
            h1Text,
            h1Count,
            noindex,
            inboundLinkCount,
            internalLinkCount,
            outgoingLinkCount,
            crawledAt,
            errorMessage
          FROM crawl_pages
          WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
        `, [ownerId, siteUrl, latestCrawlJob.id]);

        for (const row of crawlRows) {
          const pageKey = canonicalPageKey(readField(row, 'pageKey') || readField(row, 'url'), siteUrl);
          const existing = rowsByKey.get(pageKey);
          if (!existing) continue;

          existing.crawl = {
            canonicalUrl: readField(row, 'canonicalUrl') || null,
            crawledAt: readField(row, 'crawledAt') || null,
            errorMessage: readField(row, 'errorMessage') || null,
            finalUrl: readField(row, 'finalUrl') || null,
            h1Count: toFiniteNumber(readField(row, 'h1Count')),
            h1Text: readField(row, 'h1Text') || null,
            inboundLinkCount: toFiniteNumber(readField(row, 'inboundLinkCount') ?? readField(row, 'internalLinkCount')),
            metaDescription: readField(row, 'metaDescription') || null,
            noindex: Boolean(toFiniteNumber(readField(row, 'noindex'))),
            outgoingLinkCount: toFiniteNumber(readField(row, 'outgoingLinkCount')),
            statusCode: readField(row, 'statusCode') == null ? null : toFiniteNumber(readField(row, 'statusCode')),
            title: readField(row, 'title') || null,
            url: readField(row, 'url') || existing.page,
          };
        }
      }

      const rows = Array.from(rowsByKey.values()).map(({ weightedPosition, ...row }) => row);
      const totals = rows.reduce(
        (acc, row) => {
          acc.clicks += toFiniteNumber(row.gsc?.clicks);
          acc.impressions += toFiniteNumber(row.gsc?.impressions);
          acc.queryCount += toFiniteNumber(row.gsc?.queryCount);
          acc.weightedPosition += toFiniteNumber(row.gsc?.position) * toFiniteNumber(row.gsc?.impressions);
          acc.sessions += toFiniteNumber(row.ga4?.sessions);
          acc.totalUsers += toFiniteNumber(row.ga4?.totalUsers);
          acc.pageViews += toFiniteNumber(row.ga4?.pageViews);
          acc.eventCount += toFiniteNumber(row.ga4?.eventCount);
          acc.weightedBounce += toFiniteNumber(row.ga4?.bounceRate) * toFiniteNumber(row.ga4?.sessions);
          if (row.gsc) acc.gscPages += 1;
          if (row.ga4) acc.ga4Pages += 1;
          if (row.gsc && row.ga4) acc.matchedPages += 1;
          return acc;
        },
        {
          clicks: 0,
          ctr: 0,
          eventCount: 0,
          ga4Pages: 0,
          gscPages: 0,
          impressions: 0,
          matchedPages: 0,
          pageViews: 0,
          position: 0,
          queryCount: 0,
          sessions: 0,
          totalPages: rows.length,
          totalUsers: 0,
          weightedBounce: 0,
          weightedPosition: 0,
        },
      );
      totals.ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0;
      totals.position = totals.impressions > 0 ? totals.weightedPosition / totals.impressions : 0;
      const bounceRate = totals.sessions > 0 ? totals.weightedBounce / totals.sessions : 0;

      const filteredRows = rows
        .filter((row) => {
          if (
            normalizedSearch &&
            !String(row.page || '').toLowerCase().includes(normalizedSearch) &&
            !String(row.pageKey || '').toLowerCase().includes(normalizedSearch)
          ) {
            return false;
          }
          if (normalizedTrafficFilter === 'with-ga4' && !row.ga4) return false;
          if (normalizedTrafficFilter === 'without-ga4' && row.ga4) return false;
          return true;
        })
        .sort((a, b) => {
          const readSortValue = (row: any) => {
            if (normalizedSortColumn === 'page') return String(row.page || '').toLowerCase();
            if (normalizedSortColumn === 'clicks') return toFiniteNumber(row.gsc?.clicks);
            if (normalizedSortColumn === 'impressions') return toFiniteNumber(row.gsc?.impressions);
            if (normalizedSortColumn === 'ctr') return toFiniteNumber(row.gsc?.ctr);
            if (normalizedSortColumn === 'queryCount') return toFiniteNumber(row.gsc?.queryCount);
            if (normalizedSortColumn === 'sessions') return toFiniteNumber(row.ga4?.sessions);
            if (normalizedSortColumn === 'pageViews') return toFiniteNumber(row.ga4?.pageViews);
            return toFiniteNumber(row.ga4?.bounceRate);
          };
          const aValue = readSortValue(a);
          const bValue = readSortValue(b);
          if (aValue < bValue) return normalizedSortDirection === 'asc' ? -1 : 1;
          if (aValue > bValue) return normalizedSortDirection === 'asc' ? 1 : -1;
          return 0;
        });

      const pagedRows = filteredRows.slice(rowOffset, rowOffset + rowLimit);
      const topFolders = Array.from(rows.reduce((folders, row) => {
        const key = getFolderKey(row.pageKey);
        const current = folders.get(key) || { clicks: 0, pages: 0, sessions: 0 };
        current.clicks += toFiniteNumber(row.gsc?.clicks);
        current.sessions += toFiniteNumber(row.ga4?.sessions);
        current.pages += 1;
        folders.set(key, current);
        return folders;
      }, new Map<string, { clicks: number; pages: number; sessions: number }>()).entries())
        .map(([folder, value]) => ({ folder, ...value }))
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 6);

      const topOpportunities = rows
        .filter((row) => toFiniteNumber(row.gsc?.impressions) >= 100 && toFiniteNumber(row.gsc?.ctr) < 0.02)
        .sort((a, b) => toFiniteNumber(b.gsc?.impressions) - toFiniteNumber(a.gsc?.impressions))
        .slice(0, 4);

      res.json({
        page: {
          filteredTotal: filteredRows.length,
          limit: rowLimit,
          offset: rowOffset,
          total: rows.length,
        },
        rows: pagedRows,
        meta: {
          endDate,
          ga4PropertyId: ga4PropertyId || null,
          siteUrl,
          sources: {
            bing: false,
            ga4: Boolean(ga4PropertyId && toFiniteNumber(readField(ga4Freshness, 'rowCount')) > 0),
            gsc: true,
          },
          startDate,
          totals: {
            bounceRate,
            clicks: totals.clicks,
            ctr: totals.ctr,
            eventCount: totals.eventCount,
            ga4Pages: totals.ga4Pages,
            gscPages: totals.gscPages,
            impressions: totals.impressions,
            matchedPages: totals.matchedPages,
            pageViews: totals.pageViews,
            position: totals.position,
            queryCount: totals.queryCount,
            sessions: totals.sessions,
            totalPages: totals.totalPages,
            totalUsers: totals.totalUsers,
          },
          topFolders,
          topOpportunities,
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
