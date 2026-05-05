import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import { canonicalPageKey } from '../reporting/url.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isIsoDateString } from '../validation.js';
import { canUseReconciliation } from '../../shared/plans.js';

type SourceState = 'present' | 'missing';

type ReconciliationRow = {
  crawl: null | {
    canonicalUrl: string | null;
    crawledAt: string | null;
    depth: number;
    errorMessage: string | null;
    noindex: boolean;
    statusCode: number | null;
    title: string | null;
    url: string;
    wordCount: number;
  };
  flags: string[];
  ga4: null | {
    bounceRate: number;
    eventCount: number;
    pagePath: string;
    pageViews: number;
    sessions: number;
    totalUsers: number;
  };
  gsc: null | {
    clicks: number;
    ctr: number;
    impressions: number;
    page: string;
    position: number;
    queryCount: number;
  };
  pageKey: string;
  representativeUrl: string;
  sources: {
    crawl: SourceState;
    ga4: SourceState;
    gsc: SourceState;
  };
};

const toNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const getLimit = (value: unknown) => (Number.isFinite(Number(value)) ? Math.min(Math.max(Number(value), 1), 5000) : 100);
const getOffset = (value: unknown) => (Number.isFinite(Number(value)) ? Math.max(Number(value), 0) : 0);

function getFlags(row: Omit<ReconciliationRow, 'flags' | 'sources'>, hasGa4Property: boolean) {
  const flags: string[] = [];

  if ((row.gsc || row.ga4) && !row.crawl) flags.push('missing_in_crawl');
  if ((row.ga4 || row.crawl) && !row.gsc) flags.push('missing_in_gsc');
  if (hasGa4Property && (row.gsc || row.crawl) && !row.ga4) flags.push('missing_in_ga4');
  if (row.crawl?.statusCode === null || (row.crawl?.statusCode || 0) >= 400) flags.push('crawl_error');
  if (row.crawl?.noindex) flags.push('noindex');
  if (row.crawl?.canonicalUrl && canonicalPageKey(row.crawl.canonicalUrl) !== row.pageKey) flags.push('canonical_mismatch');
  if ((row.gsc?.impressions || 0) >= 100 && (row.gsc?.clicks || 0) === 0) flags.push('high_impressions_no_clicks');

  return flags;
}

function matchesStatus(row: ReconciliationRow, status: string) {
  if (status === 'all') return true;
  if (status === 'issues') return row.flags.length > 0;
  if (status === 'matched') return row.flags.length === 0;
  if (status === 'missing-crawl') return row.flags.includes('missing_in_crawl');
  if (status === 'missing-gsc') return row.flags.includes('missing_in_gsc');
  if (status === 'missing-ga4') return row.flags.includes('missing_in_ga4');
  if (status === 'crawl-errors') return row.flags.includes('crawl_error');
  if (status === 'noindex') return row.flags.includes('noindex');
  if (status === 'canonical') return row.flags.includes('canonical_mismatch');
  return true;
}

function getSortScore(row: ReconciliationRow) {
  return (
    row.flags.length * 1_000_000_000
    + (row.gsc?.impressions || 0) * 100
    + (row.gsc?.clicks || 0) * 10
    + (row.ga4?.sessions || 0)
  );
}

