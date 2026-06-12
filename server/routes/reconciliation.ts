import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import { canonicalPageKey } from '../reporting/url.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isIsoDateString } from '../validation.js';
import { canAccessGa4Property, canAccessSite } from '../accessControl.js';

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
  match: {
    canonicalPageKey: string | null;
    crawlPageKey: string | null;
    ga4PageKey: string | null;
    gscPageKey: string | null;
  };
  reasons: Array<{
    detail: string;
    label: string;
    tone: 'danger' | 'neutral' | 'warning';
  }>;
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

type ReconciliationBaseRow = Omit<ReconciliationRow, 'flags' | 'match' | 'reasons' | 'sources'>;

const toNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const getLimit = (value: unknown) => (Number.isFinite(Number(value)) ? Math.min(Math.max(Number(value), 1), 5000) : 100);
const getOffset = (value: unknown) => (Number.isFinite(Number(value)) ? Math.max(Number(value), 0) : 0);

function getFlags(row: ReconciliationBaseRow, hasGa4Property: boolean) {
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

function getReasons(
  row: ReconciliationBaseRow,
  flags: string[],
  rowsByKey: Map<string, ReconciliationBaseRow>,
) {
  const reasons: ReconciliationRow['reasons'] = [];
  const canonicalKey = row.crawl?.canonicalUrl ? canonicalPageKey(row.crawl.canonicalUrl) : null;

  if (flags.includes('missing_in_crawl')) {
    reasons.push({
      detail: row.gsc
        ? `${Math.round(row.gsc.impressions).toLocaleString('en-US')} GSC impressions matched this normalized path, but the latest completed crawl did not contain it.`
        : 'GA4 has sessions for this path, but the latest completed crawl did not contain it.',
      label: 'Not found by crawler',
      tone: 'warning',
    });
  }
  if (flags.includes('missing_in_gsc')) {
    reasons.push({
      detail: row.crawl
        ? 'The crawler found this URL, but GSC has no page-query rows for this date range.'
        : 'GA4 has behavior data, but GSC has no page-query rows for this date range.',
      label: 'No search visibility row',
      tone: 'neutral',
    });
  }
  if (flags.includes('missing_in_ga4')) {
    reasons.push({
      detail: 'The page exists in crawl or GSC, but no GA4 landing-page row matched the same normalized path.',
      label: 'No GA4 landing-page match',
      tone: 'neutral',
    });
  }
  if (flags.includes('crawl_error')) {
    reasons.push({
      detail: row.crawl?.errorMessage || `Crawler received ${row.crawl?.statusCode || 'no response'} for this URL.`,
      label: 'Crawler could not fetch page',
      tone: 'danger',
    });
  }
  if (flags.includes('noindex')) {
    reasons.push({
      detail: row.gsc
        ? `The page is noindex but still has ${Math.round(row.gsc.impressions).toLocaleString('en-US')} GSC impressions in range.`
        : 'The crawler found a noindex directive on this URL.',
      label: 'Indexability conflict',
      tone: row.gsc ? 'danger' : 'warning',
    });
  }
  if (flags.includes('canonical_mismatch') && canonicalKey) {
    const target = rowsByKey.get(canonicalKey);
    reasons.push({
      detail: target
        ? `Crawler canonical points to ${canonicalKey}, which is also present in the joined dataset.`
        : `Crawler canonical points to ${canonicalKey}, which did not match a GSC/GA4/crawl row in this result set.`,
      label: 'Canonical target differs',
      tone: 'warning',
    });
  }
  if (flags.includes('high_impressions_no_clicks')) {
    reasons.push({
      detail: `${Math.round(row.gsc?.impressions || 0).toLocaleString('en-US')} impressions but no clicks for this date range.`,
      label: 'SERP demand without clicks',
      tone: 'warning',
    });
  }

  return reasons;
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
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (propertyId && !(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }

      const latestJob = crawlJobIdParam
        ? { id: crawlJobIdParam }
        : await db.get<{ id: string }>(`
          SELECT id
          FROM crawl_jobs
          WHERE ownerId = ? AND siteUrl = ?
            AND status = 'completed'
            AND EXISTS (
              SELECT 1
              FROM crawl_pages
              WHERE crawl_pages.ownerId = crawl_jobs.ownerId
                AND crawl_pages.siteUrl = crawl_jobs.siteUrl
                AND crawl_pages.jobId = crawl_jobs.id
              LIMIT 1
            )
          ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
          LIMIT 1
        `, [ownerId, siteUrl]);
      const crawlJobId = latestJob?.id || null;

      const gscRows = await db.all<any>(`
        SELECT
          COALESCE(NULLIF(pageKey, ''), page) AS pageKey,
          MIN(page) AS page,
          SUM(clicks) AS clicks,
          SUM(impressions) AS impressions,
          CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END AS ctr,
          CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END AS position,
          COUNT(DISTINCT query) AS queryCount
        FROM gsc_page_query_metrics
        WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
        GROUP BY COALESCE(NULLIF(pageKey, ''), page)
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
          WHERE ownerId = ? AND propertyId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY pageKey
        `, [ownerId, propertyId, siteUrl, startDate, endDate])
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
            finalUrl,
            errorMessage
          FROM crawl_pages
          WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
        `, [ownerId, siteUrl, crawlJobId])
        : [];

      const rowsByKey = new Map<string, ReconciliationBaseRow>();
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
          url: row.finalUrl || url,
          wordCount: toNumber(row.wordCount),
        };
        if (!target.gsc && !target.ga4) target.representativeUrl = url || target.representativeUrl;
      }

      const reconciledRows = Array.from(rowsByKey.values())
        .map((row) => {
          const flags = getFlags(row, Boolean(propertyId));
          const canonicalPageKeyValue = row.crawl?.canonicalUrl ? canonicalPageKey(row.crawl.canonicalUrl) : null;
          return {
            ...row,
            flags,
            match: {
              canonicalPageKey: canonicalPageKeyValue,
              crawlPageKey: row.crawl ? row.pageKey : null,
              ga4PageKey: row.ga4 ? row.pageKey : null,
              gscPageKey: row.gsc ? row.pageKey : null,
            },
            reasons: getReasons(row, flags, rowsByKey),
            sources: {
              crawl: row.crawl ? 'present' : 'missing',
              ga4: row.ga4 ? 'present' : 'missing',
              gsc: row.gsc ? 'present' : 'missing',
            },
          } satisfies ReconciliationRow;
        })
        .sort((a, b) => getSortScore(b) - getSortScore(a) || a.pageKey.localeCompare(b.pageKey));

      const totals = reconciledRows.reduce(
        (acc, row) => {
          acc.total += 1;
          if (row.flags.length > 0) acc.issues += 1;
          if (row.flags.length === 0) acc.matched += 1;
          if (row.flags.includes('missing_in_crawl')) acc.missingCrawl += 1;
          if (row.flags.includes('missing_in_gsc')) acc.missingGsc += 1;
          if (row.flags.includes('missing_in_ga4')) acc.missingGa4 += 1;
          if (row.flags.includes('crawl_error')) acc.crawlErrors += 1;
          return acc;
        },
        { crawlErrors: 0, issues: 0, matched: 0, missingCrawl: 0, missingGa4: 0, missingGsc: 0, total: 0 },
      );

      const filteredRows = reconciledRows
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
            ...row.reasons.map((reason) => `${reason.label} ${reason.detail}`),
          ].join(' ').toLowerCase();
          return haystack.includes(search);
        });

      return res.json({
        meta: {
          crawlJobId,
          totals,
        },
        page: {
          limit,
          offset,
          total: filteredRows.length,
        },
        rows: filteredRows.slice(offset, offset + limit),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to reconcile page data' });
    }
  });
}
