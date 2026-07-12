import dotenv from 'dotenv';
import { performance } from 'node:perf_hooks';
import { initializeDatabase, type AppDatabase } from '../server/database.js';
import {
  ALL_GSC_MONTHLY_SUMMARY_TABLES,
  getGscMonthlySummaryCoverage,
  getGscSummaryWindow,
  type GscMonthlySummaryTable,
} from '../server/services/gscMonthlySummaries.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

type Candidate = {
  ownerId: string;
  siteUrl: string;
  startDate: string;
  endDate: string;
  detailRows: number;
};

type SourceSql = {
  params: Record<string, unknown>;
  sql: string;
};

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function timed<T>(label: string, fn: () => Promise<T>) {
  const startedAt = performance.now();
  const result = await fn();
  const elapsedMs = performance.now() - startedAt;
  console.log(`${label}: ${elapsedMs.toFixed(1)}ms`);
  return { elapsedMs, result };
}

async function getCandidate(db: AppDatabase): Promise<Candidate> {
  const ownerId = argValue('owner') || process.env.BENCHMARK_OWNER_ID;
  const siteUrl = argValue('site') || process.env.BENCHMARK_SITE_URL;
  const startDate = argValue('start') || process.env.BENCHMARK_START_DATE;
  const endDate = argValue('end') || process.env.BENCHMARK_END_DATE;

  if (ownerId && siteUrl && startDate && endDate) {
    const row = await db.get<{ detailRows: number }>(`
      SELECT COUNT(*) AS detailRows
      FROM gsc_page_query_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date BETWEEN ? AND ?
    `, [ownerId, siteUrl, startDate, endDate]);
    return {
      ownerId,
      siteUrl,
      startDate,
      endDate,
      detailRows: numberValue(row?.detailRows),
    };
  }

  const inferred = await db.get<Candidate>(`
    SELECT ownerId,
           siteUrl,
           MIN(date) AS startDate,
           MAX(date) AS endDate,
           COUNT(*) AS detailRows
    FROM gsc_page_query_metrics
    GROUP BY ownerId, siteUrl
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `);

  if (!inferred) {
    throw new Error('No gsc_page_query_metrics rows found. Pass --owner, --site, --start, and --end after importing data.');
  }

  return {
    ownerId: inferred.ownerId,
    siteUrl: inferred.siteUrl,
    startDate: inferred.startDate,
    endDate: inferred.endDate,
    detailRows: numberValue(inferred.detailRows),
  };
}

function buildBaseParams(candidate: Candidate) {
  return {
    endDate: candidate.endDate,
    limit: 1000,
    offset: 0,
    ownerId: candidate.ownerId,
    siteUrl: candidate.siteUrl,
    startDate: candidate.startDate,
  } satisfies Record<string, unknown>;
}

function buildSummaryWindowParams(candidate: Candidate) {
  const summaryWindow = getGscSummaryWindow(candidate.startDate, candidate.endDate);
  if (!summaryWindow) return null;
  const params: Record<string, unknown> = {
    ownerId: candidate.ownerId,
    siteUrl: candidate.siteUrl,
    summaryMonthStart: summaryWindow.fullMonthStart,
    summaryMonthEnd: summaryWindow.fullMonthEnd,
  };
  summaryWindow.edgeRanges.forEach((range, index) => {
    params[`edgeStart${index}`] = range.startDate;
    params[`edgeEnd${index}`] = range.endDate;
  });
  return { params, summaryWindow };
}

function buildQuerySummarySource(candidate: Candidate): SourceSql | null {
  const window = buildSummaryWindowParams(candidate);
  if (!window) return null;
  const segments = [
    `
      SELECT ownerId, siteUrl, query, clicks, impressions, positionSum
      FROM gsc_query_monthly_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND monthStart >= @summaryMonthStart AND monthStart <= @summaryMonthEnd
    `.trim(),
  ];
  window.summaryWindow.edgeRanges.forEach((_, index) => {
    segments.push(`
      SELECT ownerId, siteUrl, query, clicks, impressions, position * impressions AS positionSum
      FROM gsc_query_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @edgeStart${index} AND date <= @edgeEnd${index}
    `.trim());
  });
  return { params: window.params, sql: segments.join('\nUNION ALL\n') };
}

