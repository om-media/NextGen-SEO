import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import {
  asTrimmedString,
  hasValidMetricRows,
  isIsoDateString,
  isNonEmptyString,
  isValidWarehouseDimensions,
  validateDimensionFilterGroups,
} from '../validation.js';
import { canonicalPageKey } from '../reporting/url.js';
import { googleApiFetchJson } from '../services/googleAuth.js';
import { canUseRawExports } from '../../shared/plans.js';
import { listWarehouseJobs, queueWarehouseSyncJob } from '../services/warehouseJobs.js';

const GA4_WAREHOUSE_METRICS = new Set(['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount']);
const GA4_WAREHOUSE_DIMENSIONS = new Set(['date', 'pagePath', 'landingPagePlusQueryString']);
const GA4_ROW_LIMIT = 100_000;
const GA4_MAX_PAGES_PER_DATASET = 100;

const normalizeGa4Date = (value: unknown) => {
  if (typeof value !== 'string') return null;
  if (isIsoDateString(value)) return value;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

const readField = (row: any, key: string) => row?.[key] ?? row?.[key.toLowerCase()];
const toCoverageNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

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

const coverageFromRows = (expectedDates: string[], rows: Array<{ date?: string | null; rowCount?: number | null }>) => {
  const countByDate = new Map(rows.map((row) => [String(row.date || ''), toCoverageNumber(row.rowCount)]));
  const coveredDates = expectedDates.filter((date) => (countByDate.get(date) || 0) > 0);
  const missingDates = expectedDates.filter((date) => !coveredDates.includes(date));
  const totalRows = rows.reduce((sum, row) => sum + toCoverageNumber(row.rowCount), 0);

  return {
    coveredDateCount: coveredDates.length,
    coverageRatio: expectedDates.length > 0 ? coveredDates.length / expectedDates.length : 0,
    expectedDateCount: expectedDates.length,
    firstCoveredDate: coveredDates[0] || null,
    lastCoveredDate: coveredDates[coveredDates.length - 1] || null,
    missingDateCount: missingDates.length,
    missingDates: missingDates.slice(0, 31),
    totalRows,
  };
};

export function registerWarehouseRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);
  const toFiniteNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };

  const getReplaceDates = (value: unknown) => {
    if (!Array.isArray(value)) return [];
    return value.filter((date): date is string => typeof date === 'string' && isIsoDateString(date));
  };

  const fetchLiveGa4Report = async (
    ownerId: string,
    propertyId: string,
    startDate: string,
    endDate: string,
    dimensions: string[],
    metrics: string[],
    dimensionFilter?: unknown,
    pagination?: { limit?: number; offset?: number },
  ) => googleApiFetchJson(
    db,
    ownerId,
    `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
    {
      method: 'POST',
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: dimensions.map((name) => ({ name })),
        ...(pagination?.limit !== undefined ? { limit: pagination.limit } : {}),
        metrics: metrics.map((name) => ({ name })),
        ...(pagination?.offset !== undefined ? { offset: pagination.offset } : {}),
        ...(dimensionFilter ? { dimensionFilter } : {}),
      }),
    },
  );

  const fetchAndStoreGa4Pages = async (
    ownerId: string,
    propertyId: string,
    siteUrl: string,
    startDate: string,
    endDate: string,
  ) => {
    const rows = [];
    let offset = 0;

    for (let page = 0; page < GA4_MAX_PAGES_PER_DATASET; page += 1) {
      const data = await fetchLiveGa4Report(
        ownerId,
        propertyId,
        startDate,
        endDate,
        ['date', 'landingPagePlusQueryString'],
        ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
        undefined,
        { limit: GA4_ROW_LIMIT, offset },
      );
      const batch = Array.isArray(data?.rows) ? data.rows : [];
      rows.push(...batch);
      if (batch.length < GA4_ROW_LIMIT) {
        break;
      }
      offset += GA4_ROW_LIMIT;
    }

    const replaceAndInsert = db.transaction(async () => {
      await db.run(
        'DELETE FROM ga4_page_metrics WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?',
        [ownerId, propertyId, startDate, endDate],
      );

      for (const row of rows) {
        const date = normalizeGa4Date(row.dimensionValues?.[0]?.value);
        const pagePath = row.dimensionValues?.[1]?.value;
        if (!date || !isNonEmptyString(pagePath)) continue;

        await db.run(`
          INSERT INTO ga4_page_metrics (ownerId, propertyId, siteUrl, date, pagePath, pageKey, sessions, totalUsers, pageViews, bounceRate, eventCount)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ownerId, propertyId, date, pageKey) DO UPDATE SET
            siteUrl=excluded.siteUrl,
            pagePath=excluded.pagePath,
            sessions=excluded.sessions,
            totalUsers=excluded.totalUsers,
            pageViews=excluded.pageViews,
            bounceRate=excluded.bounceRate,
            eventCount=excluded.eventCount
        `, [
          ownerId,
          propertyId,
          siteUrl,
          date,
          pagePath,
          canonicalPageKey(pagePath, siteUrl),
          toFiniteNumber(row.metricValues?.[0]?.value),
          toFiniteNumber(row.metricValues?.[1]?.value),
          toFiniteNumber(row.metricValues?.[2]?.value),
          toFiniteNumber(row.metricValues?.[3]?.value),
          toFiniteNumber(row.metricValues?.[4]?.value),
        ]);
      }
    });

    await replaceAndInsert();
    return rows.length;
  };

  const isExactPageFilter = (dimensionFilter: any) => {
    const filter = dimensionFilter?.filter;
    const fieldName = filter?.fieldName;
    const stringFilter = filter?.stringFilter;
    if (!filter || !stringFilter || !['pagePath', 'landingPagePlusQueryString'].includes(fieldName)) return false;
    return stringFilter.matchType === undefined || stringFilter.matchType === 'EXACT';
  };

  const getExactPageFilterValue = (dimensionFilter: any) => {
    if (!isExactPageFilter(dimensionFilter)) return null;
    const value = dimensionFilter.filter.stringFilter.value;
    return isNonEmptyString(value) ? value : null;
  };

  const canServeGa4FromWarehouse = (dimensions: string[], metrics: string[], dimensionFilter: unknown) => {
    if (dimensions.some((dimension) => !GA4_WAREHOUSE_DIMENSIONS.has(dimension))) return false;
    if (metrics.some((metric) => !GA4_WAREHOUSE_METRICS.has(metric))) return false;
    if (!dimensionFilter) return true;
    return isExactPageFilter(dimensionFilter);
  };

  const ensureGa4WarehouseRange = async (
    ownerId: string,
    propertyId: string,
    siteUrl: string,
    startDate: string,
    endDate: string,
  ) => {
    const freshness = await db.get<any>(`
      SELECT MIN(date) AS earliestDate, MAX(date) AS latestDate, COUNT(*) AS rowCount
      FROM ga4_page_metrics
      WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
    `, [ownerId, propertyId, startDate, endDate]);

    const rowCount = toFiniteNumber(readField(freshness, 'rowCount'));
    const earliestDate = readField(freshness, 'earliestDate');
    const latestDate = readField(freshness, 'latestDate');
    if (rowCount === 0 || !earliestDate || !latestDate || earliestDate > startDate || latestDate < endDate) {
      await fetchAndStoreGa4Pages(ownerId, propertyId, siteUrl, startDate, endDate);
    }
  };

  const selectGa4MetricSql = (metric: string) => {
    if (metric === 'sessions') return 'SUM(sessions) AS sessions';
    if (metric === 'totalUsers') return 'SUM(totalUsers) AS totalUsers';
    if (metric === 'screenPageViews') return 'SUM(pageViews) AS screenPageViews';
    if (metric === 'eventCount') return 'SUM(eventCount) AS eventCount';
    return 'CASE WHEN SUM(sessions) > 0 THEN SUM(bounceRate * sessions)*1.0/SUM(sessions) ELSE 0 END AS bounceRate';
  };

  const readGa4MetricValue = (row: any, metric: string) => {
    if (metric === 'screenPageViews') return toFiniteNumber(readField(row, 'screenPageViews')).toString();
    return toFiniteNumber(readField(row, metric)).toString();
  };

  const readGa4WarehouseReport = async (
    ownerId: string,
    propertyId: string,
    siteUrl: string,
    startDate: string,
    endDate: string,
    dimensions: string[],
    metrics: string[],
    dimensionFilter?: any,
  ) => {
    const whereParts = ['ownerId = ?', 'propertyId = ?', 'date >= ?', 'date <= ?'];
    const params: unknown[] = [ownerId, propertyId, startDate, endDate];
    const exactPageFilterValue = getExactPageFilterValue(dimensionFilter);
    if (exactPageFilterValue) {
      whereParts.push('pageKey = ?');
      params.push(canonicalPageKey(exactPageFilterValue, siteUrl));
    }

    const selectedDimensions = dimensions.map((dimension) => {
      if (dimension === 'date') return 'date';
      return 'MIN(pagePath) AS pagePath';
    });
    const groupBy = dimensions.includes('date') && dimensions.some((dimension) => dimension !== 'date')
      ? 'GROUP BY date, pageKey'
      : dimensions.includes('date')
        ? 'GROUP BY date'
        : dimensions.some((dimension) => dimension !== 'date')
          ? 'GROUP BY pageKey'
          : '';
    const firstMetric = metrics[0] || 'sessions';
    const firstMetricAlias = firstMetric === 'screenPageViews' ? 'screenPageViews' : firstMetric;
    const orderBy = dimensions.includes('date')
      ? 'ORDER BY date ASC'
      : dimensions.length > 0
        ? `ORDER BY ${firstMetricAlias} DESC`
        : '';
    const selectParts = [
      ...selectedDimensions,
      ...metrics.map(selectGa4MetricSql),
    ];

    const rows = await db.all<any>(`
      SELECT ${selectParts.join(', ')}
      FROM ga4_page_metrics
      WHERE ${whereParts.join(' AND ')}
      ${groupBy}
      ${orderBy}
    `, params);

    return {
      rows: rows.map((row) => ({
        dimensionValues: dimensions.map((dimension) => ({
          value: dimension === 'date' ? String(readField(row, 'date') || '') : String(readField(row, 'pagePath') || ''),
        })),
        metricValues: metrics.map((metric) => ({ value: readGa4MetricValue(row, metric) })),
      })),
      metadata: { source: 'warehouse' },
    };
  };

  app.post('/api/warehouse/ga4/report', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const {
      propertyId,
      startDate,
      endDate,
      dimensions = [],
      metrics = [],
      dimensionFilter,
      siteUrl,
    } = req.body;

    if (
      !isNonEmptyString(propertyId)
      || !isIsoDateString(startDate)
      || !isIsoDateString(endDate)
      || !Array.isArray(dimensions)
      || !Array.isArray(metrics)
      || dimensions.some((dimension) => !isNonEmptyString(dimension))
      || metrics.some((metric) => !isNonEmptyString(metric))
    ) {
      return res.status(400).json({ error: 'Invalid GA4 report payload' });
    }

    try {
      const user = await db.get<any>('SELECT activatedSiteUrl FROM users WHERE id = ?', [ownerId]);
      const resolvedSiteUrl = isNonEmptyString(siteUrl)
        ? siteUrl
        : isNonEmptyString(readField(user, 'activatedSiteUrl'))
          ? readField(user, 'activatedSiteUrl')
          : propertyId;

      if (canServeGa4FromWarehouse(dimensions, metrics, dimensionFilter)) {
        await ensureGa4WarehouseRange(ownerId, propertyId, resolvedSiteUrl, startDate, endDate);
        const report = await readGa4WarehouseReport(
          ownerId,
          propertyId,
          resolvedSiteUrl,
          startDate,
          endDate,
          dimensions,
          metrics,
          dimensionFilter,
        );
        return res.json(report);
      }

      const report = await fetchLiveGa4Report(ownerId, propertyId, startDate, endDate, dimensions, metrics, dimensionFilter);
      return res.json({
        ...report,
        metadata: {
          ...(report?.metadata || {}),
          source: 'live',
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to fetch GA4 report' });
    }
  });

  app.post('/api/warehouse/ingest/site', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, rows } = req.body;
    if (!isNonEmptyString(siteUrl) || !hasValidMetricRows(rows, 1)) return res.status(400).json({ error: 'Invalid payload' });
    try {
      const insertMany = db.transaction(async (metrics: any[]) => {
        for (const row of metrics) {
          const date = row.keys[0];
          await db.run(`
            INSERT INTO gsc_site_metrics (ownerId, siteUrl, date, clicks, impressions, ctr, position)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ownerId, siteUrl, date) DO UPDATE SET
              clicks=excluded.clicks,
              impressions=excluded.impressions,
              ctr=excluded.ctr,
              position=excluded.position
          `, [ownerId, siteUrl, date, row.clicks, row.impressions, row.ctr, row.position]);
        }
      });
      await insertMany(rows);
      res.json({ success: true, count: rows.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/ingest/query', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, rows, replaceDates } = req.body;
    const datesToReplace = getReplaceDates(replaceDates);
    if (!isNonEmptyString(siteUrl) || (!hasValidMetricRows(rows, 2) && datesToReplace.length === 0)) return res.status(400).json({ error: 'Invalid payload' });
    if (replaceDates !== undefined && datesToReplace.length !== replaceDates.length) return res.status(400).json({ error: 'Invalid replaceDates' });
    try {
      const insertMany = db.transaction(async (metrics: any[]) => {
        for (const date of datesToReplace) {
          await db.run('DELETE FROM gsc_query_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [ownerId, siteUrl, date]);
        }
        for (const row of metrics) {
          const date = row.keys[0];
          const query = row.keys[1] || '';
          await db.run(`
            INSERT INTO gsc_query_metrics (ownerId, siteUrl, date, query, clicks, impressions, ctr, position)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ownerId, siteUrl, date, query) DO UPDATE SET
              clicks=excluded.clicks,
              impressions=excluded.impressions,
              ctr=excluded.ctr,
              position=excluded.position
          `, [ownerId, siteUrl, date, query, row.clicks, row.impressions, row.ctr, row.position]);
        }
      });
      const rowsToInsert = Array.isArray(rows) ? rows : [];
      await insertMany(rowsToInsert);
      res.json({ success: true, count: rowsToInsert.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/ingest/page_query', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, rows, replaceDates } = req.body;
    const datesToReplace = getReplaceDates(replaceDates);
    if (!isNonEmptyString(siteUrl) || (!hasValidMetricRows(rows, 3) && datesToReplace.length === 0)) return res.status(400).json({ error: 'Invalid payload' });
    if (replaceDates !== undefined && datesToReplace.length !== replaceDates.length) return res.status(400).json({ error: 'Invalid replaceDates' });
    try {
      const insertMany = db.transaction(async (metrics: any[]) => {
        for (const date of datesToReplace) {
          await db.run('DELETE FROM gsc_page_query_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [ownerId, siteUrl, date]);
        }
        for (const row of metrics) {
          const date = row.keys[0];
          const page = row.keys[1] || '';
          const pageKey = canonicalPageKey(page, siteUrl);
          const query = row.keys[2] || '';
          await db.run(`
            INSERT INTO gsc_page_query_metrics (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ownerId, siteUrl, date, page, query) DO UPDATE SET
              pageKey=excluded.pageKey,
              clicks=excluded.clicks,
              impressions=excluded.impressions,
              ctr=excluded.ctr,
              position=excluded.position
          `, [ownerId, siteUrl, date, page, pageKey, query, row.clicks, row.impressions, row.ctr, row.position]);
        }
      });
      const rowsToInsert = Array.isArray(rows) ? rows : [];
      await insertMany(rowsToInsert);
      res.json({ success: true, count: rowsToInsert.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/ingest/ga4-page', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { propertyId, siteUrl, rows, replaceDates } = req.body;
    const datesToReplace = getReplaceDates(replaceDates);
    if (!isNonEmptyString(propertyId) || !isNonEmptyString(siteUrl) || (!Array.isArray(rows) && datesToReplace.length === 0)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    if (replaceDates !== undefined && datesToReplace.length !== replaceDates.length) return res.status(400).json({ error: 'Invalid replaceDates' });

    try {
      const insertMany = db.transaction(async (metrics: any[]) => {
        for (const date of datesToReplace) {
          await db.run('DELETE FROM ga4_page_metrics WHERE ownerId = ? AND propertyId = ? AND date = ?', [ownerId, propertyId, date]);
        }
        for (const row of metrics) {
          const date = row.date || row.keys?.[0];
          const pagePath = row.pagePath || row.keys?.[1];
          if (!isIsoDateString(date) || !isNonEmptyString(pagePath)) continue;
          const pageKey = canonicalPageKey(pagePath, siteUrl);
          await db.run(`
            INSERT INTO ga4_page_metrics (ownerId, propertyId, siteUrl, date, pagePath, pageKey, sessions, totalUsers, pageViews, bounceRate, eventCount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ownerId, propertyId, date, pageKey) DO UPDATE SET
              siteUrl=excluded.siteUrl,
              pagePath=excluded.pagePath,
              sessions=excluded.sessions,
              totalUsers=excluded.totalUsers,
              pageViews=excluded.pageViews,
              bounceRate=excluded.bounceRate,
              eventCount=excluded.eventCount
          `, [
            ownerId,
            propertyId,
            siteUrl,
            date,
            pagePath,
            pageKey,
            toFiniteNumber(row.sessions),
            toFiniteNumber(row.totalUsers),
            toFiniteNumber(row.pageViews),
            toFiniteNumber(row.bounceRate),
            toFiniteNumber(row.eventCount),
          ]);
        }
      });
      const rowsToInsert = Array.isArray(rows) ? rows : [];
      await insertMany(rowsToInsert);
      res.json({ success: true, count: rowsToInsert.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/warehouse/status', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = req.query.siteUrl;
    if (siteUrl !== undefined && !isNonEmptyString(siteUrl)) return res.status(400).json({ error: 'Invalid siteUrl' });
    try {
      if (siteUrl) {
        const status = await db.get<Record<string, unknown>>('SELECT * FROM warehouse_sync_status WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]);
        const metricStatus = await db.get<any>(`
          SELECT
            MIN(date) as earliestMetricDate,
            MAX(date) as lastMetricDate,
            COUNT(DISTINCT date) as metricDayCount
          FROM gsc_site_metrics
          WHERE ownerId = ? AND siteUrl = ?
        `, [ownerId, siteUrl]);

        res.json({
          ...(status || { siteUrl, status: 'uninitialized' }),
          earliestMetricDate: metricStatus?.earliestMetricDate || null,
          lastMetricDate: metricStatus?.lastMetricDate || null,
          metricDayCount: metricStatus?.metricDayCount || 0,
        });
      } else {
        const allSites = new Set<string>();

        const statuses = await db.all<any>('SELECT siteUrl FROM warehouse_sync_status WHERE ownerId = ?', [ownerId]);
        statuses.forEach((s) => allSites.add(s.siteUrl));

        const queries = await db.all<any>('SELECT DISTINCT siteUrl FROM gsc_site_metrics WHERE ownerId = ?', [ownerId]);
        queries.forEach((s) => allSites.add(s.siteUrl));

        const logs = await db.all<any>('SELECT DISTINCT siteUrl FROM server_logs WHERE ownerId = ?', [ownerId]);
        logs.forEach((s) => allSites.add(s.siteUrl));

        const caches = await db.all<any>('SELECT DISTINCT siteUrl FROM url_inspection_cache WHERE ownerId = ?', [ownerId]);
        caches.forEach((s) => allSites.add(s.siteUrl));

        const keywords = await db.all<any>('SELECT DISTINCT siteUrl FROM tracked_keywords WHERE ownerId = ?', [ownerId]);
        keywords.forEach((s) => allSites.add(s.siteUrl));

        const result = Array.from(allSites).map((url) => ({ siteUrl: url }));
        res.json(result);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/warehouse/coverage', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const propertyId = asTrimmedString(req.query.propertyId) || '';
    const startDate = asTrimmedString(req.query.startDate);
    const endDate = asTrimmedString(req.query.endDate);

    if (!siteUrl || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Missing or invalid coverage parameters' });
    }

    try {
      const expectedDates = eachIsoDate(startDate, endDate);
      const [gscSiteRows, gscQueryRows, gscPageQueryRows, ga4PageRows, latestCrawl, warehouseJobRows] = await Promise.all([
        db.all<{ date: string; rowCount: number }>(`
          SELECT date, COUNT(*) AS rowCount
          FROM gsc_site_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
          ORDER BY date ASC
        `, [ownerId, siteUrl, startDate, endDate]),
        db.all<{ date: string; rowCount: number }>(`
          SELECT date, COUNT(*) AS rowCount
          FROM gsc_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
          ORDER BY date ASC
        `, [ownerId, siteUrl, startDate, endDate]),
        db.all<{ date: string; rowCount: number }>(`
          SELECT date, COUNT(*) AS rowCount
          FROM gsc_page_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
          ORDER BY date ASC
        `, [ownerId, siteUrl, startDate, endDate]),
        propertyId
          ? db.all<{ date: string; rowCount: number }>(`
            SELECT date, COUNT(*) AS rowCount
            FROM ga4_page_metrics
            WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
            GROUP BY date
            ORDER BY date ASC
          `, [ownerId, propertyId, startDate, endDate])
          : Promise.resolve([]),
        db.get<any>(`
          SELECT *
          FROM crawl_jobs
          WHERE ownerId = ? AND siteUrl = ?
          ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
          LIMIT 1
        `, [ownerId, siteUrl]),
        db.all<any>(`
          SELECT status, COUNT(*) AS jobCount
          FROM warehouse_jobs
          WHERE ownerId = ? AND siteUrl = ? AND targetDate >= ? AND targetDate <= ?
          GROUP BY status
        `, [ownerId, siteUrl, startDate, endDate]),
      ]);

      const crawlSummary = latestCrawl
        ? await db.get<any>(`
          SELECT
            COUNT(*) AS totalPages,
            SUM(CASE WHEN statusCode BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS successPages,
            SUM(CASE WHEN statusCode BETWEEN 300 AND 399 THEN 1 ELSE 0 END) AS redirectPages,
            SUM(CASE WHEN statusCode >= 400 OR statusCode IS NULL THEN 1 ELSE 0 END) AS errorPages,
            SUM(CASE WHEN noindex = 1 THEN 1 ELSE 0 END) AS noindexPages
          FROM crawl_pages
          WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
        `, [ownerId, siteUrl, latestCrawl.id])
        : null;

      return res.json({
        crawl: latestCrawl ? {
          completedAt: latestCrawl.completedAt || null,
          id: latestCrawl.id,
          startedAt: latestCrawl.startedAt || null,
          status: latestCrawl.status || 'unknown',
          summary: {
            errorPages: toFiniteNumber(crawlSummary?.errorPages),
            noindexPages: toFiniteNumber(crawlSummary?.noindexPages),
            redirectPages: toFiniteNumber(crawlSummary?.redirectPages),
            successPages: toFiniteNumber(crawlSummary?.successPages),
            totalPages: toFiniteNumber(crawlSummary?.totalPages),
          },
          updatedAt: latestCrawl.updatedAt || null,
        } : null,
        dateRange: {
          endDate,
          startDate,
          totalDays: expectedDates.length,
        },
        ga4: {
          enabled: Boolean(propertyId),
          pages: coverageFromRows(expectedDates, ga4PageRows),
          propertyId: propertyId || null,
        },
        gsc: {
          pageQuery: coverageFromRows(expectedDates, gscPageQueryRows),
          query: coverageFromRows(expectedDates, gscQueryRows),
          site: coverageFromRows(expectedDates, gscSiteRows),
        },
        warehouseJobs: {
          completed: toCoverageNumber(warehouseJobRows.find((row) => row.status === 'completed')?.jobCount),
          error: toCoverageNumber(warehouseJobRows.find((row) => row.status === 'error')?.jobCount),
          queued: toCoverageNumber(warehouseJobRows.find((row) => row.status === 'queued')?.jobCount),
          retrying: toCoverageNumber(warehouseJobRows.find((row) => row.status === 'retrying')?.jobCount),
          running: toCoverageNumber(warehouseJobRows.find((row) => row.status === 'running')?.jobCount),
          total: warehouseJobRows.reduce((sum, row) => sum + toCoverageNumber(row.jobCount), 0),
        },
        siteUrl,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to load warehouse coverage' });
    }
  });

  app.post('/api/warehouse/status', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, lastSyncDate, earliestSyncDate, status } = req.body;
    if (!isNonEmptyString(siteUrl)) return res.status(400).json({ error: 'Invalid siteUrl' });
    if (lastSyncDate !== undefined && lastSyncDate !== null && !isIsoDateString(lastSyncDate)) return res.status(400).json({ error: 'Invalid lastSyncDate' });
    if (earliestSyncDate !== undefined && earliestSyncDate !== null && !isIsoDateString(earliestSyncDate)) return res.status(400).json({ error: 'Invalid earliestSyncDate' });
    if (status !== undefined && status !== null && !isNonEmptyString(status)) return res.status(400).json({ error: 'Invalid status' });
    try {
      await db.run(`
        INSERT INTO warehouse_sync_status (ownerId, siteUrl, lastSyncDate, earliestSyncDate, status, lastUpdated)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(ownerId, siteUrl) DO UPDATE SET
          lastSyncDate=CASE
            WHEN excluded.lastSyncDate IS NULL THEN lastSyncDate
            WHEN lastSyncDate IS NULL THEN excluded.lastSyncDate
            WHEN excluded.lastSyncDate > lastSyncDate THEN excluded.lastSyncDate
            ELSE lastSyncDate
          END,
          earliestSyncDate=CASE
            WHEN excluded.earliestSyncDate IS NULL THEN earliestSyncDate
            WHEN earliestSyncDate IS NULL THEN excluded.earliestSyncDate
            WHEN excluded.earliestSyncDate < earliestSyncDate THEN excluded.earliestSyncDate
            ELSE earliestSyncDate
          END,
          status=IFNULL(excluded.status, status),
          lastUpdated=excluded.lastUpdated
      `, [ownerId, siteUrl, lastSyncDate, earliestSyncDate, status, new Date().toISOString()]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/jobs', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, propertyId, targetDate } = req.body || {};
    if (!isNonEmptyString(siteUrl) || !isIsoDateString(targetDate)) {
      return res.status(400).json({ error: 'Invalid warehouse job payload' });
    }

    try {
      const job = await queueWarehouseSyncJob(db, {
        ownerId,
        propertyId: isNonEmptyString(propertyId) ? propertyId : null,
        siteUrl,
        targetDate,
      });
      res.json({ job });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to queue warehouse sync job' });
    }
  });

  app.post('/api/warehouse/jobs/missing', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, propertyId, startDate, endDate, maxDates } = req.body || {};
    if (!isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Invalid missing warehouse job payload' });
    }

    try {
      const user = await db.get<any>('SELECT gscRefreshToken FROM users WHERE id = ?', [ownerId]);
      if (!user?.gscRefreshToken) {
        return res.status(409).json({ error: 'Connect Google data before queueing warehouse gap fills.' });
      }

      const expectedDates = eachIsoDate(startDate, endDate);
      const queueLimit = Number.isFinite(Number(maxDates)) ? Math.min(Math.max(Number(maxDates), 1), 120) : 60;
      const [gscSiteRows, gscQueryRows, gscPageQueryRows, ga4PageRows, jobRows] = await Promise.all([
        db.all<{ date: string }>(`
          SELECT date
          FROM gsc_site_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
        `, [ownerId, siteUrl, startDate, endDate]),
        db.all<{ date: string }>(`
          SELECT date
          FROM gsc_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
        `, [ownerId, siteUrl, startDate, endDate]),
        db.all<{ date: string }>(`
          SELECT date
          FROM gsc_page_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
        `, [ownerId, siteUrl, startDate, endDate]),
        isNonEmptyString(propertyId)
          ? db.all<{ date: string }>(`
            SELECT date
            FROM ga4_page_metrics
            WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
            GROUP BY date
          `, [ownerId, propertyId, startDate, endDate])
          : Promise.resolve([]),
        db.all<{ targetDate: string }>(`
          SELECT targetDate
          FROM warehouse_jobs
          WHERE ownerId = ? AND siteUrl = ? AND targetDate >= ? AND targetDate <= ?
            AND status IN ('queued', 'retrying', 'running', 'completed')
          GROUP BY targetDate
        `, [ownerId, siteUrl, startDate, endDate]),
      ]);
      const gscSiteDates = new Set(gscSiteRows.map((row) => row.date));
      const gscQueryDates = new Set(gscQueryRows.map((row) => row.date));
      const gscPageQueryDates = new Set(gscPageQueryRows.map((row) => row.date));
      const ga4PageDates = new Set(ga4PageRows.map((row) => row.date));
      const queuedOrSyncedDates = new Set(jobRows.map((row) => row.targetDate));
      const needsSync = (date: string) => (
        !gscSiteDates.has(date)
        || !gscQueryDates.has(date)
        || !gscPageQueryDates.has(date)
        || (isNonEmptyString(propertyId) && !ga4PageDates.has(date))
      );
      const datesToQueue = expectedDates
        .filter((date) => needsSync(date) && !queuedOrSyncedDates.has(date))
        .slice(0, queueLimit);

      const jobs = [];
      for (const targetDate of datesToQueue) {
        const job = await queueWarehouseSyncJob(db, {
          ownerId,
          propertyId: isNonEmptyString(propertyId) ? propertyId : null,
          siteUrl,
          targetDate,
        });
        jobs.push(job);
      }

      return res.json({
        jobs,
        queued: jobs.length,
        remainingMissingDates: Math.max(expectedDates.filter((date) => needsSync(date) && !queuedOrSyncedDates.has(date)).length - jobs.length, 0),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to queue missing warehouse jobs' });
    }
  });

  app.post('/api/warehouse/jobs/retry-failed', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, startDate, endDate, maxJobs } = req.body || {};
    if (!isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Invalid failed warehouse retry payload' });
    }

    try {
      const user = await db.get<any>('SELECT gscRefreshToken FROM users WHERE id = ?', [ownerId]);
      if (!user?.gscRefreshToken) {
        return res.status(409).json({ error: 'Connect Google data before retrying failed warehouse jobs.' });
      }

      const retryLimit = Number.isFinite(Number(maxJobs)) ? Math.min(Math.max(Number(maxJobs), 1), 120) : 60;
      const failedJobs = await db.all<{ id: string }>(`
        SELECT id
        FROM warehouse_jobs
        WHERE ownerId = ? AND siteUrl = ? AND targetDate >= ? AND targetDate <= ? AND status = 'error'
        ORDER BY targetDate ASC, updatedAt ASC
        LIMIT ?
      `, [ownerId, siteUrl, startDate, endDate, retryLimit]);

      for (const job of failedJobs) {
        await db.run(`
          UPDATE warehouse_jobs
          SET status = 'queued',
              attemptCount = 0,
              lockedAt = NULL,
              nextRunAt = ?,
              startedAt = NULL,
              completedAt = NULL,
              lastError = NULL,
              updatedAt = ?
          WHERE id = ? AND ownerId = ?
        `, [new Date().toISOString(), new Date().toISOString(), job.id, ownerId]);
      }

      const remaining = await db.get<any>(`
        SELECT COUNT(*) AS failedCount
        FROM warehouse_jobs
        WHERE ownerId = ? AND siteUrl = ? AND targetDate >= ? AND targetDate <= ? AND status = 'error'
      `, [ownerId, siteUrl, startDate, endDate]);

      return res.json({
        remainingFailedJobs: toCoverageNumber(remaining?.failedCount),
        retried: failedJobs.length,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to retry failed warehouse jobs' });
    }
  });

  app.get('/api/warehouse/jobs', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 50) : 20;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    try {
      const jobs = await listWarehouseJobs(db, ownerId, siteUrl, limit);
      res.json({ jobs });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load warehouse jobs' });
    }
  });

  app.post('/api/warehouse/query', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, startDate, endDate, dimensions, dimensionFilterGroups, metric } = req.body;
    if (!isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Missing or invalid parameters' });
    }
    if (dimensions !== undefined && !isValidWarehouseDimensions(dimensions)) {
      return res.status(400).json({ error: 'Invalid dimensions' });
    }
    if (!validateDimensionFilterGroups(dimensionFilterGroups)) {
      return res.status(400).json({ error: 'Invalid dimensionFilterGroups' });
    }

    try {
      const dims = (dimensions as string[]) || [];
      const hasDate = dims.includes('date');
      const hasQuery = dims.includes('query');
      const hasPage = dims.includes('page');
      const wantsQueryCount = metric === 'queryCount';
      const hasPageFilter = Array.isArray(dimensionFilterGroups)
        && dimensionFilterGroups.some((group: any) =>
          Array.isArray(group.filters)
          && group.filters.some((filter: any) => filter.dimension === 'page' && isNonEmptyString(filter.expression))
        );

      const selectClauseElements: string[] = [];
      const groupByClauseElements: string[] = [];
      let orderClause = 'ORDER BY impressions DESC';

      if (hasDate) {
        selectClauseElements.push('date');
        groupByClauseElements.push('date');
        orderClause = 'ORDER BY date ASC';
      }
      if (hasPage) {
        selectClauseElements.push('page');
        groupByClauseElements.push('page');
        if (!hasDate) orderClause = 'ORDER BY clicks DESC, impressions DESC';
      }
      if (hasQuery) {
        selectClauseElements.push('query');
        groupByClauseElements.push('query');
        if (!hasDate) orderClause = 'ORDER BY clicks DESC, impressions DESC';
      }

      const selectCols = selectClauseElements.length > 0 ? `${selectClauseElements.join(', ')}, ` : '';
      const queryCountCol = ((hasPage && !hasQuery) || (wantsQueryCount && hasDate && !hasQuery))
        ? 'COUNT(DISTINCT query) as queryCount,'
        : '';
      const groupByClause = groupByClauseElements.length > 0 ? `GROUP BY ${groupByClauseElements.join(', ')}` : '';

      let whereClause = 'WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate';
      const params: Record<string, unknown> = { ownerId, siteUrl, startDate, endDate };

      if (dimensionFilterGroups && dimensionFilterGroups.length > 0) {
        for (const group of dimensionFilterGroups) {
          if (group.filters) {
            for (const filter of group.filters) {
              if (filter.dimension === 'query' && filter.expression) {
                const paramIdx = Object.keys(params).length;
                if (filter.operator === 'equals') {
                  whereClause += ` AND query = @queryFilter${paramIdx}`;
                  params[`queryFilter${paramIdx}`] = filter.expression;
                } else if (filter.operator === 'contains') {
                  whereClause += ` AND query LIKE @queryFilter${paramIdx}`;
                  params[`queryFilter${paramIdx}`] = `%${filter.expression}%`;
                } else if (filter.operator === 'notContains') {
                  whereClause += ` AND query NOT LIKE @queryFilter${paramIdx}`;
                  params[`queryFilter${paramIdx}`] = `%${filter.expression}%`;
                }
              }
              if (filter.dimension === 'page' && filter.expression) {
                const paramIdx = Object.keys(params).length;
                if (filter.operator === 'equals') {
                  whereClause += ` AND page = @pageFilter${paramIdx}`;
                  params[`pageFilter${paramIdx}`] = filter.expression;
                } else if (filter.operator === 'contains') {
                  whereClause += ` AND page LIKE @pageFilter${paramIdx}`;
                  params[`pageFilter${paramIdx}`] = `%${filter.expression}%`;
                } else if (filter.operator === 'notContains') {
                  whereClause += ` AND page NOT LIKE @pageFilter${paramIdx}`;
                  params[`pageFilter${paramIdx}`] = `%${filter.expression}%`;
                }
              }
            }
          }
        }
      }

      let rows: any[] = [];
      if (hasPage || (hasQuery && hasPageFilter)) {
        rows = await db.all<any>(`
          SELECT ${selectCols} 
                 ${queryCountCol}
                 SUM(clicks) as clicks, 
                 SUM(impressions) as impressions, 
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr, 
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END as position
          FROM gsc_page_query_metrics
          ${whereClause}
          ${groupByClause}
          ${orderClause}
          LIMIT 50000
        `, params);
      } else if (wantsQueryCount && hasDate && !hasQuery) {
        rows = await db.all<any>(`
          SELECT ${selectCols}
                 ${queryCountCol}
                 SUM(clicks) as clicks,
                 SUM(impressions) as impressions,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END as position
          FROM gsc_query_metrics
          ${whereClause}
          ${groupByClause}
          ${orderClause}
          LIMIT 50000
        `, params);
      } else if (hasQuery) {
        rows = await db.all<any>(`
                 SELECT ${selectCols} 
                 SUM(clicks) as clicks, 
                 SUM(impressions) as impressions, 
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr, 
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END as position
          FROM gsc_query_metrics
          ${whereClause}
          ${groupByClause}
          ${orderClause}
          LIMIT 50000
        `, params);
      } else {
        rows = await db.all<any>(`
                 SELECT ${selectCols} 
                 SUM(clicks) as clicks, 
                 SUM(impressions) as impressions, 
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr, 
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END as position
          FROM gsc_site_metrics
          ${whereClause}
          ${groupByClause}
          ${orderClause}
          LIMIT 50000
        `, params);
      }

      rows = rows.map((r: any) => {
        const keys = [];
        if (hasDate) keys.push(r.date);
        if (hasPage) keys.push(r.page);
        if (hasQuery) keys.push(r.query);
        return {
          date: r.date,
          page: r.page,
          query: r.query,
          queryCount: r.queryCount === undefined ? undefined : toFiniteNumber(r.queryCount),
          keys: keys.length > 0 ? keys : undefined,
          clicks: toFiniteNumber(r.clicks),
          impressions: toFiniteNumber(r.impressions),
          ctr: toFiniteNumber(r.ctr),
          position: toFiniteNumber(r.position),
        };
      });

      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/warehouse/raw/gsc', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const startDate = asTrimmedString(req.query.startDate);
    const endDate = asTrimmedString(req.query.endDate);
    const kind = asTrimmedString(req.query.kind) || 'page_query';
    const search = asTrimmedString(req.query.search) || '';
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 5000) : 100;
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(Number(req.query.offset), 0) : 0;

    if (!siteUrl || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Missing or invalid raw GSC parameters' });
    }

    try {
      const user = await db.get<any>('SELECT tier FROM users WHERE id = ?', [ownerId]);
      if (!canUseRawExports(user?.tier)) {
        return res.status(403).json({ error: 'Raw exports are available on paid plans.' });
      }

      const searchTerm = `%${search.toLowerCase()}%`;
      const baseParams: unknown[] = [ownerId, siteUrl, startDate, endDate];
      const withSearch = Boolean(search);
      let total: any;
      let rows: any[];

      if (kind === 'site') {
        const where = withSearch ? 'AND date LIKE ?' : '';
        const params = withSearch ? [...baseParams, searchTerm] : baseParams;
        total = await db.get<any>(`
          SELECT COUNT(*) AS total
          FROM gsc_site_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? ${where}
        `, params);
        rows = await db.all<any>(`
          SELECT date, clicks, impressions, ctr, position
          FROM gsc_site_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? ${where}
          ORDER BY date DESC
          LIMIT ? OFFSET ?
        `, [...params, limit, offset]);
      } else if (kind === 'query') {
        const where = withSearch ? 'AND LOWER(query) LIKE ?' : '';
        const params = withSearch ? [...baseParams, searchTerm] : baseParams;
        total = await db.get<any>(`
          SELECT COUNT(*) AS total
          FROM gsc_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? ${where}
        `, params);
        rows = await db.all<any>(`
          SELECT date, query, clicks, impressions, ctr, position
          FROM gsc_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? ${where}
          ORDER BY date DESC, clicks DESC, impressions DESC
          LIMIT ? OFFSET ?
        `, [...params, limit, offset]);
      } else {
        const where = withSearch ? 'AND (LOWER(page) LIKE ? OR LOWER(query) LIKE ?)' : '';
        const params = withSearch ? [...baseParams, searchTerm, searchTerm] : baseParams;
        total = await db.get<any>(`
          SELECT COUNT(*) AS total
          FROM gsc_page_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? ${where}
        `, params);
        rows = await db.all<any>(`
          SELECT date, page, query, clicks, impressions, ctr, position
          FROM gsc_page_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? ${where}
          ORDER BY date DESC, clicks DESC, impressions DESC
          LIMIT ? OFFSET ?
        `, [...params, limit, offset]);
      }

      return res.json({
        page: { limit, offset, total: toFiniteNumber(readField(total, 'total')) },
        rows,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to load raw GSC rows' });
    }
  });

  app.get('/api/warehouse/raw/ga4-pages', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const propertyId = asTrimmedString(req.query.propertyId);
    const startDate = asTrimmedString(req.query.startDate);
    const endDate = asTrimmedString(req.query.endDate);
    const search = asTrimmedString(req.query.search) || '';
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 5000) : 100;
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(Number(req.query.offset), 0) : 0;

    if (!propertyId || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Missing or invalid raw GA4 parameters' });
    }

    try {
      const user = await db.get<any>('SELECT tier FROM users WHERE id = ?', [ownerId]);
      if (!canUseRawExports(user?.tier)) {
        return res.status(403).json({ error: 'Raw exports are available on paid plans.' });
      }

      const where = search ? 'AND LOWER(pagePath) LIKE ?' : '';
      const params: unknown[] = search
        ? [ownerId, propertyId, startDate, endDate, `%${search.toLowerCase()}%`]
        : [ownerId, propertyId, startDate, endDate];

      const total = await db.get<any>(`
        SELECT COUNT(*) AS total
        FROM ga4_page_metrics
        WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ? ${where}
      `, params);
      const rows = await db.all<any>(`
        SELECT date, siteUrl, pagePath, pageKey, sessions, totalUsers, pageViews, bounceRate, eventCount
        FROM ga4_page_metrics
        WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ? ${where}
        ORDER BY date DESC, sessions DESC, pageViews DESC
        LIMIT ? OFFSET ?
      `, [...params, limit, offset]);

      return res.json({
        page: { limit, offset, total: toFiniteNumber(readField(total, 'total')) },
        rows,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to load raw GA4 rows' });
    }
  });
}
