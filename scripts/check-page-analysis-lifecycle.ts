import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initializeDatabase, type AppDatabase } from '../server/database.js';
import { queueCompletedCrawlAnalysis, startPageAnalysisWorker } from '../server/services/pageAnalysis.js';
import { ensureSiteScope, resolveSiteScopeBySiteUrl } from '../server/services/siteScopes.js';

type SeedPageInput = {
  bodyHeading: string;
  crawlJobId: string;
  ownerId: string;
  pageIndex: number;
  pageKey: string;
  regionLabel: string;
  siteUrl: string;
  slug: string;
  title: string;
};

type QueuedJobRow = {
  crawlJobId: string | null;
  id: string;
  siteScopeId: string | null;
  status: string | null;
};

const OWNER_A = 'page-analysis-owner-a';
const OWNER_B = 'page-analysis-owner-b';
const SITE_URL = 'https://www.example.com/';
const GSC_SITE_URL = 'sc-domain:example.com';
const GA4_PROPERTY_ID = 'properties/123456789';
const FIXTURE_CREATED_AT = '2026-07-17T08:00:00.000Z';
const FIXTURE_CRAWLED_AT = '2026-07-17T08:05:00.000Z';

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function countRows(db: AppDatabase, sql: string, params: unknown[] = []) {
  const row = await db.get<{ count?: number }>(sql, params);
  return Number(row?.count || 0);
}

async function queueJob(db: AppDatabase, input: Parameters<typeof queueCompletedCrawlAnalysis>[1]): Promise<QueuedJobRow> {
  const queued = await queueCompletedCrawlAnalysis(db, input) as unknown;
  if (typeof queued === 'function') {
    return await queued();
  }
  return queued as QueuedJobRow;
}

async function insertCrawlJob(
  db: AppDatabase,
  input: {
    completedAt: string;
    id: string;
    ownerId: string;
    siteUrl: string;
  },
) {
  await db.run(
    `INSERT INTO crawl_jobs (
       id, ownerId, siteUrl, startUrl, sitemapUrl, status, maxPages, maxDepth,
       discoveredCount, crawledCount, errorCount, skippedCount, queuedCount,
       startedAt, updatedAt, completedAt, lastError, attemptCount, maxAttempts,
       lockedAt, nextRunAt, renderMode, respectRobots, includeQueryStrings, userAgent
     ) VALUES (?, ?, ?, ?, NULL, 'completed', 100, 3, 2, 2, 0, 0, 0, ?, ?, ?, NULL, 0, 3, NULL, NULL, 'html', 1, 0, 'page-analysis-test')`,
    [
      input.id,
      input.ownerId,
      input.siteUrl,
      input.siteUrl,
      input.completedAt,
      input.completedAt,
      input.completedAt,
    ],
  );
}