function buildCountrySummarySource(candidate: Candidate): SourceSql | null {
  const window = buildSummaryWindowParams(candidate);
  if (!window) return null;
  const segments = [
    `
      SELECT ownerId, siteUrl, country, clicks, impressions, positionSum
      FROM gsc_country_monthly_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND monthStart >= @summaryMonthStart AND monthStart <= @summaryMonthEnd
    `.trim(),
  ];
  window.summaryWindow.edgeRanges.forEach((_, index) => {
    segments.push(`
      SELECT ownerId, siteUrl, country, clicks, impressions, position * impressions AS positionSum
      FROM gsc_country_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @edgeStart${index} AND date <= @edgeEnd${index}
    `.trim());
  });
  return { params: window.params, sql: segments.join('\nUNION ALL\n') };
}

function buildPageSummarySource(candidate: Candidate): SourceSql | null {
  const window = buildSummaryWindowParams(candidate);
  if (!window) return null;
  const segments = [
    `
      SELECT ownerId, siteUrl, page, pageKey, queryCount, clicks, impressions, positionSum
      FROM gsc_page_monthly_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND monthStart >= @summaryMonthStart AND monthStart <= @summaryMonthEnd
    `.trim(),
  ];
  window.summaryWindow.edgeRanges.forEach((_, index) => {
    segments.push(`
      SELECT ownerId, siteUrl, page, COALESCE(NULLIF(pageKey, ''), page) AS pageKey, queryCount, clicks, impressions, position * impressions AS positionSum
      FROM gsc_page_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @edgeStart${index} AND date <= @edgeEnd${index}
    `.trim());
    segments.push(`
      SELECT
        pageQuery.ownerId,
        pageQuery.siteUrl,
        MIN(pageQuery.page) AS page,
        COALESCE(NULLIF(pageQuery.pageKey, ''), pageQuery.page) AS pageKey,
        COUNT(DISTINCT pageQuery.query) AS queryCount,
        SUM(pageQuery.clicks) AS clicks,
        SUM(pageQuery.impressions) AS impressions,
        SUM(pageQuery.position * pageQuery.impressions) AS positionSum
      FROM gsc_page_query_metrics pageQuery
      WHERE pageQuery.ownerId = @ownerId
        AND pageQuery.siteUrl = @siteUrl
        AND pageQuery.date >= @edgeStart${index}
        AND pageQuery.date <= @edgeEnd${index}
        AND COALESCE(NULLIF(pageQuery.pageKey, ''), pageQuery.page) <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM gsc_page_metrics pageMetric
          WHERE pageMetric.ownerId = pageQuery.ownerId
            AND pageMetric.siteUrl = pageQuery.siteUrl
            AND pageMetric.date = pageQuery.date
            AND COALESCE(NULLIF(pageMetric.pageKey, ''), pageMetric.page) = COALESCE(NULLIF(pageQuery.pageKey, ''), pageQuery.page)
        )
      GROUP BY pageQuery.ownerId, pageQuery.siteUrl, COALESCE(NULLIF(pageQuery.pageKey, ''), pageQuery.page)
    `.trim());
  });
  return { params: window.params, sql: segments.join('\nUNION ALL\n') };
}

