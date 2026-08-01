import type { AppDatabase } from '../database.js';
import { resolveSiteScopeBySiteUrl } from './siteScopes.js';

type MetricRow = {
  clicks?: unknown;
  impressions?: unknown;
  page?: unknown;
  pageKey?: unknown;
  position?: unknown;
  query?: unknown;
};

type CrawlPageRow = {
  h1Text?: unknown;
  inboundLinkCount?: unknown;
  pageKey?: unknown;
  title?: unknown;
  url?: unknown;
  wordCount?: unknown;
};

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'best', 'by', 'for', 'from', 'how', 'in',
  'is', 'it', 'of', 'on', 'or', 'the', 'to', 'vs', 'what', 'when', 'where', 'which',
  'who', 'why', 'with', 'your',
]);

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const text = (value: unknown) => String(value ?? '').trim();

function tokens(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.map((token) => {
      if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
      if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
      if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
      return token;
    })
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token)) || [];
}

function topicKey(query: string) {
  const normalized = [...new Set(tokens(query))].sort().slice(0, 4);
  return normalized.length ? normalized.join('|') : query.toLocaleLowerCase().trim();
}

function placeholders(count: number) {
  return new Array(count).fill('?').join(', ');
}

function statusFor(position: number) {
  if (position <= 3) return 'leading' as const;
  if (position <= 10) return 'established' as const;
  if (position <= 20) return 'emerging' as const;
  return 'gap' as const;
}

function evidenceBreakdown(input: { ctr: number; inboundLinks: number; pageCount: number; position: number }) {
  const visibility = Math.round(Math.max(0, Math.min(40, 40 - Math.max(0, input.position - 1) * 0.8)));
  const demandCapture = Math.round(Math.max(0, Math.min(25, input.ctr * 250)));
  const depth = Math.round(Math.max(0, Math.min(20, input.pageCount * 5)));
  const internalSupport = Math.round(Math.max(0, Math.min(15, input.inboundLinks)));
  return {
    demandCapture,
    depth,
    internalSupport,
    total: visibility + demandCapture + depth + internalSupport,
    visibility,
  };
}

