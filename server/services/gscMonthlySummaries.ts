import type { AppDatabase } from '../database.js';

type IsoRange = {
  startDate: string;
  endDate: string;
};

type SummaryWindow = {
  edgeRanges: IsoRange[];
  fullMonthEnd: string;
  fullMonthStart: string;
};

const LONG_RANGE_SUMMARY_MIN_DAYS = 45;
export const ALL_GSC_MONTHLY_SUMMARY_TABLES = [
  'gsc_site_monthly_metrics',
  'gsc_query_monthly_metrics',
  'gsc_country_monthly_metrics',
  'gsc_page_monthly_metrics',
  'gsc_page_query_monthly_metrics',
] as const;

export type GscMonthlySummaryTable = typeof ALL_GSC_MONTHLY_SUMMARY_TABLES[number];

function toUtcDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(value: string, days: number) {
  const date = toUtcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

function startOfMonth(value: string) {
  return `${value.slice(0, 7)}-01`;
}

function startOfNextMonth(value: string) {
  const date = toUtcDate(startOfMonth(value));
  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return toIsoDate(date);
}

function endOfMonth(value: string) {
  return addUtcDays(startOfNextMonth(value), -1);
}

function isFirstDayOfMonth(value: string) {
  return value.slice(8, 10) === '01';
}

function isLastDayOfMonth(value: string) {
  return value === endOfMonth(value);
}

function daysBetweenInclusive(startDate: string, endDate: string) {
  const start = toUtcDate(startDate).getTime();
  const end = toUtcDate(endDate).getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}

function compareIsoDates(left: string, right: string) {
  return left.localeCompare(right);
}

export function getGscSummaryWindow(startDate: string, endDate: string): SummaryWindow | null {
  if (daysBetweenInclusive(startDate, endDate) < LONG_RANGE_SUMMARY_MIN_DAYS) {
    return null;
  }

  const fullMonthStart = isFirstDayOfMonth(startDate) ? startDate : startOfNextMonth(startDate);
  const fullMonthEnd = isLastDayOfMonth(endDate) ? startOfMonth(endDate) : startOfMonth(addUtcDays(startOfMonth(endDate), -1));

  if (compareIsoDates(fullMonthStart, fullMonthEnd) > 0) {
    return null;
  }

  const edgeRanges: IsoRange[] = [];
  if (compareIsoDates(startDate, fullMonthStart) < 0) {
    edgeRanges.push({
      endDate: addUtcDays(fullMonthStart, -1),
      startDate,
    });
  }

  const trailingStart = addUtcDays(endOfMonth(fullMonthEnd), 1);
  if (compareIsoDates(trailingStart, endDate) <= 0) {
    edgeRanges.push({
      endDate,
      startDate: trailingStart,
    });
  }

  return {
    edgeRanges,
    fullMonthEnd,
    fullMonthStart,
  };
}

function monthBoundsForRange(startDate: string, endDate: string) {
  const monthStart = startOfMonth(startDate);
  return {
    monthEnd: endOfMonth(endDate),
    monthStart,
  };
}

function monthStartsBetween(startDate: string, endDate: string) {
  const months: string[] = [];
  let cursor = startOfMonth(startDate);
  const finalMonth = startOfMonth(endDate);
  while (compareIsoDates(cursor, finalMonth) <= 0) {
    months.push(cursor);
    cursor = startOfNextMonth(cursor);
  }
  return months;
}

async function rebuildSiteSummaries(db: AppDatabase, ownerId?: string, siteUrl?: string, startDate?: string, endDate?: string) {
  const filters = [];
  const params: unknown[] = [];
  if (ownerId) {
    filters.push('ownerId = ?');
    params.push(ownerId);
  }
  if (siteUrl) {
    filters.push('siteUrl = ?');
    params.push(siteUrl);
  }
  if (startDate && endDate) {
    filters.push('date >= ? AND date <= ?');
    params.push(startDate, endDate);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  if (startDate && endDate) {
    const { monthStart, monthEnd } = monthBoundsForRange(startDate, endDate);
    const deleteParams = ownerId && siteUrl ? [ownerId, siteUrl, monthStart, monthEnd] : ownerId ? [ownerId, monthStart, monthEnd] : siteUrl ? [siteUrl, monthStart, monthEnd] : [monthStart, monthEnd];
    const deleteWhere = ownerId && siteUrl
      ? 'ownerId = ? AND siteUrl = ? AND monthStart >= ? AND monthStart <= ?'
      : ownerId
        ? 'ownerId = ? AND monthStart >= ? AND monthStart <= ?'
        : siteUrl
          ? 'siteUrl = ? AND monthStart >= ? AND monthStart <= ?'
          : 'monthStart >= ? AND monthStart <= ?';
    await db.run(`DELETE FROM gsc_site_monthly_metrics WHERE ${deleteWhere}`, deleteParams);
  } else {
    await db.run('DELETE FROM gsc_site_monthly_metrics');
  }

  await db.run(
    `
      INSERT INTO gsc_site_monthly_metrics (ownerId, siteUrl, monthStart, clicks, impressions, positionSum)
      SELECT
        ownerId,
        siteUrl,
        substr(date, 1, 7) || '-01' AS monthStart,
        SUM(clicks) AS clicks,
        SUM(impressions) AS impressions,
        SUM(position * impressions) AS positionSum
      FROM gsc_site_metrics
      ${whereClause}
      GROUP BY ownerId, siteUrl, substr(date, 1, 7)
      ON CONFLICT(ownerId, siteUrl, monthStart) DO UPDATE SET
        clicks = excluded.clicks,
        impressions = excluded.impressions,
        positionSum = excluded.positionSum
    `,
    params,
  );
}

async function rebuildQuerySummaries(db: AppDatabase, ownerId?: string, siteUrl?: string, startDate?: string, endDate?: string) {
  const filters = ["query <> ''"];
  const params: unknown[] = [];
  if (ownerId) {
    filters.push('ownerId = ?');
    params.push(ownerId);
  }
  if (siteUrl) {
    filters.push('siteUrl = ?');
    params.push(siteUrl);
  }
  if (startDate && endDate) {
    filters.push('date >= ? AND date <= ?');
    params.push(startDate, endDate);
  }
  const whereClause = `WHERE ${filters.join(' AND ')}`;

  if (startDate && endDate) {
    const { monthStart, monthEnd } = monthBoundsForRange(startDate, endDate);
    const deleteParams = ownerId && siteUrl ? [ownerId, siteUrl, monthStart, monthEnd] : ownerId ? [ownerId, monthStart, monthEnd] : siteUrl ? [siteUrl, monthStart, monthEnd] : [monthStart, monthEnd];
    const deleteWhere = ownerId && siteUrl
      ? 'ownerId = ? AND siteUrl = ? AND monthStart >= ? AND monthStart <= ?'
      : ownerId
        ? 'ownerId = ? AND monthStart >= ? AND monthStart <= ?'
        : siteUrl
          ? 'siteUrl = ? AND monthStart >= ? AND monthStart <= ?'
          : 'monthStart >= ? AND monthStart <= ?';
    await db.run(`DELETE FROM gsc_query_monthly_metrics WHERE ${deleteWhere}`, deleteParams);
  } else {
    await db.run('DELETE FROM gsc_query_monthly_metrics');
  }

  await db.run(
    `
      INSERT INTO gsc_query_monthly_metrics (ownerId, siteUrl, monthStart, query, clicks, impressions, positionSum)
      SELECT
        ownerId,
        siteUrl,
        substr(date, 1, 7) || '-01' AS monthStart,
        query,
        SUM(clicks) AS clicks,
        SUM(impressions) AS impressions,
        SUM(position * impressions) AS positionSum
      FROM gsc_query_metrics
      ${whereClause}
      GROUP BY ownerId, siteUrl, substr(date, 1, 7), query
      ON CONFLICT(ownerId, siteUrl, monthStart, query) DO UPDATE SET
        clicks = excluded.clicks,
        impressions = excluded.impressions,
        positionSum = excluded.positionSum
    `,
    params,
  );

  await db.run(
    `
      INSERT INTO gsc_query_monthly_metrics (ownerId, siteUrl, monthStart, query, clicks, impressions, positionSum)
      SELECT
        site.ownerId,
        site.siteUrl,
        site.monthStart,
        '' AS query,
        0 AS clicks,
        0 AS impressions,
        0 AS positionSum
      FROM (
        SELECT ownerId, siteUrl, substr(date, 1, 7) || '-01' AS monthStart
        FROM gsc_site_metrics
        ${whereClause.replace("query <> '' AND ", '')}
        GROUP BY ownerId, siteUrl, substr(date, 1, 7)
      ) site
      WHERE NOT EXISTS (
        SELECT 1
        FROM gsc_query_monthly_metrics query
        WHERE query.ownerId = site.ownerId
          AND query.siteUrl = site.siteUrl
          AND query.monthStart = site.monthStart
      )
      ON CONFLICT(ownerId, siteUrl, monthStart, query) DO UPDATE SET
        clicks = excluded.clicks,
        impressions = excluded.impressions,
        positionSum = excluded.positionSum
    `,
    params,
  );
}

async function rebuildCountrySummaries(db: AppDatabase, ownerId?: string, siteUrl?: string, startDate?: string, endDate?: string) {
  const filters = [];
  const params: unknown[] = [];
  if (ownerId) {
    filters.push('ownerId = ?');
    params.push(ownerId);
  }
  if (siteUrl) {
    filters.push('siteUrl = ?');
    params.push(siteUrl);
  }
  if (startDate && endDate) {
    filters.push('date >= ? AND date <= ?');
    params.push(startDate, endDate);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  if (startDate && endDate) {
    const { monthStart, monthEnd } = monthBoundsForRange(startDate, endDate);
    const deleteParams = ownerId && siteUrl ? [ownerId, siteUrl, monthStart, monthEnd] : ownerId ? [ownerId, monthStart, monthEnd] : siteUrl ? [siteUrl, monthStart, monthEnd] : [monthStart, monthEnd];
    const deleteWhere = ownerId && siteUrl
      ? 'ownerId = ? AND siteUrl = ? AND monthStart >= ? AND monthStart <= ?'
      : ownerId
        ? 'ownerId = ? AND monthStart >= ? AND monthStart <= ?'
        : siteUrl
          ? 'siteUrl = ? AND monthStart >= ? AND monthStart <= ?'
          : 'monthStart >= ? AND monthStart <= ?';
    await db.run(`DELETE FROM gsc_country_monthly_metrics WHERE ${deleteWhere}`, deleteParams);
  } else {
    await db.run('DELETE FROM gsc_country_monthly_metrics');
  }

  await db.run(
    `
      INSERT INTO gsc_country_monthly_metrics (ownerId, siteUrl, monthStart, country, clicks, impressions, positionSum)
      SELECT
        ownerId,
        siteUrl,
        substr(date, 1, 7) || '-01' AS monthStart,
        country,
        SUM(clicks) AS clicks,
        SUM(impressions) AS impressions,
        SUM(position * impressions) AS positionSum
      FROM gsc_country_metrics
      ${whereClause}
      GROUP BY ownerId, siteUrl, substr(date, 1, 7), country
      ON CONFLICT(ownerId, siteUrl, monthStart, country) DO UPDATE SET
        clicks = excluded.clicks,
        impressions = excluded.impressions,
        positionSum = excluded.positionSum
    `,
    params,
  );

  await db.run(
    `
      INSERT INTO gsc_country_monthly_metrics (ownerId, siteUrl, monthStart, country, clicks, impressions, positionSum)
      SELECT
        site.ownerId,
        site.siteUrl,
        site.monthStart,
        '' AS country,
        0 AS clicks,
        0 AS impressions,
        0 AS positionSum
      FROM (
        SELECT ownerId, siteUrl, substr(date, 1, 7) || '-01' AS monthStart
        FROM gsc_site_metrics
        ${whereClause}
        GROUP BY ownerId, siteUrl, substr(date, 1, 7)
      ) site
      WHERE NOT EXISTS (
        SELECT 1
        FROM gsc_country_monthly_metrics country
        WHERE country.ownerId = site.ownerId
          AND country.siteUrl = site.siteUrl
          AND country.monthStart = site.monthStart
      )
      ON CONFLICT(ownerId, siteUrl, monthStart, country) DO UPDATE SET
        clicks = excluded.clicks,
        impressions = excluded.impressions,
        positionSum = excluded.positionSum
    `,
    params,
  );
}

async function rebuildPageSummaries(db: AppDatabase, ownerId?: string, siteUrl?: string, startDate?: string, endDate?: string) {
  const filters = ["pageKey <> ''"];
  const params: unknown[] = [];
  if (ownerId) {
    filters.push('ownerId = ?');
    params.push(ownerId);
  }
  if (siteUrl) {
    filters.push('siteUrl = ?');
    params.push(siteUrl);
  }
  if (startDate && endDate) {
    filters.push('date >= ? AND date <= ?');
    params.push(startDate, endDate);
  }
  const whereClause = `WHERE ${filters.join(' AND ')}`;

  if (startDate && endDate) {
    const { monthStart, monthEnd } = monthBoundsForRange(startDate, endDate);
    const deleteParams = ownerId && siteUrl ? [ownerId, siteUrl, monthStart, monthEnd] : ownerId ? [ownerId, monthStart, monthEnd] : siteUrl ? [siteUrl, monthStart, monthEnd] : [monthStart, monthEnd];
    const deleteWhere = ownerId && siteUrl
      ? 'ownerId = ? AND siteUrl = ? AND monthStart >= ? AND monthStart <= ?'
      : ownerId
        ? 'ownerId = ? AND monthStart >= ? AND monthStart <= ?'
        : siteUrl
          ? 'siteUrl = ? AND monthStart >= ? AND monthStart <= ?'
          : 'monthStart >= ? AND monthStart <= ?';
    await db.run(`DELETE FROM gsc_page_monthly_metrics WHERE ${deleteWhere}`, deleteParams);
  } else {
    await db.run('DELETE FROM gsc_page_monthly_metrics');
  }

  await db.run(
    `
      INSERT INTO gsc_page_monthly_metrics (ownerId, siteUrl, monthStart, page, pageKey, clicks, impressions, positionSum, queryCount)
      SELECT
        ownerId,
        siteUrl,
        substr(date, 1, 7) || '-01' AS monthStart,
        MIN(page) AS page,
        pageKey,
        SUM(clicks) AS clicks,
        SUM(impressions) AS impressions,
        SUM(position * impressions) AS positionSum,
        SUM(queryCount) AS queryCount
      FROM gsc_page_metrics
      ${whereClause}
      GROUP BY ownerId, siteUrl, substr(date, 1, 7), pageKey
      ON CONFLICT(ownerId, siteUrl, monthStart, pageKey) DO UPDATE SET
        page = excluded.page,
        clicks = excluded.clicks,
        impressions = excluded.impressions,
        positionSum = excluded.positionSum,
        queryCount = excluded.queryCount
    `,
    params,
  );

  await db.run(
    `
      INSERT INTO gsc_page_monthly_metrics (ownerId, siteUrl, monthStart, page, pageKey, clicks, impressions, positionSum, queryCount)
      SELECT
        ownerId,
        siteUrl,
        substr(date, 1, 7) || '-01' AS monthStart,
        MIN(page) AS page,
        COALESCE(NULLIF(pageKey, ''), page) AS pageKey,
        SUM(clicks) AS clicks,
        SUM(impressions) AS impressions,
        SUM(position * impressions) AS positionSum,
        COUNT(DISTINCT query) AS queryCount
      FROM gsc_page_query_metrics
      ${whereClause.replace("pageKey <> ''", "COALESCE(NULLIF(pageKey, ''), page) <> ''")}
      GROUP BY ownerId, siteUrl, substr(date, 1, 7), COALESCE(NULLIF(pageKey, ''), page)
      ON CONFLICT(ownerId, siteUrl, monthStart, pageKey) DO NOTHING
    `,
    params,
  );
  await db.run(
    `
      INSERT INTO gsc_page_monthly_metrics (ownerId, siteUrl, monthStart, page, pageKey, clicks, impressions, positionSum, queryCount)
      SELECT
        site.ownerId,
        site.siteUrl,
        site.monthStart,
        '' AS page,
        '' AS pageKey,
        0 AS clicks,
        0 AS impressions,
        0 AS positionSum,
        0 AS queryCount
      FROM (
        SELECT ownerId, siteUrl, substr(date, 1, 7) || '-01' AS monthStart
        FROM gsc_site_metrics
        ${whereClause.replace("pageKey <> '' AND ", '')}
        GROUP BY ownerId, siteUrl, substr(date, 1, 7)
      ) site
      WHERE NOT EXISTS (
        SELECT 1
        FROM gsc_page_monthly_metrics page
        WHERE page.ownerId = site.ownerId
          AND page.siteUrl = site.siteUrl
          AND page.monthStart = site.monthStart
      )
      ON CONFLICT(ownerId, siteUrl, monthStart, pageKey) DO UPDATE SET
        page = excluded.page,
        clicks = excluded.clicks,
        impressions = excluded.impressions,
        positionSum = excluded.positionSum,
        queryCount = excluded.queryCount
    `,
    params,
  );
}

async function rebuildPageQuerySummaries(db: AppDatabase, ownerId?: string, siteUrl?: string, startDate?: string, endDate?: string) {
  const filters = ["COALESCE(NULLIF(pageKey, ''), page) <> ''", "query <> ''"];
  const params: unknown[] = [];
  if (ownerId) {
    filters.push('ownerId = ?');
    params.push(ownerId);
  }
  if (siteUrl) {
    filters.push('siteUrl = ?');
    params.push(siteUrl);
  }
  if (startDate && endDate) {
    filters.push('date >= ? AND date <= ?');
    params.push(startDate, endDate);
  }
  const whereClause = `WHERE ${filters.join(' AND ')}`;

  if (startDate && endDate) {
    const { monthStart, monthEnd } = monthBoundsForRange(startDate, endDate);
    const deleteParams = ownerId && siteUrl ? [ownerId, siteUrl, monthStart, monthEnd] : ownerId ? [ownerId, monthStart, monthEnd] : siteUrl ? [siteUrl, monthStart, monthEnd] : [monthStart, monthEnd];
    const deleteWhere = ownerId && siteUrl
      ? 'ownerId = ? AND siteUrl = ? AND monthStart >= ? AND monthStart <= ?'
      : ownerId
        ? 'ownerId = ? AND monthStart >= ? AND monthStart <= ?'
        : siteUrl
          ? 'siteUrl = ? AND monthStart >= ? AND monthStart <= ?'
          : 'monthStart >= ? AND monthStart <= ?';
    await db.run(`DELETE FROM gsc_page_query_monthly_metrics WHERE ${deleteWhere}`, deleteParams);
  } else {
    await db.run('DELETE FROM gsc_page_query_monthly_metrics');
  }

  await db.run(
    `
      INSERT INTO gsc_page_query_monthly_metrics (ownerId, siteUrl, monthStart, page, pageKey, query, clicks, impressions, positionSum)
      SELECT
        ownerId,
        siteUrl,
        substr(date, 1, 7) || '-01' AS monthStart,
        MIN(page) AS page,
        COALESCE(NULLIF(pageKey, ''), page) AS pageKey,
        query,
        SUM(clicks) AS clicks,
        SUM(impressions) AS impressions,
        SUM(position * impressions) AS positionSum
      FROM gsc_page_query_metrics
      ${whereClause}
      GROUP BY ownerId, siteUrl, substr(date, 1, 7), COALESCE(NULLIF(pageKey, ''), page), query
      ON CONFLICT(ownerId, siteUrl, monthStart, pageKey, query) DO UPDATE SET
        page = excluded.page,
        clicks = excluded.clicks,
        impressions = excluded.impressions,
        positionSum = excluded.positionSum
    `,
    params,
  );

  await db.run(
    `
      INSERT INTO gsc_page_query_monthly_metrics (ownerId, siteUrl, monthStart, page, pageKey, query, clicks, impressions, positionSum)
      SELECT
        site.ownerId,
        site.siteUrl,
        site.monthStart,
        '' AS page,
        '' AS pageKey,
        '' AS query,
        0 AS clicks,
        0 AS impressions,
        0 AS positionSum
      FROM (
        SELECT ownerId, siteUrl, substr(date, 1, 7) || '-01' AS monthStart
        FROM gsc_site_metrics
        ${whereClause.replace("COALESCE(NULLIF(pageKey, ''), page) <> '' AND ", '').replace("query <> '' AND ", '')}
        GROUP BY ownerId, siteUrl, substr(date, 1, 7)
      ) site
      WHERE NOT EXISTS (
        SELECT 1
        FROM gsc_page_query_monthly_metrics pageQuery
        WHERE pageQuery.ownerId = site.ownerId
          AND pageQuery.siteUrl = site.siteUrl
          AND pageQuery.monthStart = site.monthStart
      )
      ON CONFLICT(ownerId, siteUrl, monthStart, pageKey, query) DO UPDATE SET
        page = excluded.page,
        clicks = excluded.clicks,
        impressions = excluded.impressions,
        positionSum = excluded.positionSum
    `,
    params,
  );
}

export async function refreshGscMonthlySummariesForRange(
  db: AppDatabase,
  input: { ownerId: string; siteUrl: string; startDate: string; endDate: string },
  summaryTables: readonly GscMonthlySummaryTable[] = ALL_GSC_MONTHLY_SUMMARY_TABLES,
) {
  const run = db.transaction(async () => {
    if (summaryTables.includes('gsc_site_monthly_metrics')) {
      await rebuildSiteSummaries(db, input.ownerId, input.siteUrl, input.startDate, input.endDate);
    }
    if (summaryTables.includes('gsc_query_monthly_metrics')) {
      await rebuildQuerySummaries(db, input.ownerId, input.siteUrl, input.startDate, input.endDate);
    }
    if (summaryTables.includes('gsc_country_monthly_metrics')) {
      await rebuildCountrySummaries(db, input.ownerId, input.siteUrl, input.startDate, input.endDate);
    }
    if (summaryTables.includes('gsc_page_monthly_metrics')) {
      await rebuildPageSummaries(db, input.ownerId, input.siteUrl, input.startDate, input.endDate);
    }
    if (summaryTables.includes('gsc_page_query_monthly_metrics')) {
      await rebuildPageQuerySummaries(db, input.ownerId, input.siteUrl, input.startDate, input.endDate);
    }
  });
  await run();
}

export async function ensureGscMonthlySummariesForRange(
  db: AppDatabase,
  input: { ownerId: string; siteUrl: string; startDate: string; endDate: string },
  summaryTables: readonly GscMonthlySummaryTable[] = ALL_GSC_MONTHLY_SUMMARY_TABLES,
) {
  const hasSummaries = await hasGscMonthlySummariesForRange(db, input, summaryTables);
  if (hasSummaries) return false;

  const summaryWindow = getGscSummaryWindow(input.startDate, input.endDate);
  if (!summaryWindow) return false;

  const fullMonthStart = summaryWindow.fullMonthStart;
  const fullMonthEndDate = endOfMonth(summaryWindow.fullMonthEnd);
  await refreshGscMonthlySummariesForRange(db, {
    endDate: fullMonthEndDate,
    ownerId: input.ownerId,
    siteUrl: input.siteUrl,
    startDate: fullMonthStart,
  }, summaryTables);
  return true;
}

export async function hasGscMonthlySummariesForRange(
  db: AppDatabase,
  input: { ownerId: string; siteUrl: string; startDate: string; endDate: string },
  summaryTables: readonly GscMonthlySummaryTable[] = ALL_GSC_MONTHLY_SUMMARY_TABLES,
) {
  const summaryWindow = getGscSummaryWindow(input.startDate, input.endDate);
  if (!summaryWindow) return false;

  const fullMonthStart = summaryWindow.fullMonthStart;
  const expectedMonths = monthStartsBetween(fullMonthStart, summaryWindow.fullMonthEnd);
  if (expectedMonths.length === 0) return false;

  if (summaryTables.length === 0) return false;

  const coverageRows = await Promise.all(summaryTables.map((tableName) =>
    db.get<{ count: number }>(
      `
        SELECT COUNT(DISTINCT monthStart) AS count
        FROM ${tableName}
        WHERE ownerId = ? AND siteUrl = ? AND monthStart >= ? AND monthStart <= ?
      `,
      [input.ownerId, input.siteUrl, fullMonthStart, summaryWindow.fullMonthEnd],
    )
  ));
  const missingSummaryTable = coverageRows.some((row) => Number(row?.count || 0) < expectedMonths.length);
  return !missingSummaryTable;
}

function positiveNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export async function backfillMissingGscMonthlySummaries(db: AppDatabase, maxSites = positiveNumber(process.env.GSC_MONTHLY_SUMMARY_BACKFILL_MAX_SITES, 10)) {
  const sites = await db.all<{ ownerId: string; siteUrl: string; startDate: string; endDate: string }>(`
    SELECT ownerId, siteUrl, MIN(date) AS startDate, MAX(date) AS endDate
    FROM gsc_site_metrics
    GROUP BY ownerId, siteUrl
  `);

  if (sites.length === 0) {
    return;
  }

  let backfilledSiteCount = 0;
  for (const site of sites) {
    if (backfilledSiteCount >= maxSites) break;
    if (!site.ownerId || !site.siteUrl || !site.startDate || !site.endDate) continue;
    if (!getGscSummaryWindow(site.startDate, site.endDate)) continue;
    const missingTables: GscMonthlySummaryTable[] = [];
    for (const tableName of ALL_GSC_MONTHLY_SUMMARY_TABLES) {
      const hasSummaryTable = await hasGscMonthlySummariesForRange(db, site, [tableName]);
      if (!hasSummaryTable) missingTables.push(tableName);
    }
    if (missingTables.length === 0) continue;
    await refreshGscMonthlySummariesForRange(db, site, missingTables);
    backfilledSiteCount += 1;
  }

  if (backfilledSiteCount > 0) {
    console.log(`[db] Backfilled GSC monthly summary tables for ${backfilledSiteCount} site(s)`);
  }
}

export function startGscMonthlySummaryBackfillWorker(db: AppDatabase) {
  if (process.env.RUN_GSC_MONTHLY_SUMMARY_BACKFILL === 'false') {
    return () => {};
  }

  const intervalMs = positiveNumber(process.env.GSC_MONTHLY_SUMMARY_BACKFILL_INTERVAL_MS, 5 * 60 * 1000);
  const initialDelayMs = positiveNumber(process.env.GSC_MONTHLY_SUMMARY_BACKFILL_INITIAL_DELAY_MS, 5_000);
  const maxSitesPerRun = positiveNumber(process.env.GSC_MONTHLY_SUMMARY_BACKFILL_MAX_SITES, 10);
  let stopped = false;
  let running = false;

  const runBackfill = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const activeWarehouseJobs = await db.get<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM warehouse_jobs
        WHERE status IN ('queued', 'retrying', 'running')
      `);
      if (Number(activeWarehouseJobs?.count || 0) > 0) {
        return;
      }

      await backfillMissingGscMonthlySummaries(db, maxSitesPerRun);
    } catch (error: any) {
      console.warn('[db] GSC monthly summary backfill skipped:', error?.message || error);
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(() => {
    void runBackfill();
  }, initialDelayMs);
  const interval = setInterval(() => {
    void runBackfill();
  }, intervalMs);

  return () => {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(interval);
  };
}

