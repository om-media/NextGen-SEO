import type { AppDatabase } from '../database.js';
import { canAccessSite } from '../accessControl.js';

const BING_DAILY_SCHEDULER_MS = 60 * 60 * 1000;
const BING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LEGACY_MIRROR_RANGE_SEMANTICS = 'Legacy Bing mirror rows stay query-aggregated for compatibility. Provide startDate and endDate to query dated Bing facts.';
const COMPATIBILITY_RANGE_SEMANTICS = 'Rows without Bing report dates are pinned only to their fetchedAt calendar date for compatibility. No additional history is fabricated.';

const nowIso = () => new Date().toISOString();

const toNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

type BingDateSource = 'reported' | 'compatibility-fetchedAt';

type BingFactRow = {
  Date: string;
  DateSource: BingDateSource;
  Query: string;
  Impressions: number;
  Clicks: number;
  Ctr: number;
  AvgClickPosition: number;
  AvgImpressionPosition: number;
  FetchedAt?: string | null;
};

type BingAggregateRow = {
  AvgClickPosition: number;
  AvgImpressionPosition: number;
  Clicks: number;
  Ctr: number;
  Impressions: number;
  Query: string;
};

type BingRangeMeta = {
  availableEndDate: string | null;
  availableStartDate: string | null;
  compatibilityBackfill: {
    dateCount: number;
    rowCount: number;
    semantics: string | null;
  };
  factRowCount: number;
  latestFetchedAt: string | null;
  matchedDateCount: number;
  mode: 'date-range-aggregate' | 'legacy-mirror';
  queryCount: number;
  requestedEndDate: string | null;
  requestedStartDate: string | null;
  semantics: string | null;
};

class BingQueryStatsError extends Error {
  constructor(public readonly status: number, public readonly siteUrl: string) {
    super('Bing query stats request failed with ' + status);
  }
}

function parseStringArray(value: unknown) {
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function toWeight(value: number) {
  return value > 0 ? value : 1;
}

function parseBingReportDate(value: unknown) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const msJson = trimmed.match(/^\/Date\(([-+]?\d+)(?:[-+]\d{4})?\)\/$/);
    if (msJson) {
      const millis = Number(msJson[1]);
      if (Number.isFinite(millis)) {
        return new Date(millis).toISOString().slice(0, 10);
      }
    }
    const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString().slice(0, 10);
    }
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 10);
  }

  return null;
}

function aggregateBingRowsByQuery(rows: Array<Pick<BingFactRow, 'AvgClickPosition' | 'AvgImpressionPosition' | 'Clicks' | 'Impressions' | 'Query'>>) {
  const byQuery = new Map<string, {
    avgClickPositionWeighted: number;
    avgImpressionPositionWeighted: number;
    clickWeight: number;
    Clicks: number;
    impressionWeight: number;
    Impressions: number;
    Query: string;
  }>();

  for (const rawRow of rows) {
    const query = String(rawRow.Query || '').trim();
    if (!query) continue;
    const clicks = toNumber(rawRow.Clicks);
    const impressions = toNumber(rawRow.Impressions);
    const clickWeight = toWeight(clicks);
    const impressionWeight = toWeight(impressions);
    const current = byQuery.get(query) || {
      avgClickPositionWeighted: 0,
      avgImpressionPositionWeighted: 0,
      clickWeight: 0,
      Clicks: 0,
      impressionWeight: 0,
      Impressions: 0,
      Query: query,
    };
    current.avgClickPositionWeighted += toNumber(rawRow.AvgClickPosition) * clickWeight;
    current.avgImpressionPositionWeighted += toNumber(rawRow.AvgImpressionPosition) * impressionWeight;
    current.clickWeight += clickWeight;
    current.impressionWeight += impressionWeight;
    current.Clicks += clicks;
    current.Impressions += impressions;
    byQuery.set(query, current);
  }

  return Array.from(byQuery.values())
    .map((row): BingAggregateRow => ({
      AvgClickPosition: row.clickWeight > 0 ? row.avgClickPositionWeighted / row.clickWeight : 0,
      AvgImpressionPosition: row.impressionWeight > 0 ? row.avgImpressionPositionWeighted / row.impressionWeight : 0,
      Clicks: row.Clicks,
      Ctr: row.Impressions > 0 ? row.Clicks / row.Impressions : 0,
      Impressions: row.Impressions,
      Query: row.Query,
    }))
    .sort((left, right) => (right.Impressions - left.Impressions) || (right.Clicks - left.Clicks) || left.Query.localeCompare(right.Query));
}

