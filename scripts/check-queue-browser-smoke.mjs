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
process.env.DATABASE_URL ||= 'postgres://nextgen_seo:nextgen_seo_dev_password@localhost:5432/nextgen_seo';

const screenshotPath = path.resolve('.tmp/queue-browser-smoke.png');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!fs.existsSync('dist/index.html') || !fs.existsSync('.server-dist/server/app.js')) {
    throw new Error('Run npm run build before the queue browser smoke.');
  }
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });

  const db = await initializeDatabase();
  const suffix = Date.now();
  const ownerId = `queue-browser-${suffix}`;
  const siteUrl = `https://queue-browser-${suffix}.example/`;
  const crawlJobId = `crawl-queue-${suffix}`;
  const internalJobId = `internal-queue-${suffix}`;
  const now = new Date().toISOString();
  let server;
  let browser;

  try {
    await db.run(`
      INSERT INTO users (id, email, passwordHash, activatedSiteUrl, knownSites, unlockedSites, onboardingCompleted, tier, createdAt)
      VALUES (?, ?, 'test', ?, ?, ?, 1, 'pro', ?)
    `, [ownerId, `${ownerId}@example.com`, siteUrl, JSON.stringify([siteUrl]), JSON.stringify([siteUrl]), now]);
    await db.run(`
      INSERT INTO crawl_jobs (
        id, ownerId, siteUrl, startUrl, status, maxPages, maxDepth, discoveredCount, crawledCount,
        errorCount, skippedCount, queuedCount, updatedAt, attemptCount, maxAttempts, nextRunAt,
        renderMode, respectRobots, includeQueryStrings
      ) VALUES (?, ?, ?, ?, 'queued', 100, 4, 20, 0, 0, 0, 20, ?, 0, 3, ?, 'html', 1, 0)
    `, [crawlJobId, ownerId, siteUrl, siteUrl, now, now]);
    await db.run(`
      INSERT INTO internal_link_analysis_jobs (
        id, ownerId, siteUrl, crawlJobId, startDate, endDate, status, progressTotal, progressCompleted,
        provider, embeddingProvider, embeddingModel, reviewProvider, reviewModel, updatedAt
      ) VALUES (?, ?, ?, ?, '2026-06-01', '2026-06-29', 'queued', 50, 0, 'local', 'local',
        'bge-m3-local', 'local', 'rules-editorial-v1', ?)
    `, [internalJobId, ownerId, siteUrl, crawlJobId, now]);

    const token = await createUserSession(db, ownerId);
    const app = buildApp({
      db,
      upload: multer({ dest: 'uploads/' }),
      syncJobs: new Map(),
      getSyncJobKey: (userId, scopedSiteUrl) => `${userId}:${scopedSiteUrl}`,
      startWorkers: false,
    });
    await attachFrontend(app);
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addCookies([
      { name: SESSION_COOKIE_NAME, value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
    ]);
    const page = await context.newPage();
    const failedApi = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/') && response.status() >= 400) {
        failedApi.push({ status: response.status(), url: response.url() });
      }
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.getByRole('button', { name: /Crawl Inventory/i }).click();
    await page.getByText('Position 1', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    const crawlBody = await page.locator('body').innerText();
    assert(/crawl.*next in the workspace queue/i.test(crawlBody), 'Crawl queue message was not rendered.');

    await page.getByRole('button', { name: /Internal Links/i }).click();
    await page.getByText('Queue position', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByText('Position 1', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    const internalBody = await page.locator('body').innerText();
    assert(/internal link analysis is next in the workspace queue/i.test(internalBody), 'Internal-link queue message was not rendered.');
    assert(/0 queued.*0 running/i.test(internalBody) === false, 'Queue counts should reflect the seeded active job.');

    await page.screenshot({ path: screenshotPath, fullPage: true });
    assert(failedApi.length === 0, `Queue browser smoke had failed API calls: ${JSON.stringify(failedApi)}`);

    console.log(JSON.stringify({
      crawlQueueVisible: true,
      internalLinkQueueVisible: true,
      failedApi,
      screenshot: screenshotPath,
      siteUrl,
    }, null, 2));
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.run('DELETE FROM internal_link_analysis_jobs WHERE ownerId = ?', [ownerId]).catch(() => {});
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