export function registerReconciliationRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

  app.get('/api/reconciliation/pages', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const propertyId = asTrimmedString(req.query.propertyId) || '';
    const startDate = asTrimmedString(req.query.startDate);
    const endDate = asTrimmedString(req.query.endDate);
    const crawlJobIdParam = asTrimmedString(req.query.crawlJobId) || '';
    const search = (asTrimmedString(req.query.search) || '').toLowerCase();
    const status = asTrimmedString(req.query.status) || 'issues';
    const limit = getLimit(req.query.limit);
    const offset = getOffset(req.query.offset);

    if (!siteUrl || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Missing or invalid reconciliation parameters' });
    }

    try {
      const user = await db.get<any>('SELECT tier FROM users WHERE id = ?', [ownerId]);
      if (!canUseReconciliation(user?.tier)) {
        return res.status(403).json({ error: 'Reconciliation is available on paid plans.' });
      }

      const latestJob = crawlJobIdParam
        ? { id: crawlJobIdParam }
        : await db.get<{ id: string }>(`
          SELECT id
          FROM crawl_jobs
          WHERE ownerId = ? AND siteUrl = ?
          ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
          LIMIT 1
        `, [ownerId, siteUrl]);
      const crawlJobId = latestJob?.id || null;

      const gscRows = await db.all<any>(`
        SELECT
          COALESCE(pageKey, page) AS pageKey,
          MIN(page) AS page,
          SUM(clicks) AS clicks,
          SUM(impressions) AS impressions,
          CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END AS ctr,
          CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END AS position,
          COUNT(DISTINCT query) AS queryCount
        FROM gsc_page_query_metrics
        WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
        GROUP BY COALESCE(pageKey, page)
      `, [ownerId, siteUrl, startDate, endDate]);

      const ga4Rows = propertyId
        ? await db.all<any>(`
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
        `, [ownerId, propertyId, startDate, endDate])
        : [];

      const crawlRows = crawlJobId
        ? await db.all<any>(`
          SELECT
            url,
            normalizedUrl,
            pageKey,
            statusCode,
            title,
            canonicalUrl,
            noindex,
            depth,
            wordCount,
            crawledAt,
            errorMessage
          FROM crawl_pages
          WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
        `, [ownerId, siteUrl, crawlJobId])
        : [];

      const rowsByKey = new Map<string, Omit<ReconciliationRow, 'flags' | 'sources'>>();
      const ensureRow = (pageKey: string) => {
        const existing = rowsByKey.get(pageKey);
        if (existing) return existing;
        const created = {
          crawl: null,
          ga4: null,
          gsc: null,
          pageKey,
          representativeUrl: pageKey,
        };
        rowsByKey.set(pageKey, created);
        return created;
      };

      for (const row of gscRows) {
        const page = String(row.page || '');
        const storedPageKey = String(row.pageKey || '');
        const pageKey = storedPageKey.startsWith('/') ? storedPageKey : canonicalPageKey(page, siteUrl);
        const target = ensureRow(pageKey);
        target.gsc = {
          clicks: toNumber(row.clicks),
          ctr: toNumber(row.ctr),
          impressions: toNumber(row.impressions),
          page,
          position: toNumber(row.position),
          queryCount: toNumber(row.queryCount),
        };
        target.representativeUrl = page || target.representativeUrl;
      }

      for (const row of ga4Rows) {
        const pagePath = String(row.pagePath || row.pageKey || '');
        const pageKey = canonicalPageKey(String(row.pageKey || pagePath), siteUrl);
        const target = ensureRow(pageKey);
        target.ga4 = {
          bounceRate: toNumber(row.bounceRate),
          eventCount: toNumber(row.eventCount),
          pagePath,
          pageViews: toNumber(row.pageViews),
          sessions: toNumber(row.sessions),
          totalUsers: toNumber(row.totalUsers),
        };
        if (!target.gsc) target.representativeUrl = pagePath || target.representativeUrl;
      }

      for (const row of crawlRows) {
        const url = String(row.url || row.normalizedUrl || row.pageKey || '');
        const pageKey = canonicalPageKey(String(row.pageKey || row.normalizedUrl || url), siteUrl);
        const target = ensureRow(pageKey);
        target.crawl = {
          canonicalUrl: row.canonicalUrl || null,
          crawledAt: row.crawledAt || null,
          depth: toNumber(row.depth),
          errorMessage: row.errorMessage || null,
          noindex: Boolean(row.noindex),
          statusCode: row.statusCode === null || row.statusCode === undefined ? null : toNumber(row.statusCode),
          title: row.title || null,
          url,
          wordCount: toNumber(row.wordCount),
        };
        if (!target.gsc && !target.ga4) target.representativeUrl = url || target.representativeUrl;
      }

      const allRows = Array.from(rowsByKey.values())
        .map((row) => {
          const flags = getFlags(row, Boolean(propertyId));
          return {
            ...row,
            flags,
            sources: {
              crawl: row.crawl ? 'present' : 'missing',
              ga4: row.ga4 ? 'present' : 'missing',
              gsc: row.gsc ? 'present' : 'missing',
            },
          } satisfies ReconciliationRow;
        })
        .filter((row) => matchesStatus(row, status))
        .filter((row) => {
          if (!search) return true;
          const haystack = [
            row.pageKey,
            row.representativeUrl,
            row.gsc?.page,
            row.ga4?.pagePath,
            row.crawl?.url,
            row.crawl?.title,
            row.crawl?.canonicalUrl,
          ].join(' ').toLowerCase();
          return haystack.includes(search);
        })
        .sort((a, b) => getSortScore(b) - getSortScore(a) || a.pageKey.localeCompare(b.pageKey));

      const totals = allRows.reduce(
        (acc, row) => {
          acc.total += 1;
          if (row.flags.length > 0) acc.issues += 1;
          if (row.flags.includes('missing_in_crawl')) acc.missingCrawl += 1;
          if (row.flags.includes('missing_in_gsc')) acc.missingGsc += 1;
          if (row.flags.includes('missing_in_ga4')) acc.missingGa4 += 1;
          if (row.flags.includes('crawl_error')) acc.crawlErrors += 1;
          return acc;
        },
        { crawlErrors: 0, issues: 0, missingCrawl: 0, missingGa4: 0, missingGsc: 0, total: 0 },
      );

      return res.json({
        meta: {
          crawlJobId,
          totals,
        },
        page: {
          limit,
          offset,
          total: allRows.length,
        },
        rows: allRows.slice(offset, offset + limit),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to reconcile page data' });
    }
  });
}
