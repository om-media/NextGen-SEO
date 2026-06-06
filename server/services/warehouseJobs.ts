import crypto from 'crypto';
import type { AppDatabase } from '../database.js';
import { canAccessGa4Property, canAccessSite } from '../accessControl.js';
import { canonicalPageKey } from '../reporting/url.js';
import { resolveWorkspaceGa4Property } from './ga4Mappings.js';
import { refreshGscMonthlySummariesForRange } from './gscMonthlySummaries.js';
import { googleApiFetchJson } from './googleAuth.js';

type WarehouseJob = {
  attemptCount: number | null;
  completedAt: string | null;
  id: string;
  jobType: string;
  lastError: string | null;
  lockedAt: string | null;
  maxAttempts: number | null;
  metricsJson: string | null;
  nextRunAt: string | null;
  ownerId: string;
  propertyId: string | null;
  rowsSynced: number | null;
  siteUrl: string;
  startedAt: string | null;
  status: string;
  targetStartDate: string | null;
  targetDate: string;
  updatedAt: string | null;
};

type WarehouseSyncResult = {
  apiMs: number;
  metrics?: Record<string, unknown>;
  rows: Record<string, number>;
  rowsSynced: number;
  writeMs: number;
};

const emptySyncResult = (metrics?: Record<string, unknown>): WarehouseSyncResult => ({
  apiMs: 0,
  metrics,
  rows: {},
  rowsSynced: 0,
  writeMs: 0,
});

const elapsedMs = (startedAt: number) => Math.max(0, Date.now() - startedAt);

function combineSyncResults(results: WarehouseSyncResult[], metrics?: Record<string, unknown>): WarehouseSyncResult {
  return {
    apiMs: results.reduce((sum, result) => sum + result.apiMs, 0),
    metrics,
    rows: Object.assign({}, ...results.map((result) => result.rows)),
    rowsSynced: results.reduce((sum, result) => sum + result.rowsSynced, 0),
    writeMs: results.reduce((sum, result) => sum + result.writeMs, 0),
  };
}

const prepareWarehouseStatement = (db: AppDatabase, sql: string) => (db.dialect === 'sqlite' ? db.prepare(sql) : null);

async function runWarehouseStatement(db: AppDatabase, statement: any, sql: string, params: unknown[]) {
  if (statement) {
    statement.run(params);
    return;
  }
  await db.run(sql, params);
}

const positiveIntegerEnv = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
};
const POLL_MS = positiveIntegerEnv(process.env.WAREHOUSE_WORKER_POLL_MS, 5_000, 1_000, 60_000);
const DAILY_SCHEDULER_MS = 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const JOBS_PER_TICK = positiveIntegerEnv(process.env.WAREHOUSE_JOBS_PER_TICK, 8, 1, 24);
export const SEARCH_CONSOLE_HISTORY_DAYS = 486;
const INITIAL_BACKFILL_DAYS = positiveIntegerEnv(process.env.WAREHOUSE_INITIAL_BACKFILL_DAYS, SEARCH_CONSOLE_HISTORY_DAYS, 1, SEARCH_CONSOLE_HISTORY_DAYS);
export const CORE_RANGE_JOB_DAYS = positiveIntegerEnv(process.env.WAREHOUSE_CORE_RANGE_JOB_DAYS, 120, 7, 365);
const GSC_ROW_LIMIT = 25_000;
const GSC_MAX_PAGES_PER_DATASET = 200;
const GA4_ROW_LIMIT = 100_000;
const GA4_MAX_PAGES_PER_DATASET = 100;
const LLM_SOURCE_REGEXP = 'chatgpt|openai|claude|anthropic|perplexity|copilot|bing.com/chat';
export const LLM_RANGE_JOB_DAYS = positiveIntegerEnv(process.env.WAREHOUSE_LLM_RANGE_JOB_DAYS, 120, 14, 365);
export const GA4_DIMENSION_RANGE_JOB_DAYS = positiveIntegerEnv(process.env.WAREHOUSE_GA4_DIMENSION_RANGE_JOB_DAYS, 120, 14, 365);
const GA4_DIMENSION_SYNC_CONFIGS = [
  {
    dimension: 'sessionSourceMedium',
    metrics: ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
  },
  {
    dimension: 'country',
    metrics: ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
  },
  {
    dimension: 'city',
    metrics: ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
  },
  {
    dimension: 'region',
    metrics: ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
  },
  {
    dimension: 'deviceCategory',
    metrics: ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
  },
  {
    dimension: 'browser',
    metrics: ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
  },
  {
    dimension: 'operatingSystem',
    metrics: ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
  },
  {
    dimension: 'eventName',
    metrics: ['eventCount', 'totalUsers'],
  },
] as const;
const nowIso = () => new Date().toISOString();
const toIsoDate = (value: Date) => value.toISOString().slice(0, 10);
const addDays = (value: Date, days: number) => {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};
const toNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const isIsoDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const groupRowsByDate = (rows: any[]) => {
  const grouped = new Map<string, any[]>();
  for (const row of rows) {
    const date = row.keys?.[0];
    if (!isIsoDate(date)) continue;
    const existing = grouped.get(date) || [];
    existing.push(row);
    grouped.set(date, existing);
  }
  return grouped;
};

export function recentStableWarehouseDates(days = INITIAL_BACKFILL_DAYS) {
  const end = addDays(new Date(), -2);
  const dates: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    dates.push(toIsoDate(addDays(end, -offset)));
  }
  return dates;
}

function normalizeGa4Date(value: unknown) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function classifyLlmSource(source: unknown) {
  const value = String(source || '').toLowerCase();
  if (value.includes('chatgpt') || value.includes('openai')) return 'ChatGPT';
  if (value.includes('claude') || value.includes('anthropic')) return 'Claude';
  if (value.includes('perplexity')) return 'Perplexity';
  if (value.includes('copilot') || value.includes('bing.com/chat')) return 'Copilot';
  return String(source || 'Other');
}

async function fetchGscRowsForRange(db: AppDatabase, ownerId: string, siteUrl: string, startDate: string, endDate: string, dimensions: string[]) {
  const rows = [];
  let startRow = 0;

  for (let page = 0; page < GSC_MAX_PAGES_PER_DATASET; page += 1) {
    const data = await googleApiFetchJson(
      db,
      ownerId,
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        body: JSON.stringify({
          dataState: 'all',
          dimensions,
          endDate,
          rowLimit: GSC_ROW_LIMIT,
          startDate,
          startRow,
        }),
      },
    );
    const batch = Array.isArray(data?.rows) ? data.rows : [];
    rows.push(...batch);
    if (batch.length < GSC_ROW_LIMIT) {
      break;
    }
    startRow += GSC_ROW_LIMIT;
  }

  return rows;
}

async function fetchGscRows(db: AppDatabase, ownerId: string, siteUrl: string, date: string, dimensions: string[]) {
  return fetchGscRowsForRange(db, ownerId, siteUrl, date, date, dimensions);
}

