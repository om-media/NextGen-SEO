import dotenv from 'dotenv';
import { initializeDatabase } from '../server/database.js';
import { getWarehouseStorageReport } from '../server/services/warehouseStorage.js';
import { buildWarehouseStoragePartitionPlan, recordWarehouseStoragePartitionPlan } from '../server/services/warehouseStoragePartitionPlan.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const retentionDays = Number(argValue('retention-days') || process.env.WAREHOUSE_HOT_RETENTION_DAYS || 180);
const record = process.argv.includes('--record');
const db = await initializeDatabase({ skipDataBackfills: true });

try {
  const report = await getWarehouseStorageReport(db, retentionDays);
  const plan = buildWarehouseStoragePartitionPlan(report);
  const recordedPartitions = record ? await recordWarehouseStoragePartitionPlan(db, plan) : 0;
  console.log(JSON.stringify({ ...plan, sql: undefined, record, recordedPartitions }, null, 2));
  console.log('\n-- PostgreSQL shadow-table plan --\n');
  console.log(plan.sql);
} finally {
  await db.close();
}