async function insertPageFixture(db: AppDatabase, input: SeedPageInput) {
  const pageUrl = new URL(input.slug, input.siteUrl).toString();
  const normalizedUrl = pageUrl;
  const pageKey = input.pageKey;
  const title = input.title;
  const metaDescription = `${title} meta description`;
  const h1Text = title;
  const headingChainMain = JSON.stringify([title, input.bodyHeading]);
  const headingChainCta = JSON.stringify([title, 'Talk to sales']);
  const mainBlockKey = `${pageKey}:blk:main`;
  const ctaBlockKey = `${pageKey}:blk:cta`;

  await db.run(
    `INSERT INTO crawl_pages (
       ownerId, siteUrl, jobId, url, normalizedUrl, pageKey, resolvedCanonicalPageKey, finalUrl,
       statusCode, contentType, title, metaDescription, canonicalUrl, h1Text, h1Count, h2Count,
       wordCount, depth, discoveredFrom, discoveredFromUrl, discoveredAt, crawledAt, responseTimeMs,
       noindex, inboundLinkCount, internalLinkCount, outgoingLinkCount, errorMessage
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 200, 'text/html', ?, ?, ?, ?, 1, 2, 640, ?, 'seed', ?, ?, ?, 120, 0, 1, 2, 2, NULL)`,
    [
      input.ownerId,
      input.siteUrl,
      input.crawlJobId,
      pageUrl,
      normalizedUrl,
      pageKey,
      pageKey,
      pageUrl,
      title,
      metaDescription,
      pageUrl,
      h1Text,
      input.pageIndex,
      input.siteUrl,
      FIXTURE_CREATED_AT,
      FIXTURE_CRAWLED_AT,
    ],
  );

  await db.run(
    `INSERT INTO crawl_page_text_blocks (
       ownerId, siteUrl, jobId, pageUrl, pageKey, blockIndex, blockKey, blockType, regionIndex, regionRole,
       headingChainJson, domPath, selector, text, textHash, textDensity, linkDensity, boilerplateScore, extractionVersion
     ) VALUES
       (?, ?, ?, ?, ?, 0, ?, 'article', 0, 'main', ?, 'html>body>main>article>p', 'p.body-copy',
        ?, 'hash-main', 0.88, 0.12, 0.08, 3),
       (?, ?, ?, ?, ?, 1, ?, 'cta', 1, 'cta', ?, 'html>body>main>section.cta>p', 'section.cta p',
        ?, 'hash-cta', 0.61, 0.05, 0.22, 3)`,
    [
      input.ownerId,
      input.siteUrl,
      input.crawlJobId,
      pageUrl,
      pageKey,
      mainBlockKey,
      headingChainMain,
      `${input.regionLabel} helps readers evaluate the next step with clear topical structure and supporting evidence.`,
      input.ownerId,
      input.siteUrl,
      input.crawlJobId,
      pageUrl,
      pageKey,
      ctaBlockKey,
      headingChainCta,
      `Book a consultation after reading ${title}.`,
    ],
  );

  await db.run(
    `INSERT INTO crawl_page_sentences (
       ownerId, siteUrl, jobId, pageUrl, pageKey, paragraphIndex, sentenceIndex, blockKey, blockIndex,
       regionIndex, regionRole, blockType, pageType, visualProminence, sentenceText, textHash, embeddingStatus, createdAt
     ) VALUES
       (?, ?, ?, ?, ?, 0, 0, ?, 0, 0, 'main', 'article', 'article', 0.82, ?, 'sentence-main', 'pending', ?),
       (?, ?, ?, ?, ?, 1, 0, ?, 1, 1, 'cta', 'cta', 'conversion', 0.64, ?, 'sentence-cta', 'pending', ?)`,
    [
      input.ownerId,
      input.siteUrl,
      input.crawlJobId,
      pageUrl,
      pageKey,
      mainBlockKey,
      `${input.regionLabel} makes the editorial intent explicit for ${title}.`,
      FIXTURE_CREATED_AT,
      input.ownerId,
      input.siteUrl,
      input.crawlJobId,
      pageUrl,
      pageKey,
      ctaBlockKey,
      `Talk to sales about ${title}.`,
      FIXTURE_CREATED_AT,
    ],
  );

  await db.run(
    `INSERT INTO crawl_links (
       ownerId, siteUrl, jobId, fromUrl, toUrl, fromPageKey, toPageKey, anchorText, contextText,
       regionRole, blockType, visualProminence, discoveredAt, depth
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'main', 'a', 0.57, ?, ?)`,
    [
      input.ownerId,
      input.siteUrl,
      input.crawlJobId,
      pageUrl,
      new URL('/contact/', input.siteUrl).toString(),
      pageKey,
      `${pageKey}:target`,
      'Talk to sales',
      `Context for ${title}`,
      FIXTURE_CREATED_AT,
      input.pageIndex,
    ],
  );
}

