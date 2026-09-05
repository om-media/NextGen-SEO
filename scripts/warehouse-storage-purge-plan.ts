import dotenv from 'dotenv';
import { initializeDatabase } from '../server/database.js';
import { getWarehouseStoragePurgePlan } from '../server/services/warehouseStorage.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const retentionDays = Number(argValue('retention-days') || process.env.WAREHOUSE_HOT_RETENTION_DAYS || 180);
const includeSql = process.argv.includes('--include-sql');
const db = await initializeDatabase({ skipDataBackfills: true });
try {
  const plan = await getWarehouseStoragePurgePlan(db, retentionDays);
  const output: Record<string, unknown> = { ...plan };
  if (includeSql && plan.cutoffDate) {
    output.deleteSql = plan.tables
      .filter((table) => table.candidateRows > 0)
      .map((table) => `DELETE FROM "${table.tableName}" WHERE "date" < '${plan.cutoffDate}';`);
  }
  console.log(JSON.stringify(output, null, 2));
} finally {
  await db.close();
}