async function syncGscRange(db: AppDatabase, job: WarehouseJob, startDate: string, endDate: string) {
  const insertSiteSql = 'INSERT INTO gsc_site_metrics (ownerId, siteUrl, date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const insertQuerySql = 'INSERT INTO gsc_query_metrics (ownerId, siteUrl, date, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  const insertPageQuerySql = 'INSERT INTO gsc_page_query_metrics (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const insertPageSql = 'INSERT INTO gsc_page_metrics (ownerId, siteUrl, date, page, pageKey, clicks, impressions, ctr, position, queryCount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const insertCountrySql = 'INSERT INTO gsc_country_metrics (ownerId, siteUrl, date, country, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  const insertSite = prepareWarehouseStatement(db, insertSiteSql);
  const insertQuery = prepareWarehouseStatement(db, insertQuerySql);
  const insertPageQuery = prepareWarehouseStatement(db, insertPageQuerySql);
  const insertPage = prepareWarehouseStatement(db, insertPageSql);
  const insertCountry = prepareWarehouseStatement(db, insertCountrySql);
  const apiStartedAt = Date.now();
  const [siteRows, queryRows, pageQueryRows, countryRows] = await Promise.all([
    fetchGscRowsForRange(db, job.ownerId, job.siteUrl, startDate, endDate, ['date']),
    fetchGscRowsForRange(db, job.ownerId, job.siteUrl, startDate, endDate, ['date', 'query']),
    fetchGscRowsForRange(db, job.ownerId, job.siteUrl, startDate, endDate, ['date', 'page', 'query']),
    fetchGscRowsForRange(db, job.ownerId, job.siteUrl, startDate, endDate, ['date', 'country']),
  ]);
  const apiMs = elapsedMs(apiStartedAt);
  const siteRowsByDate = groupRowsByDate(siteRows);
  const queryRowsByDate = groupRowsByDate(queryRows);
  const pageQueryRowsByDate = groupRowsByDate(pageQueryRows);
  const countryRowsByDate = groupRowsByDate(countryRows);

  const writeStartedAt = Date.now();
  let pageSummaryRowsSynced = 0;
  for (const date of eachIsoDate(startDate, endDate)) {
    const dateSiteRows = siteRowsByDate.get(date) || [];
    const dateQueryRows = queryRowsByDate.get(date) || [];
    const datePageQueryRows = pageQueryRowsByDate.get(date) || [];
    const dateCountryRows = countryRowsByDate.get(date) || [];

    await db.transaction(async () => {
      await db.run('DELETE FROM gsc_site_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [job.ownerId, job.siteUrl, date]);
      await db.run('DELETE FROM gsc_query_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [job.ownerId, job.siteUrl, date]);
      await db.run('DELETE FROM gsc_page_query_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [job.ownerId, job.siteUrl, date]);
      await db.run('DELETE FROM gsc_page_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [job.ownerId, job.siteUrl, date]);
      await db.run('DELETE FROM gsc_country_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [job.ownerId, job.siteUrl, date]);

      for (const row of dateSiteRows) {
        await runWarehouseStatement(db, insertSite, insertSiteSql, [job.ownerId, job.siteUrl, date, toNumber(row.clicks), toNumber(row.impressions), toNumber(row.ctr), toNumber(row.position)]);
      }
      for (const row of dateQueryRows) {
        await runWarehouseStatement(db, insertQuery, insertQuerySql, [job.ownerId, job.siteUrl, date, row.keys?.[1] || '', toNumber(row.clicks), toNumber(row.impressions), toNumber(row.ctr), toNumber(row.position)]);
      }
      for (const row of datePageQueryRows) {
        const page = row.keys?.[1] || '';
        await runWarehouseStatement(
          db,
          insertPageQuery,
          insertPageQuerySql,
          [job.ownerId, job.siteUrl, date, page, canonicalPageKey(page, job.siteUrl), row.keys?.[2] || '', toNumber(row.clicks), toNumber(row.impressions), toNumber(row.ctr), toNumber(row.position)],
        );
      }
      const pageSummaries = new Map<string, { clicks: number; impressions: number; page: string; pageKey: string; queries: Set<string>; weightedPosition: number }>();
      for (const row of datePageQueryRows) {
        const page = row.keys?.[1] || '';
        const pageKey = canonicalPageKey(page, job.siteUrl);
        if (!pageKey) continue;
        const summary = pageSummaries.get(pageKey) || {
          clicks: 0,
          impressions: 0,
          page,
          pageKey,
          queries: new Set<string>(),
          weightedPosition: 0,
        };
        const clicks = toNumber(row.clicks);
        const impressions = toNumber(row.impressions);
        summary.clicks += clicks;
        summary.impressions += impressions;
        summary.weightedPosition += toNumber(row.position) * impressions;
        if (row.keys?.[2]) summary.queries.add(row.keys[2]);
        if (!summary.page) summary.page = page;
        pageSummaries.set(pageKey, summary);
      }
      for (const summary of pageSummaries.values()) {
        pageSummaryRowsSynced += 1;
        await runWarehouseStatement(
          db,
          insertPage,
          insertPageSql,
          [
            job.ownerId,
            job.siteUrl,
            date,
            summary.page,
            summary.pageKey,
            summary.clicks,
            summary.impressions,
            summary.impressions > 0 ? summary.clicks / summary.impressions : 0,
            summary.impressions > 0 ? summary.weightedPosition / summary.impressions : 0,
            summary.queries.size,
          ],
        );
      }
      if (dateCountryRows.length === 0) {
        await runWarehouseStatement(
          db,
          insertCountry,
          insertCountrySql,
          [job.ownerId, job.siteUrl, date, '', 0, 0, 0, 0],
        );
      } else {
        for (const row of dateCountryRows) {
          await runWarehouseStatement(
            db,
            insertCountry,
            insertCountrySql,
            [job.ownerId, job.siteUrl, date, row.keys?.[1] || '', toNumber(row.clicks), toNumber(row.impressions), toNumber(row.ctr), toNumber(row.position)],
          );
        }
      }
    })();
  }
  const writeMs = elapsedMs(writeStartedAt);
  await refreshGscMonthlySummariesForRange(db, {
    endDate,
    ownerId: job.ownerId,
    siteUrl: job.siteUrl,
    startDate,
  });

  const rows = {
    gscCountry: countryRows.length,
    gscPage: pageSummaryRowsSynced,
    gscPageQuery: pageQueryRows.length,
    gscQuery: queryRows.length,
    gscSite: siteRows.length,
  };
  return {
    apiMs,
    metrics: { days: eachIsoDate(startDate, endDate).length, source: 'gsc' },
    rows,
    rowsSynced: Object.values(rows).reduce((sum, value) => sum + value, 0),
    writeMs,
  };
}

async function syncGscDate(db: AppDatabase, job: WarehouseJob) {
  return syncGscRange(db, job, job.targetDate, job.targetDate);
}

async function syncGa4PageRange(db: AppDatabase, job: WarehouseJob, startDate: string, endDate: string) {
  if (!job.propertyId) return emptySyncResult({ source: 'ga4-pages' });
  const insertPageSql = `INSERT INTO ga4_page_metrics (ownerId, propertyId, siteUrl, date, pagePath, pageKey, sessions, totalUsers, pageViews, bounceRate, eventCount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ownerId, propertyId, date, pageKey) DO UPDATE SET
           siteUrl=excluded.siteUrl,
           pagePath=excluded.pagePath,
           bounceRate=CASE
             WHEN ga4_page_metrics.sessions + excluded.sessions > 0
             THEN ((ga4_page_metrics.bounceRate * ga4_page_metrics.sessions) + (excluded.bounceRate * excluded.sessions)) * 1.0 / (ga4_page_metrics.sessions + excluded.sessions)
             ELSE excluded.bounceRate
           END,
           sessions=ga4_page_metrics.sessions + excluded.sessions,
           totalUsers=ga4_page_metrics.totalUsers + excluded.totalUsers,
           pageViews=ga4_page_metrics.pageViews + excluded.pageViews,
           eventCount=ga4_page_metrics.eventCount + excluded.eventCount`;
  const insertPage = prepareWarehouseStatement(db, insertPageSql);
  const rows = [];
  let offset = 0;

  const apiStartedAt = Date.now();
  for (let page = 0; page < GA4_MAX_PAGES_PER_DATASET; page += 1) {
    const data = await googleApiFetchJson(
      db,
      job.ownerId,
      `https://analyticsdata.googleapis.com/v1beta/${job.propertyId}:runReport`,
      {
        method: 'POST',
        body: JSON.stringify({
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }],
          limit: GA4_ROW_LIMIT,
          metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }, { name: 'bounceRate' }, { name: 'eventCount' }],
          offset,
        }),
      },
    );
    const batch = Array.isArray(data?.rows) ? data.rows : [];
    rows.push(...batch);
    if (batch.length < GA4_ROW_LIMIT) {
      break;
    }
    offset += GA4_ROW_LIMIT;
  }
  const apiMs = elapsedMs(apiStartedAt);

  const writeStartedAt = Date.now();
  await db.transaction(async () => {
    await db.run('DELETE FROM ga4_page_metrics WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?', [job.ownerId, job.propertyId, startDate, endDate]);
    for (const row of rows) {
      const date = normalizeGa4Date(row.dimensionValues?.[0]?.value) || startDate;
      const pagePath = row.dimensionValues?.[1]?.value || '/';
      await runWarehouseStatement(
        db,
        insertPage,
        insertPageSql,
        [job.ownerId, job.propertyId, job.siteUrl, date, pagePath, canonicalPageKey(pagePath, job.siteUrl), toNumber(row.metricValues?.[0]?.value), toNumber(row.metricValues?.[1]?.value), toNumber(row.metricValues?.[2]?.value), toNumber(row.metricValues?.[3]?.value), toNumber(row.metricValues?.[4]?.value)],
      );
    }
  })();
  const writeMs = elapsedMs(writeStartedAt);
  return {
    apiMs,
    metrics: { days: eachIsoDate(startDate, endDate).length, source: 'ga4-pages' },
    rows: { ga4Pages: rows.length },
    rowsSynced: rows.length,
    writeMs,
  };
}

async function syncGa4Date(db: AppDatabase, job: WarehouseJob) {
  return syncGa4PageRange(db, job, job.targetDate, job.targetDate);
}

async function syncGa4LlmDate(db: AppDatabase, job: WarehouseJob) {
  return syncGa4LlmRange(db, job, job.targetDate, job.targetDate);
}

async function syncGa4DimensionRange(db: AppDatabase, job: WarehouseJob, startDate: string, endDate: string) {
  if (!job.propertyId) return emptySyncResult({ source: 'ga4-dimensions' });
  const insertDimensionSql = `INSERT INTO ga4_dimension_metrics (ownerId, propertyId, siteUrl, date, dimension, dimensionValue, sessions, totalUsers, pageViews, bounceRate, eventCount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ownerId, propertyId, date, dimension, dimensionValue) DO UPDATE SET
             siteUrl=excluded.siteUrl,
             sessions=excluded.sessions,
             totalUsers=excluded.totalUsers,
             pageViews=excluded.pageViews,
             bounceRate=excluded.bounceRate,
             eventCount=excluded.eventCount`;
  const insertDimension = prepareWarehouseStatement(db, insertDimensionSql);
  let apiMs = 0;
  let rowsSynced = 0;
  const rowsByDimension: Record<string, number> = {};
  const phaseMetrics: Record<string, { apiMs: number; rows: number; writeMs: number }> = {};
  let writeMs = 0;

  for (const config of GA4_DIMENSION_SYNC_CONFIGS) {
    const rows = [];
    let offset = 0;

    const apiStartedAt = Date.now();
    for (let page = 0; page < GA4_MAX_PAGES_PER_DATASET; page += 1) {
      const data = await googleApiFetchJson(
        db,
        job.ownerId,
        `https://analyticsdata.googleapis.com/v1beta/${job.propertyId}:runReport`,
        {
          method: 'POST',
          body: JSON.stringify({
            dateRanges: [{ startDate, endDate }],
            dimensions: [{ name: 'date' }, { name: config.dimension }],
            limit: GA4_ROW_LIMIT,
            metrics: config.metrics.map((name) => ({ name })),
            offset,
          }),
        },
      );
      const batch = Array.isArray(data?.rows) ? data.rows : [];
      rows.push(...batch);
      if (batch.length < GA4_ROW_LIMIT) {
        break;
      }
      offset += GA4_ROW_LIMIT;
    }
    const dimensionApiMs = elapsedMs(apiStartedAt);
    apiMs += dimensionApiMs;

    const writeStartedAt = Date.now();
    await db.transaction(async () => {
      await db.run(
        'DELETE FROM ga4_dimension_metrics WHERE ownerId = ? AND propertyId = ? AND dimension = ? AND date >= ? AND date <= ?',
        [job.ownerId, job.propertyId, config.dimension, startDate, endDate],
      );

      for (const row of rows) {
        const date = normalizeGa4Date(row.dimensionValues?.[0]?.value) || startDate;
        const dimensionValue = String(row.dimensionValues?.[1]?.value || '(not set)');
        const metricValue = (metric: string) => {
          const index = (config.metrics as readonly string[]).indexOf(metric);
          return index === -1 ? 0 : toNumber(row.metricValues?.[index]?.value);
        };

        await runWarehouseStatement(
          db,
          insertDimension,
          insertDimensionSql,
          [
            job.ownerId,
            job.propertyId,
            job.siteUrl,
            date,
            config.dimension,
            dimensionValue,
            metricValue('sessions'),
            metricValue('totalUsers'),
            metricValue('screenPageViews'),
            metricValue('bounceRate'),
            metricValue('eventCount'),
          ],
        );
      }
    })();
    const dimensionWriteMs = elapsedMs(writeStartedAt);
    writeMs += dimensionWriteMs;

    rowsSynced += rows.length;
    rowsByDimension[`ga4.${config.dimension}`] = rows.length;
    phaseMetrics[config.dimension] = {
      apiMs: dimensionApiMs,
      rows: rows.length,
      writeMs: dimensionWriteMs,
    };
  }

  return {
    apiMs,
    metrics: { days: eachIsoDate(startDate, endDate).length, phases: phaseMetrics, source: 'ga4-dimensions' },
    rows: rowsByDimension,
    rowsSynced,
    writeMs,
  };
}

async function syncGa4LlmRange(db: AppDatabase, job: WarehouseJob, startDate: string, endDate: string) {
  if (!job.propertyId) return emptySyncResult({ source: 'ga4-llm' });
  const insertLlmSql = `INSERT INTO ga4_llm_referral_metrics (ownerId, propertyId, siteUrl, date, source, sourceClass, pagePath, pageKey, sessions, engagedSessions, keyEvents, averageSessionDuration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ownerId, propertyId, date, source, pageKey) DO UPDATE SET
           siteUrl=excluded.siteUrl,
           sourceClass=excluded.sourceClass,
           pagePath=excluded.pagePath,
           sessions=excluded.sessions,
           engagedSessions=excluded.engagedSessions,
           keyEvents=excluded.keyEvents,
           averageSessionDuration=excluded.averageSessionDuration`;
  const insertLlm = prepareWarehouseStatement(db, insertLlmSql);
  const rows = [];
  let offset = 0;

  const apiStartedAt = Date.now();
  for (let page = 0; page < GA4_MAX_PAGES_PER_DATASET; page += 1) {
    const data = await googleApiFetchJson(
      db,
      job.ownerId,
      `https://analyticsdata.googleapis.com/v1beta/${job.propertyId}:runReport`,
      {
        method: 'POST',
        body: JSON.stringify({
          dateRanges: [{ startDate, endDate }],
          dimensionFilter: {
            filter: {
              fieldName: 'sessionSource',
              stringFilter: {
                matchType: 'PARTIAL_REGEXP',
                value: LLM_SOURCE_REGEXP,
              },
            },
          },
          dimensions: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }, { name: 'sessionSource' }],
          limit: GA4_ROW_LIMIT,
          metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }, { name: 'averageSessionDuration' }],
          offset,
        }),
      },
    );
    const batch = Array.isArray(data?.rows) ? data.rows : [];
    rows.push(...batch);
    if (batch.length < GA4_ROW_LIMIT) {
      break;
    }
    offset += GA4_ROW_LIMIT;
  }
  const apiMs = elapsedMs(apiStartedAt);

  const writeStartedAt = Date.now();
  await db.transaction(async () => {
    await db.run('DELETE FROM ga4_llm_referral_metrics WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?', [job.ownerId, job.propertyId, startDate, endDate]);
    for (const row of rows) {
      const date = normalizeGa4Date(row.dimensionValues?.[0]?.value) || startDate;
      const pagePath = row.dimensionValues?.[1]?.value || '/';
      const source = row.dimensionValues?.[2]?.value || '(not set)';
      await runWarehouseStatement(
        db,
        insertLlm,
        insertLlmSql,
        [
          job.ownerId,
          job.propertyId,
          job.siteUrl,
          date,
          source,
          classifyLlmSource(source),
          pagePath,
          canonicalPageKey(pagePath, job.siteUrl),
          toNumber(row.metricValues?.[0]?.value),
          toNumber(row.metricValues?.[1]?.value),
          toNumber(row.metricValues?.[2]?.value),
          toNumber(row.metricValues?.[3]?.value),
        ],
      );
    }
  })();
  const writeMs = elapsedMs(writeStartedAt);
  return {
    apiMs,
    metrics: { days: eachIsoDate(startDate, endDate).length, source: 'ga4-llm' },
    rows: { ga4LlmReferrals: rows.length },
    rowsSynced: rows.length,
    writeMs,
  };
}