function buildPageQuerySummarySource(candidate: Candidate): SourceSql | null {
  const window = buildSummaryWindowParams(candidate);
  if (!window) return null;
  const segments = [
    `
      SELECT ownerId, siteUrl, page, pageKey, query, clicks, impressions, positionSum
      FROM gsc_page_query_monthly_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND monthStart >= @summaryMonthStart AND monthStart <= @summaryMonthEnd
    `.trim(),
  ];
  window.summaryWindow.edgeRanges.forEach((_, index) => {
    segments.push(`
      SELECT ownerId, siteUrl, page, COALESCE(NULLIF(pageKey, ''), page) AS pageKey, query, clicks, impressions, position * impressions AS positionSum
      FROM gsc_page_query_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @edgeStart${index} AND date <= @edgeEnd${index}
    `.trim());
  });
  return { params: window.params, sql: segments.join('\nUNION ALL\n') };
}

async function runLegacyVsGrouped(
  db: AppDatabase,
  label: string,
  countSql: string,
  rowsSql: string,
  groupedSql: string,
  params: Record<string, unknown>,
) {
  const legacyCount = await timed(`${label} legacy-count`, () => db.get<{ totalRowCount: number }>(countSql, params));
  const legacyRows = await timed(`${label} legacy-rows`, () => db.all(rowsSql, params));
  const grouped = await timed(`${label} grouped`, () => db.all(`
    SELECT grouped.*, COUNT(*) OVER() AS totalRowCount
    FROM (${groupedSql}) grouped
    ORDER BY clicks DESC, impressions DESC
    LIMIT @limit OFFSET @offset
  `, params));
  const groupedRows = Array.isArray(grouped.result) ? grouped.result as Array<Record<string, unknown>> : [];
  const totalFromGrouped = groupedRows.length > 0 ? numberValue(groupedRows[0]?.totalRowCount) : 0;
  console.log(`${label} totals legacy=${numberValue((legacyCount.result as any)?.totalRowCount)} grouped=${totalFromGrouped} rows=${groupedRows.length}`);
  return {
    groupedMs: grouped.elapsedMs,
    legacyCountMs: legacyCount.elapsedMs,
    legacyRowsMs: legacyRows.elapsedMs,
  };
}

function coverageMap(coverage: Awaited<ReturnType<typeof getGscMonthlySummaryCoverage>>) {
  return new Map(coverage.tables.map((table) => [table.tableName, table]));
}

