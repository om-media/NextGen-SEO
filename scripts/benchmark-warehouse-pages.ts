import dotenv from 'dotenv';
import { performance } from 'node:perf_hooks';
import { initializeDatabase, type AppDatabase } from '../server/database.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

type Candidate = {
  ownerId: string;
  siteUrl: string;
  startDate: string;
  endDate: string;
  detailRows: number;
};

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function timed<T>(label: string, fn: () => Promise<T>) {
  const startedAt = performance.now();
  const result = await fn();
  const elapsedMs = performance.now() - startedAt;
  console.log(`${label}: ${elapsedMs.toFixed(1)}ms`);
  return result;
}

async function getCandidate(db: AppDatabase): Promise<Candidate> {
  const ownerId = argValue('owner') || process.env.BENCHMARK_OWNER_ID;
  const siteUrl = argValue('site') || process.env.BENCHMARK_SITE_URL;
  const startDate = argValue('start') || process.env.BENCHMARK_START_DATE;
  const endDate = argValue('end') || process.env.BENCHMARK_END_DATE;

  if (ownerId && siteUrl && startDate && endDate) {
    const row = await db.get<{ detailRows: number }>(`
      SELECT COUNT(*) AS detailRows
      FROM gsc_page_query_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date BETWEEN ? AND ?
    `, [ownerId, siteUrl, startDate, endDate]);
    return {
      ownerId,
      siteUrl,
      startDate,
      endDate,
      detailRows: numberValue(row?.detailRows),
    };
  }

  const inferred = await db.get<Candidate>(`
    SELECT ownerId,
           siteUrl,
           MIN(date) AS startDate,
           MAX(date) AS endDate,
           COUNT(*) AS detailRows
    FROM gsc_page_query_metrics
    GROUP BY ownerId, siteUrl
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `);

  if (!inferred) {
    throw new Error('No gsc_page_query_metrics rows found. Pass --owner, --site, --start, and --end after importing data.');
  }

  return {
    ownerId: inferred.ownerId,
    siteUrl: inferred.siteUrl,
    startDate: inferred.startDate,
    endDate: inferred.endDate,
    detailRows: numberValue(inferred.detailRows),
  };
}

async function main() {
  const db = await initializeDatabase();
  try {
    const candidate = await getCandidate(db);
    console.log(JSON.stringify({
      dialect: db.dialect,
      ownerId: candidate.ownerId,
      siteUrl: candidate.siteUrl,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
      detailRows: candidate.detailRows,
    }, null, 2));

    const summaryCount = await timed('summary row count', () => db.get<{ total: number }>(`
      SELECT COUNT(*) AS total
      FROM gsc_page_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date BETWEEN ? AND ?
    `, [candidate.ownerId, candidate.siteUrl, candidate.startDate, candidate.endDate]));

    console.log(`summaryRows: ${numberValue(summaryCount?.total)}`);

    const pageCount = await timed('distinct page count', () => db.get<{ total: number }>(`
      SELECT COUNT(DISTINCT pageKey) AS total
      FROM gsc_page_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date BETWEEN ? AND ? AND pageKey <> ''
    `, [candidate.ownerId, candidate.siteUrl, candidate.startDate, candidate.endDate]));

    console.log(`pages: ${numberValue(pageCount?.total)}`);

    const topRows = await timed('top pages summary query', () => db.all(`
      SELECT MIN(page) AS page,
             COALESCE(NULLIF(pageKey, ''), MIN(page)) AS pageKey,
             SUM(clicks) AS clicks,
             SUM(impressions) AS impressions,
             CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END AS ctr,
             CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END AS position
      FROM gsc_page_metrics
      WHERE ownerId = ? AND siteUrl = ? AND date BETWEEN ? AND ? AND pageKey <> ''
      GROUP BY pageKey
      ORDER BY clicks DESC, impressions DESC
      LIMIT 1000
    `, [candidate.ownerId, candidate.siteUrl, candidate.startDate, candidate.endDate]));

    console.log(`topRows: ${topRows.length}`);
  } finally {
    await db.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