async function updateJob(db: AppDatabase, id: string, fields: Partial<WarehouseJob>) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  await db.run(`UPDATE warehouse_jobs SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updatedAt = ? WHERE id = ?`, [...entries.map(([, value]) => value), nowIso(), id]);
}

async function resolveActiveGa4PropertyForSite(db: AppDatabase, job: WarehouseJob) {
  if (!job.propertyId) return null;
  const [siteAllowed, propertyAllowed] = await Promise.all([
    canAccessSite(db, job.ownerId, job.siteUrl),
    canAccessGa4Property(db, job.ownerId, job.propertyId),
  ]);
  return siteAllowed && propertyAllowed ? job.propertyId : null;
}

async function hasRequiredCoreWarehouseRows(
  db: AppDatabase,
  job: Pick<WarehouseJob, 'ownerId' | 'propertyId' | 'siteUrl'>,
  startDate: string,
  endDate: string,
  effectivePropertyId?: string | null,
) {
  const expectedDays = eachIsoDate(startDate, endDate).length;
  if (expectedDays === 0) return false;
  const propertyId = effectivePropertyId || job.propertyId || '';

  const [siteRows, queryRows, pageQueryRows, ga4Rows] = await Promise.all([
    db.get<{ count: number }>(`
      SELECT COUNT(DISTINCT date) AS count
      FROM gsc_site_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
    `, [job.ownerId, job.siteUrl, startDate, endDate]),
    db.get<{ count: number }>(`
      SELECT COUNT(DISTINCT date) AS count
      FROM gsc_query_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
    `, [job.ownerId, job.siteUrl, startDate, endDate]),
    db.get<{ count: number }>(`
      SELECT COUNT(DISTINCT date) AS count
      FROM gsc_page_query_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
    `, [job.ownerId, job.siteUrl, startDate, endDate]),
    propertyId
      ? db.get<{ count: number }>(`
        SELECT COUNT(DISTINCT date) AS count
        FROM ga4_page_metrics
        WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
      `, [job.ownerId, propertyId, startDate, endDate])
      : Promise.resolve({ count: expectedDays }),
  ]);

  return Number(siteRows?.count || 0) >= expectedDays
    && Number(queryRows?.count || 0) >= expectedDays
    && Number(pageQueryRows?.count || 0) >= expectedDays
    && Number(ga4Rows?.count || 0) >= expectedDays;
}

