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
}

export async function refreshGscMonthlySummariesForRange(
  db: AppDatabase,
  input: { ownerId: string; siteUrl: string; startDate: string; endDate: string },
) {
  const run = db.transaction(async () => {
    await rebuildSiteSummaries(db, input.ownerId, input.siteUrl, input.startDate, input.endDate);
    await rebuildQuerySummaries(db, input.ownerId, input.siteUrl, input.startDate, input.endDate);
    await rebuildCountrySummaries(db, input.ownerId, input.siteUrl, input.startDate, input.endDate);
    await rebuildPageSummaries(db, input.ownerId, input.siteUrl, input.startDate, input.endDate);
    await rebuildPageQuerySummaries(db, input.ownerId, input.siteUrl, input.startDate, input.endDate);
  });
  await run();
}

export async function ensureGscMonthlySummariesForRange(
  db: AppDatabase,
  input: { ownerId: string; siteUrl: string; startDate: string; endDate: string },
) {
  const summaryWindow = getGscSummaryWindow(input.startDate, input.endDate);
  if (!summaryWindow) return false;

  const fullMonthStart = summaryWindow.fullMonthStart;
  const fullMonthEndDate = endOfMonth(summaryWindow.fullMonthEnd);
  const expectedMonths = monthStartsBetween(fullMonthStart, summaryWindow.fullMonthEnd);
  if (expectedMonths.length === 0) return false;

  const summaryTables = [
    'gsc_site_monthly_metrics',
    'gsc_query_monthly_metrics',
    'gsc_country_monthly_metrics',
    'gsc_page_monthly_metrics',
    'gsc_page_query_monthly_metrics',
  ];
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
  if (!missingSummaryTable) return false;

  await refreshGscMonthlySummariesForRange(db, {
    endDate: fullMonthEndDate,
    ownerId: input.ownerId,
    siteUrl: input.siteUrl,
    startDate: fullMonthStart,
  });
  return true;
}

export async function backfillMissingGscMonthlySummaries(db: AppDatabase) {
  const missingSites = await db.all<{ ownerId: string; siteUrl: string; startDate: string; endDate: string }>(`
    SELECT source.ownerId, source.siteUrl, MIN(source.date) AS startDate, MAX(source.date) AS endDate
    FROM gsc_site_metrics source
    LEFT JOIN gsc_site_monthly_metrics summary
      ON summary.ownerId = source.ownerId
      AND summary.siteUrl = source.siteUrl
      AND summary.monthStart = substr(source.date, 1, 7) || '-01'
    WHERE summary.monthStart IS NULL
    GROUP BY source.ownerId, source.siteUrl
  `);

  if (missingSites.length === 0) {
    return;
  }

  for (const site of missingSites) {
    if (!site.ownerId || !site.siteUrl || !site.startDate || !site.endDate) continue;
    await refreshGscMonthlySummariesForRange(db, site);
  }
  console.log(`[db] Backfilled GSC monthly summary tables for ${missingSites.length} site(s)`);
}
