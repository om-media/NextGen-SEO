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
      analyticsFilter,
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
    const normalizedAnalyticsFilter = [
      'all',
      'low-ctr',
      'missing-ga4',
      'crawl-issues',
      'crawl-errors',
      'metadata-gaps',
      'indexability',
      'not-crawled',
    ].includes(analyticsFilter) ? analyticsFilter : 'all';
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
      'crawlStatus',
      'depth',
      'inlinks',
      'wordCount',
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
        SELECT id, completedAt, updatedAt, crawledCount
        FROM crawl_jobs
        WHERE ownerId = ? AND siteUrl = ? AND status = 'completed'
        ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
        LIMIT 1
      `, [ownerId, siteUrl]);

      let crawlRows: any[] = [];
      if (latestCrawlJob?.id) {
        crawlRows = await db.all<any>(`
          SELECT
            url,
            pageKey,
            finalUrl,
            statusCode,
            contentType,
            title,
            metaDescription,
            canonicalUrl,
            h1Text,
            h1Count,
            h2Count,
            wordCount,
            depth,
            crawledAt,
            responseTimeMs,
            noindex,
            inboundLinkCount,
            internalLinkCount,
            outgoingLinkCount,
            errorMessage
          FROM crawl_pages
          WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
        `, [ownerId, siteUrl, latestCrawlJob.id]);

        for (const row of crawlRows) {
          const url = String(readField(row, 'url') || '');
          const pageKey = canonicalPageKey(readField(row, 'pageKey') || url, siteUrl);
          if (!pageKey) continue;

          const existing = rowsByKey.get(pageKey) || {
            page: url || pageKey,
            pageKey,
            gsc: null,
            ga4: null,
            crawl: null,
          };

          existing.crawl = {
            canonicalUrl: readField(row, 'canonicalUrl') || null,
            contentType: readField(row, 'contentType') || null,
            crawledAt: readField(row, 'crawledAt') || null,
            depth: toFiniteNumber(readField(row, 'depth')),
            errorMessage: readField(row, 'errorMessage') || null,
            finalUrl: readField(row, 'finalUrl') || null,
            h1Count: toFiniteNumber(readField(row, 'h1Count')),
            h1Text: readField(row, 'h1Text') || null,
            h2Count: toFiniteNumber(readField(row, 'h2Count')),
            hasMetaDescription: isNonEmptyString(readField(row, 'metaDescription')),
            hasTitle: isNonEmptyString(readField(row, 'title')),
            inboundLinkCount: toFiniteNumber(readField(row, 'inboundLinkCount')),
            internalLinkCount: toFiniteNumber(readField(row, 'internalLinkCount')),
            metaDescription: readField(row, 'metaDescription') || null,
            metaDescriptionLength: String(readField(row, 'metaDescription') || '').length,
            noindex: Boolean(toFiniteNumber(readField(row, 'noindex'))),
            outgoingLinkCount: toFiniteNumber(readField(row, 'outgoingLinkCount')),
            responseTimeMs: toFiniteNumber(readField(row, 'responseTimeMs')),
            statusCode: readField(row, 'statusCode') === null || readField(row, 'statusCode') === undefined
              ? null
              : toFiniteNumber(readField(row, 'statusCode')),
            title: readField(row, 'title') || null,
            titleLength: String(readField(row, 'title') || '').length,
            url,
            wordCount: toFiniteNumber(readField(row, 'wordCount')),
          };

          if (!existing.page || existing.page === pageKey) existing.page = url || pageKey;
          rowsByKey.set(pageKey, existing);
        }
      }

      const rows = Array.from(rowsByKey.values()).map(({ weightedPosition, ...row }) => row);
      const isLowCtrOpportunity = (row: any) => toFiniteNumber(row.gsc?.impressions) >= 500 && toFiniteNumber(row.gsc?.ctr) < 0.02;
      const hasCrawlError = (row: any) => {
        const crawl = row.crawl;
        if (!crawl) return false;
        const statusCode = toFiniteNumber(crawl.statusCode);
        return Boolean(crawl.errorMessage || (statusCode > 0 && statusCode !== 200));
      };
      const hasMetadataGap = (row: any) => Boolean(
        row.crawl &&
        (!row.crawl.hasTitle || !row.crawl.hasMetaDescription || toFiniteNumber(row.crawl.h1Count) !== 1),
      );
      const hasIndexabilityIssue = (row: any) => Boolean(
        row.crawl?.noindex ||
        (row.crawl?.canonicalUrl && row.crawl?.finalUrl && row.crawl.canonicalUrl !== row.crawl.finalUrl),
      );
      const hasCrawlIssue = (row: any) => {
        const crawl = row.crawl;
        if (!crawl) return true;
        return Boolean(
          hasCrawlError(row) ||
          hasMetadataGap(row) ||
          hasIndexabilityIssue(row),
        );
      };
      const getIssueInsight = (row: any) => {
        const reasons: string[] = [];
        const impressions = toFiniteNumber(row.gsc?.impressions);
        const ctr = toFiniteNumber(row.gsc?.ctr);
        const clicks = toFiniteNumber(row.gsc?.clicks);
        const sessions = toFiniteNumber(row.ga4?.sessions);
        const bounceRate = toFiniteNumber(row.ga4?.bounceRate);
        const crawl = row.crawl;
        const hasDemand = impressions >= 100 || clicks > 0 || sessions >= 20;
        const canonicalKey = crawl?.canonicalUrl ? canonicalPageKey(crawl.canonicalUrl, siteUrl) : null;
        const canonicalMismatch = Boolean(canonicalKey && canonicalKey !== row.pageKey);

        if (!crawl && (row.gsc || row.ga4)) {
          if (row.gsc) {
            reasons.push(`${Math.round(impressions).toLocaleString('en-US')} GSC impressions matched this page key, but the latest crawl did not find the page.`);
          }
          if (row.ga4) {
            reasons.push(`${Math.round(sessions).toLocaleString('en-US')} GA4 sessions matched this page key, but the latest crawl did not find the page.`);
          }
          return {
            label: 'Find in crawl',
            reasons,
            severity: hasDemand ? 'high' : 'medium',
          };
        }

        if (hasCrawlError(row)) {
          const statusCode = crawl?.statusCode ? String(crawl.statusCode) : 'no response';
          reasons.push(crawl?.errorMessage || `Crawler received ${statusCode} for this page.`);
          if (impressions > 0) reasons.push(`${Math.round(impressions).toLocaleString('en-US')} impressions depend on this URL being fetchable.`);
          return {
            label: 'Fix crawl error',
            reasons,
            severity: hasDemand ? 'high' : 'medium',
          };
        }

        if (crawl?.noindex && (row.gsc || row.ga4)) {
          reasons.push(
            row.gsc
              ? `The crawler found noindex, but GSC still reports ${Math.round(impressions).toLocaleString('en-US')} impressions.`
              : 'The crawler found noindex on a page with GA4 traffic.',
          );
          return {
            label: 'Resolve noindex conflict',
            reasons,
            severity: impressions >= 100 || clicks > 0 ? 'high' : 'medium',
          };
        }

        if (canonicalMismatch) {
          reasons.push(`Crawler canonical points to ${canonicalKey}, but this row is grouped as ${row.pageKey}.`);
          if (impressions > 0) reasons.push(`${Math.round(impressions).toLocaleString('en-US')} impressions may be split by the canonical target.`);
          return {
            label: 'Resolve canonical mismatch',
            reasons,
            severity: hasDemand ? 'high' : 'medium',
          };
        }

        if (hasMetadataGap(row) && (impressions >= 100 || sessions >= 20)) {
          const missing = [
            !crawl?.hasTitle ? 'title' : null,
            !crawl?.hasMetaDescription ? 'meta description' : null,
            toFiniteNumber(crawl?.h1Count) !== 1 ? 'single H1' : null,
          ].filter(Boolean);
          reasons.push(`Crawler found a ${missing.join(', ')} gap on a page with measurable demand.`);
          if (impressions > 0) reasons.push(`${Math.round(impressions).toLocaleString('en-US')} impressions can be reviewed against the visible snippet.`);
          return {
            label: 'Fix page metadata',
            reasons,
            severity: 'medium',
          };
        }

        if (impressions >= 500 && ctr < 0.02) {
          reasons.push(`High impressions with ${(ctr * 100).toFixed(1)}% CTR.`);
          if (row.gsc?.position) reasons.push(`Average position is ${toFiniteNumber(row.gsc.position).toFixed(1)}, so snippet and intent should be checked before content expansion.`);
          return {
            label: 'Improve CTR',
            reasons,
            severity: 'medium',
          };
        }

        if (crawl && impressions >= 250 && toFiniteNumber(crawl.inboundLinkCount) <= 2) {
          reasons.push(`${Math.round(impressions).toLocaleString('en-US')} impressions, but only ${toFiniteNumber(crawl.inboundLinkCount).toLocaleString('en-US')} internal inlinks in the latest crawl.`);
          return {
            label: 'Add internal links',
            reasons,
            severity: 'medium',
          };
        }

        if (clicks >= 20 && sessions >= 20 && bounceRate >= 0.7) {
          reasons.push(`Traffic is reaching the page, but bounce rate is ${(bounceRate * 100).toFixed(1)}%.`);
          return {
            label: 'Improve engagement',
            reasons,
            severity: 'medium',
          };
        }

        if (sessions >= 25 && impressions < 250) {
          reasons.push(`${Math.round(sessions).toLocaleString('en-US')} GA4 sessions with only ${Math.round(impressions).toLocaleString('en-US')} GSC impressions.`);
          return {
            label: 'Build search visibility',
            reasons,
            severity: 'low',
          };
        }

        if (row.gsc && !row.ga4) {
          reasons.push('Page has GSC visibility but no matched GA4 landing-page data for the same normalized path.');
          return {
            label: 'Check GA4 match',
            reasons,
            severity: 'low',
          };
        }

        if ((row.ga4 || row.crawl) && !row.gsc) {
          reasons.push(row.ga4
            ? 'GA4 has behavior data, but GSC has no page-query rows for this date range.'
            : 'Crawler found the page, but GSC has no page-query rows for this date range.');
          return {
            label: 'Review search coverage',
            reasons,
            severity: 'low',
          };
        }

        return {
          label: 'No priority issue',
          reasons: ['Search, engagement, crawl, and indexability signals do not currently trigger a priority decision rule.'],
          severity: 'none',
        };
      };
      rows.forEach((row) => {
        row.issueInsight = getIssueInsight(row);
      });
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
          if (row.crawl) acc.crawledPages += 1;
          if (hasCrawlIssue(row)) acc.crawlIssuePages += 1;
          return acc;
        },
        {
          clicks: 0,
          crawledPages: 0,
          crawlIssuePages: 0,
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
          if (normalizedAnalyticsFilter === 'low-ctr' && !isLowCtrOpportunity(row)) return false;
          if (normalizedAnalyticsFilter === 'missing-ga4' && row.ga4) return false;
          if (normalizedAnalyticsFilter === 'crawl-issues' && !hasCrawlIssue(row)) return false;
          if (normalizedAnalyticsFilter === 'crawl-errors' && !hasCrawlError(row)) return false;
          if (normalizedAnalyticsFilter === 'metadata-gaps' && !hasMetadataGap(row)) return false;
          if (normalizedAnalyticsFilter === 'indexability' && !hasIndexabilityIssue(row)) return false;
          if (normalizedAnalyticsFilter === 'not-crawled' && row.crawl) return false;
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
            if (normalizedSortColumn === 'crawlStatus') return hasCrawlIssue(row) ? 1 : 0;
            if (normalizedSortColumn === 'depth') return toFiniteNumber(row.crawl?.depth);
            if (normalizedSortColumn === 'inlinks') return toFiniteNumber(row.crawl?.inboundLinkCount);
            if (normalizedSortColumn === 'wordCount') return toFiniteNumber(row.crawl?.wordCount);
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

      const severityWeight = (severity: string) => {
        if (severity === 'high') return 3;
        if (severity === 'medium') return 2;
        if (severity === 'low') return 1;
        return 0;
      };
      const topOpportunities = rows
        .filter((row) => row.issueInsight?.severity && row.issueInsight.severity !== 'none')
        .sort((a, b) => (
          severityWeight(b.issueInsight.severity) - severityWeight(a.issueInsight.severity)
          || toFiniteNumber(b.gsc?.impressions) - toFiniteNumber(a.gsc?.impressions)
          || toFiniteNumber(b.ga4?.sessions) - toFiniteNumber(a.ga4?.sessions)
        ))
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
            crawl: crawlRows.length > 0,
            ga4: Boolean(ga4PropertyId && toFiniteNumber(readField(ga4Freshness, 'rowCount')) > 0),
            gsc: true,
          },
          startDate,
          totals: {
            bounceRate,
            crawledPages: totals.crawledPages,
            crawlIssuePages: totals.crawlIssuePages,
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
            crawl: {
              completedAt: readField(latestCrawlJob, 'completedAt') || readField(latestCrawlJob, 'updatedAt') || null,
              rowCount: crawlRows.length,
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
