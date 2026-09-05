import assert from 'node:assert/strict';
import type { AppDatabase } from '../server/database.js';
import { buildWarehouseStoragePartitionPlan } from '../server/services/warehouseStoragePartitionPlan.js';
import { recordWarehouseStoragePartitionPlan } from '../server/services/warehouseStoragePartitionPlan.js';
import type { WarehouseStorageReport } from '../server/services/warehouseStorage.js';

const report: WarehouseStorageReport = {
  retentionDays: 180,
  latestObservedDate: '2026-08-10',
  cutoffDate: '2026-02-12',
  tables: [
    {
      tableName: 'gsc_page_query_metrics',
      minDate: '2025-01-04',
      maxDate: '2026-08-10',
      distinctDays: 584,
      rowCount: 100,
      candidateRows: 40,
      retainedRows: 60,
      sizeBytes: 1000,
    },
  ],
};

const plan = buildWarehouseStoragePartitionPlan(report);
assert.equal(plan.partitions.length, 21);
assert.equal(plan.partitions[0]?.rangeStart, '2025-01-01');
assert.equal(plan.partitions[0]?.rangeEnd, '2025-02-01');
assert.equal(plan.partitions[0]?.storageClass, 'archive');
assert.equal(plan.partitions.at(-1)?.rangeStart, '2026-09-01');
assert.equal(plan.partitions.at(-1)?.storageClass, 'hot');
assert.match(plan.sql, /gsc_page_query_metrics_partitioned/);
assert.match(plan.sql, /PARTITION BY RANGE \("date"\)/);
assert.match(plan.sql, /FROM \('2025-01-01'\) TO \('2025-02-01'\)/);

const writes: unknown[][] = [];
const metadataDb = {
  run: async (_sql: string, params?: unknown[]) => {
    writes.push(params || []);
    return { changes: 1 };
  },
  transaction: (callback: () => Promise<void>) => async () => callback(),
} as unknown as AppDatabase;
assert.equal(await recordWarehouseStoragePartitionPlan(metadataDb, plan), 21);
assert.equal(writes.length, 21);
console.log('warehouse storage partition plan checks passed');
