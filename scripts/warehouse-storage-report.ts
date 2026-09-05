import dotenv from 'dotenv';
import { initializeDatabase } from '../server/database.js';
import { getWarehouseStorageReport } from '../server/services/warehouseStorage.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const retentionDays = Number(argValue('retention-days') || process.env.WAREHOUSE_HOT_RETENTION_DAYS || 180);
const db = await initializeDatabase({ skipDataBackfills: true });

try {
  const report = await getWarehouseStorageReport(db, retentionDays);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}
