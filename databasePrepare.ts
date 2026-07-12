import dotenv from 'dotenv';
import { validateRuntimeConfig } from './server/config.js';
import { initializeDatabase } from './server/database.js';

dotenv.config({ path: '.env.local' });
dotenv.config();
validateRuntimeConfig();

async function prepareDatabase() {
  process.env.RUN_DATABASE_BACKFILLS = 'true';
  const db = await initializeDatabase();
  await db.close?.();
  console.log('[db-prepare] Schema migrations and startup backfills completed.');
}

prepareDatabase().catch((error) => {
  console.error('[db-prepare] Failed:', error);
  process.exit(1);
});