async function executeWarehouseJob(db: AppDatabase, job: WarehouseJob) {
  const totalStartedAt = Date.now();
  let syncResult = emptySyncResult();
  const jobStartDate = job.targetStartDate || job.targetDate;
  const jobEndDate = job.targetDate;
  let syncedStartDate = jobStartDate;
  const propertyId = await resolveActiveGa4PropertyForSite(db, job);
  const scopedJob = propertyId === job.propertyId ? job : { ...job, propertyId };
  if (job.jobType === 'ga4-llm-range-sync') {
    syncResult = propertyId ? await syncGa4LlmRange(db, scopedJob, jobStartDate, jobEndDate) : emptySyncResult({ skippedReason: 'missing-ga4-property' });
  } else if (job.jobType === 'ga4-dimension-range-sync') {
    syncResult = propertyId ? await syncGa4DimensionRange(db, scopedJob, jobStartDate, jobEndDate) : emptySyncResult({ skippedReason: 'missing-ga4-property' });
  } else if (job.jobType === 'ga4-llm-sync') {
    syncResult = propertyId ? await syncGa4LlmDate(db, scopedJob) : emptySyncResult({ skippedReason: 'missing-ga4-property' });
  } else if (job.jobType === 'core-range-sync') {
    const importStartDate = maxIsoDate(jobStartDate, earliestSearchConsoleReportingDate());
    if (importStartDate > jobEndDate) {
      await updateJob(db, job.id, {
        completedAt: nowIso(),
        lastError: null,
        lockedAt: null,
        metricsJson: JSON.stringify({
          days: 0,
          skippedReason: 'outside-search-console-history-window',
          source: 'core',
          totalMs: elapsedMs(totalStartedAt),
        }),
        rowsSynced: 0,
        status: 'superseded',
      });
      return;
    }
    syncedStartDate = importStartDate;
    const alreadyStored = await hasRequiredCoreWarehouseRows(db, job, importStartDate, jobEndDate, propertyId);
    if (alreadyStored) {
      await updateJob(db, job.id, {
        completedAt: nowIso(),
        lastError: null,
        lockedAt: null,
        metricsJson: JSON.stringify({
          days: eachIsoDate(importStartDate, jobEndDate).length,
          skippedReason: 'already-warehoused',
          source: 'core',
          totalMs: elapsedMs(totalStartedAt),
        }),
        rowsSynced: 0,
        status: 'superseded',
      });
      return;
    }
    const gscResult = await syncGscRange(db, job, importStartDate, jobEndDate);
    const ga4Result = propertyId ? await syncGa4PageRange(db, scopedJob, importStartDate, jobEndDate) : emptySyncResult({ skippedReason: 'missing-ga4-property' });
    syncResult = combineSyncResults([gscResult, ga4Result], {
      phases: {
        ga4Pages: {
          apiMs: ga4Result.apiMs,
          rows: ga4Result.rowsSynced,
          writeMs: ga4Result.writeMs,
        },
        gsc: {
          apiMs: gscResult.apiMs,
          rows: gscResult.rowsSynced,
          writeMs: gscResult.writeMs,
        },
      },
      source: 'core',
    });
  } else if (job.jobType === 'daily-sync' && jobEndDate < earliestSearchConsoleReportingDate()) {
    await updateJob(db, job.id, {
      completedAt: nowIso(),
      lastError: null,
      lockedAt: null,
      metricsJson: JSON.stringify({
        days: 0,
        skippedReason: 'outside-search-console-history-window',
        source: 'daily',
        totalMs: elapsedMs(totalStartedAt),
      }),
      rowsSynced: 0,
      status: 'superseded',
    });
    return;
  } else {
    const gscResult = await syncGscDate(db, job);
    const ga4Result = propertyId ? await syncGa4Date(db, scopedJob) : emptySyncResult({ skippedReason: 'missing-ga4-property' });
    syncResult = combineSyncResults([gscResult, ga4Result], {
      phases: {
        ga4Pages: {
          apiMs: ga4Result.apiMs,
          rows: ga4Result.rowsSynced,
          writeMs: ga4Result.writeMs,
        },
        gsc: {
          apiMs: gscResult.apiMs,
          rows: gscResult.rowsSynced,
          writeMs: gscResult.writeMs,
        },
      },
      source: 'daily',
    });
  }
  const completedAt = nowIso();
  const metricsJson = JSON.stringify({
    ...(syncResult.metrics || {}),
    apiMs: syncResult.apiMs,
    completedAt,
    days: eachIsoDate(syncedStartDate, jobEndDate).length,
    jobType: job.jobType,
    propertyIncluded: Boolean(propertyId),
    rows: syncResult.rows,
    rowsSynced: syncResult.rowsSynced,
    totalMs: elapsedMs(totalStartedAt),
    writeMs: syncResult.writeMs,
  });
  await db.run(
    `INSERT INTO warehouse_sync_status (ownerId, siteUrl, lastSyncDate, earliestSyncDate, status, lastUpdated)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ownerId, siteUrl) DO UPDATE SET
       lastSyncDate=CASE WHEN warehouse_sync_status.lastSyncDate IS NULL OR excluded.lastSyncDate > warehouse_sync_status.lastSyncDate THEN excluded.lastSyncDate ELSE warehouse_sync_status.lastSyncDate END,
       earliestSyncDate=CASE WHEN warehouse_sync_status.earliestSyncDate IS NULL OR excluded.earliestSyncDate < warehouse_sync_status.earliestSyncDate THEN excluded.earliestSyncDate ELSE warehouse_sync_status.earliestSyncDate END,
       status=excluded.status,
       lastUpdated=excluded.lastUpdated`,
    [job.ownerId, job.siteUrl, jobEndDate, syncedStartDate, 'synced', nowIso()],
  );
  await updateJob(db, job.id, { completedAt, lastError: null, lockedAt: null, metricsJson, rowsSynced: syncResult.rowsSynced, status: 'completed' });
}

