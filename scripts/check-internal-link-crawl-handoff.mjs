import fs from 'node:fs';
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertBuiltArtifacts() {
  for (const artifact of ['.server-dist/server/app.js', 'dist/index.html']) {
    if (!fs.existsSync(artifact)) throw new Error(`Missing ${artifact}. Run npm run build first.`);
  }
}

async function main() {
  assertBuiltArtifacts();
  const db = await initializeDatabase();
  const suffix = Date.now();
  const ownerId = `internal-link-handoff-${suffix}`;
  const siteUrl = `https://internal-link-handoff-${suffix}.example/`;
  const crawlJobId = `crawl-handoff-${suffix}`;
  const now = new Date().toISOString();
  let browser;
  let server;

  try {
    await db.run(`
      INSERT INTO users (id, email, passwordHash, tier, onboardingCompleted, activatedSiteUrl, knownSites, unlockedSites, createdAt)
      VALUES (?, ?, 'test', 'enterprise', 1, ?, ?, ?, ?)
    `, [ownerId, `${ownerId}@example.com`, siteUrl, JSON.stringify([siteUrl]), JSON.stringify([siteUrl]), now]);
    await db.run(`
      INSERT INTO crawl_jobs (
        id, ownerId, siteUrl, startUrl, status, maxPages, maxDepth,
        discoveredCount, crawledCount, errorCount, skippedCount, queuedCount,
        startedAt, updatedAt, completedAt
      ) VALUES (?, ?, ?, ?, 'completed', 1000, 2, 2, 2, 0, 0, 0, ?, ?, ?)
    `, [crawlJobId, ownerId, siteUrl, siteUrl, now, now, now]);
    await db.run(`
      INSERT INTO crawl_page_sentences (
        ownerId, siteUrl, jobId, pageUrl, pageKey, paragraphIndex, sentenceIndex,
        sentenceText, textHash, embeddingStatus, createdAt, headingText,
        linkDensity, boilerplateScore, extractionVersion
      ) VALUES (?, ?, ?, ?, '/source', 0, 0, ?, ?, 'pending', ?, 'Technical SEO', 0.05, 0.1, 2)
    `, [ownerId, siteUrl, crawlJobId, `${siteUrl}source/`, 'Contextual internal links help readers discover useful supporting technical SEO guidance.', `hash-${suffix}`, now]);

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
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([
      { name: SESSION_COOKIE_NAME, value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
    ]);
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) => candidate.request().method() === 'POST' && candidate.url().includes('/api/internal-links/analyze'),
        { timeout: 30000 },
      ),
      page.getByRole('button', { name: /Internal Links/i }).click({ timeout: 10000 }),
    ]);
    const responseBody = await response.json().catch(() => null);
    assert(response.status() === 200, `Expected automatic analysis request to succeed, got ${response.status()}: ${JSON.stringify(responseBody)}`);

    const jobs = await db.all(
      'SELECT id, crawlJobId, status FROM internal_link_analysis_jobs WHERE ownerId = ? AND siteUrl = ? ORDER BY updatedAt DESC',
      [ownerId, siteUrl],
    );
    assert(jobs.length === 1, `Expected exactly one analysis job, got ${jobs.length}`);
    assert(jobs[0].crawlJobId === crawlJobId, `Expected analysis to use ${crawlJobId}, got ${jobs[0].crawlJobId}`);
    assert(jobs[0].status === 'queued', `Expected queued analysis job, got ${jobs[0].status}`);

    const bodyText = await page.locator('body').innerText();
    assert(!bodyText.includes('Fresh crawl queued. This page will update'), 'Stale crawl-queued copy remained after crawl completion.');

    console.log(JSON.stringify({ automaticAnalysisStatus: response.status(), crawlJobId, job: jobs[0], siteUrl }, null, 2));
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