export async function getTopicalAuthorityReport(
  db: AppDatabase,
  ownerId: string,
  input: { limit?: number; offset?: number; search?: string | null; siteUrl: string; status?: string | null },
) {
  const resolved = await resolveSiteScopeBySiteUrl(db, ownerId, input.siteUrl);
  const gscSources = resolved?.sources
    .filter((source) => text(source.sourceType).toLowerCase().startsWith('gsc'))
    .flatMap((source) => [text(source.siteUrl), text(source.sourceKey)])
    .filter(Boolean) || [];
  const sourceSites = [...new Set([input.siteUrl, ...gscSources])];
  const sitePlaceholders = placeholders(sourceSites.length);
  const metrics = await db.all<MetricRow>(`
    SELECT
      COALESCE(NULLIF(pageKey, ''), page) AS pageKey,
      MAX(page) AS page,
      query,
      SUM(clicks) AS clicks,
      SUM(impressions) AS impressions,
      CASE WHEN SUM(impressions) > 0
        THEN SUM(position * impressions) / SUM(impressions)
        ELSE AVG(position)
      END AS position
    FROM gsc_page_query_metrics
    WHERE ownerId = ?
      AND siteUrl IN (${sitePlaceholders})
      AND query IS NOT NULL
      AND query <> ''
      AND impressions > 0
    GROUP BY COALESCE(NULLIF(pageKey, ''), page), query
    ORDER BY SUM(impressions) DESC
  `, [ownerId, ...sourceSites]);

  const dateRange = await db.get<{ endDate?: unknown; startDate?: unknown }>(`
    SELECT MIN(date) AS startDate, MAX(date) AS endDate
    FROM gsc_page_query_metrics
    WHERE ownerId = ? AND siteUrl IN (${sitePlaceholders})
  `, [ownerId, ...sourceSites]);

  const latestCrawl = await db.get<{ id?: unknown; siteUrl?: unknown }>(`
    SELECT id, siteUrl
    FROM crawl_jobs
    WHERE ownerId = ? AND siteUrl IN (${sitePlaceholders}) AND status = 'completed'
    ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC, id DESC
    LIMIT 1
  `, [ownerId, ...sourceSites]);
  const crawlJobId = text(latestCrawl?.id) || null;
  const crawlPages = crawlJobId
    ? await db.all<CrawlPageRow>(`
        SELECT pageKey, url, title, h1Text, wordCount, inboundLinkCount
        FROM crawl_pages
        WHERE ownerId = ? AND jobId = ? AND statusCode >= 200 AND statusCode < 400 AND noindex = 0
      `, [ownerId, crawlJobId])
    : [];
  const crawlByPage = new Map(crawlPages.map((row) => [text(row.pageKey), row]));

  type PageEvidence = {
    clicks: number;
    impressions: number;
    inboundLinks: number;
    pageKey: string;
    positionWeighted: number;
    queryCount: number;
    title: string;
    url: string;
    wordCount: number;
  };
  type Cluster = {
    clicks: number;
    impressions: number;
    key: string;
    label: string;
    pages: Map<string, PageEvidence>;
    positionWeighted: number;
    queries: Map<string, { clicks: number; impressions: number; positionWeighted: number }>;
  };

  const clusters = new Map<string, Cluster>();
  for (const row of metrics) {
    const query = text(row.query);
    const pageKey = text(row.pageKey);
    if (!query || !pageKey) continue;
    const key = topicKey(query);
    const clicks = num(row.clicks);
    const impressions = num(row.impressions);
    const position = num(row.position);
    const cluster = clusters.get(key) || {
      clicks: 0,
      impressions: 0,
      key,
      label: query,
      pages: new Map<string, PageEvidence>(),
      positionWeighted: 0,
      queries: new Map<string, { clicks: number; impressions: number; positionWeighted: number }>(),
    };
    if (impressions > cluster.impressions) cluster.label = query;
    cluster.clicks += clicks;
    cluster.impressions += impressions;
    cluster.positionWeighted += position * impressions;
    const queryEvidence = cluster.queries.get(query) || { clicks: 0, impressions: 0, positionWeighted: 0 };
    queryEvidence.clicks += clicks;
    queryEvidence.impressions += impressions;
    queryEvidence.positionWeighted += position * impressions;
    cluster.queries.set(query, queryEvidence);
    const crawl = crawlByPage.get(pageKey);
    const page = cluster.pages.get(pageKey) || {
      clicks: 0,
      impressions: 0,
      inboundLinks: num(crawl?.inboundLinkCount),
      pageKey,
      positionWeighted: 0,
      queryCount: 0,
      title: text(crawl?.title) || text(crawl?.h1Text) || text(row.page) || pageKey,
      url: text(crawl?.url) || text(row.page),
      wordCount: num(crawl?.wordCount),
    };
    page.clicks += clicks;
    page.impressions += impressions;
    page.positionWeighted += position * impressions;
    page.queryCount += 1;
    cluster.pages.set(pageKey, page);
    clusters.set(key, cluster);
  }

  const rows = [...clusters.values()].map((cluster) => {
    const position = cluster.impressions ? cluster.positionWeighted / cluster.impressions : 0;
    const ctr = cluster.impressions ? cluster.clicks / cluster.impressions : 0;
    const pages = [...cluster.pages.values()]
      .map((page) => ({
        ...page,
        position: page.impressions ? page.positionWeighted / page.impressions : 0,
      }))
      .sort((a, b) => b.impressions - a.impressions);
    const inboundLinks = pages.reduce((sum, page) => sum + page.inboundLinks, 0);
    const evidence = evidenceBreakdown({ ctr, inboundLinks, pageCount: pages.length, position });
    const status = statusFor(position);
    const queries = [...cluster.queries.entries()]
      .map(([query, queryEvidence]) => ({
        clicks: queryEvidence.clicks,
        impressions: queryEvidence.impressions,
        position: queryEvidence.impressions ? queryEvidence.positionWeighted / queryEvidence.impressions : 0,
        query,
      }))
      .sort((a, b) => b.impressions - a.impressions);
    const issues = [
      pages.length < 2 ? 'Only one ranking page supports this topic.' : null,
      position > 10 ? 'The topic has demand but weak first-page visibility.' : null,
      inboundLinks < Math.max(3, pages.length * 2) ? 'Ranking pages have limited internal-link support.' : null,
      ctr < 0.02 && position <= 10 ? 'First-page visibility is not translating into clicks.' : null,
    ].filter((value): value is string => Boolean(value));
    return {
      _pageKeys: pages.map((page) => page.pageKey),
      _searchText: [
        cluster.label,
        ...queries.map((query) => query.query),
        ...pages.flatMap((page) => [page.title, page.url]),
      ].join('\n').toLocaleLowerCase(),
      clicks: cluster.clicks,
      ctr,
      evidence,
      impressions: cluster.impressions,
      issues,
      key: cluster.key,
      label: cluster.label,
      pageCount: pages.length,
      pages: pages.slice(0, 8),
      position,
      queryCount: cluster.queries.size,
      queries: queries.slice(0, 10),
      status,
      support: { inboundLinks },
    };
  }).sort((a, b) => b.impressions - a.impressions);

  const search = text(input.search).toLocaleLowerCase();
  const status = text(input.status).toLocaleLowerCase();
  const filtered = rows.filter((row) => {
    if (status && status !== 'all' && row.status !== status) return false;
    return !search || row._searchText.includes(search);
  });
  const limit = Math.min(Math.max(Math.trunc(input.limit || 50), 1), 200);
  const offset = Math.max(Math.trunc(input.offset || 0), 0);
  const statusCounts = rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.status] = (counts[row.status] || 0) + 1;
    return counts;
  }, { leading: 0, established: 0, emerging: 0, gap: 0 });
  const responseRows = filtered.slice(offset, offset + limit).map(({ _pageKeys, _searchText, ...row }) => row);

  return {
    meta: {
      crawlJobId,
      dateRange: { endDate: text(dateRange?.endDate) || null, startDate: text(dateRange?.startDate) || null },
      methodology: 'Observed GSC page-query clusters with crawl depth and internal-link support. Evidence score is an app diagnostic, not a Google metric.',
      source: 'warehouse',
      sourceSites,
    },
    page: { limit, offset, total: filtered.length },
    rows: responseRows,
    summary: {
      clicks: rows.reduce((sum, row) => sum + row.clicks, 0),
      clusters: rows.length,
      impressions: rows.reduce((sum, row) => sum + row.impressions, 0),
      pages: new Set(rows.flatMap((row) => row._pageKeys)).size,
      statusCounts,
    },
  };
}
