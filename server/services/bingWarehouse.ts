import type { AppDatabase } from '../database.js';
import { canAccessSite } from '../accessControl.js';

const BING_DAILY_SCHEDULER_MS = 60 * 60 * 1000;
const BING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const nowIso = () => new Date().toISOString();

const toNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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

export function normalizeBingRows(data: any) {
  const rows = Array.isArray(data?.d) ? data.d : [];
  const byQuery = new Map<string, {
    AvgClickPosition: number;
    AvgImpressionPosition: number;
    Clicks: number;
    Impressions: number;
    Query: string;
  }>();

  for (const rawRow of rows) {
    const query = String(rawRow?.Query || '').trim();
    if (!query) continue;
    const clicks = toNumber(rawRow.Clicks);
    const impressions = toNumber(rawRow.Impressions);
    const current = byQuery.get(query) || {
      AvgClickPosition: 0,
      AvgImpressionPosition: 0,
      Clicks: 0,
      Impressions: 0,
      Query: query,
    };
    current.AvgClickPosition += toNumber(rawRow.AvgClickPosition) * Math.max(clicks, 1);
    current.AvgImpressionPosition += toNumber(rawRow.AvgImpressionPosition) * Math.max(impressions, 1);
    current.Clicks += clicks;
    current.Impressions += impressions;
    byQuery.set(query, current);
  }

  return Array.from(byQuery.values()).map((row) => ({
    AvgClickPosition: row.Clicks > 0 ? row.AvgClickPosition / row.Clicks : row.AvgClickPosition,
    AvgImpressionPosition: row.Impressions > 0 ? row.AvgImpressionPosition / row.Impressions : row.AvgImpressionPosition,
    Clicks: row.Clicks,
    Ctr: row.Impressions > 0 ? row.Clicks / row.Impressions : 0,
    Impressions: row.Impressions,
    Query: row.Query,
  }));
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
  const response = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=${encodeURIComponent(input.siteUrl)}&apikey=${input.apiKey}`);
  if (!response.ok) {
    throw new BingQueryStatsError(response.status, input.siteUrl);
  }

  const data = await response.json();
  const rows = normalizeBingRows(data);
  const fetchedAt = nowIso();

  await db.transaction(async () => {
    await db.run('DELETE FROM bing_query_stats WHERE ownerId = ? AND siteUrl = ?', [input.ownerId, input.siteUrl]);
    for (const row of rows) {
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

  return { fetchedAt, rows };
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
    return { fromCache: true, rows: await listCachedBingQueryStats(db, input.ownerId, input.siteUrl), status };
  }

  try {
    const result = await syncBingQueryStats(db, input);
    return {
      fromCache: false,
      rows: result.rows,
      status: { isFresh: true, latestFetchedAt: result.fetchedAt, rowCount: result.rows.length },
    };
  } catch (error) {
    const cachedRows = await listCachedBingQueryStats(db, input.ownerId, input.siteUrl);
    if (cachedRows.length > 0) {
      return { fromCache: true, rows: cachedRows, status };
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
