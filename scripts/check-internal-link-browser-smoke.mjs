import fs from 'fs';
import path from 'path';
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

const screenshotPath = path.resolve('.tmp/internal-links-browser-smoke.png');
const mobileScreenshotPath = path.resolve('.tmp/internal-links-browser-smoke-mobile.png');

function assertBuiltArtifacts() {
  const missing = [];
  if (!fs.existsSync(path.resolve('.server-dist/server/app.js'))) missing.push('.server-dist/server/app.js');
  if (!fs.existsSync(path.resolve('dist/index.html'))) missing.push('dist/index.html');
  if (missing.length) {
    throw new Error(`Missing built artifacts: ${missing.join(', ')}. Run npm run build before this smoke test.`);
  }
}

async function main() {
  assertBuiltArtifacts();
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });

  const db = await initializeDatabase();
  let server;
  let browser;
  const suffix = Date.now();
  const ownerId = `internal-link-browser-${suffix}`;
  const siteUrl = `https://internal-link-browser-${suffix}.example/`;
  const crawlJobId = `crawl-browser-${suffix}`;
  const now = new Date().toISOString();

  try {
    await db.run(
      `INSERT INTO users (id, email, passwordHash, tier, onboardingCompleted, activatedSiteUrl, knownSites, unlockedSites, createdAt)
       VALUES (?, ?, 'test', 'enterprise', 1, ?, ?, ?, ?)`,
      [ownerId, `${ownerId}@example.com`, siteUrl, JSON.stringify([siteUrl]), JSON.stringify([siteUrl]), now],
    );
    await db.run(
      `INSERT INTO crawl_jobs (
         id, ownerId, siteUrl, startUrl, status, maxPages, maxDepth,
         discoveredCount, crawledCount, errorCount, skippedCount, queuedCount,
         startedAt, updatedAt, completedAt
       ) VALUES (?, ?, ?, ?, 'completed', 1000, 2, 1, 1, 0, 0, 0, ?, ?, ?)`,
      [crawlJobId, ownerId, siteUrl, siteUrl, now, now, now],
    );
    await db.run(
      `INSERT INTO crawl_page_sentences (
         ownerId, siteUrl, jobId, pageUrl, pageKey, paragraphIndex, sentenceIndex,
         sentenceText, textHash, embeddingStatus, createdAt, headingText,
         linkDensity, boilerplateScore, extractionVersion
       ) VALUES (?, ?, ?, ?, '/source', 0, 0, ?, ?, 'pending', ?, 'Internal links', 0.05, 0.1, 2)`,
      [ownerId, siteUrl, crawlJobId, `${siteUrl}source/`, 'Contextual internal links help readers find supporting material.', `hash-${suffix}`, now],
    );
    const user = { id: ownerId, activatedSiteUrl: siteUrl };
    if (!user?.id || !user?.activatedSiteUrl) {
      throw new Error('No user with an activated site was found for the Internal Links browser smoke test.');
    }

    const token = await createUserSession(db, user.id);
    const app = buildApp({
      db,
      upload: multer({ dest: 'uploads/' }),
      syncJobs: new Map(),
      getSyncJobKey: (ownerId, siteUrl) => `${ownerId}:${siteUrl}`,
      startWorkers: false,
    });
    await attachFrontend(app);

    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const apiEvents = [];
    const crawlStartRequests = [];

    browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addCookies([
      { name: SESSION_COOKIE_NAME, value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
    ]);

    const page = await context.newPage();
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/crawl/start')) {
        crawlStartRequests.push(request.url());
      }
    });
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/api/internal-links/')) apiEvents.push({ status: response.status(), url });
    });
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`browser-console-error: ${message.text()}`);
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('button', { name: /Crawl Inventory/i }).waitFor({ state: 'visible', timeout: 30000 });
    await page.getByRole('button', { name: /Crawl Inventory/i }).click();
    const crawlAction = page.getByRole('button', { name: /Start fresh crawl|Cancel crawl/i }).first();
    await crawlAction.waitFor({ state: 'visible', timeout: 15000 });
    const crawlStartControlCount = await page.getByRole('button', { name: /Start fresh crawl|Cancel crawl/i }).count();
    await page.getByRole('button', { name: /Internal Links/i }).click({ timeout: 10000 });
    await page
      .waitForResponse((response) => response.url().includes('/api/internal-links/opportunities') && response.status() === 200, { timeout: 20000 })
      .catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
    await page.waitForSelector('text=Internal links', { timeout: 15000 });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const desktopClippedControlCount = await page.locator('button:visible, input:visible, [role="combobox"]:visible').evaluateAll((elements) => elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > window.innerWidth + 1;
    }).length);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const mobileClippedControlCount = await page.locator('button:visible, input:visible, [role="combobox"]:visible').evaluateAll((elements) => elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > window.innerWidth + 1;
    }).length);
    const mobileFreshCrawlActionCount = await page.getByRole('button', { name: /Start fresh crawl|Crawling/i }).count();
    await page.screenshot({ path: mobileScreenshotPath, fullPage: true });

    const bodyText = await page.locator('body').innerText({ timeout: 5000 });
    const cardCount = await page.locator('text=/In “/').count();
    const assetTextCount = await page.locator('text=/\\.(jpg|jpeg|png|gif|webp|svg|pdf)(\\?|#|$)/i').count();
    const failedApiEvents = apiEvents.filter((event) => event.status >= 400);

    const checks = {
      authenticatedDashboardRendered: /Your SEO performance|Internal links/i.test(bodyText),
      crawlInventoryStartControlVisible: crawlStartControlCount > 0,
      noImplicitCrawlStarted: crawlStartRequests.length === 0,
      internalLinksViewRendered: /Internal links/i.test(bodyText),
      contextualSectionTitleVisible: /Find contextual internal link opportunities/i.test(bodyText),
      existingCrawlDoesNotClaimFreshCrawl: !/Fresh crawl complete/i.test(bodyText),
      providerVisible: /local\s*·\s*BAAI\/bge-m3/i.test(bodyText) || /Built-in BGE-M3/i.test(bodyText),
      builtInProviderReady: /BGE-M3 ready/i.test(bodyText),
      reviewProviderVisible: /review\s+local|review\s+ollama|Ollama judge|Local rules/i.test(bodyText),
      groupedCardsOrEmptyStateRendered: cardCount > 0 || /Run analysis after a fresh crawl|recommendations/i.test(bodyText),
      noRenderedAssetTargets: assetTextCount === 0,
      internalLinkApisNoErrors: failedApiEvents.length === 0,
      noDesktopHorizontalOverflow: desktopOverflow <= 1,
      noDesktopClippedControls: desktopClippedControlCount === 0,
      noMobileHorizontalOverflow: mobileOverflow <= 1,
      noMobileClippedControls: mobileClippedControlCount === 0,
      singleMobileFreshCrawlAction: mobileFreshCrawlActionCount <= 1,
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);

    console.log(JSON.stringify({
      baseUrl,
      activeSite: user.activatedSiteUrl,
      cardCount,
      assetTextCount,
      crawlStartControlCount,
      crawlStartRequests,
      apiEvents,
      desktopOverflow,
      desktopClippedControlCount,
      mobileOverflow,
      mobileClippedControlCount,
      mobileFreshCrawlActionCount,
      checks,
      failed,
      screenshot: screenshotPath,
      mobileScreenshot: mobileScreenshotPath,
    }, null, 2));

    if (failed.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.run('DELETE FROM internal_link_opportunities WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM internal_link_analysis_jobs WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM crawl_page_sentences WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM crawl_pages WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM crawl_jobs WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM sessions WHERE userId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM users WHERE id = ?', [ownerId]).catch(() => {});
    await db.close?.();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
