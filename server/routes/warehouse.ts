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
import {
  CORE_RANGE_JOB_DAYS,
  GA4_DIMENSION_RANGE_JOB_DAYS,
  LLM_RANGE_JOB_DAYS,
  SEARCH_CONSOLE_HISTORY_DAYS,
  listWarehouseJobs,
  queueWarehouseBootstrapJobs,
  queueWarehouseCoreRangeJob,
  queueWarehouseGa4DimensionRangeJob,
  queueWarehouseLlmRangeJob,
  queueWarehouseSyncJob,
} from '../services/warehouseJobs.js';
import { canAccessGa4Property, canAccessSite } from '../accessControl.js';
import { getBingCacheStatus } from '../services/bingWarehouse.js';
import { upsertWorkspaceGa4Mapping } from '../services/ga4Mappings.js';
import {
  getGscSummaryWindow,
  refreshGscMonthlySummariesForRange,
} from '../services/gscMonthlySummaries.js';

const GA4_WAREHOUSE_METRICS = new Set(['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount']);
const GA4_PAGE_WAREHOUSE_DIMENSIONS = new Set(['date', 'pagePath', 'landingPagePlusQueryString']);
const GA4_DIMENSION_WAREHOUSE_DIMENSIONS = new Set([
  'browser',
  'city',
  'country',
  'deviceCategory',
  'eventName',
  'operatingSystem',
  'region',
  'sessionSourceMedium',
]);
const GA4_WAREHOUSE_DIMENSIONS = new Set([
  ...GA4_PAGE_WAREHOUSE_DIMENSIONS,
  ...GA4_DIMENSION_WAREHOUSE_DIMENSIONS,
]);
const GA4_DIMENSION_DATASET_COUNT = GA4_DIMENSION_WAREHOUSE_DIMENSIONS.size;
const GA4_RAW_DIMENSIONS: Record<string, string> = {
  browser: 'browser',
  city: 'city',
  country: 'country',
  device: 'deviceCategory',
  event: 'eventName',
  operatingSystem: 'operatingSystem',
  region: 'region',
  traffic: 'sessionSourceMedium',
};

const readField = (row: any, key: string) => row?.[key] ?? row?.[key.toLowerCase()];
const toCoverageNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const parseWarehouseJobMetrics = (value: unknown) => {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const completedJobIncludedProperty = (row: { metricsJson?: string | null; status?: string | null }) => {
  if (row.status !== 'completed') return false;
  const metrics = parseWarehouseJobMetrics(row.metricsJson);
  return metrics?.propertyIncluded === true;
};

async function resolveActiveGa4PropertyForSite(db: AppDatabase, ownerId: string, siteUrl: string, propertyId: string) {
  if (!propertyId) return '';
  const [siteAllowed, propertyAllowed] = await Promise.all([
    canAccessSite(db, ownerId, siteUrl),
    canAccessGa4Property(db, ownerId, propertyId),
  ]);
  return siteAllowed && propertyAllowed ? propertyId : '';
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

const addIsoDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const latestStableReportingDate = () => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - 2);
  return date.toISOString().slice(0, 10);
};

const earliestSearchConsoleReportingDate = () => addIsoDays(latestStableReportingDate(), -(SEARCH_CONSOLE_HISTORY_DAYS - 1));

const minIsoDate = (a: string, b: string) => (a <= b ? a : b);
const maxIsoDate = (a: string, b: string) => (a >= b ? a : b);

const jobDateRange = (job: { targetDate?: string | null; targetStartDate?: string | null }) => {
  const endDate = typeof job.targetDate === 'string' && isIsoDateString(job.targetDate) ? job.targetDate : null;
  if (!endDate) return null;
  const startDate = typeof job.targetStartDate === 'string' && isIsoDateString(job.targetStartDate)
    ? job.targetStartDate
    : endDate;
  return { endDate, startDate };
};

const jobDatesWithin = (
  job: { targetDate?: string | null; targetStartDate?: string | null },
  startDate: string,
  endDate: string,
) => {
  const range = jobDateRange(job);
  if (!range) return [];
  const effectiveStart = maxIsoDate(range.startDate, startDate);
  const effectiveEnd = minIsoDate(range.endDate, endDate);
  return effectiveStart <= effectiveEnd ? eachIsoDate(effectiveStart, effectiveEnd) : [];
};

const addJobDatesToSet = (
  target: Set<string>,
  jobs: Array<{ targetDate?: string | null; targetStartDate?: string | null }>,
  startDate: string,
  endDate: string,
) => {
  for (const job of jobs) {
    for (const date of jobDatesWithin(job, startDate, endDate)) target.add(date);
  }
};

const chunkAscendingDates = (dates: string[], maxDays: number) => {
  const chunks: Array<{ endDate: string; startDate: string }> = [];
  const sortedDates = [...dates].sort();
  for (let index = 0; index < sortedDates.length; index += maxDays) {
    const chunk = sortedDates.slice(index, index + maxDays);
    const startDate = chunk[0];
    const endDate = chunk[chunk.length - 1];
    if (startDate && endDate) chunks.push({ endDate, startDate });
  }
  return chunks;
};

