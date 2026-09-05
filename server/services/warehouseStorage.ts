import type { AppDatabase } from '../database.js';

export const RAW_GSC_WAREHOUSE_TABLES = [
  'gsc_site_metrics',
  'gsc_query_metrics',
  'gsc_country_metrics',
  'gsc_page_metrics',
  'gsc_page_query_metrics',
] as const;

export type RawGscWarehouseTable = typeof RAW_GSC_WAREHOUSE_TABLES[number];

export type WarehouseStorageTableReport = {
  candidateRows: number;
  maxDate: string | null;
  minDate: string | null;
  retainedRows: number;
  rowCount: number;
  sizeBytes: number | null;
  tableName: RawGscWarehouseTable;
  distinctDays: number;
};

export type WarehouseStorageReport = {
  cutoffDate: string | null;
  latestObservedDate: string | null;
  retentionDays: number;
  tables: WarehouseStorageTableReport[];
};

export type WarehouseStorageLocation = 'hot' | 'cold' | 'mixed' | 'unavailable';

export type WarehouseStorageRangeRoute = {
  archiveBeforeDate: string | null;
  endDate: string;
  hotStartDate: string | null;
  latestObservedDate: string | null;
  location: WarehouseStorageLocation;
  startDate: string;
  tableName: RawGscWarehouseTable;
};

export type WarehouseStoragePurgeTablePlan = WarehouseStorageTableReport & {
  archivePath: string | null;
  archiveVerified: boolean;
  estimatedReclaimableBytes: number | null;
};

export type WarehouseStoragePurgePlan = {
  archiveReady: boolean;
  cutoffDate: string | null;
  estimatedReclaimableBytes: number | null;
  retentionDays: number;
  tables: WarehouseStoragePurgeTablePlan[];
};

function toCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function toBytes(value: unknown) {
  const bytes = Number(value);
  return Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : null;
}

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function subtractDays(date: string, days: number) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() - days);
  return toIsoDate(result);
}

function normalizeRetentionDays(value: number) {
  if (!Number.isFinite(value)) return 180;
  return Math.max(1, Math.min(3650, Math.trunc(value)));
}

