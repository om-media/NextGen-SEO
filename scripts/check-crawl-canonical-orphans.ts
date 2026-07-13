import fs from 'fs';
import os from 'os';
import path from 'path';

import { initializeDatabase } from '../server/database.js';
import { resolvedCanonicalPageKey } from '../server/reporting/url.js';
import { registerBlendedRoutes } from '../server/routes/blended.js';
import { registerReconciliationRoutes } from '../server/routes/reconciliation.js';
import { __crawlQueueTestUtils, getCrawlPages } from '../server/services/crawl.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type RouteHandler = (req: any, res: any) => Promise<unknown> | unknown;

class FakeApp {
  routes = new Map<string, RouteHandler[]>();

  get(pathname: string, ...handlers: RouteHandler[]) {
    this.routes.set(`GET:${pathname}`, handlers);
  }

  post(pathname: string, ...handlers: RouteHandler[]) {
    this.routes.set(`POST:${pathname}`, handlers);
  }
}

class FakeResponse {
  body: any = null;
  statusCode = 200;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: any) {
    this.body = body;
    return this;
  }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gscplus-crawl-canonical-'));
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;
  const originalRunDatabaseBackfills = process.env.RUN_DATABASE_BACKFILLS;
  const usePostgres = process.env.USE_TEST_POSTGRES === 'true';
  process.env.RUN_DATABASE_BACKFILLS = 'false';
  if (!usePostgres) {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    process.chdir(tempDir);
  }

  const db = await initializeDatabase();
  const ownerId = 'crawl-canonical-owner';
  const siteUrl = 'https://example.com/';
  const jobId = 'crawl-canonical-job';
  const now = '2026-07-10T10:00:00.000Z';

  try {
    if (usePostgres) {
      await db.run('DELETE FROM crawl_links WHERE ownerId = ?', [ownerId]);
      await db.run('DELETE FROM crawl_pages WHERE ownerId = ?', [ownerId]);
      await db.run('DELETE FROM crawl_jobs WHERE ownerId = ?', [ownerId]);
      await db.run('DELETE FROM gsc_page_query_metrics WHERE ownerId = ?', [ownerId]);
      await db.run('DELETE FROM users WHERE id = ?', [ownerId]);
    }

    await db.run(
      `INSERT INTO users (id, email, tier, unlockedSites, knownSites, activatedSiteUrl, createdAt)
       VALUES (?, ?, 'enterprise', ?, ?, ?, ?)`,
      [ownerId, 'crawl-canonical@example.com', JSON.stringify([siteUrl]), JSON.stringify([siteUrl]), siteUrl, now],
    );
    await db.run(
      `INSERT INTO gsc_page_query_metrics (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position)
       VALUES (?, ?, '2026-07-10', 'https://example.com/plans/', '/plans', 'plans', 1, 10, 0.1, 3)`,
      [ownerId, siteUrl],
    );

    await db.run(
      `INSERT INTO crawl_jobs (
        id, ownerId, siteUrl, startUrl, status, maxPages, maxDepth, discoveredCount, crawledCount,
        errorCount, skippedCount, queuedCount, startedAt, updatedAt, completedAt, attemptCount,
        maxAttempts, renderMode, respectRobots, includeQueryStrings, userAgent
      ) VALUES (?, ?, ?, ?, 'completed', 100, 4, 4, 4, 0, 0, 0, ?, ?, ?, 1, 3, 'html', 1, 0, 'test-crawler')`,
      [jobId, ownerId, siteUrl, siteUrl, now, now, now],
    );

    const pages = [
      ['https://example.com/', '/', '/', null],
      ['https://example.com/pricing/', '/pricing', '/pricing', null],
      ['https://example.com/plans/', '/plans', '/pricing', 'https://example.com/pricing/'],
      ['https://example.com/contact/', '/contact', '/contact', 'https://external.example/contact/'],
    ] as const;

    for (const [url, pageKey, resolvedKey, canonicalUrl] of pages) {
      await db.run(
        `INSERT INTO crawl_pages (
          ownerId, siteUrl, jobId, url, normalizedUrl, pageKey, resolvedCanonicalPageKey, finalUrl,
          statusCode, contentType, title, canonicalUrl, h1Count, h2Count, wordCount, depth,
          discoveredAt, crawledAt, noindex, inboundLinkCount, internalLinkCount, outgoingLinkCount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 200, 'text/html', ?, ?, 1, 0, 100, 1, ?, ?, 0, 0, 0, 0)`,
        [ownerId, siteUrl, jobId, url, url, pageKey, resolvedKey, url, pageKey, canonicalUrl, now, now],
      );
    }

    const links = [
      ['https://example.com/', 'https://www.example.com/pricing/', '/', '/pricing'],
      ['https://example.com/pricing/', 'https://example.com/', '/pricing', '/'],
      ['https://example.com/', 'https://example.com/plans/', '/', '/plans'],
    ] as const;
    for (const [fromUrl, toUrl, fromPageKey, toPageKey] of links) {
      await db.run(
        `INSERT INTO crawl_links (
          ownerId, siteUrl, jobId, fromUrl, toUrl, fromPageKey, toPageKey, discoveredAt, depth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [ownerId, siteUrl, jobId, fromUrl, toUrl, fromPageKey, toPageKey, now],
      );
    }

    await __crawlQueueTestUtils.computeInboundCounts(db, ownerId, siteUrl, jobId);

    const allPages = await getCrawlPages(db, ownerId, siteUrl, 20, 0, null, jobId, null);
    const orphanPages = await getCrawlPages(db, ownerId, siteUrl, 20, 0, null, jobId, 'orphan');
    const byKey = new Map(allPages.rows.map((row) => [row.pageKey, row]));

    assert(allPages.summary?.totalPages === 4, 'Expected all four crawl rows.');
    assert(allPages.summary?.orphanPages === 1, `Expected one orphan, got ${allPages.summary?.orphanPages}`);
    assert(byKey.get('/')?.inboundLinkCount === 1, 'Root should have one inbound link.');
    assert(byKey.get('/pricing')?.inboundLinkCount === 2, 'Canonical target should include variant and alias links.');
    assert(byKey.get('/plans')?.inboundLinkCount === 2, 'Canonical alias should share target-cluster inbound links.');
    assert(byKey.get('/contact')?.inboundLinkCount === 0, 'Unlinked contact page should remain orphaned.');
    assert(
      JSON.stringify(orphanPages.rows.map((row) => row.pageKey)) === JSON.stringify(['/contact']),
      `Unexpected orphan rows: ${orphanPages.rows.map((row) => row.pageKey).join(', ')}`,
    );
    assert(
      resolvedCanonicalPageKey('https://external.example/pricing/', 'https://example.com/local/', siteUrl) === '/local',
      'External canonicals must not collapse into the workspace canonical cluster.',
    );

    const app = new FakeApp();
    registerReconciliationRoutes(app as any, db);
    const reconciliationHandler = app.routes.get('GET:/api/reconciliation/pages')?.at(-1);
    assert(reconciliationHandler, 'Expected the reconciliation route handler.');
    const reconciliationResponse = new FakeResponse();
    await reconciliationHandler(
      {
        authUser: { uid: ownerId },
        query: {
          endDate: '2026-07-10',
          limit: '100',
          offset: '0',
          siteUrl,
          startDate: '2026-07-10',
          status: 'all',
        },
      },
      reconciliationResponse,
    );
    assert(reconciliationResponse.statusCode === 200, 'Expected reconciliation request to succeed.');
    const canonicalAliasRow = reconciliationResponse.body?.rows?.find((row: any) => row.pageKey === '/plans');
    assert(canonicalAliasRow, 'Expected the canonical alias analytics row in reconciliation.');
    assert(canonicalAliasRow.sources?.crawl === 'present', 'Crawled canonical aliases must remain present.');
    assert(!canonicalAliasRow.flags?.includes('missing_in_crawl'), 'Canonical aliases must not be marked missing from crawl.');


    registerBlendedRoutes(app as any, db);
    const blendedHandler = app.routes.get('POST:/api/blended/page-performance')?.at(-1);
    assert(blendedHandler, 'Expected the blended page-performance route handler.');
    const blendedResponse = new FakeResponse();
    await blendedHandler(
      {
        authUser: { uid: ownerId },
        body: {
          endDate: '2026-07-10',
          limit: 100,
          offset: 0,
          siteUrl,
          startDate: '2026-07-10',
        },
      },
      blendedResponse,
    );
    assert(blendedResponse.statusCode === 200, 'Expected blended page-performance request to succeed.');
    const blendedAliasRow = blendedResponse.body?.rows?.find((row: any) => row.pageKey === '/plans');
    assert(blendedAliasRow?.crawl, 'Blended analytics rows must retain their matching canonical-alias crawl data.');
    assert(blendedAliasRow.crawl.pageKey === '/plans', 'Blended canonical-alias crawl data must retain its raw page key.');
    console.log('Crawl canonical orphan checks passed.');
  } finally {
    if (usePostgres) {
      await db.run('DELETE FROM crawl_links WHERE ownerId = ?', [ownerId]);
      await db.run('DELETE FROM crawl_pages WHERE ownerId = ?', [ownerId]);
      await db.run('DELETE FROM crawl_jobs WHERE ownerId = ?', [ownerId]);
      await db.run('DELETE FROM gsc_page_query_metrics WHERE ownerId = ?', [ownerId]);
      await db.run('DELETE FROM users WHERE id = ?', [ownerId]);
    }
    await db.close();
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
    if (originalRunDatabaseBackfills === undefined) delete process.env.RUN_DATABASE_BACKFILLS;
    else process.env.RUN_DATABASE_BACKFILLS = originalRunDatabaseBackfills;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});