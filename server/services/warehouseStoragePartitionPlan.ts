import type { AppDatabase } from '../database.js';
import type { WarehouseStorageReport, RawGscWarehouseTable } from './warehouseStorage.js';

type PartitionKey = {
  columns: string[];
};

export type WarehouseStoragePartition = {
  tableName: RawGscWarehouseTable;
  partitionName: string;
  rangeStart: string;
  rangeEnd: string;
  storageClass: 'hot' | 'archive';
};

export type WarehouseStoragePartitionPlan = {
  retentionDays: number;
  hotCutoffDate: string | null;
  partitions: WarehouseStoragePartition[];
  sql: string;
};

const PARTITION_KEYS: Record<RawGscWarehouseTable, PartitionKey> = {
  gsc_site_metrics: { columns: ['ownerId', 'siteUrl', 'date'] },
  gsc_query_metrics: { columns: ['ownerId', 'siteUrl', 'date', 'query'] },
  gsc_country_metrics: { columns: ['ownerId', 'siteUrl', 'date', 'country'] },
  gsc_page_metrics: { columns: ['ownerId', 'siteUrl', 'date', 'pageKey'] },
  gsc_page_query_metrics: { columns: ['ownerId', 'siteUrl', 'date', 'page', 'query'] },
};

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function toMonthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

function addMonths(date: string, months: number) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result.toISOString().slice(0, 10);
}

function monthPartitionName(tableName: RawGscWarehouseTable, rangeStart: string) {
  return `${tableName}_p_${rangeStart.slice(0, 7).replace('-', '_')}`;
}

function buildPartitions(report: WarehouseStorageReport): WarehouseStoragePartition[] {
  const partitions: WarehouseStoragePartition[] = [];
  for (const table of report.tables) {
    if (!table.minDate || !table.maxDate) continue;
    const firstMonth = toMonthStart(table.minDate);
    const lastMonth = toMonthStart(table.maxDate);
    let rangeStart = firstMonth;
    const finalMonth = addMonths(lastMonth, 1);
    while (rangeStart <= finalMonth) {
      const rangeEnd = addMonths(rangeStart, 1);
      const storageClass = report.cutoffDate && rangeEnd <= report.cutoffDate ? 'archive' : 'hot';
      partitions.push({
        tableName: table.tableName,
        partitionName: monthPartitionName(table.tableName, rangeStart),
        rangeStart,
        rangeEnd,
        storageClass,
      });
      rangeStart = rangeEnd;
    }
  }
  return partitions;
}

function buildSql(partitions: WarehouseStoragePartition[]) {
  const tables = [...new Set(partitions.map((partition) => partition.tableName))];
  const statements: string[] = [
    '-- Review this plan before applying. It creates shadow parents and does not move or delete source rows.',
  ];

  for (const tableName of tables) {
    const parentName = `${tableName}_partitioned`;
    const keyColumns = PARTITION_KEYS[tableName].columns.map(quoteIdentifier).join(', ');
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(parentName)} (LIKE ${quoteIdentifier(tableName)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS, CONSTRAINT ${quoteIdentifier(`${parentName}_pk`)} PRIMARY KEY (${keyColumns})) PARTITION BY RANGE ("date");`,
    );
  }

  for (const partition of partitions) {
    const parentName = `${partition.tableName}_partitioned`;
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(partition.partitionName)} PARTITION OF ${quoteIdentifier(parentName)} FOR VALUES FROM ('${partition.rangeStart}') TO ('${partition.rangeEnd}');`,
    );
  }

  return `${statements.join('\n')}\n`;
}

export function buildWarehouseStoragePartitionPlan(
  report: WarehouseStorageReport,
): WarehouseStoragePartitionPlan {
  const partitions = buildPartitions(report);
  return {
    retentionDays: report.retentionDays,
    hotCutoffDate: report.cutoffDate,
    partitions,
    sql: buildSql(partitions),
  };
}

export async function recordWarehouseStoragePartitionPlan(
  db: AppDatabase,
  plan: WarehouseStoragePartitionPlan,
) {
  const createdAt = new Date().toISOString();
  const writePlan = async () => {
    for (const partition of plan.partitions) {
      await db.run(`
        INSERT INTO warehouse_storage_partitions
          (id, tableName, partitionName, rangeStart, rangeEnd, storageClass, status, createdAt, appliedAt)
        VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, NULL)
        ON CONFLICT (tableName, partitionName) DO UPDATE SET
          rangeStart = excluded.rangeStart,
          rangeEnd = excluded.rangeEnd,
          storageClass = excluded.storageClass,
          status = CASE WHEN warehouse_storage_partitions.status = 'applied' THEN warehouse_storage_partitions.status ELSE 'planned' END
      `, [
        `${partition.tableName}:${partition.partitionName}`,
        partition.tableName,
        partition.partitionName,
        partition.rangeStart,
        partition.rangeEnd,
        partition.storageClass,
        createdAt,
      ]);
    }
  };
  await db.transaction(writePlan)();
  return plan.partitions.length;
}