function buildRangeMeta(rows: BingFactRow[], requestedStartDate: string | null, requestedEndDate: string | null): BingRangeMeta {
  const matchedDates = new Set<string>();
  const compatibilityDates = new Set<string>();
  let availableStartDate: string | null = null;
  let availableEndDate: string | null = null;
  let latestFetchedAt: string | null = null;
  let compatibilityRowCount = 0;

  for (const row of rows) {
    matchedDates.add(row.Date);
    if (!availableStartDate || row.Date < availableStartDate) availableStartDate = row.Date;
    if (!availableEndDate || row.Date > availableEndDate) availableEndDate = row.Date;
    if (row.FetchedAt && (!latestFetchedAt || row.FetchedAt > latestFetchedAt)) latestFetchedAt = row.FetchedAt;
    if (row.DateSource === 'compatibility-fetchedAt') {
      compatibilityRowCount += 1;
      compatibilityDates.add(row.Date);
    }
  }

  return {
    availableEndDate,
    availableStartDate,
    compatibilityBackfill: {
      dateCount: compatibilityDates.size,
      rowCount: compatibilityRowCount,
      semantics: compatibilityRowCount > 0 ? COMPATIBILITY_RANGE_SEMANTICS : null,
    },
    factRowCount: rows.length,
    latestFetchedAt,
    matchedDateCount: matchedDates.size,
    mode: 'date-range-aggregate',
    queryCount: aggregateBingRowsByQuery(rows).length,
    requestedEndDate,
    requestedStartDate,
    semantics: null,
  };
}

