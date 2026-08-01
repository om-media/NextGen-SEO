import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initializeDatabase } from '../server/database.js';
import { getTopicalAuthorityReport } from '../server/services/topicalAuthority.js';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gscplus-topical-authority-'));
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;
  const originalBackfills = process.env.RUN_DATABASE_BACKFILLS;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  process.env.RUN_DATABASE_BACKFILLS = 'false';
  process.chdir(tempDir);

  const db = await initializeDatabase();
  const ownerId = 'topical-owner';
  const workspaceSite = 'https://example.com/';
  const gscSite = 'sc-domain:example.com';
  const scopeId = 'topical-scope';
  const now = '2026-07-20T12:00:00.000Z';

  try {
    await db.run(
      `INSERT INTO users (id, email, tier, unlockedSites, knownSites, activatedSiteUrl, createdAt)
       VALUES (?, ?, 'enterprise', ?, ?, ?, ?)`,
      [ownerId, 'topical@example.com', JSON.stringify([workspaceSite]), JSON.stringify([workspaceSite]), workspaceSite, now],
    );
    await db.run(
      'INSERT INTO site_scopes (id, ownerId, canonicalDomain, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
      [scopeId, ownerId, 'example.com', now, now],
    );
    await db.run(
      `INSERT INTO site_scope_sources (siteScopeId, sourceType, sourceKey, siteUrl, propertyId, createdAt, updatedAt)
       VALUES (?, 'workspace-site', ?, ?, NULL, ?, ?)`,
      [scopeId, workspaceSite, workspaceSite, now, now],
    );
    await db.run(
      `INSERT INTO site_scope_sources (siteScopeId, sourceType, sourceKey, siteUrl, propertyId, createdAt, updatedAt)
       VALUES (?, 'gsc-site', ?, ?, NULL, ?, ?)`,
      [scopeId, gscSite, gscSite, now, now],
    );

    const metrics = [
      ['2026-06-01', 'https://example.com/acoustic-panels/', '/acoustic-panels', 'acoustic wall panels', 80, 1000, 0.08, 4],
      ['2026-06-02', 'https://example.com/acoustic-panels/', '/acoustic-panels', 'wall acoustic panels', 40, 500, 0.08, 5],
      ['2026-06-01', 'https://example.com/guides/soundproofing/', '/guides/soundproofing', 'soundproofing room guide', 5, 400, 0.0125, 18],
      ['2026-06-02', 'https://example.com/guides/soundproofing/', '/guides/soundproofing', 'room soundproofing guide', 4, 300, 0.0133, 19],
    ] as const;
    for (const row of metrics) {
      await db.run(
        `INSERT INTO gsc_page_query_metrics
         (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ownerId, gscSite, ...row],
      );
    }
    await db.run(
      `INSERT INTO gsc_page_query_metrics
       (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position)
       VALUES ('foreign-owner', ?, '2026-06-01', 'https://example.com/private/', '/private', 'private topic', 999, 9999, 0.1, 1)`,
      [gscSite],
    );

    await db.run(
      `INSERT INTO crawl_jobs (
        id, ownerId, siteUrl, startUrl, status, maxPages, maxDepth, discoveredCount, crawledCount,
        errorCount, skippedCount, queuedCount, startedAt, updatedAt, completedAt, attemptCount,
        maxAttempts, renderMode, respectRobots, includeQueryStrings, userAgent
      ) VALUES ('topical-crawl', ?, ?, ?, 'completed', 100, 3, 2, 2, 0, 0, 0, ?, ?, ?, 1, 3, 'html', 1, 0, 'test-crawler')`,
      [ownerId, workspaceSite, workspaceSite, now, now, now],
    );
    for (const page of [
      ['/acoustic-panels', 'https://example.com/acoustic-panels/', 'Acoustic wall panels', 1400, 12],
      ['/guides/soundproofing', 'https://example.com/guides/soundproofing/', 'Room soundproofing guide', 900, 1],
    ] as const) {
      await db.run(
        `INSERT INTO crawl_pages (
          ownerId, siteUrl, jobId, url, normalizedUrl, pageKey, resolvedCanonicalPageKey, finalUrl,
          statusCode, contentType, title, h1Text, h1Count, h2Count, wordCount, depth, discoveredAt,
          crawledAt, noindex, inboundLinkCount, internalLinkCount, outgoingLinkCount
        ) VALUES (?, ?, 'topical-crawl', ?, ?, ?, ?, ?, 200, 'text/html', ?, ?, 1, 2, ?, 1, ?, ?, 0, ?, 4, 4)`,
        [ownerId, workspaceSite, page[1], page[1], page[0], page[0], page[1], page[2], page[2], page[3], now, now, page[4]],
      );
    }

    const queryVariants = [
      'Acoustic wall panels',
      'ACOUSTIC WALL PANELS',
      'acoustic-wall panels',
      'acoustic / wall / panels',
      'acoustic, wall, panels',
      'acoustic + wall + panels',
      'acoustic (wall) panels',
      'wall panels acoustic',
      'acoustic wall panels for your',
    ];
    for (const [index, query] of queryVariants.entries()) {
      await db.run(
        `INSERT INTO gsc_page_query_metrics
         (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position)
         VALUES (?, ?, '2026-06-03', 'https://example.com/acoustic-panels/', '/acoustic-panels', ?, 0, ?, 0, 8)`,
        [ownerId, gscSite, query, index === queryVariants.length - 1 ? 1 : 90 - index * 10],
      );
    }
    for (let index = 1; index <= 8; index += 1) {
      const pageKey = `/acoustic-extra-${index}`;
      const url = `https://example.com${pageKey}/`;
      const title = index === 8 ? 'Needle evidence page' : `Acoustic support page ${index}`;
      await db.run(
        `INSERT INTO gsc_page_query_metrics
         (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position)
         VALUES (?, ?, '2026-06-03', ?, ?, 'acoustic wall panels', 0, ?, 0, 8)`,
        [ownerId, gscSite, url, pageKey, 90 - index * 10],
      );
      await db.run(
        `INSERT INTO crawl_pages (
          ownerId, siteUrl, jobId, url, normalizedUrl, pageKey, resolvedCanonicalPageKey, finalUrl,
          statusCode, contentType, title, h1Text, h1Count, h2Count, wordCount, depth, discoveredAt,
          crawledAt, noindex, inboundLinkCount, internalLinkCount, outgoingLinkCount
        ) VALUES (?, ?, 'topical-crawl', ?, ?, ?, ?, ?, 200, 'text/html', ?, ?, 1, 2, 500, 1, ?, ?, 0, 1, 2, 2)`,
        [ownerId, workspaceSite, url, url, pageKey, pageKey, url, title, title, now, now],
      );
    }

    let inspectedMetricsQuery = false;
    const reportDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'all') {
          return async (sql: string, params?: any) => {
            if (sql.includes('FROM gsc_page_query_metrics') && sql.includes('GROUP BY')) {
              inspectedMetricsQuery = true;
              assert.doesNotMatch(sql, /\bLIMIT\s+\d+/i, 'Topical evidence must not be globally truncated before clustering.');
            }
            return target.all(sql, params);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const report = await getTopicalAuthorityReport(reportDb, ownerId, { siteUrl: workspaceSite, limit: 50 });
    assert(inspectedMetricsQuery, 'Expected to inspect the aggregated topical metrics query.');
    assert.equal(report.meta.source, 'warehouse');
    assert.equal(report.meta.dateRange.startDate, '2026-06-01');
    assert.equal(report.meta.dateRange.endDate, '2026-06-03');
    assert.equal(report.summary.clusters, 2, 'Query variants should consolidate into two SEO topic clusters.');
    assert.equal(report.summary.impressions, 3001, 'The report must resolve the gsc-site alias, include complete evidence, and exclude foreign-owner rows.');
    assert.equal(report.summary.pages, 10, 'Summary page counts must include unique pages beyond the response evidence preview.');
    assert.equal(report.rows.some((row) => row.label.includes('private')), false, 'Foreign owner data leaked into topic evidence.');

    const acoustic = report.rows.find((row) => row.label.includes('acoustic'));
    assert(acoustic, 'Expected the acoustic-panels topic cluster.');
    assert.equal('_pageKeys' in acoustic || '_searchText' in acoustic, false, 'Internal full-evidence fields must not leak into response rows.');
    assert.equal(acoustic.queryCount, 11);
    assert.equal(acoustic.pageCount, 9);
    assert.equal(acoustic.pages.length, 8, 'Returned page evidence must remain bounded.');
    assert.equal(acoustic.queries.length, 10, 'Returned query evidence must remain bounded.');
    assert.equal(acoustic.support.inboundLinks, 20);
    assert.equal(acoustic.status, 'established');
    assert.equal(acoustic.evidence.total,
      acoustic.evidence.visibility + acoustic.evidence.demandCapture + acoustic.evidence.depth + acoustic.evidence.internalSupport,
      'Evidence score must be the sum of its disclosed components.');
    assert(acoustic.evidence.total <= 100, 'Evidence score must not exceed 100.');

    const gaps = await getTopicalAuthorityReport(reportDb, ownerId, { siteUrl: workspaceSite, limit: 50, status: 'emerging' });
    assert.equal(gaps.page.total, 1, 'Status filtering should return the weak-visibility topic.');
    assert(gaps.rows[0]?.issues.some((issue) => issue.includes('weak first-page visibility')));

    const search = await getTopicalAuthorityReport(reportDb, ownerId, { siteUrl: workspaceSite, limit: 50, search: 'soundproofing' });
    assert.equal(search.page.total, 1, 'Search should match topic queries and ranking pages.');
    const hiddenQuerySearch = await getTopicalAuthorityReport(reportDb, ownerId, { siteUrl: workspaceSite, limit: 50, search: 'your' });
    assert.equal(hiddenQuerySearch.page.total, 1, 'Search must scan query evidence beyond the returned top-ten preview.');
    const hiddenPageSearch = await getTopicalAuthorityReport(reportDb, ownerId, { siteUrl: workspaceSite, limit: 50, search: 'needle' });
    assert.equal(hiddenPageSearch.page.total, 1, 'Search must scan page evidence beyond the returned top-eight preview.');
    console.log('Topical authority contracts passed.');
  } finally {
    await db.close();
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
    if (originalBackfills === undefined) delete process.env.RUN_DATABASE_BACKFILLS;
    else process.env.RUN_DATABASE_BACKFILLS = originalBackfills;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