async function claimJob(db: AppDatabase) {
  const now = nowIso();
  const job = await db.get<WarehouseJob>("SELECT * FROM warehouse_jobs WHERE status IN ('queued', 'retrying') AND (nextRunAt IS NULL OR nextRunAt <= ?) ORDER BY targetDate DESC, nextRunAt ASC, updatedAt ASC LIMIT 1", [now]);
  if (!job) return null;
  const result = await db.run("UPDATE warehouse_jobs SET status = 'running', attemptCount = COALESCE(attemptCount, 0) + 1, startedAt = COALESCE(startedAt, ?), updatedAt = ?, lockedAt = ?, lastError = NULL, metricsJson = NULL WHERE id = ? AND status IN ('queued', 'retrying')", [now, now, now, job.id]);
  if (result.changes === 0) return null;
  return db.get<WarehouseJob>('SELECT * FROM warehouse_jobs WHERE id = ?', [job.id]);
}

async function recoverJobs(db: AppDatabase) {
  const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
  await db.run("UPDATE warehouse_jobs SET status = 'queued', lockedAt = NULL, nextRunAt = ?, updatedAt = ?, lastError = COALESCE(lastError, 'Recovered after interrupted warehouse worker.') WHERE status = 'running' AND (lockedAt IS NULL OR lockedAt < ?)", [nowIso(), nowIso(), cutoff]);
}

async function failOrRetry(db: AppDatabase, job: WarehouseJob, error: unknown) {
  const attemptCount = Number(job.attemptCount || 0);
  const maxAttempts = Number(job.maxAttempts || DEFAULT_MAX_ATTEMPTS);
  const shouldRetry = attemptCount < maxAttempts;
  const delayMs = Math.min(30 * 60 * 1000, 60 * 1000 * Math.max(1, attemptCount));
  await updateJob(db, job.id, {
    completedAt: shouldRetry ? null : nowIso(),
    lastError: error instanceof Error ? error.message : 'Warehouse sync failed',
    lockedAt: null,
    nextRunAt: shouldRetry ? new Date(Date.now() + delayMs).toISOString() : null,
    status: shouldRetry ? 'retrying' : 'error',
  });
}

