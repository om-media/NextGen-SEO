import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import multer from 'multer';
import { chromium } from 'playwright';
import { initializeDatabase } from '../.server-dist/server/database.js';
import { buildApp } from '../.server-dist/server/app.js';
import { attachFrontend } from '../.server-dist/server/frontend.js';
import { createUserSession, SESSION_COOKIE_NAME } from '../.server-dist/server/auth.js';

dotenv.config({ path: '.env.local' });
dotenv.config();
process.env.START_BACKGROUND_WORKERS = 'false';

const screenshotPath = path.resolve('.tmp/topical-authority-browser-smoke.png');
const mobileScreenshotPath = path.resolve('.tmp/topical-authority-browser-smoke-mobile.png');

function assertBuiltArtifacts() {
  const missing = ['.server-dist/server/app.js', 'dist/index.html'].filter((file) => !fs.existsSync(path.resolve(file)));
  if (missing.length) throw new Error(`Missing built artifacts: ${missing.join(', ')}. Run npm run build first.`);
}

async function main() {
  assertBuiltArtifacts();
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const db = await initializeDatabase();
  const suffix = Date.now();
  const ownerId = `topical-browser-${suffix}`;
  const siteUrl = `https://topical-browser-${suffix}.example/`;
  const scopeId = `scope-topical-${suffix}`;
  const crawlJobId = `crawl-topical-${suffix}`;
  const now = new Date().toISOString();
  let server;
  let browser;

  try {
    await db.run(
      `INSERT INTO users (id, email, passwordHash, tier, onboardingCompleted, activatedSiteUrl, knownSites, unlockedSites, createdAt)
       VALUES (?, ?, 'test', 'enterprise', 1, ?, ?, ?, ?)`,
      [ownerId, `${ownerId}@example.com`, siteUrl, JSON.stringify([siteUrl]), JSON.stringify([siteUrl]), now],
    );
    await db.run('INSERT INTO site_scopes (id, ownerId, canonicalDomain, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)', [scopeId, ownerId, new URL(siteUrl).hostname, now, now]);
    await db.run(
      `INSERT INTO site_scope_sources (siteScopeId, sourceType, sourceKey, siteUrl, propertyId, createdAt, updatedAt)
       VALUES (?, 'gsc-site', ?, ?, NULL, ?, ?)`,
      [scopeId, siteUrl, siteUrl, now, now],
    );
    await db.run(
      `INSERT INTO crawl_jobs (
        id, ownerId, siteUrl, startUrl, status, maxPages, maxDepth, discoveredCount,
        crawledCount, errorCount, skippedCount, queuedCount, startedAt, updatedAt, completedAt
      ) VALUES (?, ?, ?, ?, 'completed', 1000, 3, 65, 65, 0, 0, 0, ?, ?, ?)`,
      [crawlJobId, ownerId, siteUrl, siteUrl, now, now, now],
    );

    for (let index = 0; index < 65; index += 1) {
      const topicNumber = 100 + index;
      const pageKey = `/topic-${topicNumber}`;
      const pageUrl = `${siteUrl}topics/topic-${topicNumber}`;
      const position = [2, 6, 14, 25][index % 4];
      const impressions = 1000 - index * 7;
      const clicks = Math.max(1, Math.round(impressions * (position <= 10 ? 0.06 : 0.012)));
      await db.run(
        `INSERT INTO gsc_page_query_metrics
         (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position)
         VALUES (?, ?, '2026-07-01', ?, ?, ?, ?, ?, ?, ?)`,
        [ownerId, siteUrl, pageUrl, pageKey, `acoustic topic ${topicNumber}`, clicks, impressions, clicks / impressions, position],
      );
      await db.run(
        `INSERT INTO crawl_pages (
          ownerId, siteUrl, jobId, url, normalizedUrl, pageKey, resolvedCanonicalPageKey, finalUrl,
          statusCode, contentType, title, h1Text, h1Count, h2Count, wordCount, depth,
          discoveredAt, crawledAt, noindex, inboundLinkCount, internalLinkCount, outgoingLinkCount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 200, 'text/html', ?, ?, 1, 2, ?, 1, ?, ?, 0, ?, 6, 6)`,
        [ownerId, siteUrl, crawlJobId, pageUrl, pageUrl, pageKey, pageKey, pageUrl, `Acoustic topic ${topicNumber}`, `Acoustic topic ${topicNumber}`, 800 + index, now, now, index % 9],
      );
    }

    const token = await createUserSession(db, ownerId);
    const app = buildApp({
      db,
      upload: multer({ dest: 'uploads/' }),
      syncJobs: new Map(),
      getSyncJobKey: (userId, activeSite) => `${userId}:${activeSite}`,
      startWorkers: false,
    });
    await attachFrontend(app);
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const apiEvents = [];
    const writeRequests = [];

    browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addCookies([{ name: SESSION_COOKIE_NAME, value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.on('request', (request) => {
      if (request.url().includes('/api/topical-authority/') && request.method() !== 'GET') writeRequests.push(`${request.method()} ${request.url()}`);
    });
    page.on('response', (response) => {
      if (response.url().includes('/api/topical-authority/')) apiEvents.push({ status: response.status(), url: response.url() });
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loadStartedAt = Date.now();
    await page.getByRole('button', { name: 'Topical Authority' }).click();
    await page.getByText('Topical coverage', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
    await page.getByText('Showing 1–50 of 65 topics', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
    const initialLoadMs = Date.now() - loadStartedAt;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const workspace = page.getByRole('region', { name: 'Topical authority summary' }).locator('..');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText('Showing 51–65 of 65 topics', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(300);
    const secondPageVisible = await page.getByText('Showing 51–65 of 65 topics', { exact: true }).isVisible();
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await page.getByText('Showing 1–50 of 65 topics', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });

    const searchInput = page.getByRole('textbox', { name: 'Search topic clusters' });
    await searchInput.fill('acoustic topic 164');
    await page.getByText('Showing 1–1 of 1 topics', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: 'Inspect topic acoustic topic 164' }).click();
    const sheetVisible = await page.getByText('Evidence score', { exact: true }).isVisible();
    const disclaimerVisible = await page.getByText('Transparent app diagnostic, not a Google metric.', { exact: true }).isVisible();
    const queryVisible = await page.getByText('Observed queries', { exact: true }).isVisible();
    const rankingPageVisible = await page.getByRole('heading', { name: 'Ranking pages', exact: true }).isVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await searchInput.fill('');
    await page.getByText('Showing 1–50 of 65 topics', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });

    await page.getByRole('combobox', { name: 'Filter topic status' }).click();
    await page.getByRole('option', { name: 'Coverage gaps' }).click();
    await page.getByText(/Showing 1–\d+ of \d+ topics/).waitFor({ state: 'visible', timeout: 10000 });
    const topicTable = page.locator('[data-slot=table]').filter({ has: page.getByRole('columnheader', { name: 'Topic cluster' }) });
    const gapsOnly = await topicTable.getByText('Coverage gap', { exact: true }).count() > 0
      && await topicTable.getByText('Leading', { exact: true }).count() === 0;

    const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const desktopClippedControls = await page.locator('button:visible, input:visible').evaluateAll((elements) => elements.filter((element) => {
      if (element.closest('[data-slot="table-container"]')) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > window.innerWidth + 1;
    }).length);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const mobileClippedControls = await page.locator('button:visible, input:visible').evaluateAll((elements) => elements.filter((element) => {
      if (element.closest('[data-slot="table-container"]')) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > window.innerWidth + 1;
    }).length);
    await page.screenshot({ path: mobileScreenshotPath, fullPage: true });

    const mainText = await page.locator('main').innerText();
    const checks = {
      distinctWorkspaceTitle: /Measure topical authority from search evidence/.test(mainText),
      visualSemanticsCopyAbsent: !/Inspect how pages communicate meaning/.test(mainText),
      summaryVisible: /Observed topics/.test(mainText) && /Coverage gaps/.test(mainText),
      paginationVisible: secondPageVisible,
      evidenceInspectorVisible: sheetVisible && disclaimerVisible && queryVisible && rankingPageVisible,
      statusFilterWorks: gapsOnly,
      dateControlsHidden: !/Compare/.test(mainText),
      initialLoadUnderFiveSeconds: initialLoadMs < 5000,
      readOnlyOnOpen: writeRequests.length === 0,
      APIsSucceeded: apiEvents.every((event) => event.status < 400),
      noDesktopHorizontalOverflow: desktopOverflow <= 1,
      noDesktopClippedControls: desktopClippedControls === 0,
      noMobileHorizontalOverflow: mobileOverflow <= 1,
      noMobileClippedControls: mobileClippedControls === 0,
    };
    const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
    console.log(JSON.stringify({ apiEvents, checks, failed, initialLoadMs, screenshotPath, mobileScreenshotPath }, null, 2));
    if (failed.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.run('DELETE FROM gsc_page_query_metrics WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM crawl_pages WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM crawl_jobs WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM site_scope_sources WHERE siteScopeId = ?', [scopeId]).catch(() => {});
    await db.run('DELETE FROM site_scopes WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM sessions WHERE userId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM users WHERE id = ?', [ownerId]).catch(() => {});
    await db.close?.();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
