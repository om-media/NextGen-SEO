import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import {
  hasValidMetricRows,
  isIsoDateString,
  isNonEmptyString,
  isValidWarehouseDimensions,
  validateDimensionFilterGroups,
} from '../validation.js';
import { canonicalPageKey } from '../reporting/url.js';
import { googleApiFetchJson } from '../services/googleAuth.js';

const GA4_WAREHOUSE_METRICS = new Set(['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount']);
const GA4_WAREHOUSE_DIMENSIONS = new Set(['date', 'pagePath', 'landingPagePlusQueryString']);

const normalizeGa4Date = (value: unknown) => {
  if (typeof value !== 'string') return null;
  if (isIsoDateString(value)) return value;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

const readField = (row: any, key: string) => row?.[key] ?? row?.[key.toLowerCase()];

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
  ) => googleApiFetchJson(
    db,
    ownerId,
    `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
    {
      method: 'POST',
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
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
    const data = await fetchLiveGa4Report(
      ownerId,
      propertyId,
      startDate,
      endDate,
      ['date', 'landingPagePlusQueryString'],
      ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
    );

    const rows = Array.isArray(data?.rows) ? data.rows : [];
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
          const query = row.keys[2] || '';
          await db.run(`
            INSERT INTO gsc_page_query_metrics (ownerId, siteUrl, date, page, query, clicks, impressions, ctr, position)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ownerId, siteUrl, date, page, query) DO UPDATE SET
              clicks=excluded.clicks,
              impressions=excluded.impressions,
              ctr=excluded.ctr,
              position=excluded.position
          `, [ownerId, siteUrl, date, page, query, row.clicks, row.impressions, row.ctr, row.position]);
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
}