export async function queueWarehouseSyncJob(db: AppDatabase, input: { dedupeCompleted?: boolean; jobType?: string; ownerId: string; propertyId?: string | null; siteUrl: string; targetDate: string; targetStartDate?: string | null }) {
  const jobType = input.jobType || 'daily-sync';
  const propertyId = input.propertyId || null;
  const targetStartDate = input.targetStartDate || input.targetDate;
  const dedupeStatuses = input.dedupeCompleted === false
    ? ['queued', 'retrying', 'running']
    : ['queued', 'retrying', 'running', 'completed'];
  const statusPlaceholders = dedupeStatuses.map(() => '?').join(', ');
  const existing = propertyId
    ? await db.get<WarehouseJob>(`SELECT * FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? AND targetDate = ? AND COALESCE(targetStartDate, targetDate) = ? AND COALESCE(propertyId, '') = ? AND jobType = ? AND status IN (${statusPlaceholders}) LIMIT 1`, [input.ownerId, input.siteUrl, input.targetDate, targetStartDate, propertyId, jobType, ...dedupeStatuses])
    : await db.get<WarehouseJob>(`SELECT * FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? AND targetDate = ? AND COALESCE(targetStartDate, targetDate) = ? AND jobType = ? AND status IN (${statusPlaceholders}) LIMIT 1`, [input.ownerId, input.siteUrl, input.targetDate, targetStartDate, jobType, ...dedupeStatuses]);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const queuedAt = nowIso();
  await db.run('INSERT INTO warehouse_jobs (id, ownerId, siteUrl, propertyId, jobType, status, targetStartDate, targetDate, attemptCount, maxAttempts, lockedAt, nextRunAt, startedAt, updatedAt, completedAt, lastError, rowsSynced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, input.ownerId, input.siteUrl, propertyId, jobType, 'queued', targetStartDate, input.targetDate, 0, DEFAULT_MAX_ATTEMPTS, null, queuedAt, null, queuedAt, null, null, 0]);
  return db.get<WarehouseJob>('SELECT * FROM warehouse_jobs WHERE id = ?', [id]);
}

function chunkDescendingDates(dates: string[], maxDays: number) {
  const chunks: Array<{ endDate: string; startDate: string }> = [];
  for (let index = 0; index < dates.length; index += maxDays) {
    const chunk = dates.slice(index, index + maxDays);
    const sorted = [...chunk].sort();
    const startDate = sorted[0];
    const endDate = sorted[sorted.length - 1];
    if (startDate && endDate) chunks.push({ endDate, startDate });
  }
  return chunks;
}

const eachIsoDate = (startDate: string, endDate: string) => {
  const dates: string[] = [];
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return dates;

  for (let current = start; current <= end; current = new Date(current.getTime() + 24 * 60 * 60 * 1000)) {
    dates.push(current.toISOString().slice(0, 10));
  }

  return dates;
};

const minIsoDate = (a: string, b: string) => (a <= b ? a : b);
const maxIsoDate = (a: string, b: string) => (a >= b ? a : b);
const earliestSearchConsoleReportingDate = () => toIsoDate(addDays(addDays(new Date(), -2), -(SEARCH_CONSOLE_HISTORY_DAYS - 1)));

const jobDatesWithin = (
  job: { targetDate?: string | null; targetStartDate?: string | null },
  startDate: string,
  endDate: string,
) => {
  const jobEndDate = isIsoDate(job.targetDate) ? job.targetDate : null;
  if (!jobEndDate) return [];
  const jobStartDate = isIsoDate(job.targetStartDate) ? job.targetStartDate : jobEndDate;
  const effectiveStart = maxIsoDate(jobStartDate, startDate);
  const effectiveEnd = minIsoDate(jobEndDate, endDate);
  return effectiveStart <= effectiveEnd ? eachIsoDate(effectiveStart, effectiveEnd) : [];
};

async function missingCoreWarehouseDates(db: AppDatabase, input: { days?: number; ownerId: string; propertyId?: string | null; siteUrl: string }) {
  const dates = recentStableWarehouseDates(input.days);
  const sortedDates = [...dates].sort();
  const startDate = sortedDates[0];
  const endDate = sortedDates[sortedDates.length - 1];
  if (!startDate || !endDate) return [];

  const propertyId = input.propertyId || '';
  const [gscSiteRows, gscQueryRows, gscPageQueryRows, ga4PageRows, jobRows] = await Promise.all([
    db.all<{ date: string }>(`
      SELECT date
      FROM gsc_site_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
      GROUP BY date
    `, [input.ownerId, input.siteUrl, startDate, endDate]),
    db.all<{ date: string }>(`
      SELECT date
      FROM gsc_query_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
      GROUP BY date
    `, [input.ownerId, input.siteUrl, startDate, endDate]),
    db.all<{ date: string }>(`
      SELECT date
      FROM gsc_page_query_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
      GROUP BY date
    `, [input.ownerId, input.siteUrl, startDate, endDate]),
    propertyId
      ? db.all<{ date: string }>(`
        SELECT date
        FROM ga4_page_metrics
        WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
        GROUP BY date
      `, [input.ownerId, propertyId, startDate, endDate])
      : Promise.resolve([]),
    db.all<{ propertyId: string | null; status: string; targetDate: string; targetStartDate: string | null }>(`
      SELECT propertyId, status, targetStartDate, targetDate
      FROM warehouse_jobs
      WHERE ownerId = ? AND siteUrl = ?
        AND jobType IN ('daily-sync', 'core-range-sync')
        AND status IN ('queued', 'retrying', 'running', 'completed')
        AND targetDate >= ? AND COALESCE(targetStartDate, targetDate) <= ?
    `, [input.ownerId, input.siteUrl, startDate, endDate]),
  ]);

  const gscSiteDates = new Set(gscSiteRows.map((row) => row.date));
  const gscQueryDates = new Set(gscQueryRows.map((row) => row.date));
  const gscPageQueryDates = new Set(gscPageQueryRows.map((row) => row.date));
  const ga4PageDates = new Set(ga4PageRows.map((row) => row.date));
  const anyCoreJobDates = new Set<string>();
  const matchingPropertyJobDates = new Set<string>();

  for (const row of jobRows) {
    for (const date of jobDatesWithin(row, startDate, endDate)) {
      anyCoreJobDates.add(date);
      if (propertyId && row.propertyId === propertyId) {
        matchingPropertyJobDates.add(date);
      }
    }
  }

  return dates.filter((date) => {
    const needsExistingGsc = !gscSiteDates.has(date) || !gscQueryDates.has(date) || !gscPageQueryDates.has(date);
    const needsGa4 = Boolean(propertyId && !ga4PageDates.has(date));
    return (needsExistingGsc && !anyCoreJobDates.has(date))
      || (needsGa4 && !matchingPropertyJobDates.has(date));
  });
}

async function supersedeLegacyLlmDailyJobs(db: AppDatabase) {
  const legacyRows = await db.all<{ ownerId: string; propertyId: string | null; siteUrl: string; targetDate: string }>(`
    SELECT DISTINCT ownerId, siteUrl, propertyId, targetDate
    FROM warehouse_jobs
    WHERE jobType = 'ga4-llm-sync'
      AND status IN ('queued', 'retrying')
      AND targetDate IS NOT NULL
    ORDER BY ownerId, siteUrl, propertyId, targetDate DESC
    LIMIT 5000
  `);
  if (legacyRows.length === 0) return;

  const datesByScope = new Map<string, { ownerId: string; propertyId: string; siteUrl: string; targetDates: string[] }>();
  for (const row of legacyRows) {
    if (!row.ownerId || !row.siteUrl || !row.propertyId || !row.targetDate) continue;
    const key = JSON.stringify([row.ownerId, row.siteUrl, row.propertyId]);
    const existing = datesByScope.get(key) || {
      ownerId: row.ownerId,
      propertyId: row.propertyId,
      siteUrl: row.siteUrl,
      targetDates: [],
    };
    existing.targetDates.push(row.targetDate);
    datesByScope.set(key, existing);
  }

  const supersededAt = nowIso();
  for (const scope of datesByScope.values()) {
    for (const chunk of chunkDescendingDates(scope.targetDates, LLM_RANGE_JOB_DAYS)) {
      await queueWarehouseLlmRangeJob(db, {
        endDate: chunk.endDate,
        ownerId: scope.ownerId,
        propertyId: scope.propertyId,
        siteUrl: scope.siteUrl,
        startDate: chunk.startDate,
      });
    }
    await db.run(
      `UPDATE warehouse_jobs
       SET status = 'superseded', lockedAt = NULL, completedAt = ?, updatedAt = ?, lastError = NULL
       WHERE ownerId = ? AND siteUrl = ? AND COALESCE(propertyId, '') = ? AND jobType = 'ga4-llm-sync'
         AND status IN ('queued', 'retrying')`,
      [supersededAt, supersededAt, scope.ownerId, scope.siteUrl, scope.propertyId],
    );
  }
}

async function supersedeLegacyCoreDailyJobs(db: AppDatabase) {
  const legacyRows = await db.all<{ activatedGa4PropertyId: string | null; activatedSiteUrl: string | null; ownerId: string; propertyId: string | null; siteUrl: string; targetDate: string }>(`
    SELECT j.ownerId, j.siteUrl, j.propertyId, j.targetDate, u.activatedGa4PropertyId, u.activatedSiteUrl
    FROM warehouse_jobs j
    LEFT JOIN users u ON u.id = j.ownerId
    WHERE j.jobType = 'daily-sync'
      AND j.status IN ('queued', 'retrying')
      AND j.targetDate IS NOT NULL
    ORDER BY j.ownerId, j.siteUrl, j.targetDate DESC
    LIMIT 10000
  `);
  if (legacyRows.length === 0) return;

  const scopes = new Map<string, { ownerId: string; propertyId: string | null; siteUrl: string; targetDates: Set<string> }>();
  for (const row of legacyRows) {
    if (!row.ownerId || !row.siteUrl || !row.targetDate) continue;
    const activeSiteUrl = typeof row.activatedSiteUrl === 'string' ? row.activatedSiteUrl.trim() : '';
    const activePropertyId = typeof row.activatedGa4PropertyId === 'string' ? row.activatedGa4PropertyId.trim() : '';
    const rowPropertyId = typeof row.propertyId === 'string' ? row.propertyId.trim() : '';
    const propertyIdForSite = row.siteUrl === activeSiteUrl
      ? (rowPropertyId === activePropertyId ? rowPropertyId : activePropertyId || null)
      : null;
    const key = JSON.stringify([row.ownerId, row.siteUrl]);
    const existing = scopes.get(key) || {
      ownerId: row.ownerId,
      propertyId: propertyIdForSite,
      siteUrl: row.siteUrl,
      targetDates: new Set<string>(),
    };
    if (!existing.propertyId && propertyIdForSite) {
      existing.propertyId = propertyIdForSite;
    }
    existing.targetDates.add(row.targetDate);
    scopes.set(key, existing);
  }

  const supersededAt = nowIso();
  for (const scope of scopes.values()) {
    for (const chunk of chunkDescendingDates([...scope.targetDates], CORE_RANGE_JOB_DAYS)) {
      await queueWarehouseCoreRangeJob(db, {
        endDate: chunk.endDate,
        ownerId: scope.ownerId,
        propertyId: scope.propertyId,
        siteUrl: scope.siteUrl,
        startDate: chunk.startDate,
      });
    }
    await db.run(
      `UPDATE warehouse_jobs
       SET status = 'superseded', lockedAt = NULL, completedAt = ?, updatedAt = ?, lastError = NULL
       WHERE ownerId = ? AND siteUrl = ? AND jobType = 'daily-sync'
         AND status IN ('queued', 'retrying')`,
      [supersededAt, supersededAt, scope.ownerId, scope.siteUrl],
    );
  }
}

async function supersedeObsoleteCoreRangeJobs(db: AppDatabase) {
  const jobs = await db.all<WarehouseJob>(`
    SELECT *
    FROM warehouse_jobs
    WHERE jobType = 'core-range-sync'
      AND status IN ('queued', 'retrying')
      AND targetDate IS NOT NULL
    ORDER BY updatedAt ASC
    LIMIT 500
  `);
  if (jobs.length === 0) return;

  const supersededAt = nowIso();
  for (const job of jobs) {
    const startDate = job.targetStartDate || job.targetDate;
    const endDate = job.targetDate;
    const importStartDate = maxIsoDate(startDate, earliestSearchConsoleReportingDate());
    if (importStartDate > endDate) {
      await db.run(
        `UPDATE warehouse_jobs
         SET status = 'superseded', lockedAt = NULL, completedAt = ?, updatedAt = ?, lastError = NULL,
             metricsJson = ?
         WHERE id = ? AND status IN ('queued', 'retrying')`,
        [
          supersededAt,
          supersededAt,
          JSON.stringify({ days: 0, skippedReason: 'outside-search-console-history-window', source: 'core' }),
          job.id,
        ],
      );
      continue;
    }

    const expectedDays = eachIsoDate(importStartDate, endDate).length;
    if (expectedDays === 0) continue;

    if (!(await hasRequiredCoreWarehouseRows(db, job, importStartDate, endDate))) continue;

    await db.run(
      `UPDATE warehouse_jobs
       SET status = 'superseded', lockedAt = NULL, completedAt = ?, updatedAt = ?, lastError = NULL
       WHERE id = ? AND status IN ('queued', 'retrying')`,
      [supersededAt, supersededAt, job.id],
    );
  }
}

export async function queueWarehouseBackfillJobs(db: AppDatabase, input: { days?: number; ownerId: string; propertyId?: string | null; siteUrl: string }) {
  const jobs = [];
  const missingDates = await missingCoreWarehouseDates(db, input);
  for (const chunk of chunkDescendingDates(missingDates, CORE_RANGE_JOB_DAYS)) {
    const job = await queueWarehouseCoreRangeJob(db, {
      endDate: chunk.endDate,
      ownerId: input.ownerId,
      propertyId: input.propertyId,
      siteUrl: input.siteUrl,
      startDate: chunk.startDate,
    });
    jobs.push(job);
  }
  return jobs;
}

export async function queueWarehouseLlmBackfillJobs(db: AppDatabase, input: { days?: number; ownerId: string; propertyId: string; siteUrl: string }) {
  const jobs = [];
  for (const chunk of chunkDescendingDates(recentStableWarehouseDates(input.days), LLM_RANGE_JOB_DAYS)) {
    const job = await queueWarehouseSyncJob(db, {
      jobType: 'ga4-llm-range-sync',
      ownerId: input.ownerId,
      propertyId: input.propertyId,
      siteUrl: input.siteUrl,
      targetDate: chunk.endDate,
      targetStartDate: chunk.startDate,
    });
    jobs.push(job);
  }
  return jobs;
}

export async function queueWarehouseGa4DimensionBackfillJobs(db: AppDatabase, input: { days?: number; ownerId: string; propertyId: string; siteUrl: string }) {
  const jobs = [];
  for (const chunk of chunkDescendingDates(recentStableWarehouseDates(input.days), GA4_DIMENSION_RANGE_JOB_DAYS)) {
    const job = await queueWarehouseGa4DimensionRangeJob(db, {
      endDate: chunk.endDate,
      ownerId: input.ownerId,
      propertyId: input.propertyId,
      siteUrl: input.siteUrl,
      startDate: chunk.startDate,
    });
    jobs.push(job);
  }
  return jobs;
}

export async function queueWarehouseBootstrapJobs(db: AppDatabase, input: { days?: number; ownerId: string; propertyId?: string | null; siteUrl: string }) {
  const core = await queueWarehouseBackfillJobs(db, input);
  const ga4Dimensions = input.propertyId
    ? await queueWarehouseGa4DimensionBackfillJobs(db, {
      days: input.days,
      ownerId: input.ownerId,
      propertyId: input.propertyId,
      siteUrl: input.siteUrl,
    })
    : [];
  const llm = input.propertyId
    ? await queueWarehouseLlmBackfillJobs(db, {
      days: input.days,
      ownerId: input.ownerId,
      propertyId: input.propertyId,
      siteUrl: input.siteUrl,
    })
    : [];

  return {
    core,
    ga4Dimensions,
    llm,
    totalQueued: core.length + ga4Dimensions.length + llm.length,
  };
}

export async function queueWarehouseLlmRangeJob(db: AppDatabase, input: { dedupeCompleted?: boolean; ownerId: string; propertyId: string; siteUrl: string; startDate: string; endDate: string }) {
  return queueWarehouseSyncJob(db, {
    dedupeCompleted: input.dedupeCompleted,
    jobType: 'ga4-llm-range-sync',
    ownerId: input.ownerId,
    propertyId: input.propertyId,
    siteUrl: input.siteUrl,
    targetDate: input.endDate,
    targetStartDate: input.startDate,
  });
}

export async function queueWarehouseCoreRangeJob(db: AppDatabase, input: { dedupeCompleted?: boolean; ownerId: string; propertyId?: string | null; siteUrl: string; startDate: string; endDate: string }) {
  return queueWarehouseSyncJob(db, {
    dedupeCompleted: input.dedupeCompleted,
    jobType: 'core-range-sync',
    ownerId: input.ownerId,
    propertyId: input.propertyId,
    siteUrl: input.siteUrl,
    targetDate: input.endDate,
    targetStartDate: input.startDate,
  });
}

export async function queueWarehouseGa4DimensionRangeJob(db: AppDatabase, input: { dedupeCompleted?: boolean; ownerId: string; propertyId: string; siteUrl: string; startDate: string; endDate: string }) {
  return queueWarehouseSyncJob(db, {
    dedupeCompleted: input.dedupeCompleted,
    jobType: 'ga4-dimension-range-sync',
    ownerId: input.ownerId,
    propertyId: input.propertyId,
    siteUrl: input.siteUrl,
    targetDate: input.endDate,
    targetStartDate: input.startDate,
  });
}

export async function listWarehouseJobs(db: AppDatabase, ownerId: string, siteUrl: string, limit = 20) {
  return db.all<WarehouseJob>("SELECT * FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? AND status != 'superseded' ORDER BY updatedAt DESC LIMIT ?", [ownerId, siteUrl, limit]);
}

export function startWarehouseJobWorker(db: AppDatabase) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await recoverJobs(db);
      await supersedeLegacyCoreDailyJobs(db);
      await supersedeLegacyLlmDailyJobs(db);
      await supersedeObsoleteCoreRangeJobs(db);
      for (let i = 0; i < JOBS_PER_TICK; i += 1) {
        const job = await claimJob(db);
        if (!job) break;
        try {
          await executeWarehouseJob(db, job);
        } catch (error) {
          await failOrRetry(db, job, error);
        }
      }
    } catch (error) {
      console.error('[warehouse] Queue worker failed:', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
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

function latestStableReportingDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 2);
  return date.toISOString().slice(0, 10);
}

