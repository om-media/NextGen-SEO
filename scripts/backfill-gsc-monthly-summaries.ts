import dotenv from 'dotenv';
import { performance } from 'node:perf_hooks';
import { initializeDatabase } from '../server/database.js';
import {
  ALL_GSC_MONTHLY_SUMMARY_TABLES,
  backfillMissingGscMonthlySummaries,
  hasGscMonthlySummariesForRange,
} from '../server/services/gscMonthlySummaries.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

async function main() {
  const startedAt = performance.now();
  const db = await initializeDatabase();
  try {
    if (process.argv.includes('--diagnose')) {
      const sites = await db.all<{ ownerId: string; siteUrl: string; startDate: string; endDate: string }>(`
        SELECT ownerId, siteUrl, MIN(date) AS startDate, MAX(date) AS endDate
        FROM gsc_site_metrics
        GROUP BY ownerId, siteUrl
        ORDER BY COUNT(*) DESC
        LIMIT 5
      `);
      for (const site of sites) {
        console.log(`${site.siteUrl} ${site.startDate}..${site.endDate}`);
        console.log(`  all=${await hasGscMonthlySummariesForRange(db, site)}`);
        for (const table of ALL_GSC_MONTHLY_SUMMARY_TABLES) {
          console.log(`  ${table}=${await hasGscMonthlySummariesForRange(db, site, [table])}`);
        }
      }
    }
    await backfillMissingGscMonthlySummaries(db);
    const elapsedMs = performance.now() - startedAt;
    console.log(`[db] GSC monthly summary backfill completed in ${elapsedMs.toFixed(0)}ms`);
  } finally {
    await db.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
