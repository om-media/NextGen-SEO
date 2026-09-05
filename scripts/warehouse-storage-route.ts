import dotenv from 'dotenv';
import { initializeDatabase } from '../server/database.js';
import { getWarehouseStorageRangeRoute, RAW_GSC_WAREHOUSE_TABLES, type RawGscWarehouseTable } from '../server/services/warehouseStorage.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const tableName = argValue('table') as RawGscWarehouseTable | undefined;
const startDate = argValue('start');
const endDate = argValue('end');
if (!tableName || !RAW_GSC_WAREHOUSE_TABLES.includes(tableName)) {
  throw new Error(`Table is required. Choose one of: ${RAW_GSC_WAREHOUSE_TABLES.join(', ')}`);
}
if (!startDate || !endDate) throw new Error('Range is required. Pass --start=YYYY-MM-DD --end=YYYY-MM-DD.');

const retentionDays = Number(argValue('retention-days') || process.env.WAREHOUSE_HOT_RETENTION_DAYS || 180);
const db = await initializeDatabase({ skipDataBackfills: true });
try {
  console.log(JSON.stringify(await getWarehouseStorageRangeRoute(db, tableName, startDate, endDate, retentionDays), null, 2));
} finally {
  await db.close();
}