export function startWarehouseDailyScheduler(db: AppDatabase) {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const targetDate = latestStableReportingDate();
      const users = await db.all<any>(`
        SELECT id, tier, activatedSiteUrl, activatedGa4PropertyId, knownSites, unlockedSites
        FROM users
        WHERE gscRefreshToken IS NOT NULL AND gscRefreshToken != ''
      `);

      for (const user of users) {
        const sites = new Set<string>();
        const activeSiteUrl = typeof user.activatedSiteUrl === 'string' ? user.activatedSiteUrl.trim() : '';
        if (activeSiteUrl) {
          sites.add(activeSiteUrl);
        }
        for (const site of parseStringArray(user.unlockedSites)) {
          sites.add(site.trim());
        }
        for (const site of parseStringArray(user.knownSites)) {
          sites.add(site.trim());
        }

        for (const siteUrl of sites) {
          if (!(await canAccessSite(db, user.id, siteUrl))) {
            continue;
          }
          const propertyId = await resolveWorkspaceGa4Property(db, user.id, siteUrl);
          await queueWarehouseSyncJob(db, {
            ownerId: user.id,
            propertyId,
            siteUrl,
            targetDate,
          });
          if (propertyId) {
            await queueWarehouseGa4DimensionRangeJob(db, {
              endDate: targetDate,
              ownerId: user.id,
              propertyId,
              siteUrl,
              startDate: targetDate,
            });
            await queueWarehouseLlmRangeJob(db, {
              endDate: targetDate,
              ownerId: user.id,
              propertyId,
              siteUrl,
              startDate: targetDate,
            });
          }
        }
      }
    } catch (error) {
      console.error('[warehouse] Daily scheduler failed:', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), DAILY_SCHEDULER_MS);
  setTimeout(() => void tick(), 15_000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