async function waitForJobStatus(
  db: AppDatabase,
  jobId: string,
  expectedStatus: string,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  let lastStatus = 'missing';
  while (Date.now() - startedAt < timeoutMs) {
    const row = await db.get<{ status?: string }>('SELECT status FROM page_analysis_jobs WHERE id = ? LIMIT 1', [jobId]);
    lastStatus = String(row?.status || 'missing');
    if (lastStatus === expectedStatus) {
      return;
    }
    if (lastStatus === 'error') {
      const errorRow = await db.get<{ lastError?: string }>('SELECT lastError FROM page_analysis_jobs WHERE id = ? LIMIT 1', [jobId]);
      throw new Error(`Job ${jobId} entered error state: ${String(errorRow?.lastError || 'unknown error')}`);
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${expectedStatus}. Last status was ${lastStatus}.`);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gscplus-page-analysis-lifecycle-'));
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;
  const testDatabaseUrl = process.env.PAGE_ANALYSIS_TEST_DATABASE_URL?.trim();
  const originalBackfills = process.env.RUN_DATABASE_BACKFILLS;
  const originalWorkerCount = process.env.PAGE_ANALYSIS_WORKERS;
  let stopWorker: (() => void) | null = null;

  try {
    if (testDatabaseUrl) {
      process.env.DATABASE_URL = testDatabaseUrl;
      delete process.env.POSTGRES_URL;
    } else {
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;
    }
    process.env.RUN_DATABASE_BACKFILLS = 'false';
    process.env.PAGE_ANALYSIS_WORKERS = '1';
    process.chdir(tempDir);

    const db = await initializeDatabase();
    try {
      const scopeFromWorkspace = await ensureSiteScope(db, {
        ownerId: OWNER_A,
        siteUrl: SITE_URL,
        sourceKey: SITE_URL,
        sourceType: 'workspace-site',
      });
      const scopeFromGsc = await ensureSiteScope(db, {
        ownerId: OWNER_A,
        siteUrl: SITE_URL,
        sourceKey: GSC_SITE_URL,
        sourceType: 'gsc-site',
      });
      const scopeFromGa4 = await ensureSiteScope(db, {
        ownerId: OWNER_A,
        propertyId: GA4_PROPERTY_ID,
        siteUrl: SITE_URL,
        sourceKey: GA4_PROPERTY_ID,
        sourceType: 'ga4-property',
      });
      const ownerBScope = await ensureSiteScope(db, {
        ownerId: OWNER_B,
        siteUrl: SITE_URL,
        sourceKey: SITE_URL,
        sourceType: 'workspace-site',
      });
      const resolvedScope = await resolveSiteScopeBySiteUrl(db, OWNER_A, SITE_URL);

      assert.equal(scopeFromWorkspace.scope.id, scopeFromGsc.scope.id, 'GSC mapping must resolve to the same logical site scope.');
      assert.equal(scopeFromWorkspace.scope.id, scopeFromGa4.scope.id, 'GA4 mapping must resolve to the same logical site scope.');
      assert.notEqual(scopeFromWorkspace.scope.id, ownerBScope.scope.id, 'Different owners must not share the same logical site scope id.');
      assert.equal(scopeFromWorkspace.canonicalDomain, 'example.com');
      assert.equal(resolvedScope?.scope.id, scopeFromWorkspace.scope.id, 'Site URL resolution must return the canonical logical scope.');

      await insertCrawlJob(db, {
        id: 'crawl-a-1',
        ownerId: OWNER_A,
        siteUrl: SITE_URL,
        completedAt: '2026-07-17T08:10:00.000Z',
      });
      await insertCrawlJob(db, {
        id: 'crawl-a-2',
        ownerId: OWNER_A,
        siteUrl: SITE_URL,
        completedAt: '2026-07-17T08:20:00.000Z',
      });
      await insertCrawlJob(db, {
        id: 'crawl-b-1',
        ownerId: OWNER_B,
        siteUrl: SITE_URL,
        completedAt: '2026-07-17T08:30:00.000Z',
      });

      await insertPageFixture(db, {
        bodyHeading: 'Product details',
        crawlJobId: 'crawl-a-1',
        ownerId: OWNER_A,
        pageIndex: 1,
        pageKey: 'a1-alpha',
        regionLabel: 'Alpha page',
        siteUrl: SITE_URL,
        slug: '/alpha/',
        title: 'Alpha service',
      });
      await insertPageFixture(db, {
        bodyHeading: 'Product details',
        crawlJobId: 'crawl-a-1',
        ownerId: OWNER_A,
        pageIndex: 2,
        pageKey: 'a1-beta',
        regionLabel: 'Beta page',
        siteUrl: SITE_URL,
        slug: '/beta/',
        title: 'Beta service',
      });

      await insertPageFixture(db, {
        bodyHeading: 'Product details',
        crawlJobId: 'crawl-a-2',
        ownerId: OWNER_A,
        pageIndex: 1,
        pageKey: 'a2-alpha',
        regionLabel: 'Alpha page',
        siteUrl: SITE_URL,
        slug: '/alpha/',
        title: 'Alpha service',
      });
      await insertPageFixture(db, {
        bodyHeading: 'Product details',
        crawlJobId: 'crawl-a-2',
        ownerId: OWNER_A,
        pageIndex: 2,
        pageKey: 'a2-beta',
        regionLabel: 'Beta page',
        siteUrl: SITE_URL,
        slug: '/beta/',
        title: 'Beta service',
      });

      await insertPageFixture(db, {
        bodyHeading: 'Regional details',
        crawlJobId: 'crawl-b-1',
        ownerId: OWNER_B,
        pageIndex: 1,
        pageKey: 'b1-alpha',
        regionLabel: 'Owner B alpha',
        siteUrl: SITE_URL,
        slug: '/regional-alpha/',
        title: 'Owner B Alpha service',
      });
      await insertPageFixture(db, {
        bodyHeading: 'Regional details',
        crawlJobId: 'crawl-b-1',
        ownerId: OWNER_B,
        pageIndex: 2,
        pageKey: 'b1-beta',
        regionLabel: 'Owner B beta',
        siteUrl: SITE_URL,
        slug: '/regional-beta/',
        title: 'Owner B Beta service',
      });

      const firstQueue = await queueJob(db, {
        crawlJobId: 'crawl-a-1',
        ownerId: OWNER_A,
        siteUrl: SITE_URL,
        sourceKey: SITE_URL,
        sourceType: 'crawl-site',
      });
      const duplicateQueue = await queueJob(db, {
        crawlJobId: 'crawl-a-1',
        ownerId: OWNER_A,
        siteUrl: SITE_URL,
        sourceKey: SITE_URL,
        sourceType: 'crawl-site',
      });

      assert.equal(firstQueue.id, duplicateQueue.id, 'Same crawl queued twice must reuse the same page-analysis job.');
      assert.equal(
        await countRows(db, 'SELECT COUNT(*) AS count FROM page_analysis_jobs WHERE ownerId = ? AND crawlJobId = ?', [OWNER_A, 'crawl-a-1']),
        1,
        'Same crawl queueing must remain idempotent.',
      );

      const supersedingQueue = await queueJob(db, {
        crawlJobId: 'crawl-a-2',
        ownerId: OWNER_A,
        siteUrl: SITE_URL,
        sourceKey: SITE_URL,
        sourceType: 'crawl-site',
      });
      const ownerBQueue = await queueJob(db, {
        crawlJobId: 'crawl-b-1',
        ownerId: OWNER_B,
        siteUrl: SITE_URL,
        sourceKey: SITE_URL,
        sourceType: 'crawl-site',
      });

      const cancelledA1 = await db.get<{ lastError?: string; status?: string }>(
        'SELECT status, lastError FROM page_analysis_jobs WHERE ownerId = ? AND crawlJobId = ? LIMIT 1',
        [OWNER_A, 'crawl-a-1'],
      );
      assert.equal(cancelledA1?.status, 'cancelled', 'A newer crawl for the same logical site must cancel the older queued analysis job.');
      assert.match(String(cancelledA1?.lastError || ''), /Superseded by crawl crawl-a-2\./);
      assert.equal(supersedingQueue.siteScopeId, scopeFromWorkspace.scope.id);
      assert.equal(ownerBQueue.siteScopeId, ownerBScope.scope.id);

      stopWorker = startPageAnalysisWorker(db);
      await waitForJobStatus(db, supersedingQueue.id, 'completed', 15000);
      await waitForJobStatus(db, ownerBQueue.id, 'completed', 15000);
      stopWorker();
      stopWorker = null;

      const completedRows = await db.all<{
        completedAt?: string | null;
        crawlJobId?: string | null;
        extractionVersion?: number | null;
        id: string;
        ownerId: string;
        siteScopeId?: string | null;
        status?: string | null;
      }>(
        `SELECT id, ownerId, crawlJobId, status, siteScopeId, extractionVersion, completedAt
         FROM page_analysis_jobs
         WHERE id IN (?, ?)
         ORDER BY ownerId ASC, crawlJobId ASC`,
        [supersedingQueue.id, ownerBQueue.id],
      );
      assert.equal(completedRows.length, 2, 'Expected both queued jobs to complete.');
      for (const row of completedRows) {
        assert.equal(row.status, 'completed');
        assert.equal(row.extractionVersion, 3, 'Completed analysis jobs must persist extraction version 3.');
        assert.ok(row.completedAt, 'Completed jobs must set completedAt.');
      }

      const persistedRegions = await db.all<{
        blockKey?: string | null;
        extractionVersion?: number | null;
        ownerId: string;
        pageKey: string;
        siteUrl: string;
      }>(
        `SELECT ownerId, siteUrl, pageKey, blockKey, extractionVersion
         FROM crawl_page_regions
         WHERE (ownerId = ? AND jobId = ?) OR (ownerId = ? AND jobId = ?)
         ORDER BY ownerId ASC, pageKey ASC, blockKey ASC`,
        [OWNER_A, 'crawl-a-2', OWNER_B, 'crawl-b-1'],
      );
      assert.ok(persistedRegions.length >= 8, `Expected persisted regions for both crawls, got ${persistedRegions.length}.`);
      for (const row of persistedRegions) {
        assert.equal(row.extractionVersion, 3, 'Persisted regions must carry extraction version 3.');
        assert.ok(String(row.blockKey || '').trim().length > 0, `Persisted region for ${row.ownerId}/${row.pageKey} is missing stable blockKey.`);
        assert.equal(row.siteUrl, SITE_URL, 'Persisted regions must stay site-scoped.');
      }

      const profileCountA = await countRows(
        db,
        'SELECT COUNT(*) AS count FROM page_function_profiles WHERE ownerId = ? AND siteUrl = ? AND crawlJobId = ?',
        [OWNER_A, SITE_URL, 'crawl-a-2'],
      );
      const profileCountB = await countRows(
        db,
        'SELECT COUNT(*) AS count FROM page_function_profiles WHERE ownerId = ? AND siteUrl = ? AND crawlJobId = ?',
        [OWNER_B, SITE_URL, 'crawl-b-1'],
      );
      const templateCountA = await countRows(
        db,
        'SELECT COUNT(*) AS count FROM page_template_clusters WHERE ownerId = ? AND siteUrl = ? AND crawlJobId = ?',
        [OWNER_A, SITE_URL, 'crawl-a-2'],
      );
      const memberCountA = await countRows(
        db,
        'SELECT COUNT(*) AS count FROM page_template_members WHERE ownerId = ? AND siteUrl = ? AND crawlJobId = ?',
        [OWNER_A, SITE_URL, 'crawl-a-2'],
      );

      assert.equal(profileCountA, 2, `Expected two owner A function profiles, got ${profileCountA}.`);
      assert.equal(profileCountB, 2, `Expected two owner B function profiles, got ${profileCountB}.`);
      assert.ok(templateCountA >= 1, 'Expected at least one template cluster for owner A.');
      assert.ok(memberCountA >= 2, 'Expected template members to persist for owner A.');

      const leakedProfiles = await countRows(
        db,
        'SELECT COUNT(*) AS count FROM page_function_profiles WHERE ownerId = ? AND siteScopeId = ?',
        [OWNER_B, scopeFromWorkspace.scope.id],
      );
      assert.equal(leakedProfiles, 0, 'Owner B rows must not leak into owner A site scope.');

      const requeueWithoutForce = await queueJob(db, {
        crawlJobId: 'crawl-a-2',
        ownerId: OWNER_A,
        siteUrl: SITE_URL,
        sourceKey: SITE_URL,
        sourceType: 'crawl-site',
      });
      assert.equal(requeueWithoutForce.id, supersedingQueue.id, 'Completed crawl requeue without force must reuse the existing job.');
      assert.equal(
        await countRows(db, 'SELECT COUNT(*) AS count FROM page_analysis_jobs WHERE ownerId = ? AND crawlJobId = ?', [OWNER_A, 'crawl-a-2']),
        1,
        'Requeue without force must not create duplicate page-analysis jobs.',
      );

      const forcedRerun = await queueJob(db, {
        crawlJobId: 'crawl-a-2',
        force: true,
        ownerId: OWNER_A,
        siteUrl: SITE_URL,
        sourceKey: SITE_URL,
        sourceType: 'crawl-site',
      });
      assert.equal(forcedRerun.id, supersedingQueue.id, 'Forced rerun must recycle the stable page-analysis job id.');
      assert.equal(forcedRerun.status, 'queued', 'Forced rerun must reset the job back to queued.');

      stopWorker = startPageAnalysisWorker(db);
      await waitForJobStatus(db, forcedRerun.id, 'completed', 15000);
      stopWorker();
      stopWorker = null;

      const finalSummary = {
        ownerAScopeId: scopeFromWorkspace.scope.id,
        ownerBScopeId: ownerBScope.scope.id,
        ownerBTemplateClusters: await countRows(
          db,
          'SELECT COUNT(*) AS count FROM page_template_clusters WHERE ownerId = ? AND siteUrl = ? AND crawlJobId = ?',
          [OWNER_B, SITE_URL, 'crawl-b-1'],
        ),
        ownerBTemplateMembers: await countRows(
          db,
          'SELECT COUNT(*) AS count FROM page_template_members WHERE ownerId = ? AND siteUrl = ? AND crawlJobId = ?',
          [OWNER_B, SITE_URL, 'crawl-b-1'],
        ),
        persistedProfiles: await countRows(
          db,
          'SELECT COUNT(*) AS count FROM page_function_profiles WHERE (ownerId = ? AND crawlJobId = ?) OR (ownerId = ? AND crawlJobId = ?)',
          [OWNER_A, 'crawl-a-2', OWNER_B, 'crawl-b-1'],
        ),
        persistedRegionRows: persistedRegions.length,
        stableJobId: supersedingQueue.id,
      };

      console.log(JSON.stringify(finalSummary, null, 2));
      console.log('Page analysis lifecycle regression passed.');
    } finally {
      if (stopWorker) {
        stopWorker();
      }
      await db.close?.();
    }
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = originalPostgresUrl;
    if (originalBackfills === undefined) delete process.env.RUN_DATABASE_BACKFILLS; else process.env.RUN_DATABASE_BACKFILLS = originalBackfills;
    if (originalWorkerCount === undefined) delete process.env.PAGE_ANALYSIS_WORKERS; else process.env.PAGE_ANALYSIS_WORKERS = originalWorkerCount;
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