const coverageFromRows = (
  expectedDates: string[],
  rows: Array<{ date?: string | null; rowCount?: number | null }>,
  completedDates = new Set<string>(),
) => {
  const countByDate = new Map(rows.map((row) => [String(row.date || ''), toCoverageNumber(row.rowCount)]));
  const coveredDates = expectedDates.filter((date) => (countByDate.get(date) || 0) > 0 || completedDates.has(date));
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

const coverageFromRowsWithMinimum = (
  expectedDates: string[],
  rows: Array<{ date?: string | null; rowCount?: number | null }>,
  minimumRowCount: number,
  completedDates = new Set<string>(),
) => {
  const countByDate = new Map(rows.map((row) => [String(row.date || ''), toCoverageNumber(row.rowCount)]));
  const coveredDates = expectedDates.filter((date) => (countByDate.get(date) || 0) >= minimumRowCount || completedDates.has(date));
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

  const getDateRangeFromDates = (dates: string[]) => {
    if (dates.length === 0) return null;
    const sortedDates = [...dates].sort();
    return {
      endDate: sortedDates[sortedDates.length - 1],
      startDate: sortedDates[0],
    };
  };

  const appendWarehouseFilterClauses = (
    initialWhereClause: string,
    params: Record<string, unknown>,
    filterGroups: any[] | undefined,
    siteUrl: string,
  ) => {
    let whereClause = initialWhereClause;
    if (!filterGroups || filterGroups.length === 0) return whereClause;

    for (const group of filterGroups) {
      if (!group.filters) continue;
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
            whereClause += ` AND COALESCE(NULLIF(pageKey, ''), page) = @pageFilter${paramIdx}`;
            params[`pageFilter${paramIdx}`] = canonicalPageKey(filter.expression, siteUrl);
          } else if (filter.operator === 'contains') {
            whereClause += ` AND page LIKE @pageFilter${paramIdx}`;
            params[`pageFilter${paramIdx}`] = `%${filter.expression}%`;
          } else if (filter.operator === 'notContains') {
            whereClause += ` AND page NOT LIKE @pageFilter${paramIdx}`;
            params[`pageFilter${paramIdx}`] = `%${filter.expression}%`;
          }
        }
        if (filter.dimension === 'country' && filter.expression) {
          const paramIdx = Object.keys(params).length;
          if (filter.operator === 'equals') {
            whereClause += ` AND country = @countryFilter${paramIdx}`;
            params[`countryFilter${paramIdx}`] = filter.expression;
          } else if (filter.operator === 'contains') {
            whereClause += ` AND country LIKE @countryFilter${paramIdx}`;
            params[`countryFilter${paramIdx}`] = `%${filter.expression}%`;
          } else if (filter.operator === 'notContains') {
            whereClause += ` AND country NOT LIKE @countryFilter${paramIdx}`;
            params[`countryFilter${paramIdx}`] = `%${filter.expression}%`;
          }
        }
      }
    }

    return whereClause;
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

  const getExactDimensionFilter = (dimensionFilter: any) => {
    const filter = dimensionFilter?.filter;
    const fieldName = filter?.fieldName;
    const stringFilter = filter?.stringFilter;
    if (!filter || !stringFilter || !isNonEmptyString(fieldName)) return null;
    if (stringFilter.matchType !== undefined && stringFilter.matchType !== 'EXACT') return null;
    const value = stringFilter.value;
    return isNonEmptyString(value) ? { fieldName, value } : null;
  };

  const getGenericGa4WarehouseDimension = (dimensions: string[], dimensionFilter: unknown) => {
    const genericDimensions = dimensions.filter((dimension) => GA4_DIMENSION_WAREHOUSE_DIMENSIONS.has(dimension));
    if (genericDimensions.length > 1) return null;
    if (genericDimensions.length === 1) return genericDimensions[0];

    const exactFilter = getExactDimensionFilter(dimensionFilter);
    if (
      exactFilter
      && GA4_DIMENSION_WAREHOUSE_DIMENSIONS.has(exactFilter.fieldName)
      && dimensions.length === 1
      && dimensions[0] === 'date'
    ) {
      return exactFilter.fieldName;
    }

    return null;
  };

  const canServeGa4PageWarehouseReport = (dimensions: string[], metrics: string[], dimensionFilter: unknown) => {
    if (dimensions.some((dimension) => !GA4_PAGE_WAREHOUSE_DIMENSIONS.has(dimension))) return false;
    if (metrics.some((metric) => !GA4_WAREHOUSE_METRICS.has(metric))) return false;
    if (!dimensionFilter) return true;
    return isExactPageFilter(dimensionFilter);
  };

  const canServeGa4DimensionWarehouseReport = (dimensions: string[], metrics: string[], dimensionFilter: unknown) => {
    const warehouseDimension = getGenericGa4WarehouseDimension(dimensions, dimensionFilter);
    if (!warehouseDimension) return false;
    if (dimensions.some((dimension) => dimension !== 'date' && dimension !== warehouseDimension)) return false;
    if (metrics.some((metric) => !GA4_WAREHOUSE_METRICS.has(metric))) return false;
    const exactFilter = getExactDimensionFilter(dimensionFilter);
    if (!exactFilter) return true;
    return exactFilter.fieldName === warehouseDimension;
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
    const whereParts = ['ownerId = ?', 'propertyId = ?', 'siteUrl = ?', 'date >= ?', 'date <= ?'];
    const params: unknown[] = [ownerId, propertyId, siteUrl, startDate, endDate];
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
    const expectedDates = eachIsoDate(startDate, endDate);
    const [coverageRows, jobRows] = await Promise.all([
      db.all<{ date: string; rowCount: number }>(`
        SELECT date, COUNT(*) AS rowCount
        FROM ga4_page_metrics
        WHERE ownerId = ? AND propertyId = ? AND siteUrl = ? AND date >= ? AND date <= ?
        GROUP BY date
      `, [ownerId, propertyId, siteUrl, startDate, endDate]),
      db.all<{ jobType: string; propertyId: string | null; status: string; targetDate: string; targetStartDate: string | null }>(`
        SELECT jobType, propertyId, status, targetStartDate, targetDate
        FROM warehouse_jobs
        WHERE ownerId = ? AND siteUrl = ? AND targetDate >= ? AND COALESCE(targetStartDate, targetDate) <= ?
          AND jobType IN ('daily-sync', 'core-range-sync')
          AND status IN ('queued', 'retrying', 'running', 'completed')
      `, [ownerId, siteUrl, startDate, endDate]),
    ]);
    const completedDates = new Set<string>();
    const activeDates = new Set<string>();
    for (const job of jobRows) {
      if (job.propertyId !== propertyId) continue;
      if (job.status === 'completed') {
        addJobDatesToSet(completedDates, [job], startDate, endDate);
      } else {
        addJobDatesToSet(activeDates, [job], startDate, endDate);
      }
    }
    const coverage = {
      ...coverageFromRows(expectedDates, coverageRows, completedDates),
      activeDateCount: activeDates.size,
      activeJobCount: jobRows.filter((row) => row.propertyId === propertyId && row.status !== 'completed').length,
      queuedDateCount: activeDates.size,
    };

    return {
      rows: rows.map((row) => ({
        dimensionValues: dimensions.map((dimension) => ({
          value: dimension === 'date' ? String(readField(row, 'date') || '') : String(readField(row, 'pagePath') || ''),
        })),
        metricValues: metrics.map((metric) => ({ value: readGa4MetricValue(row, metric) })),
      })),
      metadata: { coverage, source: 'warehouse' },
    };
  };

  const getGa4DimensionCoverage = async (
    ownerId: string,
    propertyId: string,
    siteUrl: string,
    warehouseDimension: string,
    startDate: string,
    endDate: string,
  ) => {
    const latestAvailableDate = latestStableReportingDate();
    const effectiveEndDate = minIsoDate(endDate, latestAvailableDate);
    const expectedDates = startDate <= effectiveEndDate ? eachIsoDate(startDate, effectiveEndDate) : [];

    const [rowDates, jobRows] = await Promise.all([
      db.all<{ date: string }>(`
        SELECT date
        FROM ga4_dimension_metrics
        WHERE ownerId = ? AND propertyId = ? AND dimension = ? AND date >= ? AND date <= ?
        GROUP BY date
      `, [ownerId, propertyId, warehouseDimension, startDate, effectiveEndDate]),
      db.all<{ jobType: string; status: string; targetDate: string; targetStartDate: string | null }>(`
        SELECT jobType, status, targetStartDate, targetDate
        FROM warehouse_jobs
        WHERE ownerId = ? AND siteUrl = ? AND COALESCE(propertyId, '') = ? AND jobType = 'ga4-dimension-range-sync'
          AND targetDate >= ? AND COALESCE(targetStartDate, targetDate) <= ?
          AND status IN ('queued', 'retrying', 'running', 'completed', 'error')
      `, [ownerId, siteUrl, propertyId, startDate, effectiveEndDate]),
    ]);

    const activeJobs = jobRows.filter((row) => ['queued', 'retrying', 'running'].includes(row.status));
    const completedJobs = jobRows.filter((row) => row.status === 'completed');
    const coveredDates = new Set(rowDates.map((row) => row.date));
    const activeDates = new Set<string>();
    addJobDatesToSet(coveredDates, completedJobs, startDate, effectiveEndDate);
    addJobDatesToSet(activeDates, activeJobs, startDate, effectiveEndDate);

    const missingDates = expectedDates.filter((date) => !coveredDates.has(date));
    const datesToQueue = missingDates.filter((date) => !activeDates.has(date));
    const queuedJobs = [];
    for (const chunk of chunkAscendingDates(datesToQueue, GA4_DIMENSION_RANGE_JOB_DAYS)) {
      const job = await queueWarehouseGa4DimensionRangeJob(db, {
        endDate: chunk.endDate,
        ownerId,
        propertyId,
        siteUrl,
        startDate: chunk.startDate,
      });
      queuedJobs.push(job);
      addJobDatesToSet(activeDates, [job], startDate, effectiveEndDate);
    }

    return {
      activeDateCount: activeDates.size,
      activeJobCount: activeJobs.length + queuedJobs.length,
      coveredDateCount: Math.min(coveredDates.size, expectedDates.length),
      dimension: warehouseDimension,
      errorJobCount: jobRows.filter((row) => row.status === 'error').length,
      expectedDateCount: expectedDates.length,
      latestAvailableDate,
      missingDateCount: missingDates.length,
      queued: queuedJobs.length,
      queuedDateCount: datesToQueue.length,
      skippedUnavailableDates: Math.max(eachIsoDate(startDate, endDate).length - expectedDates.length, 0),
    };
  };

  const readGa4DimensionWarehouseReport = async (
    ownerId: string,
    propertyId: string,
    warehouseDimension: string,
    startDate: string,
    endDate: string,
    dimensions: string[],
    metrics: string[],
    dimensionFilter?: any,
  ) => {
    const whereParts = ['ownerId = ?', 'propertyId = ?', 'dimension = ?', 'date >= ?', 'date <= ?'];
    const params: unknown[] = [ownerId, propertyId, warehouseDimension, startDate, endDate];
    const exactFilter = getExactDimensionFilter(dimensionFilter);
    if (exactFilter?.fieldName === warehouseDimension) {
      whereParts.push('dimensionValue = ?');
      params.push(exactFilter.value);
    }

    const selectedDimensions = dimensions.map((dimension) => {
      if (dimension === 'date') return 'date';
      return 'dimensionValue';
    });
    const groupByFields = Array.from(new Set(selectedDimensions));
    const groupBy = groupByFields.length > 0 ? `GROUP BY ${groupByFields.join(', ')}` : '';
    const firstMetric = metrics[0] || 'sessions';
    const firstMetricAlias = firstMetric === 'screenPageViews' ? 'screenPageViews' : firstMetric;
    const orderBy = dimensions.includes('date')
      ? 'ORDER BY date ASC'
      : dimensions.length > 0
        ? `ORDER BY ${firstMetricAlias} DESC`
        : '';
    const selectParts = [
      ...(selectedDimensions.length > 0 ? selectedDimensions : []),
      ...metrics.map(selectGa4MetricSql),
    ];

    const rows = await db.all<any>(`
      SELECT ${selectParts.join(', ')}
      FROM ga4_dimension_metrics
      WHERE ${whereParts.join(' AND ')}
      ${groupBy}
      ${orderBy}
    `, params);

    return {
      rows: rows.map((row) => ({
        dimensionValues: dimensions.map((dimension) => ({
          value: dimension === 'date' ? String(readField(row, 'date') || '') : String(readField(row, 'dimensionValue') || ''),
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
      allowLive = false,
    } = req.body;

    if (
      !isNonEmptyString(propertyId)
      || !isIsoDateString(startDate)
      || !isIsoDateString(endDate)
      || !Array.isArray(dimensions)
      || !Array.isArray(metrics)
      || dimensions.some((dimension) => !isNonEmptyString(dimension))
      || metrics.some((metric) => !isNonEmptyString(metric))
      || typeof allowLive !== 'boolean'
    ) {
      return res.status(400).json({ error: 'Invalid GA4 report payload' });
    }

    try {
      if (!(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }

      const user = await db.get<any>('SELECT activatedSiteUrl FROM users WHERE id = ?', [ownerId]);
      const resolvedSiteUrl = isNonEmptyString(siteUrl)
        ? siteUrl
        : isNonEmptyString(readField(user, 'activatedSiteUrl'))
          ? readField(user, 'activatedSiteUrl')
          : propertyId;
      if (isNonEmptyString(siteUrl) && !(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      if (canServeGa4PageWarehouseReport(dimensions, metrics, dimensionFilter)) {
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

      if (canServeGa4DimensionWarehouseReport(dimensions, metrics, dimensionFilter)) {
        const warehouseDimension = getGenericGa4WarehouseDimension(dimensions, dimensionFilter);
        if (!warehouseDimension) {
          return res.status(409).json({
            code: 'GA4_REPORT_NOT_WAREHOUSED',
            error: 'This GA4 report is not available in the stored warehouse model yet.',
          });
        }
        const [coverage, report] = await Promise.all([
          getGa4DimensionCoverage(ownerId, propertyId, resolvedSiteUrl, warehouseDimension, startDate, endDate),
          readGa4DimensionWarehouseReport(
            ownerId,
            propertyId,
            warehouseDimension,
            startDate,
            endDate,
            dimensions,
            metrics,
            dimensionFilter,
          ),
        ]);
        return res.json({
          ...report,
          metadata: {
            ...(report.metadata || {}),
            coverage,
          },
        });
      }

      if (!allowLive) {
        return res.status(409).json({
          code: 'GA4_REPORT_NOT_WAREHOUSED',
          error: 'This GA4 report is not available in the stored warehouse model yet. Use one of the supported stored dimensions or enable an explicit live request.',
          metadata: {
            source: 'warehouse',
            supportedDimensions: Array.from(GA4_WAREHOUSE_DIMENSIONS),
            supportedMetrics: Array.from(GA4_WAREHOUSE_METRICS),
          },
        });
      }

      const report = await fetchLiveGa4Report(ownerId, propertyId, startDate, endDate, dimensions, metrics, dimensionFilter);
      return res.json({
        ...report,
        metadata: {
          ...(report?.metadata || {}),
          source: 'live-explicit',
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to fetch GA4 report' });
    }
  });

  app.post('/api/warehouse/ga4/llm/missing', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { propertyId, siteUrl, startDate, endDate, maxDates } = req.body || {};
    if (!isNonEmptyString(propertyId) || !isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Invalid LLM traffic import request' });
    }

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (!(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }
      const effectivePropertyId = await resolveActiveGa4PropertyForSite(db, ownerId, siteUrl, propertyId);
      if (!effectivePropertyId) {
        return res.json({
          jobs: [],
          latestAvailableDate: latestStableReportingDate(),
          queued: 0,
          queuedDates: 0,
          remainingMissingDates: 0,
          skippedUnavailableDates: 0,
        });
      }

      const latestAvailableDate = latestStableReportingDate();
      const effectiveEndDate = minIsoDate(endDate, latestAvailableDate);
      const expectedDates = eachIsoDate(startDate, effectiveEndDate);
      const queueLimit = Number.isFinite(Number(maxDates)) ? Math.min(Math.max(Number(maxDates), 1), 720) : 365;
      const [rowDates, jobRows] = await Promise.all([
        db.all<{ date: string }>(`
          SELECT date
          FROM ga4_llm_referral_metrics
          WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
          GROUP BY date
        `, [ownerId, effectivePropertyId, startDate, effectiveEndDate]),
        db.all<{ jobType: string; status: string; targetDate: string; targetStartDate: string | null }>(`
          SELECT jobType, status, targetStartDate, targetDate
          FROM warehouse_jobs
          WHERE ownerId = ? AND siteUrl = ? AND COALESCE(propertyId, '') = ? AND jobType IN ('ga4-llm-sync', 'ga4-llm-range-sync')
            AND targetDate >= ? AND COALESCE(targetStartDate, targetDate) <= ?
            AND status IN ('queued', 'retrying', 'running', 'completed')
        `, [ownerId, siteUrl, effectivePropertyId, startDate, effectiveEndDate]),
      ]);
      const coveredDates = new Set(rowDates.map((row) => row.date));
      addJobDatesToSet(coveredDates, jobRows.filter((row) => row.status === 'completed'), startDate, effectiveEndDate);
      addJobDatesToSet(coveredDates, jobRows.filter((row) => row.jobType === 'ga4-llm-range-sync' && ['queued', 'retrying', 'running'].includes(row.status)), startDate, effectiveEndDate);
      const missingDates = expectedDates.filter((date) => !coveredDates.has(date));
      const datesToQueue = missingDates.slice(Math.max(missingDates.length - queueLimit, 0));
      const chunksToQueue = chunkAscendingDates(datesToQueue, LLM_RANGE_JOB_DAYS);

      const jobs = [];
      for (const chunk of chunksToQueue) {
        const job = await queueWarehouseLlmRangeJob(db, {
          endDate: chunk.endDate,
          ownerId,
          propertyId: effectivePropertyId,
          siteUrl,
          startDate: chunk.startDate,
        });
        jobs.push(job);
      }
      const supersededAt = new Date().toISOString();
      await db.run(
        `UPDATE warehouse_jobs
         SET status = 'superseded', lockedAt = NULL, completedAt = ?, updatedAt = ?, lastError = NULL
         WHERE ownerId = ? AND siteUrl = ? AND COALESCE(propertyId, '') = ? AND jobType = 'ga4-llm-sync'
           AND status IN ('queued', 'retrying')
           AND targetDate >= ? AND targetDate <= ?`,
        [supersededAt, supersededAt, ownerId, siteUrl, effectivePropertyId, startDate, effectiveEndDate],
      );

      return res.json({
        jobs,
        latestAvailableDate,
        queued: jobs.length,
        queuedDates: datesToQueue.length,
        remainingMissingDates: Math.max(missingDates.length - datesToQueue.length, 0),
        skippedUnavailableDates: Math.max(eachIsoDate(startDate, endDate).length - expectedDates.length, 0),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to start LLM traffic import' });
    }
  });

  app.post('/api/warehouse/ga4/llm/report', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { propertyId, siteUrl, startDate, endDate } = req.body || {};
    if (!isNonEmptyString(propertyId) || !isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Invalid GA4 LLM report payload' });
    }

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (!(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }

      const latestAvailableDate = latestStableReportingDate();
      const effectiveEndDate = minIsoDate(endDate, latestAvailableDate);
      const expectedDates = eachIsoDate(startDate, effectiveEndDate);
      const [dailyRows, sourceRows, landingPageRows, coveredRows, llmJobRows] = await Promise.all([
        db.all<any>(`
          SELECT
            date,
            SUM(sessions) AS sessions
          FROM ga4_llm_referral_metrics
          WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
          GROUP BY date
          ORDER BY date ASC
        `, [ownerId, propertyId, startDate, effectiveEndDate]),
        db.all<any>(`
          SELECT
            sourceClass,
            SUM(sessions) AS sessions,
            SUM(engagedSessions) AS engagedSessions,
            SUM(keyEvents) AS keyEvents,
            CASE WHEN SUM(sessions) > 0 THEN SUM(averageSessionDuration * sessions)*1.0/SUM(sessions) ELSE 0 END AS averageSessionDuration
          FROM ga4_llm_referral_metrics
          WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
          GROUP BY sourceClass
          ORDER BY sessions DESC
        `, [ownerId, propertyId, startDate, effectiveEndDate]),
        db.all<any>(`
          SELECT
            MIN(pagePath) AS pagePath,
            pageKey,
            sourceClass,
            SUM(sessions) AS sessions,
            SUM(engagedSessions) AS engagedSessions,
            SUM(keyEvents) AS keyEvents,
            CASE WHEN SUM(sessions) > 0 THEN SUM(averageSessionDuration * sessions)*1.0/SUM(sessions) ELSE 0 END AS averageSessionDuration
          FROM ga4_llm_referral_metrics
          WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
          GROUP BY pageKey, sourceClass
          ORDER BY sessions DESC
          LIMIT 500
        `, [ownerId, propertyId, startDate, effectiveEndDate]),
        db.all<{ date: string }>(`
          SELECT date
          FROM ga4_llm_referral_metrics
          WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
          GROUP BY date
        `, [ownerId, propertyId, startDate, effectiveEndDate]),
        db.all<{ jobType: string; status: string; targetDate: string; targetStartDate: string | null }>(`
          SELECT jobType, status, targetStartDate, targetDate
          FROM warehouse_jobs
          WHERE ownerId = ? AND siteUrl = ? AND COALESCE(propertyId, '') = ? AND jobType IN ('ga4-llm-sync', 'ga4-llm-range-sync')
            AND targetDate >= ? AND COALESCE(targetStartDate, targetDate) <= ?
        `, [ownerId, siteUrl, propertyId, startDate, effectiveEndDate]),
      ]);
      const activeJobs = llmJobRows.filter((row) => ['queued', 'retrying', 'running'].includes(row.status));
      const completedJobs = llmJobRows.filter((row) => row.status === 'completed');
      const activeJobCount = activeJobs.length;
      const activeDates = new Set<string>();
      addJobDatesToSet(activeDates, activeJobs, startDate, effectiveEndDate);
      const coveredDates = new Set(coveredRows.map((row) => row.date));
      addJobDatesToSet(coveredDates, completedJobs, startDate, effectiveEndDate);
      const missingDates = expectedDates.filter((date) => !coveredDates.has(date));
      const datesToQueue = missingDates.filter((date) => !activeDates.has(date));
      const queuedJobs = [];
      for (const chunk of chunkAscendingDates(datesToQueue, LLM_RANGE_JOB_DAYS)) {
        const job = await queueWarehouseLlmRangeJob(db, {
          endDate: chunk.endDate,
          ownerId,
          propertyId,
          siteUrl,
          startDate: chunk.startDate,
        });
        queuedJobs.push(job);
        addJobDatesToSet(activeDates, [job], startDate, effectiveEndDate);
      }
      const coveredDateCount = coveredDates.size;
      const totals = sourceRows.reduce((acc, row) => {
        const sessions = toFiniteNumber(readField(row, 'sessions'));
        acc.sessions += sessions;
        acc.engagedSessions += toFiniteNumber(readField(row, 'engagedSessions'));
        acc.keyEvents += toFiniteNumber(readField(row, 'keyEvents'));
        acc.duration += toFiniteNumber(readField(row, 'averageSessionDuration')) * sessions;
        return acc;
      }, { duration: 0, engagedSessions: 0, keyEvents: 0, sessions: 0 });
      const averageSessionDuration = totals.sessions > 0 ? totals.duration / totals.sessions : 0;
      const metricValues = (row: any) => [
        { value: toFiniteNumber(readField(row, 'sessions')).toString() },
        { value: toFiniteNumber(readField(row, 'engagedSessions')).toString() },
        { value: toFiniteNumber(readField(row, 'keyEvents')).toString() },
        { value: toFiniteNumber(readField(row, 'averageSessionDuration')).toString() },
      ];

      return res.json({
        coverage: {
          activeJobCount: activeJobCount + queuedJobs.length,
          activeDateCount: activeDates.size,
          coveredDateCount: Math.min(coveredDateCount, expectedDates.length),
          errorJobCount: llmJobRows.filter((row) => row.status === 'error').length,
          expectedDateCount: expectedDates.length,
          latestAvailableDate,
          missingDateCount: missingDates.length,
          queued: queuedJobs.length,
          queuedDateCount: datesToQueue.length,
          skippedUnavailableDates: Math.max(eachIsoDate(startDate, endDate).length - expectedDates.length, 0),
        },
        daily: {
          rows: dailyRows.map((row) => ({
            dimensionValues: [{ value: String(readField(row, 'date') || '') }],
            metricValues: [{ value: toFiniteNumber(readField(row, 'sessions')).toString() }],
          })),
        },
        landingPage: {
          rows: landingPageRows.map((row) => ({
            dimensionValues: [
              { value: String(readField(row, 'pagePath') || '') },
              { value: String(readField(row, 'sourceClass') || '') },
            ],
            metricValues: metricValues(row),
          })),
        },
        metadata: { source: 'warehouse' },
        source: {
          rows: sourceRows.map((row) => ({
            dimensionValues: [{ value: String(readField(row, 'sourceClass') || '') }],
            metricValues: metricValues(row),
          })),
        },
        totals: {
          rows: totals.sessions > 0 || coveredDateCount > 0
            ? [{
              metricValues: [
                { value: totals.sessions.toString() },
                { value: totals.engagedSessions.toString() },
                { value: totals.keyEvents.toString() },
                { value: averageSessionDuration.toString() },
              ],
            }]
            : [],
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to load LLM traffic report' });
    }
  });

  app.post('/api/warehouse/ingest/site', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, rows } = req.body;
    if (!isNonEmptyString(siteUrl) || !hasValidMetricRows(rows, 1)) return res.status(400).json({ error: 'Invalid payload' });
    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

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
      const range = getDateRangeFromDates(rows.map((row: any) => row?.keys?.[0]).filter(isIsoDateString));
      if (range) {
        await refreshGscMonthlySummariesForRange(db, {
          endDate: range.endDate,
          ownerId,
          siteUrl,
          startDate: range.startDate,
        });
      }
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
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

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
      const range = getDateRangeFromDates([
        ...datesToReplace,
        ...rowsToInsert.map((row: any) => row?.keys?.[0]).filter(isIsoDateString),
      ]);
      if (range) {
        await refreshGscMonthlySummariesForRange(db, {
          endDate: range.endDate,
          ownerId,
          siteUrl,
          startDate: range.startDate,
        });
      }
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
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const insertMany = db.transaction(async (metrics: any[]) => {
        for (const date of datesToReplace) {
          await db.run('DELETE FROM gsc_page_query_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [ownerId, siteUrl, date]);
          await db.run('DELETE FROM gsc_page_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [ownerId, siteUrl, date]);
        }
        const affectedDates = new Set<string>(datesToReplace);
        for (const row of metrics) {
          const date = row.keys[0];
          affectedDates.add(date);
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
        for (const date of affectedDates) {
          await db.run('DELETE FROM gsc_page_metrics WHERE ownerId = ? AND siteUrl = ? AND date = ?', [ownerId, siteUrl, date]);
          await db.run(`
            INSERT INTO gsc_page_metrics (ownerId, siteUrl, date, page, pageKey, clicks, impressions, ctr, position, queryCount)
            SELECT
              ownerId,
              siteUrl,
              date,
              MIN(page) AS page,
              COALESCE(NULLIF(pageKey, ''), page) AS pageKey,
              SUM(clicks) AS clicks,
              SUM(impressions) AS impressions,
              CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END AS ctr,
              CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END AS position,
              COUNT(DISTINCT query) AS queryCount
            FROM gsc_page_query_metrics
            WHERE ownerId = ? AND siteUrl = ? AND date = ? AND COALESCE(NULLIF(pageKey, ''), page) <> ''
            GROUP BY ownerId, siteUrl, date, COALESCE(NULLIF(pageKey, ''), page)
            ON CONFLICT(ownerId, siteUrl, date, pageKey) DO UPDATE SET
              page=excluded.page,
              clicks=excluded.clicks,
              impressions=excluded.impressions,
              ctr=excluded.ctr,
              position=excluded.position,
              queryCount=excluded.queryCount
          `, [ownerId, siteUrl, date]);
        }
      });
      const rowsToInsert = Array.isArray(rows) ? rows : [];
      await insertMany(rowsToInsert);
      const range = getDateRangeFromDates([
        ...datesToReplace,
        ...rowsToInsert.map((row: any) => row?.keys?.[0]).filter(isIsoDateString),
      ]);
      if (range) {
        await refreshGscMonthlySummariesForRange(db, {
          endDate: range.endDate,
          ownerId,
          siteUrl,
          startDate: range.startDate,
        });
      }
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
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (!(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }

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
    const siteUrl = asTrimmedString(req.query.siteUrl);
    if (req.query.siteUrl !== undefined && !siteUrl) return res.status(400).json({ error: 'Invalid siteUrl' });
    try {
      if (siteUrl) {
        if (!(await canAccessSite(db, ownerId, siteUrl))) {
          return res.status(403).json({ error: 'This site is not activated for your workspace.' });
        }

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

        const result = [];
        for (const url of allSites) {
          if (await canAccessSite(db, ownerId, url)) {
            result.push({ siteUrl: url });
          }
        }
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
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (propertyId && !(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }
      const effectivePropertyId = propertyId
        ? await resolveActiveGa4PropertyForSite(db, ownerId, siteUrl, propertyId)
        : '';

      const latestAvailableDate = latestStableReportingDate();
      const earliestAvailableDate = earliestSearchConsoleReportingDate();
      const effectiveStartDate = maxIsoDate(startDate, earliestAvailableDate);
      const effectiveEndDate = minIsoDate(endDate, latestAvailableDate);
      const expectedDates = eachIsoDate(effectiveStartDate, effectiveEndDate);
      const unavailableDates = endDate > latestAvailableDate
        ? eachIsoDate(maxIsoDate(startDate, addIsoDays(latestAvailableDate, 1)), endDate)
        : [];
      const [gscSiteRows, gscQueryRows, gscPageQueryRows, gscCountryRows, ga4PageRows, ga4DimensionRows, latestCrawl, warehouseJobRows, bingStatus, bingUser] = await Promise.all([
        db.all<{ date: string; rowCount: number }>(`
          SELECT date, COUNT(*) AS rowCount
          FROM gsc_site_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
          ORDER BY date ASC
        `, [ownerId, siteUrl, effectiveStartDate, effectiveEndDate]),
        db.all<{ date: string; rowCount: number }>(`
          SELECT date, COUNT(*) AS rowCount
          FROM gsc_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
          ORDER BY date ASC
        `, [ownerId, siteUrl, effectiveStartDate, effectiveEndDate]),
        db.all<{ date: string; rowCount: number }>(`
          SELECT date, COUNT(*) AS rowCount
          FROM gsc_page_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
          ORDER BY date ASC
        `, [ownerId, siteUrl, effectiveStartDate, effectiveEndDate]),
        db.all<{ date: string; rowCount: number }>(`
          SELECT date, COUNT(*) AS rowCount
          FROM gsc_country_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
          ORDER BY date ASC
        `, [ownerId, siteUrl, effectiveStartDate, effectiveEndDate]),
        effectivePropertyId
          ? db.all<{ date: string; rowCount: number }>(`
            SELECT date, COUNT(*) AS rowCount
            FROM ga4_page_metrics
            WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
            GROUP BY date
            ORDER BY date ASC
          `, [ownerId, effectivePropertyId, effectiveStartDate, effectiveEndDate])
          : Promise.resolve([]),
        effectivePropertyId
          ? db.all<{ date: string; rowCount: number }>(`
            SELECT date, COUNT(DISTINCT dimension) AS rowCount
            FROM ga4_dimension_metrics
            WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
            GROUP BY date
            ORDER BY date ASC
          `, [ownerId, effectivePropertyId, effectiveStartDate, effectiveEndDate])
          : Promise.resolve([]),
        db.get<any>(`
          SELECT *
          FROM crawl_jobs
          WHERE ownerId = ? AND siteUrl = ?
          ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
          LIMIT 1
        `, [ownerId, siteUrl]),
        db.all<{ jobType: string; propertyId: string | null; status: string; targetDate: string; targetStartDate: string | null; metricsJson: string | null }>(`
          SELECT jobType, propertyId, status, targetStartDate, targetDate, metricsJson
          FROM warehouse_jobs
          WHERE ownerId = ? AND siteUrl = ? AND targetDate >= ? AND COALESCE(targetStartDate, targetDate) <= ?
            AND jobType IN ('daily-sync', 'core-range-sync', 'ga4-dimension-range-sync')
        `, [ownerId, siteUrl, effectiveStartDate, effectiveEndDate]),
        getBingCacheStatus(db, ownerId, siteUrl),
        db.get<any>('SELECT bingApiKey FROM users WHERE id = ?', [ownerId]),
      ]);
      const completedCoreJobs = warehouseJobRows.filter((row) => row.status === 'completed' && ['daily-sync', 'core-range-sync'].includes(row.jobType));
      const completedGa4CoreJobs = completedCoreJobs.filter((row) => completedJobIncludedProperty(row));
      const completedGa4DimensionJobs = warehouseJobRows.filter((row) => (
        row.status === 'completed'
        && row.jobType === 'ga4-dimension-range-sync'
        && completedJobIncludedProperty(row)
      ));
      const activeJobs = warehouseJobRows.filter((row) => ['queued', 'retrying', 'running'].includes(row.status));
      const errorJobs = warehouseJobRows.filter((row) => row.status === 'error');
      const completedGscDates = new Set<string>();
      addJobDatesToSet(completedGscDates, completedCoreJobs, effectiveStartDate, effectiveEndDate);
      const completedGa4Dates = new Set<string>();
      const completedGa4DimensionDates = new Set<string>();
      if (effectivePropertyId) {
        addJobDatesToSet(
          completedGa4Dates,
          completedGa4CoreJobs.filter((row) => row.propertyId === effectivePropertyId),
          effectiveStartDate,
          effectiveEndDate,
        );
        addJobDatesToSet(
          completedGa4DimensionDates,
          completedGa4DimensionJobs.filter((row) => row.propertyId === effectivePropertyId),
          effectiveStartDate,
          effectiveEndDate,
        );
      }
      const gscSiteDates = new Set(gscSiteRows.map((row) => row.date));
      const gscQueryDates = new Set(gscQueryRows.map((row) => row.date));
      const gscPageQueryDates = new Set(gscPageQueryRows.map((row) => row.date));
      const gscCountryDates = new Set(gscCountryRows.map((row) => row.date));
      const ga4PageDates = new Set(ga4PageRows.map((row) => row.date));
      const ga4DimensionDateCounts = new Map(ga4DimensionRows.map((row) => [row.date, toCoverageNumber(row.rowCount)]));
      const missingCoreDates = new Set(expectedDates.filter((date) => {
        const needsGsc = (!gscSiteDates.has(date) || !gscQueryDates.has(date) || !gscPageQueryDates.has(date)) && !completedGscDates.has(date);
        const needsGa4 = Boolean(effectivePropertyId && !ga4PageDates.has(date) && !completedGa4Dates.has(date));
        return needsGsc || needsGa4;
      }));
      const missingGa4DimensionDates = new Set(expectedDates.filter((date) => Boolean(
        effectivePropertyId
        && (ga4DimensionDateCounts.get(date) || 0) < GA4_DIMENSION_DATASET_COUNT
        && !completedGa4DimensionDates.has(date),
      )));
      const missingDates = new Set([...missingCoreDates, ...missingGa4DimensionDates]);
      const relevantActiveJobs = activeJobs.filter((job) => {
        const dates = jobDatesWithin(job, effectiveStartDate, effectiveEndDate);
        if (job.jobType === 'ga4-dimension-range-sync') {
          return dates.some((date) => missingGa4DimensionDates.has(date));
        }
        return dates.some((date) => missingCoreDates.has(date));
      });
      const relevantErrorJobs = errorJobs.filter((job) => {
        const dates = jobDatesWithin(job, effectiveStartDate, effectiveEndDate);
        if (job.jobType === 'ga4-dimension-range-sync') {
          return dates.some((date) => missingGa4DimensionDates.has(date));
        }
        return dates.some((date) => missingCoreDates.has(date));
      });
      const activeDates = new Set<string>();
      addJobDatesToSet(activeDates, relevantActiveJobs, effectiveStartDate, effectiveEndDate);
      for (const date of [...activeDates]) {
        if (!missingDates.has(date)) activeDates.delete(date);
      }
      const autoQueueMissingHistory = req.query.autoQueue !== 'false';
      let autoQueuedCoreJobs = 0;
      let autoQueuedGa4DimensionJobs = 0;
      if (autoQueueMissingHistory && expectedDates.length > 0) {
        const user = await db.get<{ gscRefreshToken?: string | null }>(
          'SELECT gscRefreshToken FROM users WHERE id = ?',
          [ownerId],
        );
        if (user?.gscRefreshToken) {
          const handledCoreDates = new Set<string>();
          addJobDatesToSet(
            handledCoreDates,
            warehouseJobRows.filter((row) => (
              ['daily-sync', 'core-range-sync'].includes(row.jobType)
              && ['queued', 'retrying', 'running', 'completed'].includes(row.status)
            )),
            effectiveStartDate,
            effectiveEndDate,
          );
          const handledGa4DimensionDates = new Set<string>();
          addJobDatesToSet(
            handledGa4DimensionDates,
            warehouseJobRows.filter((row) => (
              row.jobType === 'ga4-dimension-range-sync'
              && row.propertyId === effectivePropertyId
              && ['queued', 'retrying', 'running', 'completed'].includes(row.status)
            )),
            effectiveStartDate,
            effectiveEndDate,
          );
          const coreDatesToQueue = expectedDates
            .filter((date) => missingCoreDates.has(date) && !handledCoreDates.has(date))
            .sort();
          const ga4DimensionDatesToQueue = effectivePropertyId
            ? expectedDates
              .filter((date) => missingGa4DimensionDates.has(date) && !handledGa4DimensionDates.has(date))
              .sort()
            : [];

          for (const chunk of chunkAscendingDates(coreDatesToQueue, CORE_RANGE_JOB_DAYS)) {
            const job = await queueWarehouseCoreRangeJob(db, {
              endDate: chunk.endDate,
              ownerId,
              propertyId: effectivePropertyId || null,
              siteUrl,
              startDate: chunk.startDate,
            });
            if (job) autoQueuedCoreJobs += 1;
          }
          if (effectivePropertyId) {
            for (const chunk of chunkAscendingDates(ga4DimensionDatesToQueue, GA4_DIMENSION_RANGE_JOB_DAYS)) {
              const job = await queueWarehouseGa4DimensionRangeJob(db, {
                endDate: chunk.endDate,
                ownerId,
                propertyId: effectivePropertyId,
                siteUrl,
                startDate: chunk.startDate,
              });
              if (job) autoQueuedGa4DimensionJobs += 1;
            }
          }
        }
      }
      const activeJobCountByStatus = relevantActiveJobs.reduce((counts, row) => {
        counts[row.status] = (counts[row.status] || 0) + 1;
        return counts;
      }, {} as Record<string, number>);
      const supersededJobCount = warehouseJobRows.filter((row) => row.status === 'superseded').length;
      const visibleWarehouseJobRows = warehouseJobRows.filter((row) => row.status !== 'superseded');
      const jobCountByStatus = visibleWarehouseJobRows.reduce((counts, row) => {
        counts[row.status] = (counts[row.status] || 0) + 1;
        return counts;
      }, {} as Record<string, number>);
      jobCountByStatus.error = relevantErrorJobs.length;

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
          earliestAvailableDate,
          endDate: effectiveEndDate,
          requestedStartDate: startDate,
          latestAvailableDate,
          requestedEndDate: endDate,
          startDate: effectiveStartDate,
          totalDays: expectedDates.length,
          unavailableDateCount: unavailableDates.length,
          unavailableDates: unavailableDates.slice(0, 7),
        },
        ga4: {
          enabled: Boolean(effectivePropertyId),
          dimensions: effectivePropertyId
            ? coverageFromRowsWithMinimum(expectedDates, ga4DimensionRows, GA4_DIMENSION_DATASET_COUNT, completedGa4DimensionDates)
            : coverageFromRows(expectedDates, []),
          pages: coverageFromRows(expectedDates, ga4PageRows, completedGa4Dates),
          propertyId: effectivePropertyId || null,
        },
        gsc: {
          country: coverageFromRows(expectedDates, gscCountryRows),
          pageQuery: coverageFromRows(expectedDates, gscPageQueryRows, completedGscDates),
          query: coverageFromRows(expectedDates, gscQueryRows, completedGscDates),
          site: coverageFromRows(expectedDates, gscSiteRows, completedGscDates),
        },
        bing: {
          enabled: Boolean(bingUser?.bingApiKey),
          isFresh: Boolean(bingStatus.isFresh),
          latestFetchedAt: bingStatus.latestFetchedAt,
          rowCount: toCoverageNumber(bingStatus.rowCount),
        },
        warehouseJobs: {
          activeDateCount: activeDates.size,
          completed: jobCountByStatus.completed || 0,
          error: jobCountByStatus.error || 0,
          queued: (activeJobCountByStatus.queued || 0) + autoQueuedCoreJobs + autoQueuedGa4DimensionJobs,
          retrying: activeJobCountByStatus.retrying || 0,
          running: activeJobCountByStatus.running || 0,
          superseded: supersededJobCount,
          total: visibleWarehouseJobRows.length,
        },
        autoQueue: {
          coreJobs: autoQueuedCoreJobs,
          ga4DimensionJobs: autoQueuedGa4DimensionJobs,
          enabled: autoQueueMissingHistory,
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
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

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

  app.post('/api/warehouse/bootstrap', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, propertyId, days } = req.body || {};
    if (!isNonEmptyString(siteUrl)) {
      return res.status(400).json({ error: 'Invalid history import request' });
    }

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (isNonEmptyString(propertyId) && !(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }
      const effectivePropertyId = isNonEmptyString(propertyId)
        ? await resolveActiveGa4PropertyForSite(db, ownerId, siteUrl, propertyId)
        : '';
      if (effectivePropertyId) {
        await upsertWorkspaceGa4Mapping(db, {
          ownerId,
          propertyId: effectivePropertyId,
          siteUrl,
        });
      }

      const user = await db.get<any>('SELECT gscRefreshToken FROM users WHERE id = ?', [ownerId]);
      if (!user?.gscRefreshToken) {
        return res.status(409).json({ error: 'Connect Google data before importing historical reports.' });
      }

      const boundedDays = Number.isFinite(Number(days)) ? Math.min(Math.max(Number(days), 1), SEARCH_CONSOLE_HISTORY_DAYS) : undefined;
      const result = await queueWarehouseBootstrapJobs(db, {
        days: boundedDays,
        ownerId,
        propertyId: effectivePropertyId || null,
        siteUrl,
      });

      return res.json({
        coreJobs: result.core.length,
        ga4DimensionJobs: result.ga4Dimensions.length,
        llmJobs: result.llm.length,
        totalJobs: result.totalQueued,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to start history import' });
    }
  });

  app.post('/api/warehouse/jobs', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, propertyId, targetDate } = req.body || {};
    if (!isNonEmptyString(siteUrl) || !isIsoDateString(targetDate)) {
      return res.status(400).json({ error: 'Invalid warehouse job payload' });
    }

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (isNonEmptyString(propertyId) && !(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }
      const effectivePropertyId = isNonEmptyString(propertyId)
        ? await resolveActiveGa4PropertyForSite(db, ownerId, siteUrl, propertyId)
        : '';

      const job = await queueWarehouseSyncJob(db, {
        ownerId,
        propertyId: effectivePropertyId || null,
        siteUrl,
        targetDate,
      });
      res.json({ job });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to start data import' });
    }
  });

  app.post('/api/warehouse/jobs/missing', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, propertyId, startDate, endDate, maxDates } = req.body || {};
    if (!isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Invalid missing-days import request' });
    }

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }
      if (isNonEmptyString(propertyId) && !(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }
      const effectivePropertyId = isNonEmptyString(propertyId)
        ? await resolveActiveGa4PropertyForSite(db, ownerId, siteUrl, propertyId)
        : '';
      if (effectivePropertyId) {
        await upsertWorkspaceGa4Mapping(db, {
          ownerId,
          propertyId: effectivePropertyId,
          siteUrl,
        });
      }

      const user = await db.get<any>('SELECT gscRefreshToken FROM users WHERE id = ?', [ownerId]);
      if (!user?.gscRefreshToken) {
        return res.status(409).json({ error: 'Connect Google data before importing missing days.' });
      }

      const latestAvailableDate = latestStableReportingDate();
      const earliestAvailableDate = earliestSearchConsoleReportingDate();
      const effectiveStartDate = maxIsoDate(startDate, earliestAvailableDate);
      const effectiveEndDate = minIsoDate(endDate, latestAvailableDate);
      const expectedDates = eachIsoDate(effectiveStartDate, effectiveEndDate);
      const requestedPropertyId = effectivePropertyId;
      const queueLimit = Number.isFinite(Number(maxDates)) ? Math.min(Math.max(Number(maxDates), 1), SEARCH_CONSOLE_HISTORY_DAYS) : SEARCH_CONSOLE_HISTORY_DAYS;
      const [gscSiteRows, gscQueryRows, gscPageQueryRows, gscCountryRows, ga4PageRows, ga4DimensionRows, jobRows] = await Promise.all([
        db.all<{ date: string }>(`
          SELECT date
          FROM gsc_site_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
        `, [ownerId, siteUrl, effectiveStartDate, effectiveEndDate]),
        db.all<{ date: string }>(`
          SELECT date
          FROM gsc_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
        `, [ownerId, siteUrl, effectiveStartDate, effectiveEndDate]),
        db.all<{ date: string }>(`
          SELECT date
          FROM gsc_page_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
        `, [ownerId, siteUrl, effectiveStartDate, effectiveEndDate]),
        db.all<{ date: string }>(`
          SELECT date
          FROM gsc_country_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ?
          GROUP BY date
        `, [ownerId, siteUrl, effectiveStartDate, effectiveEndDate]),
        requestedPropertyId
          ? db.all<{ date: string }>(`
            SELECT date
            FROM ga4_page_metrics
            WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
            GROUP BY date
        `, [ownerId, requestedPropertyId, effectiveStartDate, effectiveEndDate])
          : Promise.resolve([]),
        requestedPropertyId
          ? db.all<{ date: string; rowCount: number }>(`
            SELECT date, COUNT(DISTINCT dimension) AS rowCount
            FROM ga4_dimension_metrics
            WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ?
            GROUP BY date
        `, [ownerId, requestedPropertyId, effectiveStartDate, effectiveEndDate])
          : Promise.resolve([]),
        db.all<{ jobType: string; targetDate: string; targetStartDate: string | null; propertyId: string | null; status: string; metricsJson: string | null }>(`
          SELECT jobType, targetDate, targetStartDate, propertyId, status, metricsJson
          FROM warehouse_jobs
          WHERE ownerId = ? AND siteUrl = ? AND targetDate >= ? AND COALESCE(targetStartDate, targetDate) <= ?
            AND jobType IN ('daily-sync', 'core-range-sync', 'ga4-dimension-range-sync')
            AND status IN ('queued', 'retrying', 'running', 'completed')
        `, [ownerId, siteUrl, effectiveStartDate, effectiveEndDate]),
      ]);
      const gscSiteDates = new Set(gscSiteRows.map((row) => row.date));
      const gscQueryDates = new Set(gscQueryRows.map((row) => row.date));
      const gscPageQueryDates = new Set(gscPageQueryRows.map((row) => row.date));
      const gscCountryDates = new Set(gscCountryRows.map((row) => row.date));
      const ga4PageDates = new Set(ga4PageRows.map((row) => row.date));
      const ga4DimensionDateCounts = new Map(ga4DimensionRows.map((row) => [row.date, toCoverageNumber(row.rowCount)]));
      const jobsByDate = new Map<string, Array<{ jobType: string; propertyId: string | null; status: string; metricsJson: string | null }>>();
      for (const row of jobRows) {
        for (const date of jobDatesWithin(row, effectiveStartDate, effectiveEndDate)) {
          if (!jobsByDate.has(date)) {
            jobsByDate.set(date, []);
          }
          jobsByDate.get(date)?.push({ jobType: row.jobType, metricsJson: row.metricsJson || null, propertyId: row.propertyId || null, status: row.status });
        }
      }
      const isCoreJob = (row: { jobType: string }) => row.jobType === 'daily-sync' || row.jobType === 'core-range-sync';
      const hasAnyCoreWarehouseJob = (date: string) => Boolean(jobsByDate.get(date)?.some(isCoreJob));
      const hasMatchingPropertyJob = (date: string) => Boolean(
        requestedPropertyId
        && jobsByDate.get(date)?.some((row) => (
          isCoreJob(row)
          && row.propertyId === requestedPropertyId
          && (['queued', 'retrying', 'running'].includes(row.status) || completedJobIncludedProperty(row))
        )),
      );
      const hasMatchingDimensionJob = (date: string) => Boolean(
        requestedPropertyId
        && jobsByDate.get(date)?.some((row) => (
          row.jobType === 'ga4-dimension-range-sync'
          && row.propertyId === requestedPropertyId
          && (['queued', 'retrying', 'running'].includes(row.status) || completedJobIncludedProperty(row))
        )),
      );
      const needsExistingGscSync = (date: string) => !gscSiteDates.has(date) || !gscQueryDates.has(date) || !gscPageQueryDates.has(date);
      const needsGa4Sync = (date: string) => Boolean(requestedPropertyId && !ga4PageDates.has(date));
      const needsGa4DimensionSync = (date: string) => Boolean(
        requestedPropertyId
        && (ga4DimensionDateCounts.get(date) || 0) < GA4_DIMENSION_DATASET_COUNT
        && !hasMatchingDimensionJob(date),
      );
      const needsCoreSync = (date: string) => (
        (needsExistingGscSync(date) && !hasAnyCoreWarehouseJob(date))
        || (needsGa4Sync(date) && !hasMatchingPropertyJob(date))
      );
      const coreDatesToQueue = expectedDates
        .filter(needsCoreSync)
        .sort((a, b) => b.localeCompare(a))
        .slice(0, queueLimit);
      const dimensionDatesToQueue = expectedDates
        .filter(needsGa4DimensionSync)
        .sort((a, b) => b.localeCompare(a))
        .slice(0, queueLimit);

      const jobs = [];
      for (const chunk of chunkAscendingDates(coreDatesToQueue, CORE_RANGE_JOB_DAYS)) {
        const job = await queueWarehouseCoreRangeJob(db, {
          dedupeCompleted: false,
          endDate: chunk.endDate,
          ownerId,
          propertyId: requestedPropertyId || null,
          siteUrl,
          startDate: chunk.startDate,
        });
        jobs.push(job);
      }
      if (requestedPropertyId) {
        for (const chunk of chunkAscendingDates(dimensionDatesToQueue, GA4_DIMENSION_RANGE_JOB_DAYS)) {
          const job = await queueWarehouseGa4DimensionRangeJob(db, {
            dedupeCompleted: false,
            endDate: chunk.endDate,
            ownerId,
            propertyId: requestedPropertyId,
            siteUrl,
            startDate: chunk.startDate,
          });
          jobs.push(job);
        }
      }

      const missingCoreCount = expectedDates.filter(needsCoreSync).length;
      const missingDimensionCount = expectedDates.filter(needsGa4DimensionSync).length;

      return res.json({
        jobs,
        latestAvailableDate,
        queued: jobs.length,
        queuedCoreDates: coreDatesToQueue.length,
        queuedGa4DimensionDates: dimensionDatesToQueue.length,
        remainingMissingDates: Math.max(missingCoreCount - coreDatesToQueue.length, 0) + Math.max(missingDimensionCount - dimensionDatesToQueue.length, 0),
        skippedUnavailableDates: Math.max(eachIsoDate(startDate, endDate).length - expectedDates.length, 0),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to start missing-days import' });
    }
  });

  app.post('/api/warehouse/jobs/retry-failed', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, startDate, endDate, maxJobs } = req.body || {};
    if (!isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Invalid failed import retry request' });
    }

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const user = await db.get<any>('SELECT gscRefreshToken FROM users WHERE id = ?', [ownerId]);
      if (!user?.gscRefreshToken) {
        return res.status(409).json({ error: 'Connect Google data before retrying failed imports.' });
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
              metricsJson = NULL,
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
      return res.status(500).json({ error: err.message || 'Failed to retry failed imports' });
    }
  });

  app.get('/api/warehouse/jobs', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 50) : 20;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const jobs = (await listWarehouseJobs(db, ownerId, siteUrl, limit)).map((job: any) => {
        const { metricsJson, ...rest } = job;
        return {
          ...rest,
          metrics: parseWarehouseJobMetrics(metricsJson),
        };
      });
      res.json({ jobs });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load import jobs' });
    }
  });

  app.post('/api/warehouse/query', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, startDate, endDate, dimensions, dimensionFilterGroups, metric, rowLimit, startRow, includeTotal, totalOnly } = req.body;
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
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const dims = (dimensions as string[]) || [];
      const hasDate = dims.includes('date');
      const hasQuery = dims.includes('query');
      const hasPage = dims.includes('page');
      const hasCountry = dims.includes('country');
      const wantsQueryCount = metric === 'queryCount';
      const hasPageFilter = Array.isArray(dimensionFilterGroups)
        && dimensionFilterGroups.some((group: any) =>
          Array.isArray(group.filters)
          && group.filters.some((filter: any) => filter.dimension === 'page' && isNonEmptyString(filter.expression))
        );

      if (hasCountry && (hasPage || hasQuery || hasPageFilter)) {
        return res.status(400).json({ error: 'Country metrics cannot be combined with page or query dimensions yet.' });
      }

      const selectClauseElements: string[] = [];
      const groupByClauseElements: string[] = [];
      let orderClause = 'ORDER BY impressions DESC';

      if (hasDate) {
        selectClauseElements.push('date');
        groupByClauseElements.push('date');
        orderClause = 'ORDER BY date ASC';
      }
      if (hasPage) {
        selectClauseElements.push('MIN(page) AS page');
        groupByClauseElements.push('COALESCE(NULLIF(pageKey, \'\'), page)');
        if (!hasDate) orderClause = 'ORDER BY clicks DESC, impressions DESC';
      }
      if (hasQuery) {
        selectClauseElements.push('query');
        groupByClauseElements.push('query');
        if (!hasDate) orderClause = 'ORDER BY clicks DESC, impressions DESC';
      }
      if (hasCountry) {
        selectClauseElements.push('country');
        groupByClauseElements.push('country');
        if (!hasDate) orderClause = 'ORDER BY clicks DESC, impressions DESC';
      }

      const selectCols = selectClauseElements.length > 0 ? `${selectClauseElements.join(', ')}, ` : '';
      const queryCountCol = ((hasPage && !hasQuery) || (wantsQueryCount && hasDate && !hasQuery))
        ? 'COUNT(DISTINCT query) as queryCount,'
        : '';
      const groupByClause = groupByClauseElements.length > 0 ? `GROUP BY ${groupByClauseElements.join(', ')}` : '';

      let whereClause = 'WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate';
      const limit = Number.isFinite(Number(rowLimit)) ? Math.min(Math.max(Number(rowLimit), 1), 50000) : 50000;
      const offset = Number.isFinite(Number(startRow)) ? Math.max(Number(startRow), 0) : 0;
      const params: Record<string, unknown> = { ownerId, siteUrl, startDate, endDate, limit, offset };
      whereClause = appendWarehouseFilterClauses(whereClause, params, dimensionFilterGroups, siteUrl);

      let rows: any[] = [];
      let totalRowCount: number | undefined;
      let totalRowCountPromise: Promise<number> | undefined;
      const shouldIncludeTotal = includeTotal === true;
      const shouldReturnTotalOnly = shouldIncludeTotal && totalOnly === true;
      const summaryWindow = hasDate ? null : getGscSummaryWindow(startDate, endDate);

      const getTotalRowCount = async (tableName: string, countExpression: string, extraWhere = '') => {
        const total = await db.get<any>(`
          SELECT COUNT(DISTINCT ${countExpression}) AS totalRowCount
          FROM ${tableName}
          ${whereClause}
          ${extraWhere}
        `, params);
        return toFiniteNumber(total?.totalRowCount);
      };

      const buildSummarySourceSql = (tableName: string, summaryTableName: string, kind: 'site' | 'query' | 'country' | 'page' | 'pageQuery') => {
        if (!summaryWindow) return null;
        const sourceSegments: string[] = [];
        const sourceParams: Record<string, unknown> = {
          ownerId,
          siteUrl,
        };

        if (kind === 'site') {
          sourceSegments.push(`
            SELECT ownerId, siteUrl, NULL AS page, NULL AS pageKey, NULL AS query, NULL AS country, clicks, impressions, positionSum
            FROM ${summaryTableName}
            WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND monthStart >= @summaryMonthStart AND monthStart <= @summaryMonthEnd
          `);
        } else if (kind === 'query') {
          sourceSegments.push(`
            SELECT ownerId, siteUrl, NULL AS page, NULL AS pageKey, query, NULL AS country, clicks, impressions, positionSum
            FROM ${summaryTableName}
            WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND monthStart >= @summaryMonthStart AND monthStart <= @summaryMonthEnd
          `);
        } else if (kind === 'country') {
          sourceSegments.push(`
            SELECT ownerId, siteUrl, NULL AS page, NULL AS pageKey, NULL AS query, country, clicks, impressions, positionSum
            FROM ${summaryTableName}
            WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND monthStart >= @summaryMonthStart AND monthStart <= @summaryMonthEnd
          `);
        } else if (kind === 'page') {
          sourceSegments.push(`
            SELECT ownerId, siteUrl, page, pageKey, NULL AS query, NULL AS country, queryCount, clicks, impressions, positionSum
            FROM ${summaryTableName}
            WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND monthStart >= @summaryMonthStart AND monthStart <= @summaryMonthEnd
          `);
        } else {
          sourceSegments.push(`
            SELECT ownerId, siteUrl, page, pageKey, query, NULL AS country, NULL AS queryCount, clicks, impressions, positionSum
            FROM ${summaryTableName}
            WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND monthStart >= @summaryMonthStart AND monthStart <= @summaryMonthEnd
          `);
        }

        sourceParams.summaryMonthStart = summaryWindow.fullMonthStart;
        sourceParams.summaryMonthEnd = summaryWindow.fullMonthEnd;

        summaryWindow.edgeRanges.forEach((range, index) => {
          sourceParams[`edgeStart${index}`] = range.startDate;
          sourceParams[`edgeEnd${index}`] = range.endDate;
          if (kind === 'site') {
            sourceSegments.push(`
              SELECT ownerId, siteUrl, NULL AS page, NULL AS pageKey, NULL AS query, NULL AS country, clicks, impressions, position * impressions AS positionSum
              FROM ${tableName}
              WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @edgeStart${index} AND date <= @edgeEnd${index}
            `);
          } else if (kind === 'query') {
            sourceSegments.push(`
              SELECT ownerId, siteUrl, NULL AS page, NULL AS pageKey, query, NULL AS country, clicks, impressions, position * impressions AS positionSum
              FROM ${tableName}
              WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @edgeStart${index} AND date <= @edgeEnd${index}
            `);
          } else if (kind === 'country') {
            sourceSegments.push(`
              SELECT ownerId, siteUrl, NULL AS page, NULL AS pageKey, NULL AS query, country, clicks, impressions, position * impressions AS positionSum
              FROM ${tableName}
              WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @edgeStart${index} AND date <= @edgeEnd${index}
            `);
          } else if (kind === 'page') {
            sourceSegments.push(`
              SELECT ownerId, siteUrl, page, COALESCE(NULLIF(pageKey, ''), page) AS pageKey, NULL AS query, NULL AS country, queryCount, clicks, impressions, position * impressions AS positionSum
              FROM ${tableName}
              WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @edgeStart${index} AND date <= @edgeEnd${index}
            `);
          } else {
            sourceSegments.push(`
              SELECT ownerId, siteUrl, page, COALESCE(NULLIF(pageKey, ''), page) AS pageKey, query, NULL AS country, NULL AS queryCount, clicks, impressions, position * impressions AS positionSum
              FROM ${tableName}
              WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @edgeStart${index} AND date <= @edgeEnd${index}
            `);
          }
        });

        return {
          params: { ...params, ...sourceParams },
          sql: sourceSegments.map((segment) => segment.trim()).join('\nUNION ALL\n'),
        };
      };

      if (summaryWindow && !hasDate) {
        if (hasCountry) {
          const summarySource = buildSummarySourceSql('gsc_country_metrics', 'gsc_country_monthly_metrics', 'country');
          if (summarySource) {
            const summaryWhereClause = appendWarehouseFilterClauses(
              'WHERE ownerId = @ownerId AND siteUrl = @siteUrl',
              summarySource.params,
              dimensionFilterGroups,
              siteUrl,
            );
            if (shouldIncludeTotal) {
              totalRowCountPromise = db.get<any>(`
                SELECT COUNT(DISTINCT country) AS totalRowCount
                FROM (${summarySource.sql}) source
                ${summaryWhereClause}
                  AND country <> ''
              `, summarySource.params).then((row) => toFiniteNumber(row?.totalRowCount));
            }
            if (!shouldReturnTotalOnly) rows = await db.all<any>(`
              SELECT country,
                     SUM(clicks) as clicks,
                     SUM(impressions) as impressions,
                     CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr,
                     CASE WHEN SUM(impressions) > 0 THEN SUM(positionSum)*1.0/SUM(impressions) ELSE 0 END as position
              FROM (${summarySource.sql}) source
              ${summaryWhereClause}
                AND country <> ''
              GROUP BY country
              ORDER BY clicks DESC, impressions DESC
              LIMIT @limit OFFSET @offset
            `, summarySource.params);
          }
        } else if (hasPage && !hasQuery && !hasPageFilter) {
          const summarySource = buildSummarySourceSql('gsc_page_metrics', 'gsc_page_monthly_metrics', 'page');
          if (summarySource) {
            if (shouldIncludeTotal) {
              totalRowCountPromise = db.get<any>(`
                SELECT COUNT(DISTINCT pageKey) AS totalRowCount
                FROM (${summarySource.sql}) source
                WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND pageKey <> ''
              `, summarySource.params).then((row) => toFiniteNumber(row?.totalRowCount));
            }
            if (!shouldReturnTotalOnly) rows = await db.all<any>(`
              SELECT MIN(page) AS page,
                     pageKey,
                     SUM(queryCount) as queryCount,
                     SUM(clicks) as clicks,
                     SUM(impressions) as impressions,
                     CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr,
                     CASE WHEN SUM(impressions) > 0 THEN SUM(positionSum)*1.0/SUM(impressions) ELSE 0 END as position
              FROM (${summarySource.sql}) source
              WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND pageKey <> ''
              GROUP BY pageKey
              ORDER BY clicks DESC, impressions DESC
              LIMIT @limit OFFSET @offset
            `, summarySource.params);
          }
        } else if (hasPage || (hasQuery && hasPageFilter)) {
          const summarySource = buildSummarySourceSql('gsc_page_query_metrics', 'gsc_page_query_monthly_metrics', 'pageQuery');
          if (summarySource) {
            const summaryWhereClause = appendWarehouseFilterClauses(
              'WHERE ownerId = @ownerId AND siteUrl = @siteUrl',
              summarySource.params,
              dimensionFilterGroups,
              siteUrl,
            );
            if (shouldIncludeTotal) {
              totalRowCountPromise = db.get<any>(`
                SELECT COUNT(DISTINCT ${hasQuery ? 'query' : 'pageKey'}) AS totalRowCount
                FROM (${summarySource.sql}) source
                ${summaryWhereClause}
              `, summarySource.params).then((row) => toFiniteNumber(row?.totalRowCount));
            }
            if (!shouldReturnTotalOnly) rows = await db.all<any>(`
              SELECT ${selectCols}
                     ${queryCountCol}
                     SUM(clicks) as clicks,
                     SUM(impressions) as impressions,
                     CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr,
                     CASE WHEN SUM(impressions) > 0 THEN SUM(positionSum)*1.0/SUM(impressions) ELSE 0 END as position
              FROM (${summarySource.sql}) source
              ${summaryWhereClause}
              ${groupByClause}
              ${orderClause}
              LIMIT @limit OFFSET @offset
            `, summarySource.params);
          }
        } else if (hasQuery) {
          const summarySource = buildSummarySourceSql('gsc_query_metrics', 'gsc_query_monthly_metrics', 'query');
          if (summarySource) {
            const summaryWhereClause = appendWarehouseFilterClauses(
              'WHERE ownerId = @ownerId AND siteUrl = @siteUrl',
              summarySource.params,
              dimensionFilterGroups,
              siteUrl,
            );
            if (shouldIncludeTotal) {
              totalRowCountPromise = db.get<any>(`
                SELECT COUNT(DISTINCT query) AS totalRowCount
                FROM (${summarySource.sql}) source
                ${summaryWhereClause}
              `, summarySource.params).then((row) => toFiniteNumber(row?.totalRowCount));
            }
            if (!shouldReturnTotalOnly) rows = await db.all<any>(`
              SELECT ${selectCols}
                     SUM(clicks) as clicks,
                     SUM(impressions) as impressions,
                     CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr,
                     CASE WHEN SUM(impressions) > 0 THEN SUM(positionSum)*1.0/SUM(impressions) ELSE 0 END as position
              FROM (${summarySource.sql}) source
              ${summaryWhereClause}
              ${groupByClause}
              ${orderClause}
              LIMIT @limit OFFSET @offset
            `, summarySource.params);
          }
        } else {
          const summarySource = buildSummarySourceSql('gsc_site_metrics', 'gsc_site_monthly_metrics', 'site');
          if (summarySource && !shouldReturnTotalOnly) rows = await db.all<any>(`
            SELECT ${selectCols}
                   SUM(clicks) as clicks,
                   SUM(impressions) as impressions,
                   CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr,
                   CASE WHEN SUM(impressions) > 0 THEN SUM(positionSum)*1.0/SUM(impressions) ELSE 0 END as position
            FROM (${summarySource.sql}) source
            WHERE ownerId = @ownerId AND siteUrl = @siteUrl
            ${groupByClause}
            ${orderClause}
            LIMIT @limit OFFSET @offset
          `, summarySource.params);
        }
      } else if (hasCountry) {
        if (shouldIncludeTotal) {
          totalRowCountPromise = getTotalRowCount('gsc_country_metrics', 'country', "AND country <> ''");
        }
        if (!shouldReturnTotalOnly) rows = await db.all<any>(`
          SELECT ${selectCols}
                 SUM(clicks) as clicks,
                 SUM(impressions) as impressions,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END as position
          FROM gsc_country_metrics
          ${whereClause}
            AND country <> ''
          ${groupByClause}
          ${orderClause}
          LIMIT @limit OFFSET @offset
        `, params);
      } else if (hasPage && !hasQuery && !hasPageFilter) {
        if (shouldIncludeTotal) {
          totalRowCountPromise = getTotalRowCount('gsc_page_metrics', 'pageKey', "AND pageKey <> ''");
        }
        if (!shouldReturnTotalOnly) rows = await db.all<any>(`
          SELECT MIN(page) AS page,
                 COALESCE(NULLIF(pageKey, ''), MIN(page)) AS pageKey,
                 SUM(clicks) as clicks,
                 SUM(impressions) as impressions,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END as position
          FROM gsc_page_metrics
          ${whereClause}
            AND pageKey <> ''
          GROUP BY pageKey
          ORDER BY clicks DESC, impressions DESC
          LIMIT @limit OFFSET @offset
        `, params);
        if (!shouldReturnTotalOnly && rows.length === 0) {
          if (shouldIncludeTotal) {
            totalRowCountPromise = getTotalRowCount(
              'gsc_page_query_metrics',
              "COALESCE(NULLIF(pageKey, ''), page)",
            );
          }
          rows = await db.all<any>(`
            SELECT MIN(page) AS page,
                   COALESCE(NULLIF(pageKey, ''), page) AS pageKey,
                   COUNT(DISTINCT query) as queryCount,
                   SUM(clicks) as clicks,
                   SUM(impressions) as impressions,
                   CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr,
                   CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END as position
            FROM gsc_page_query_metrics
            ${whereClause}
            GROUP BY COALESCE(NULLIF(pageKey, ''), page)
            ORDER BY clicks DESC, impressions DESC
            LIMIT @limit OFFSET @offset
          `, params);
        }
      } else if (hasPage || (hasQuery && hasPageFilter)) {
        if (shouldIncludeTotal) {
          totalRowCountPromise = getTotalRowCount(
            'gsc_page_query_metrics',
            hasQuery ? 'query' : "COALESCE(NULLIF(pageKey, ''), page)",
          );
        }
        if (!shouldReturnTotalOnly) rows = await db.all<any>(`
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
          LIMIT @limit OFFSET @offset
        `, params);
      } else if (wantsQueryCount && hasDate && !hasQuery) {
        if (!shouldReturnTotalOnly) rows = await db.all<any>(`
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
          LIMIT @limit OFFSET @offset
        `, params);
      } else if (hasQuery) {
        if (shouldIncludeTotal) {
          totalRowCountPromise = getTotalRowCount('gsc_query_metrics', 'query');
        }
        if (!shouldReturnTotalOnly) rows = await db.all<any>(`
                 SELECT ${selectCols} 
                 SUM(clicks) as clicks, 
                 SUM(impressions) as impressions, 
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr, 
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END as position
          FROM gsc_query_metrics
          ${whereClause}
          ${groupByClause}
          ${orderClause}
          LIMIT @limit OFFSET @offset
        `, params);
      } else {
        if (!shouldReturnTotalOnly) rows = await db.all<any>(`
                 SELECT ${selectCols} 
                 SUM(clicks) as clicks, 
                 SUM(impressions) as impressions, 
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END as ctr, 
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END as position
          FROM gsc_site_metrics
          ${whereClause}
          ${groupByClause}
          ${orderClause}
          LIMIT @limit OFFSET @offset
        `, params);
      }

      if (totalRowCountPromise) {
        totalRowCount = await totalRowCountPromise;
      }

      if (shouldReturnTotalOnly && hasPage && !hasQuery && !hasPageFilter && Number(totalRowCount || 0) === 0) {
        totalRowCount = await getTotalRowCount(
          'gsc_page_query_metrics',
          "COALESCE(NULLIF(pageKey, ''), page)",
        );
      }

      if (shouldReturnTotalOnly) {
        res.json({ rows: [], totalRowCount });
        return;
      }

      rows = rows.map((r: any) => {
        const keys = [];
        if (hasDate) keys.push(r.date);
        if (hasPage) keys.push(r.page);
        if (hasQuery) keys.push(r.query);
        if (hasCountry) keys.push(r.country);
        return {
          country: r.country,
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

      if (shouldIncludeTotal) {
        res.json(totalRowCount === undefined ? { rows } : { rows, totalRowCount });
        return;
      }

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
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
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
      } else if (kind === 'page') {
        const where = withSearch ? 'AND (LOWER(page) LIKE ? OR LOWER(COALESCE(NULLIF(pageKey, \'\'), page)) LIKE ?)' : '';
        const params = withSearch ? [...baseParams, searchTerm, searchTerm] : baseParams;
        total = await db.get<any>(`
          SELECT COUNT(*) AS total
          FROM (
            SELECT COALESCE(NULLIF(pageKey, ''), page) AS pageKey
            FROM gsc_page_query_metrics
            WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? ${where}
            GROUP BY COALESCE(NULLIF(pageKey, ''), page)
          ) pages
        `, params);
        rows = await db.all<any>(`
          SELECT
            COALESCE(NULLIF(pageKey, ''), page) AS pageKey,
            MIN(page) AS page,
            SUM(clicks) AS clicks,
            SUM(impressions) AS impressions,
            CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END AS ctr,
            CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END AS position,
            COUNT(DISTINCT query) AS queryCount
          FROM gsc_page_query_metrics
          WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? ${where}
          GROUP BY COALESCE(NULLIF(pageKey, ''), page)
          ORDER BY clicks DESC, impressions DESC
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
    const kind = asTrimmedString(req.query.kind) || 'page';
    const search = asTrimmedString(req.query.search) || '';
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 5000) : 100;
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(Number(req.query.offset), 0) : 0;

    if (!propertyId || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Missing or invalid raw GA4 parameters' });
    }

    try {
      if (!(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }

      const where = search ? 'AND LOWER(pagePath) LIKE ?' : '';
      const params: unknown[] = search
        ? [ownerId, propertyId, startDate, endDate, `%${search.toLowerCase()}%`]
        : [ownerId, propertyId, startDate, endDate];

      let total: any;
      let rows: any[];

      if (kind === 'page_date') {
        total = await db.get<any>(`
          SELECT COUNT(*) AS total
          FROM ga4_page_metrics
          WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ? ${where}
        `, params);
        rows = await db.all<any>(`
          SELECT date, siteUrl, pagePath, pageKey, sessions, totalUsers, pageViews, bounceRate, eventCount
          FROM ga4_page_metrics
          WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ? ${where}
          ORDER BY date DESC, sessions DESC, pageViews DESC
          LIMIT ? OFFSET ?
        `, [...params, limit, offset]);
      } else {
        total = await db.get<any>(`
          SELECT COUNT(*) AS total
          FROM (
            SELECT pageKey
            FROM ga4_page_metrics
            WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ? ${where}
            GROUP BY pageKey
          ) pages
        `, params);
        rows = await db.all<any>(`
          SELECT
            MAX(siteUrl) AS siteUrl,
            MIN(pagePath) AS pagePath,
            pageKey,
            SUM(sessions) AS sessions,
            SUM(totalUsers) AS totalUsers,
            SUM(pageViews) AS pageViews,
            CASE WHEN SUM(sessions) > 0 THEN SUM(bounceRate * sessions)*1.0/SUM(sessions) ELSE 0 END AS bounceRate,
            SUM(eventCount) AS eventCount
          FROM ga4_page_metrics
          WHERE ownerId = ? AND propertyId = ? AND date >= ? AND date <= ? ${where}
          GROUP BY pageKey
          ORDER BY sessions DESC, pageViews DESC
          LIMIT ? OFFSET ?
        `, [...params, limit, offset]);
      }

      return res.json({
        page: { limit, offset, total: toFiniteNumber(readField(total, 'total')) },
        rows,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to load raw GA4 rows' });
    }
  });

  app.get('/api/warehouse/raw/ga4-report', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const propertyId = asTrimmedString(req.query.propertyId);
    const startDate = asTrimmedString(req.query.startDate);
    const endDate = asTrimmedString(req.query.endDate);
    const kind = asTrimmedString(req.query.kind) || '';
    const search = asTrimmedString(req.query.search) || '';
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 5000) : 100;
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(Number(req.query.offset), 0) : 0;
    const dimension = GA4_RAW_DIMENSIONS[kind];

    if (!propertyId || !isIsoDateString(startDate) || !isIsoDateString(endDate) || !dimension) {
      return res.status(400).json({ error: 'Missing or invalid raw GA4 report parameters' });
    }

    try {
      if (!(await canAccessGa4Property(db, ownerId, propertyId))) {
        return res.status(403).json({ error: 'This GA4 property is not activated for your workspace.' });
      }

      const where = search ? 'AND LOWER(dimensionValue) LIKE ?' : '';
      const params: unknown[] = search
        ? [ownerId, propertyId, dimension, startDate, endDate, `%${search.toLowerCase()}%`]
        : [ownerId, propertyId, dimension, startDate, endDate];
      const total = await db.get<any>(`
        SELECT COUNT(*) AS total
        FROM (
          SELECT dimensionValue
          FROM ga4_dimension_metrics
          WHERE ownerId = ? AND propertyId = ? AND dimension = ? AND date >= ? AND date <= ? ${where}
          GROUP BY dimensionValue
        ) dimension_rows
      `, params);
      const rows = await db.all<any>(`
        SELECT
          dimension,
          dimensionValue,
          SUM(sessions) AS sessions,
          SUM(totalUsers) AS totalUsers,
          SUM(pageViews) AS pageViews,
          CASE WHEN SUM(sessions) > 0 THEN SUM(bounceRate * sessions)*1.0/SUM(sessions) ELSE 0 END AS bounceRate,
          SUM(eventCount) AS eventCount
        FROM ga4_dimension_metrics
        WHERE ownerId = ? AND propertyId = ? AND dimension = ? AND date >= ? AND date <= ? ${where}
        GROUP BY dimension, dimensionValue
        ORDER BY sessions DESC, pageViews DESC, eventCount DESC
        LIMIT ? OFFSET ?
      `, [...params, limit, offset]);

      return res.json({
        page: {
          limit,
          offset,
          total: toFiniteNumber(readField(total, 'total')),
        },
        rows: rows.map((row) => ({
          bounceRate: toFiniteNumber(row.bounceRate),
          dimension,
          dimensionValue: readField(row, 'dimensionValue') || '',
          eventCount: toFiniteNumber(row.eventCount),
          pageViews: toFiniteNumber(row.pageViews),
          sessions: toFiniteNumber(row.sessions),
          totalUsers: toFiniteNumber(row.totalUsers),
        })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to load raw GA4 report rows' });
    }
  });
}
