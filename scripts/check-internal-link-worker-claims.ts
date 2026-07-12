import fs from 'fs';
import os from 'os';
import path from 'path';

import { initializeDatabase } from '../server/database.js';
import { __internalLinkWorkerTestUtils } from '../server/services/internalLinks.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function insertJob(db: Awaited<ReturnType<typeof initializeDatabase>>, input: {
  id: string;
  ownerId: string;
  siteUrl: string;
  status: string;
  startedAt: string | null;
  updatedAt: string;
  lastError?: string | null;
}) {
  await db.run(`
    INSERT INTO internal_link_analysis_jobs (
      id, ownerId, siteUrl, crawlJobId, startDate, endDate, status, progressTotal, progressCompleted,
      provider, embeddingProvider, embeddingModel, reviewProvider, reviewModel, maxPages, maxSentencesPerPage,
      maxRecommendations, estimatedLocalUnits, estimatedEmbeddingTokens, estimatedHostedEmbeddingCost,
      estimatedReviewTokens, estimatedHostedReviewCost, startedAt, updatedAt, completedAt, lastError
    ) VALUES (?, ?, ?, ?, '2026-06-01', '2026-06-30', ?, 10, 0, 'local', 'local', 'bge-m3-local', 'local', 'rules-editorial-v1', 25, 10, 25, 10, 0, 0, 0, 0, ?, ?, NULL, ?)
  `, [
    input.id,
    input.ownerId,
    input.siteUrl,
    `crawl-${input.id}`,
    input.status,
    input.startedAt,
    input.updatedAt,
    input.lastError ?? null,
  ]);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gscplus-claim-workers-'));
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
    if (usePostgres) await db.run("DELETE FROM internal_link_analysis_jobs WHERE ownerId LIKE 'claim-test-owner-%'");
    const queued = [
      ['a-01', 'claim-test-owner-a', 'https://a-one.example/'],
      ['a-02', 'claim-test-owner-a', 'https://a-two.example/'],
      ['a-03', 'claim-test-owner-a', 'https://a-three.example/'],
      ['a-04', 'claim-test-owner-a', 'https://a-four.example/'],
      ['b-01', 'claim-test-owner-b', 'https://b-one.example/'],
      ['b-02', 'claim-test-owner-b', 'https://b-two.example/'],
      ['b-03', 'claim-test-owner-b', 'https://b-three.example/'],
    ] as const;

    for (let index = 0; index < queued.length; index += 1) {
      const [id, ownerId, siteUrl] = queued[index];
      await insertJob(db, {
        id,
        ownerId,
        siteUrl,
        status: 'queued',
        startedAt: null,
        updatedAt: new Date(baseTime + index * 1_000).toISOString(),
      });
    }

    await insertJob(db, {
      id: 'c-stale-01',
      ownerId: 'claim-test-owner-c',
      siteUrl: 'https://c-stale.example/',
      status: 'running',
      startedAt: new Date(baseTime - (3 * 60 * 60 * 1000)).toISOString(),
      updatedAt: new Date(baseTime - (3 * 60 * 60 * 1000)).toISOString(),
    });

    const firstClaims = await Promise.all(
      Array.from({ length: 5 }, () => __internalLinkWorkerTestUtils.claimNextAnalysisJob(db)),
    );
    const claimed = firstClaims.filter(Boolean);
    assert(claimed.length === 5, `Expected 5 claimed jobs, received ${claimed.length}`);
    assert(new Set(claimed.map((job: any) => job.id)).size === 5, 'Parallel claims must never return the same job twice: ' + claimed.map((job: any) => job.id).join(', '));

    const servedOwners = new Set(claimed.map((job: any) => job.ownerId));
    assert(servedOwners.size === 3, 'Fair claims should allocate the first worker wave across all queued owners.');

    const ownerCounts = new Map<string, number>();
    for (const job of claimed as any[]) ownerCounts.set(job.ownerId, (ownerCounts.get(job.ownerId) || 0) + 1);
    const counts = Array.from(ownerCounts.values());
    assert(Math.max(...counts) - Math.min(...counts) <= 1, `Initial claims are not balanced across owners: ${JSON.stringify(Object.fromEntries(ownerCounts))}`);
    assert(claimed.some((job: any) => job.id === 'c-stale-01'), 'A stale running job should be recovered and reclaimed.');

    const fencedJob = claimed[0] as any;
    const heartbeat = __internalLinkWorkerTestUtils.createAnalysisHeartbeat(db, fencedJob);
    await heartbeat(true);
    await db.run('UPDATE internal_link_analysis_jobs SET lockedAt = ? WHERE id = ?', ['replacement-lease', fencedJob.id]);
    let leaseRejected = false;
    try {
      await heartbeat(true);
    } catch (error: any) {
      leaseRejected = error?.name === 'AnalysisLeaseLostError';
    }
    assert(leaseRejected, 'A stale worker heartbeat must be fenced after another worker takes its lease.');

    const remaining = await Promise.all(
      Array.from({ length: 3 }, () => __internalLinkWorkerTestUtils.claimNextAnalysisJob(db)),
    );
    const allClaims = [...claimed, ...remaining.filter(Boolean)];
    assert(allClaims.length === 8, `Expected all 8 jobs to be claimable, got ${allClaims.length}`);
    assert(new Set(allClaims.map((job: any) => job.id)).size === 8, 'Every job must be claimed exactly once.');

    const queuedLeft = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM internal_link_analysis_jobs WHERE status = 'queued'");
    assert(Number(queuedLeft?.count || 0) === 0, 'Expected no queued jobs after draining the queue.');

    console.log(JSON.stringify({
      firstClaimOwners: claimed.map((job: any) => job.ownerId),
      ownerCounts: Object.fromEntries(ownerCounts),
      recoveredStale: true,
      staleWorkerFenced: true,
      totalClaims: allClaims.length,
      uniqueClaims: new Set(allClaims.map((job: any) => job.id)).size,
    }, null, 2));
  } finally {
    if (usePostgres) await db.run("DELETE FROM internal_link_analysis_jobs WHERE ownerId LIKE 'claim-test-owner-%'").catch(() => {});
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
