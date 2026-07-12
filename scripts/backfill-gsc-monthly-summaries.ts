import dotenv from 'dotenv';
import { performance } from 'node:perf_hooks';
import { initializeDatabase } from '../server/database.js';
import {
  ALL_GSC_MONTHLY_SUMMARY_TABLES,
  backfillMissingGscMonthlySummaries,
  getGscMonthlySummaryCoverage,
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
        const coverage = await getGscMonthlySummaryCoverage(db, site, ALL_GSC_MONTHLY_SUMMARY_TABLES);
        console.log(`${site.siteUrl} ${site.startDate}..${site.endDate}`);
        console.log(`  fullCoverage=${coverage.hasFullCoverage} expectedMonths=${coverage.expectedMonthStarts.length}`);
        for (const table of coverage.tables) {
          console.log(`  ${table.tableName}=${table.hasFullCoverage} available=${table.availableMonthStarts.length} missing=${table.missingMonthStarts.length}`);
          if (table.missingMonthStarts.length > 0) {
            console.log(`    missingMonths=${table.missingMonthStarts.join(',')}`);
          }
        }
      }
      return;
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