async function main() {
  const db = await initializeDatabase();
  try {
    const candidate = await getCandidate(db);
    const baseParams = buildBaseParams(candidate);
    const coverage = await getGscMonthlySummaryCoverage(db, candidate, ALL_GSC_MONTHLY_SUMMARY_TABLES);
    const coverageByTable = coverageMap(coverage);

    console.log(JSON.stringify({
      dialect: db.dialect,
      ownerId: candidate.ownerId,
      siteUrl: candidate.siteUrl,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
      detailRows: candidate.detailRows,
      summaryWindow: getGscSummaryWindow(candidate.startDate, candidate.endDate),
      summaryCoverage: ALL_GSC_MONTHLY_SUMMARY_TABLES.map((tableName) => {
        const table = coverageByTable.get(tableName);
        return {
          availableMonths: table?.availableMonthStarts.length || 0,
          fullCoverage: table?.hasFullCoverage || false,
          missingMonths: table?.missingMonthStarts || [],
          tableName,
        };
      }),
    }, null, 2));

    const selectedPage = await db.get<{ page: string; pageKey: string }>(`
      SELECT MIN(page) AS page,
             COALESCE(NULLIF(pageKey, ''), page) AS pageKey
      FROM gsc_page_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date BETWEEN ? AND ? AND COALESCE(NULLIF(pageKey, ''), page) <> ''
      GROUP BY COALESCE(NULLIF(pageKey, ''), page)
      ORDER BY SUM(clicks) DESC, SUM(impressions) DESC
      LIMIT 1
    `, [candidate.ownerId, candidate.siteUrl, candidate.startDate, candidate.endDate]);
    console.log(`selectedPageKey=${selectedPage?.pageKey || ''}`);

    const overview = await timed('overview daily', () => db.all(`
      SELECT date,
             SUM(clicks) AS clicks,
             SUM(impressions) AS impressions,
             CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
             CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) * 1.0 / SUM(impressions) ELSE 0 END AS position
      FROM gsc_site_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate
      GROUP BY date
      ORDER BY date ASC
    `, baseParams));
    console.log(`overviewRows=${(overview.result as any[]).length}`);

    const visibleQueriesDailyLegacy = await timed('visible queries daily legacy-distinct', () => db.all(`
      SELECT date,
             COUNT(DISTINCT NULLIF(query, '')) AS queryCount,
             SUM(clicks) AS clicks,
             SUM(impressions) AS impressions,
             CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
             CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) * 1.0 / SUM(impressions) ELSE 0 END AS position
      FROM gsc_query_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate
      GROUP BY date
      ORDER BY date ASC
    `, baseParams));
    const visibleQueriesDaily = await timed('visible queries daily optimized-count', () => db.all(`
      SELECT date,
             COUNT(NULLIF(query, '')) AS queryCount,
             SUM(clicks) AS clicks,
             SUM(impressions) AS impressions,
             CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
             CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) * 1.0 / SUM(impressions) ELSE 0 END AS position
      FROM gsc_query_metrics
      WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate
      GROUP BY date
      ORDER BY date ASC
    `, baseParams));
    console.log(`visibleQueryDays=${(visibleQueriesDaily.result as any[]).length} legacyDays=${(visibleQueriesDailyLegacy.result as any[]).length}`);

    const querySource = coverageByTable.get('gsc_query_monthly_metrics')?.hasFullCoverage ? buildQuerySummarySource(candidate) : null;
    const queryParams = querySource ? { ...baseParams, ...querySource.params } : baseParams;
    const queryFrom = querySource
      ? `FROM (${querySource.sql}) source WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND query <> ''`
      : `FROM gsc_query_metrics WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate AND query <> ''`;
    const queryGroupedSql = querySource
      ? `
        SELECT query,
               SUM(clicks) AS clicks,
               SUM(impressions) AS impressions,
               CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
               CASE WHEN SUM(impressions) > 0 THEN SUM(positionSum) * 1.0 / SUM(impressions) ELSE 0 END AS position
        ${queryFrom}
        GROUP BY query
      `
      : `
        SELECT query,
               SUM(clicks) AS clicks,
               SUM(impressions) AS impressions,
               CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
               CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) * 1.0 / SUM(impressions) ELSE 0 END AS position
        ${queryFrom}
        GROUP BY query
      `;
    const queryRowsSql = `${queryGroupedSql}
      ORDER BY clicks DESC, impressions DESC
      LIMIT @limit OFFSET @offset`;
    const queryCountSql = `SELECT COUNT(DISTINCT query) AS totalRowCount ${queryFrom}`;
    await runLegacyVsGrouped(db, 'queries report', queryCountSql, queryRowsSql, queryGroupedSql, queryParams);

    const pageSource = coverageByTable.get('gsc_page_monthly_metrics')?.hasFullCoverage ? buildPageSummarySource(candidate) : null;
    const pageParams = pageSource ? { ...baseParams, ...pageSource.params } : baseParams;
    const pageFrom = pageSource
      ? `FROM (${pageSource.sql}) source WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND pageKey <> ''`
      : `FROM gsc_page_metrics WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate AND pageKey <> ''`;
    const pageGroupedSql = pageSource
      ? `
        SELECT MIN(page) AS page,
               pageKey,
               SUM(queryCount) AS queryCount,
               SUM(clicks) AS clicks,
               SUM(impressions) AS impressions,
               CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
               CASE WHEN SUM(impressions) > 0 THEN SUM(positionSum) * 1.0 / SUM(impressions) ELSE 0 END AS position
        ${pageFrom}
        GROUP BY pageKey
      `
      : `
        SELECT MIN(page) AS page,
               pageKey,
               SUM(queryCount) AS queryCount,
               SUM(clicks) AS clicks,
               SUM(impressions) AS impressions,
               CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
               CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) * 1.0 / SUM(impressions) ELSE 0 END AS position
        ${pageFrom}
        GROUP BY pageKey
      `;
    const pageRowsSql = `${pageGroupedSql}
      ORDER BY clicks DESC, impressions DESC
      LIMIT @limit OFFSET @offset`;
    const pageCountSql = `SELECT COUNT(DISTINCT pageKey) AS totalRowCount ${pageFrom}`;
    await runLegacyVsGrouped(db, 'pages report', pageCountSql, pageRowsSql, pageGroupedSql, pageParams);
    await runLegacyVsGrouped(db, 'visible queries table', pageCountSql, pageRowsSql, pageGroupedSql, pageParams);

    const countrySource = coverageByTable.get('gsc_country_monthly_metrics')?.hasFullCoverage ? buildCountrySummarySource(candidate) : null;
    const countryParams = countrySource ? { ...baseParams, ...countrySource.params } : baseParams;
    const countryFrom = countrySource
      ? `FROM (${countrySource.sql}) source WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND country <> ''`
      : `FROM gsc_country_metrics WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate AND country <> ''`;
    const countryGroupedSql = countrySource
      ? `
        SELECT country,
               SUM(clicks) AS clicks,
               SUM(impressions) AS impressions,
               CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
               CASE WHEN SUM(impressions) > 0 THEN SUM(positionSum) * 1.0 / SUM(impressions) ELSE 0 END AS position
        ${countryFrom}
        GROUP BY country
      `
      : `
        SELECT country,
               SUM(clicks) AS clicks,
               SUM(impressions) AS impressions,
               CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
               CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) * 1.0 / SUM(impressions) ELSE 0 END AS position
        ${countryFrom}
        GROUP BY country
      `;
    const countryRowsSql = `${countryGroupedSql}
      ORDER BY clicks DESC, impressions DESC
      LIMIT @limit OFFSET @offset`;
    const countryCountSql = `SELECT COUNT(DISTINCT country) AS totalRowCount ${countryFrom}`;
    await runLegacyVsGrouped(db, 'countries report', countryCountSql, countryRowsSql, countryGroupedSql, countryParams);

    if (selectedPage?.pageKey) {
      const pageQuerySource = coverageByTable.get('gsc_page_query_monthly_metrics')?.hasFullCoverage ? buildPageQuerySummarySource(candidate) : null;
      const pageQueryParams = {
        ...baseParams,
        ...(pageQuerySource ? pageQuerySource.params : {}),
        selectedPageKey: selectedPage.pageKey,
      };
      const pageQueryFrom = pageQuerySource
        ? `FROM (${pageQuerySource.sql}) source WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND pageKey = @selectedPageKey AND query <> ''`
        : `FROM gsc_page_query_metrics WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate AND COALESCE(NULLIF(pageKey, ''), page) = @selectedPageKey AND query <> ''`;
      const pageQueryGroupedSql = pageQuerySource
        ? `
          SELECT query,
                 SUM(clicks) AS clicks,
                 SUM(impressions) AS impressions,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(positionSum) * 1.0 / SUM(impressions) ELSE 0 END AS position
          ${pageQueryFrom}
          GROUP BY query
        `
        : `
          SELECT query,
                 SUM(clicks) AS clicks,
                 SUM(impressions) AS impressions,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) * 1.0 / SUM(impressions) ELSE 0 END AS ctr,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) * 1.0 / SUM(impressions) ELSE 0 END AS position
          ${pageQueryFrom}
          GROUP BY query
        `;
      const pageQueryRowsSql = `${pageQueryGroupedSql}
        ORDER BY clicks DESC, impressions DESC
        LIMIT @limit OFFSET @offset`;
      const pageQueryCountSql = `SELECT COUNT(DISTINCT query) AS totalRowCount ${pageQueryFrom}`;
      await runLegacyVsGrouped(db, 'page-filtered queries', pageQueryCountSql, pageQueryRowsSql, pageQueryGroupedSql, pageQueryParams);
    }
  } finally {
    await db.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
