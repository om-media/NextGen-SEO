import fs from 'fs';
import os from 'os';
import path from 'path';

import { initializeDatabase } from '../server/database.js';
import { buildCrawlQueueMetadata } from '../server/routes/crawl.js';
import { __crawlQueueTestUtils } from '../server/services/crawl.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function insertJob(db: Awaited<ReturnType<typeof initializeDatabase>>, input: {
  id: string;
  ownerId: string;
  siteUrl: string;
  status: string;
  updatedAt: string;
  lockedAt?: string | null;
}) {
  await db.run(`
    INSERT INTO crawl_jobs (
      id, ownerId, siteUrl, startUrl, sitemapUrl, status, maxPages, maxDepth,
      discoveredCount, crawledCount, errorCount, skippedCount, queuedCount,
      startedAt, updatedAt, completedAt, lastError, attemptCount, maxAttempts,
      lockedAt, nextRunAt, renderMode, respectRobots, includeQueryStrings, userAgent
    ) VALUES (?, ?, ?, ?, NULL, ?, 100, 4, 0, 0, 0, 0, 0, ?, ?, NULL, NULL, 0, 3, ?, ?, 'html', 1, 0, 'test-crawler')
  `, [
    input.id,
    input.ownerId,
    input.siteUrl,
    input.siteUrl,
    input.status,
    input.status === 'running' ? input.updatedAt : null,
    input.updatedAt,
    input.lockedAt ?? null,
    input.status === 'queued' ? input.updatedAt : null,
  ]);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gscplus-crawl-claims-'));
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;
  const usePostgres = process.env.USE_TEST_POSTGRES === 'true';
  if (!usePostgres) {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    process.chdir(tempDir);
  }

  const db = await initializeDatabase();
  const baseTime = Date.parse('2026-07-10T10:00:00.000Z');

  try {
    if (usePostgres) await db.run("DELETE FROM crawl_jobs WHERE ownerId LIKE 'crawl-claim-owner-%'");
    const queued = [
      ['crawl-claim-a-01', 'crawl-claim-owner-a', 'https://a-one.example/'],
      ['crawl-claim-a-01-duplicate', 'crawl-claim-owner-a', 'https://a-one.example/'],
      ['crawl-claim-a-02', 'crawl-claim-owner-a', 'https://a-two.example/'],
      ['crawl-claim-b-01', 'crawl-claim-owner-b', 'https://b-one.example/'],
      ['crawl-claim-b-02', 'crawl-claim-owner-b', 'https://b-two.example/'],
    ] as const;
    for (let index = 0; index < queued.length; index += 1) {
      const [id, ownerId, siteUrl] = queued[index];
      await insertJob(db, {
        id,
        ownerId,
        siteUrl,
        status: 'queued',
        updatedAt: new Date(baseTime + index * 1_000).toISOString(),
      });
    }
    await insertJob(db, {
      id: 'crawl-claim-c-stale-01',
      ownerId: 'crawl-claim-owner-c',
      siteUrl: 'https://c-stale.example/',
      status: 'running',
      updatedAt: new Date(baseTime - 3 * 60 * 60 * 1000).toISOString(),
      lockedAt: new Date(baseTime - 3 * 60 * 60 * 1000).toISOString(),
    });

    await __crawlQueueTestUtils.recoverInterruptedCrawlJobs(db);

    const firstClaims = await Promise.all(
      Array.from({ length: 5 }, () => __crawlQueueTestUtils.claimNextQueuedCrawlJob(db)),
    );
    const claimed = firstClaims.filter(Boolean) as any[];
    assert(claimed.length === 5, `Expected five distinct-site claims, got ${claimed.length}: ${claimed.map((job) => job.id).join(', ')}`);
    assert(new Set(claimed.map((job) => job.id)).size === 5, 'Crawl claims must be unique.');
    const ownerCounts = new Map<string, number>();
    for (const job of claimed) ownerCounts.set(job.ownerId, (ownerCounts.get(job.ownerId) || 0) + 1);
    const claimCounts = Array.from(ownerCounts.values());
    assert(ownerCounts.size === 3 && Math.max(...claimCounts) - Math.min(...claimCounts) <= 1, 'First worker wave should be balanced across crawl owners.');
    assert(claimed.some((job) => job.id === 'crawl-claim-c-stale-01'), 'Stale crawl should be recovered and reclaimed.');

    const sameSiteClaims = claimed.filter((job) => job.siteUrl === 'https://a-one.example/');
    assert(sameSiteClaims.length === 1, 'Only one crawl per owner and site may run concurrently.');

    const deferred = await db.get<{ status: string }>('SELECT status FROM crawl_jobs WHERE id = ?', ['crawl-claim-a-01-duplicate']);
    assert(deferred?.status === 'queued', 'Second same-site crawl should remain queued.');

    await db.run("UPDATE crawl_jobs SET status = 'completed', completedAt = ?, lockedAt = NULL WHERE id = ?", [
      new Date().toISOString(),
      sameSiteClaims[0].id,
    ]);
    const next = await __crawlQueueTestUtils.claimNextQueuedCrawlJob(db) as any;
    assert(next?.id === 'crawl-claim-a-01-duplicate', `Expected deferred same-site crawl next, got ${next?.id || 'none'}`);

    process.env.CRAWL_JOB_CONCURRENCY = '2';
    const queueNow = Date.parse('2026-07-10T12:00:00.000Z');
    const queueMetadata = buildCrawlQueueMetadata({
      activeJobs: [
        {
          completedAt: null,
          id: 'queue-running-1',
          nextRunAt: null,
          siteUrl: 'https://queue-one.example/',
          startedAt: new Date(queueNow - 60_000).toISOString(),
          status: 'running',
          updatedAt: new Date(queueNow - 60_000).toISOString(),
        },
        {
          completedAt: null,
          id: 'queue-running-2',
          nextRunAt: null,
          siteUrl: 'https://queue-two.example/',
          startedAt: new Date(queueNow - 10_000).toISOString(),
          status: 'running',
          updatedAt: new Date(queueNow - 10_000).toISOString(),
        },
        {
          completedAt: null,
          id: 'queue-target',
          nextRunAt: new Date(queueNow).toISOString(),
          siteUrl: 'https://queue-target.example/',
          startedAt: null,
          status: 'queued',
          updatedAt: new Date(queueNow).toISOString(),
        },
        {
          completedAt: null,
          id: 'queue-after-target',
          nextRunAt: new Date(queueNow + 1_000).toISOString(),
          siteUrl: 'https://queue-after-target.example/',
          startedAt: null,
          status: 'queued',
          updatedAt: new Date(queueNow + 1_000).toISOString(),
        },
      ],
      completedJobs: [
        {
          completedAt: new Date(queueNow - 120_000).toISOString(),
          id: 'queue-completed-1',
          nextRunAt: null,
          siteUrl: 'https://queue-completed.example/',
          startedAt: new Date(queueNow - 240_000).toISOString(),
          status: 'completed',
          updatedAt: new Date(queueNow - 120_000).toISOString(),
        },
        {
          completedAt: new Date(queueNow - 300_000).toISOString(),
          id: 'queue-completed-2',
          nextRunAt: null,
          siteUrl: 'https://queue-completed.example/',
          startedAt: new Date(queueNow - 420_000).toISOString(),
          status: 'completed',
          updatedAt: new Date(queueNow - 300_000).toISOString(),
        },
      ],
      now: queueNow,
      targetJob: { id: 'queue-target', status: 'queued' },
    });
    assert(queueMetadata.estimatedDurationSeconds === 120, `Expected 120 second crawl estimate, got ${queueMetadata.estimatedDurationSeconds}`);
    assert(queueMetadata.estimatedStartInSeconds === 60, `Expected queued crawl to start in 60 seconds with two workers, got ${queueMetadata.estimatedStartInSeconds}`);
    assert(queueMetadata.position === 2, `Expected queued crawl to report position 2, got ${queueMetadata.position}`);
    assert(queueMetadata.runningAhead === 1, `Expected one blocking running batch ahead, got ${queueMetadata.runningAhead}`);

    console.log(JSON.stringify({
      deferredSameSiteClaim: next.id,
      firstClaimOwners: claimed.map((job) => job.ownerId),
      queueEstimatedStartInSeconds: queueMetadata.estimatedStartInSeconds,
      queuePosition: queueMetadata.position,
      recoveredStale: true,
      totalInitialClaims: claimed.length,
      uniqueClaims: new Set(claimed.map((job) => job.id)).size,
    }, null, 2));
  } finally {
    if (usePostgres) await db.run("DELETE FROM crawl_jobs WHERE ownerId LIKE 'crawl-claim-owner-%'").catch(() => {});
    await db.close?.();
    if (!usePostgres) process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = originalPostgresUrl;
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