async function ensureBingQueryMetricsTable(db: AppDatabase) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bing_query_metrics (
      ownerId TEXT,
      siteUrl TEXT,
      date TEXT,
      query TEXT,
      impressions INTEGER,
      clicks INTEGER,
      ctr REAL,
      avgClickPosition REAL,
      avgImpressionPosition REAL,
      fetchedAt TEXT,
      dateSource TEXT DEFAULT 'reported',
      PRIMARY KEY (ownerId, siteUrl, date, query)
    );
    CREATE INDEX IF NOT EXISTS idx_bing_query_metrics_owner_site_date ON bing_query_metrics(ownerId, siteUrl, date);
    CREATE INDEX IF NOT EXISTS idx_bing_query_metrics_owner_site_query_date ON bing_query_metrics(ownerId, siteUrl, query, date);
  `);
}

export function collectWorkspaceSiteUrls(user: {
  activatedSiteUrl?: string | null;
  knownSites?: string | null;
  unlockedSites?: string | null;
}) {
  const sites = new Set<string>();
  if (typeof user.activatedSiteUrl === 'string' && user.activatedSiteUrl.trim()) {
    sites.add(user.activatedSiteUrl.trim());
  }
  for (const site of parseStringArray(user.unlockedSites)) {
    sites.add(site.trim());
  }
  for (const site of parseStringArray(user.knownSites)) {
    sites.add(site.trim());
  }
  return [...sites];
}

export function normalizeBingRows(
  data: any,
  options: { fallbackDate?: string | null; fallbackDateSource?: BingDateSource } = {},
) {
  const rows = Array.isArray(data?.d) ? data.d : [];
  const byDateAndQuery = new Map<string, BingFactRow & { clickWeight: number; impressionWeight: number }>();

  for (const rawRow of rows) {
    const query = String(rawRow?.Query || '').trim();
    if (!query) continue;

    const reportedDate = parseBingReportDate(rawRow?.Date);
    const date = reportedDate || options.fallbackDate || null;
    if (!date) continue;

    const dateSource: BingDateSource = reportedDate
      ? 'reported'
      : options.fallbackDateSource || 'compatibility-fetchedAt';
    const key = `${date}\u0000${query}`;
    const clicks = toNumber(rawRow.Clicks);
    const impressions = toNumber(rawRow.Impressions);
    const clickWeight = toWeight(clicks);
    const impressionWeight = toWeight(impressions);
    const current = byDateAndQuery.get(key) || {
      Date: date,
      DateSource: dateSource,
      AvgClickPosition: 0,
      AvgImpressionPosition: 0,
      Clicks: 0,
      Ctr: 0,
      Impressions: 0,
      Query: query,
      clickWeight: 0,
      impressionWeight: 0,
    };

    current.DateSource = current.DateSource === 'reported' || dateSource === 'reported'
      ? 'reported'
      : 'compatibility-fetchedAt';
    current.AvgClickPosition += toNumber(rawRow.AvgClickPosition) * clickWeight;
    current.AvgImpressionPosition += toNumber(rawRow.AvgImpressionPosition) * impressionWeight;
    current.Clicks += clicks;
    current.Impressions += impressions;
    current.clickWeight += clickWeight;
    current.impressionWeight += impressionWeight;
    byDateAndQuery.set(key, current);
  }

  return Array.from(byDateAndQuery.values())
    .map((row) => ({
      Date: row.Date,
      DateSource: row.DateSource,
      AvgClickPosition: row.clickWeight > 0 ? row.AvgClickPosition / row.clickWeight : 0,
      AvgImpressionPosition: row.impressionWeight > 0 ? row.AvgImpressionPosition / row.impressionWeight : 0,
      Clicks: row.Clicks,
      Ctr: row.Impressions > 0 ? row.Clicks / row.Impressions : 0,
      Impressions: row.Impressions,
      Query: row.Query,
    }))
    .sort((left, right) => (left.Date.localeCompare(right.Date)) || (right.Impressions - left.Impressions) || left.Query.localeCompare(right.Query));
}

export async function listCachedBingQueryStats(db: AppDatabase, ownerId: string, siteUrl: string) {
  const rows = await db.all<any>(
    `SELECT query, impressions, clicks, ctr, avgClickPosition, avgImpressionPosition
     FROM bing_query_stats
     WHERE ownerId = ? AND siteUrl = ?
     ORDER BY impressions DESC, clicks DESC`,
    [ownerId, siteUrl],
  );

  return rows.map((row) => ({
    AvgClickPosition: toNumber(row.avgClickPosition),
    AvgImpressionPosition: toNumber(row.avgImpressionPosition),
    Clicks: toNumber(row.clicks),
    Ctr: toNumber(row.ctr),
    Impressions: toNumber(row.impressions),
    Query: String(row.query || ''),
  }));
}

export async function listBingQueryStatsForRange(
  db: AppDatabase,
  ownerId: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
) {
  await ensureBingQueryMetricsTable(db);
  const factRows = await db.all<any>(
    `SELECT date, query, impressions, clicks, ctr, avgClickPosition, avgImpressionPosition, fetchedAt, dateSource
     FROM bing_query_metrics
     WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
     ORDER BY date ASC, impressions DESC, clicks DESC, query ASC`,
    [ownerId, siteUrl, startDate, endDate],
  );

  const rows: BingFactRow[] = factRows.map((row) => ({
    Date: String(row.date || ''),
    DateSource: (row.dateSource === 'compatibility-fetchedAt' ? 'compatibility-fetchedAt' : 'reported') as BingDateSource,
    AvgClickPosition: toNumber(row.avgClickPosition),
    AvgImpressionPosition: toNumber(row.avgImpressionPosition),
    Clicks: toNumber(row.clicks),
    Ctr: toNumber(row.ctr),
    FetchedAt: typeof row.fetchedAt === 'string' ? row.fetchedAt : null,
    Impressions: toNumber(row.impressions),
    Query: String(row.query || ''),
  })).filter((row) => row.Date && row.Query);

  const aggregatedRows = aggregateBingRowsByQuery(rows);
  const meta = buildRangeMeta(rows, startDate, endDate);
  meta.queryCount = aggregatedRows.length;
  return { meta, rows: aggregatedRows };
}

export function buildLegacyBingRangeMeta(status: { latestFetchedAt: string | null; rowCount: number }): BingRangeMeta {
  return {
    availableEndDate: null,
    availableStartDate: null,
    compatibilityBackfill: {
      dateCount: 0,
      rowCount: 0,
      semantics: null,
    },
    factRowCount: 0,
    latestFetchedAt: status.latestFetchedAt,
    matchedDateCount: 0,
    mode: 'legacy-mirror',
    queryCount: status.rowCount,
    requestedEndDate: null,
    requestedStartDate: null,
    semantics: LEGACY_MIRROR_RANGE_SEMANTICS,
  };
}

export async function getBingCacheStatus(db: AppDatabase, ownerId: string, siteUrl: string) {
  const row = await db.get<any>(
    `SELECT MAX(fetchedAt) AS latestFetchedAt, COUNT(*) AS rowCount
     FROM bing_query_stats
     WHERE ownerId = ? AND siteUrl = ?`,
    [ownerId, siteUrl],
  );
  const latestFetchedAt = typeof row?.latestFetchedAt === 'string' ? row.latestFetchedAt : null;
  return {
    isFresh: latestFetchedAt ? Date.now() - new Date(latestFetchedAt).getTime() < BING_CACHE_TTL_MS : false,
    latestFetchedAt,
    rowCount: toNumber(row?.rowCount),
  };
}

export async function syncBingQueryStats(db: AppDatabase, input: { apiKey: string; ownerId: string; siteUrl: string }) {
  await ensureBingQueryMetricsTable(db);
  const response = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=${encodeURIComponent(input.siteUrl)}&apikey=${input.apiKey}`);
  if (!response.ok) {
    throw new BingQueryStatsError(response.status, input.siteUrl);
  }

  const fetchedAt = nowIso();
  const fallbackDate = fetchedAt.slice(0, 10);
  const data = await response.json();
  const factRows = normalizeBingRows(data, {
    fallbackDate,
    fallbackDateSource: 'compatibility-fetchedAt',
  }).map((row) => ({ ...row, FetchedAt: fetchedAt }));
  const aggregateRows = aggregateBingRowsByQuery(factRows);

  await db.transaction(async () => {
    for (const row of factRows) {
      await db.run(
        `INSERT INTO bing_query_metrics
          (ownerId, siteUrl, date, query, impressions, clicks, ctr, avgClickPosition, avgImpressionPosition, fetchedAt, dateSource)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ownerId, siteUrl, date, query) DO UPDATE SET
           impressions = excluded.impressions,
           clicks = excluded.clicks,
           ctr = excluded.ctr,
           avgClickPosition = excluded.avgClickPosition,
           avgImpressionPosition = excluded.avgImpressionPosition,
           fetchedAt = excluded.fetchedAt,
           dateSource = excluded.dateSource`,
        [
          input.ownerId,
          input.siteUrl,
          row.Date,
          row.Query,
          row.Impressions,
          row.Clicks,
          row.Ctr,
          row.AvgClickPosition,
          row.AvgImpressionPosition,
          fetchedAt,
          row.DateSource,
        ],
      );
    }

    await db.run('DELETE FROM bing_query_stats WHERE ownerId = ? AND siteUrl = ?', [input.ownerId, input.siteUrl]);
    for (const row of aggregateRows) {
      await db.run(
        `INSERT INTO bing_query_stats
          (ownerId, siteUrl, query, impressions, clicks, ctr, avgClickPosition, avgImpressionPosition, fetchedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.ownerId,
          input.siteUrl,
          row.Query,
          row.Impressions,
          row.Clicks,
          row.Ctr,
          row.AvgClickPosition,
          row.AvgImpressionPosition,
          fetchedAt,
        ],
      );
    }
  })();

  const rangeDates = factRows.map((row) => row.Date);
  const rangeMeta = buildRangeMeta(
    factRows,
    rangeDates.length > 0 ? rangeDates[0] : null,
    rangeDates.length > 0 ? rangeDates[rangeDates.length - 1] : null,
  );
  rangeMeta.queryCount = aggregateRows.length;

  return {
    fetchedAt,
    legacyRows: aggregateRows,
    rangeMeta,
    rows: factRows,
  };
}

export async function syncBingSites(db: AppDatabase, input: { apiKey: string; ownerId: string; siteUrls: string[] }) {
  const apiKey = String(input.apiKey || '').trim();
  if (!apiKey) {
    return { attemptedSites: [], syncedSites: [] as string[] };
  }

  const attemptedSites = Array.from(new Set(input.siteUrls.map((siteUrl) => siteUrl.trim()).filter(Boolean)));
  const syncedSites: string[] = [];

  for (const siteUrl of attemptedSites) {
    try {
      if (!(await canAccessSite(db, input.ownerId, siteUrl))) continue;
      await syncBingQueryStats(db, { apiKey, ownerId: input.ownerId, siteUrl });
      syncedSites.push(siteUrl);
    } catch (error: any) {
      const message = error instanceof BingQueryStatsError
        ? 'Bing query stats request failed with ' + error.status
        : error?.message || 'Bing query stats refresh failed';
      console.warn('[bing] Workspace query stats sync skipped', { message, ownerId: input.ownerId, siteUrl });
    }
  }

  return { attemptedSites, syncedSites };
}

export async function getFreshBingQueryStats(db: AppDatabase, input: { apiKey: string; ownerId: string; siteUrl: string }) {
  const status = await getBingCacheStatus(db, input.ownerId, input.siteUrl);
  if (status.isFresh) {
    return {
      fromCache: true,
      rangeMeta: buildLegacyBingRangeMeta(status),
      rows: await listCachedBingQueryStats(db, input.ownerId, input.siteUrl),
      status,
    };
  }

  try {
    const result = await syncBingQueryStats(db, input);
    return {
      fromCache: false,
      rangeMeta: result.rangeMeta,
      rows: result.legacyRows,
      status: { isFresh: true, latestFetchedAt: result.fetchedAt, rowCount: result.legacyRows.length },
    };
  } catch (error) {
    const cachedRows = await listCachedBingQueryStats(db, input.ownerId, input.siteUrl);
    if (cachedRows.length > 0) {
      return {
        fromCache: true,
        rangeMeta: buildLegacyBingRangeMeta(status),
        rows: cachedRows,
        status,
      };
    }
    throw error;
  }
}

export async function runBingDailySchedulerTick(db: AppDatabase) {
  const users = await db.all<any>(`
    SELECT id, tier, activatedSiteUrl, knownSites, unlockedSites, bingApiKey
    FROM users
    WHERE bingApiKey IS NOT NULL AND bingApiKey != ''
  `);

  for (const user of users) {
    await syncBingSites(db, {
      apiKey: user.bingApiKey,
      ownerId: user.id,
      siteUrls: collectWorkspaceSiteUrls(user),
    });
  }
}

export function startBingDailyScheduler(db: AppDatabase) {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runBingDailySchedulerTick(db);
    } catch (error) {
      console.error('[bing] Daily scheduler failed:', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), BING_DAILY_SCHEDULER_MS);
  setTimeout(() => void tick(), 30_000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
