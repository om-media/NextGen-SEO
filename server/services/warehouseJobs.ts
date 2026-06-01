import crypto from 'crypto';
import type { AppDatabase } from '../database.js';
import { canonicalPageKey } from '../reporting/url.js';
import { googleApiFetchJson } from './googleAuth.js';
import { isMultiSitePlan } from '../../shared/plans.js';

type WarehouseJob = {
  attemptCount: number | null;
  completedAt: string | null;
  id: string;
  jobType: string;
  lastError: string | null;
  lockedAt: string | null;
  maxAttempts: number | null;
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

const POLL_MS = 10_000;
const DAILY_SCHEDULER_MS = 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const positiveIntegerEnv = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
};
const JOBS_PER_TICK = positiveIntegerEnv(process.env.WAREHOUSE_JOBS_PER_TICK, 4, 1, 12);
const INITIAL_BACKFILL_DAYS = positiveIntegerEnv(process.env.WAREHOUSE_INITIAL_BACKFILL_DAYS, 720, 1, 720);
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

async function fetchGscRows(db: AppDatabase, ownerId: string, siteUrl: string, date: string, dimensions: string[]) {
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
          endDate: date,
          rowLimit: GSC_ROW_LIMIT,
          startDate: date,
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

async function syncGscDate(db: AppDatabase, job: WarehouseJob) {
  const [siteRows, queryRows, pageQueryRows] = await Promise.all([
    fetchGscRows(db, job.ownerId, job.siteUrl, job.targetDate, ['date']),
    fetchGscRows(db, job.ownerId, job.siteUrl, job.targetDate, ['date', 'query']),
    fetchGscRows(db, job.ownerId, job.siteUrl, job.targetDate, ['date', 'page', 'query']),
  ]);

  await db.transaction(async () => {
    await db.run('DELETE FROM gsc_site_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [job.ownerId, job.siteUrl, job.targetDate]);
    await db.run('DELETE FROM gsc_query_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [job.ownerId, job.siteUrl, job.targetDate]);
    await db.run('DELETE FROM gsc_page_query_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [job.ownerId, job.siteUrl, job.targetDate]);

    for (const row of siteRows) {
      await db.run('INSERT INTO gsc_site_metrics (ownerId, siteUrl, date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?)', [job.ownerId, job.siteUrl, job.targetDate, toNumber(row.clicks), toNumber(row.impressions), toNumber(row.ctr), toNumber(row.position)]);
    }
    for (const row of queryRows) {
      await db.run('INSERT INTO gsc_query_metrics (ownerId, siteUrl, date, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [job.ownerId, job.siteUrl, job.targetDate, row.keys?.[1] || '', toNumber(row.clicks), toNumber(row.impressions), toNumber(row.ctr), toNumber(row.position)]);
    }
    for (const row of pageQueryRows) {
      const page = row.keys?.[1] || '';
      await db.run(
        'INSERT INTO gsc_page_query_metrics (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [job.ownerId, job.siteUrl, job.targetDate, page, canonicalPageKey(page, job.siteUrl), row.keys?.[2] || '', toNumber(row.clicks), toNumber(row.impressions), toNumber(row.ctr), toNumber(row.position)],
      );
    }
  })();

  return siteRows.length + queryRows.length + pageQueryRows.length;
}

async function syncGa4Date(db: AppDatabase, job: WarehouseJob) {
  if (!job.propertyId) return 0;
  const rows = [];
  let offset = 0;

  for (let page = 0; page < GA4_MAX_PAGES_PER_DATASET; page += 1) {
    const data = await googleApiFetchJson(
      db,
      job.ownerId,
      `https://analyticsdata.googleapis.com/v1beta/${job.propertyId}:runReport`,
      {
        method: 'POST',
        body: JSON.stringify({
          dateRanges: [{ startDate: job.targetDate, endDate: job.targetDate }],
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

  await db.run('DELETE FROM ga4_page_metrics WHERE ownerId = ? AND propertyId = ? AND date = ?', [job.ownerId, job.propertyId, job.targetDate]);
  for (const row of rows) {
    const date = normalizeGa4Date(row.dimensionValues?.[0]?.value) || job.targetDate;
    const pagePath = row.dimensionValues?.[1]?.value || '/';
    await db.run(
      `INSERT INTO ga4_page_metrics (ownerId, propertyId, siteUrl, date, pagePath, pageKey, sessions, totalUsers, pageViews, bounceRate, eventCount)
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
         eventCount=ga4_page_metrics.eventCount + excluded.eventCount`,
      [job.ownerId, job.propertyId, job.siteUrl, date, pagePath, canonicalPageKey(pagePath, job.siteUrl), toNumber(row.metricValues?.[0]?.value), toNumber(row.metricValues?.[1]?.value), toNumber(row.metricValues?.[2]?.value), toNumber(row.metricValues?.[3]?.value), toNumber(row.metricValues?.[4]?.value)],
    );
  }
  return rows.length;
}

async function syncGa4LlmDate(db: AppDatabase, job: WarehouseJob) {
  return syncGa4LlmRange(db, job, job.targetDate, job.targetDate);
}

async function syncGa4DimensionRange(db: AppDatabase, job: WarehouseJob, startDate: string, endDate: string) {
  if (!job.propertyId) return 0;
  let rowsSynced = 0;

  for (const config of GA4_DIMENSION_SYNC_CONFIGS) {
    const rows = [];
    let offset = 0;

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

        await db.run(
          `INSERT INTO ga4_dimension_metrics (ownerId, propertyId, siteUrl, date, dimension, dimensionValue, sessions, totalUsers, pageViews, bounceRate, eventCount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ownerId, propertyId, date, dimension, dimensionValue) DO UPDATE SET
             siteUrl=excluded.siteUrl,
             sessions=excluded.sessions,
             totalUsers=excluded.totalUsers,
             pageViews=excluded.pageViews,
             bounceRate=excluded.bounceRate,
             eventCount=excluded.eventCount`,
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

    rowsSynced += rows.length;
  }

  return rowsSynced;
}

async function syncGa4LlmRange(db: AppDatabase, job: WarehouseJob, startDate: string, endDate: string) {
  if (!job.propertyId) return 0;
  const rows = [];
  let offset = 0;

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

  await db.transaction(async () => {
    await db.run('DELETE FROM ga4_llm_referral_metrics WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?', [job.ownerId, job.propertyId, startDate, endDate]);
    for (const row of rows) {
      const date = normalizeGa4Date(row.dimensionValues?.[0]?.value) || startDate;
      const pagePath = row.dimensionValues?.[1]?.value || '/';
      const source = row.dimensionValues?.[2]?.value || '(not set)';
      await db.run(
        `INSERT INTO ga4_llm_referral_metrics (ownerId, propertyId, siteUrl, date, source, sourceClass, pagePath, pageKey, sessions, engagedSessions, keyEvents, averageSessionDuration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ownerId, propertyId, date, source, pageKey) DO UPDATE SET
           siteUrl=excluded.siteUrl,
           sourceClass=excluded.sourceClass,
           pagePath=excluded.pagePath,
           sessions=excluded.sessions,
           engagedSessions=excluded.engagedSessions,
           keyEvents=excluded.keyEvents,
           averageSessionDuration=excluded.averageSessionDuration`,
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
  return rows.length;
}

async function updateJob(db: AppDatabase, id: string, fields: Partial<WarehouseJob>) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  await db.run(`UPDATE warehouse_jobs SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updatedAt = ? WHERE id = ?`, [...entries.map(([, value]) => value), nowIso(), id]);
}

async function executeWarehouseJob(db: AppDatabase, job: WarehouseJob) {
  let rowsSynced = 0;
  const jobStartDate = job.targetStartDate || job.targetDate;
  const jobEndDate = job.targetDate;
  if (job.jobType === 'ga4-llm-range-sync') {
    rowsSynced = await syncGa4LlmRange(db, job, jobStartDate, jobEndDate);
  } else if (job.jobType === 'ga4-dimension-range-sync') {
    rowsSynced = await syncGa4DimensionRange(db, job, jobStartDate, jobEndDate);
  } else if (job.jobType === 'ga4-llm-sync') {
    rowsSynced = await syncGa4LlmDate(db, job);
  } else {
    rowsSynced = (await syncGscDate(db, job)) + (await syncGa4Date(db, job));
  }
  await db.run(
    `INSERT INTO warehouse_sync_status (ownerId, siteUrl, lastSyncDate, earliestSyncDate, status, lastUpdated)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ownerId, siteUrl) DO UPDATE SET
       lastSyncDate=CASE WHEN warehouse_sync_status.lastSyncDate IS NULL OR excluded.lastSyncDate > warehouse_sync_status.lastSyncDate THEN excluded.lastSyncDate ELSE warehouse_sync_status.lastSyncDate END,
       earliestSyncDate=CASE WHEN warehouse_sync_status.earliestSyncDate IS NULL OR excluded.earliestSyncDate < warehouse_sync_status.earliestSyncDate THEN excluded.earliestSyncDate ELSE warehouse_sync_status.earliestSyncDate END,
       status=excluded.status,
       lastUpdated=excluded.lastUpdated`,
    [job.ownerId, job.siteUrl, jobEndDate, jobStartDate, 'synced', nowIso()],
  );
  await updateJob(db, job.id, { completedAt: nowIso(), lastError: null, lockedAt: null, rowsSynced, status: 'completed' });
}

async function claimJob(db: AppDatabase) {
  const now = nowIso();
  const job = await db.get<WarehouseJob>("SELECT * FROM warehouse_jobs WHERE status IN ('queued', 'retrying') AND (nextRunAt IS NULL OR nextRunAt <= ?) ORDER BY targetDate DESC, nextRunAt ASC, updatedAt ASC LIMIT 1", [now]);
  if (!job) return null;
  const result = await db.run("UPDATE warehouse_jobs SET status = 'running', attemptCount = COALESCE(attemptCount, 0) + 1, startedAt = COALESCE(startedAt, ?), updatedAt = ?, lockedAt = ?, lastError = NULL WHERE id = ? AND status IN ('queued', 'retrying')", [now, now, now, job.id]);
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

export async function queueWarehouseSyncJob(db: AppDatabase, input: { jobType?: string; ownerId: string; propertyId?: string | null; siteUrl: string; targetDate: string; targetStartDate?: string | null }) {
  const jobType = input.jobType || 'daily-sync';
  const propertyId = input.propertyId || null;
  const targetStartDate = input.targetStartDate || input.targetDate;
  const existing = propertyId
    ? await db.get<WarehouseJob>("SELECT * FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? AND targetDate = ? AND COALESCE(targetStartDate, targetDate) = ? AND COALESCE(propertyId, '') = ? AND jobType = ? AND status IN ('queued', 'retrying', 'running', 'completed') LIMIT 1", [input.ownerId, input.siteUrl, input.targetDate, targetStartDate, propertyId, jobType])
    : await db.get<WarehouseJob>("SELECT * FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? AND targetDate = ? AND COALESCE(targetStartDate, targetDate) = ? AND jobType = ? AND status IN ('queued', 'retrying', 'running', 'completed') LIMIT 1", [input.ownerId, input.siteUrl, input.targetDate, targetStartDate, jobType]);
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

export async function queueWarehouseBackfillJobs(db: AppDatabase, input: { days?: number; ownerId: string; propertyId?: string | null; siteUrl: string }) {
  const jobs = [];
  for (const targetDate of recentStableWarehouseDates(input.days)) {
    const job = await queueWarehouseSyncJob(db, {
      ownerId: input.ownerId,
      propertyId: input.propertyId,
      siteUrl: input.siteUrl,
      targetDate,
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

export async function queueWarehouseLlmRangeJob(db: AppDatabase, input: { ownerId: string; propertyId: string; siteUrl: string; startDate: string; endDate: string }) {
  return queueWarehouseSyncJob(db, {
    jobType: 'ga4-llm-range-sync',
    ownerId: input.ownerId,
    propertyId: input.propertyId,
    siteUrl: input.siteUrl,
    targetDate: input.endDate,
    targetStartDate: input.startDate,
  });
}

export async function queueWarehouseGa4DimensionRangeJob(db: AppDatabase, input: { ownerId: string; propertyId: string; siteUrl: string; startDate: string; endDate: string }) {
  return queueWarehouseSyncJob(db, {
    jobType: 'ga4-dimension-range-sync',
    ownerId: input.ownerId,
    propertyId: input.propertyId,
    siteUrl: input.siteUrl,
    targetDate: input.endDate,
    targetStartDate: input.startDate,
  });
}

export async function listWarehouseJobs(db: AppDatabase, ownerId: string, siteUrl: string, limit = 20) {
  return db.all<WarehouseJob>('SELECT * FROM warehouse_jobs WHERE ownerId = ? AND siteUrl = ? ORDER BY updatedAt DESC LIMIT ?', [ownerId, siteUrl, limit]);
}

export function startWarehouseJobWorker(db: AppDatabase) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await recoverJobs(db);
      await supersedeLegacyLlmDailyJobs(db);
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
        SELECT id, tier, activatedSiteUrl, activatedGa4PropertyId, unlockedSites
        FROM users
        WHERE gscRefreshToken IS NOT NULL AND gscRefreshToken != ''
      `);

      for (const user of users) {
        const sites = new Set<string>();
        if (typeof user.activatedSiteUrl === 'string' && user.activatedSiteUrl.trim()) {
          sites.add(user.activatedSiteUrl.trim());
        }
        if (isMultiSitePlan(user.tier)) {
          for (const site of parseStringArray(user.unlockedSites)) {
            sites.add(site.trim());
          }
        }

        for (const siteUrl of sites) {
          const propertyId = typeof user.activatedGa4PropertyId === 'string' ? user.activatedGa4PropertyId : null;
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