function validateDate(value: string, name: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid ${name}: ${value}. Use YYYY-MM-DD.`);
  return value;
}

export function classifyWarehouseStorageRange({
  startDate,
  endDate,
  hotStartDate,
  archiveBeforeDate,
}: {
  startDate: string;
  endDate: string;
  hotStartDate: string;
  archiveBeforeDate?: string | null;
}): WarehouseStorageLocation {
  if (endDate < startDate) throw new Error(`Storage range ends before it starts: ${startDate}..${endDate}`);
  if (endDate < hotStartDate) return archiveBeforeDate && archiveBeforeDate > endDate ? 'cold' : 'unavailable';
  if (startDate >= hotStartDate) return 'hot';
  return archiveBeforeDate && archiveBeforeDate >= hotStartDate ? 'mixed' : 'unavailable';
}

export async function getWarehouseStorageRangeRoute(
  db: AppDatabase,
  tableName: RawGscWarehouseTable,
  startDate: string,
  endDate: string,
  retentionDays = 180,
): Promise<WarehouseStorageRangeRoute> {
  const normalizedStartDate = validateDate(startDate, 'range start date');
  const normalizedEndDate = validateDate(endDate, 'range end date');
  if (normalizedEndDate < normalizedStartDate) {
    throw new Error(`Storage range ends before it starts: ${normalizedStartDate}..${normalizedEndDate}`);
  }
  const normalizedRetentionDays = normalizeRetentionDays(retentionDays);
  const latest = await db.get<{ latestObservedDate: string | null }>(`
    SELECT MAX(date) AS "latestObservedDate"
    FROM ${tableName}
  `);
  const latestObservedDate = latest?.latestObservedDate || null;
  if (!latestObservedDate) {
    return {
      archiveBeforeDate: null,
      endDate: normalizedEndDate,
      hotStartDate: null,
      latestObservedDate: null,
      location: 'unavailable',
      startDate: normalizedStartDate,
      tableName,
    };
  }
  const hotStartDate = subtractDays(latestObservedDate, normalizedRetentionDays - 1);
  const archives = await db.all<{ beforeDate: string; status: string }>(`
    SELECT beforeDate, status
    FROM warehouse_storage_archives
    WHERE tableName = ? AND status = 'verified'
    ORDER BY beforeDate DESC
  `, [tableName]);
  const archiveBeforeDate = archives.find((archive) => archive.beforeDate > normalizedEndDate)?.beforeDate || null;
  const location = normalizedEndDate > latestObservedDate
    ? 'unavailable'
    : classifyWarehouseStorageRange({
      startDate: normalizedStartDate,
      endDate: normalizedEndDate,
      hotStartDate,
      archiveBeforeDate,
    });
  return {
    archiveBeforeDate,
    endDate: normalizedEndDate,
    hotStartDate,
    latestObservedDate,
    location,
    startDate: normalizedStartDate,
    tableName,
  };
}

export async function getWarehouseStorageReport(
  db: AppDatabase,
  retentionDays = 180,
): Promise<WarehouseStorageReport> {
  const normalizedRetentionDays = normalizeRetentionDays(retentionDays);
  const latest = await db.get<{ latestObservedDate: string | null }>(`
    SELECT MAX(date) AS "latestObservedDate"
    FROM gsc_page_query_metrics
  `);
  const latestObservedDate = latest?.latestObservedDate || null;
  const cutoffDate = latestObservedDate
    ? subtractDays(latestObservedDate, normalizedRetentionDays - 1)
    : null;

  const tables = await Promise.all(RAW_GSC_WAREHOUSE_TABLES.map(async (tableName) => {
    const row = await db.get<any>(`
      SELECT
        MIN(date) AS "minDate",
        MAX(date) AS "maxDate",
        COUNT(DISTINCT date) AS "distinctDays",
        COUNT(*) AS "rowCount",
        ${cutoffDate ? 'SUM(CASE WHEN date < ? THEN 1 ELSE 0 END)' : '0'} AS "candidateRows",
        ${cutoffDate ? 'SUM(CASE WHEN date >= ? THEN 1 ELSE 0 END)' : '0'} AS "retainedRows"
      FROM ${tableName}
    `, cutoffDate ? [cutoffDate, cutoffDate] : []);

    let sizeBytes: number | null = null;
    if (db.dialect === 'postgres') {
      const size = await db.get<{ sizeBytes: number }>(
        'SELECT pg_total_relation_size(?::regclass) AS "sizeBytes"',
        [tableName],
      );
      sizeBytes = toBytes(size?.sizeBytes);
    }

    return {
      candidateRows: toCount(row?.candidateRows),
      maxDate: row?.maxDate || null,
      minDate: row?.minDate || null,
      retainedRows: toCount(row?.retainedRows),
      rowCount: toCount(row?.rowCount),
      sizeBytes,
      tableName,
      distinctDays: toCount(row?.distinctDays),
    } satisfies WarehouseStorageTableReport;
  }));

  return {
    cutoffDate,
    latestObservedDate,
    retentionDays: normalizedRetentionDays,
    tables,
  };
}

export async function getWarehouseStoragePurgePlan(
  db: AppDatabase,
  retentionDays = 180,
): Promise<WarehouseStoragePurgePlan> {
  const report = await getWarehouseStorageReport(db, retentionDays);
  const archives = report.cutoffDate
    ? await db.all<{ tableName: RawGscWarehouseTable; archivePath: string; status: string }>(`
      SELECT tableName, archivePath, status
      FROM warehouse_storage_archives
      WHERE beforeDate = ?
    `, [report.cutoffDate])
    : [];
  const archiveByTable = new Map(archives.map((archive) => [archive.tableName, archive]));
  const tables = report.tables.map((table) => {
    const archive = archiveByTable.get(table.tableName);
    const estimatedReclaimableBytes = table.sizeBytes === null || table.rowCount === 0
      ? table.sizeBytes === null ? null : 0
      : Math.round(table.sizeBytes * (table.candidateRows / table.rowCount));
    return {
      ...table,
      archivePath: archive?.archivePath || null,
      archiveVerified: archive?.status === 'verified',
      estimatedReclaimableBytes,
    };
  });
  const knownEstimates = tables
    .map((table) => table.estimatedReclaimableBytes)
    .filter((value): value is number => value !== null);
  return {
    archiveReady: tables.every((table) => table.candidateRows === 0 || table.archiveVerified),
    cutoffDate: report.cutoffDate,
    estimatedReclaimableBytes: knownEstimates.length === tables.length
      ? knownEstimates.reduce((sum, value) => sum + value, 0)
      : null,
    retentionDays: report.retentionDays,
    tables,
  };
}
