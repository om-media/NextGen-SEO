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

const screenshotPath = path.resolve('.tmp/visual-semantics-browser-smoke.png');
const mobileScreenshotPath = path.resolve('.tmp/visual-semantics-browser-smoke-mobile.png');

function assertBuiltArtifacts() {
  const missing = ['.server-dist/server/app.js', 'dist/index.html'].filter((file) => !fs.existsSync(path.resolve(file)));
  if (missing.length) throw new Error(`Missing built artifacts: ${missing.join(', ')}. Run npm run build first.`);
}

async function main() {
  assertBuiltArtifacts();
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const db = await initializeDatabase();
  const suffix = Date.now();
  const ownerId = `authority-browser-${suffix}`;
  const siteUrl = `https://authority-browser-${suffix}.example/`;
  const secondSiteUrl = `https://authority-browser-beta-${suffix}.example/`;
  const scopeId = `scope-authority-${suffix}`;
  const crawlJobId = `crawl-authority-${suffix}`;
  const analysisJobId = `analysis-authority-${suffix}`;
  const templateKey = `template-authority-${suffix}`;
  const now = new Date().toISOString();
  let server;
  let browser;

  try {
    await db.run(
      `INSERT INTO users (id, email, passwordHash, tier, onboardingCompleted, activatedSiteUrl, knownSites, unlockedSites, createdAt)
       VALUES (?, ?, 'test', 'enterprise', 1, ?, ?, ?, ?)`,
      [ownerId, `${ownerId}@example.com`, siteUrl, JSON.stringify([siteUrl, secondSiteUrl]), JSON.stringify([siteUrl, secondSiteUrl]), now],
    );
    await db.run('INSERT INTO site_scopes (id, ownerId, canonicalDomain, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)', [scopeId, ownerId, new URL(siteUrl).hostname, now, now]);
    await db.run('INSERT INTO site_scope_sources (siteScopeId, sourceType, sourceKey, siteUrl, propertyId, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, ?, ?)', [scopeId, 'gsc', siteUrl, siteUrl, now, now]);
    await db.run(
      `INSERT INTO crawl_jobs (
        id, ownerId, siteUrl, startUrl, status, maxPages, maxDepth, discoveredCount,
        crawledCount, errorCount, skippedCount, queuedCount, startedAt, updatedAt, completedAt
      ) VALUES (?, ?, ?, ?, 'completed', 1000, 3, 65, 65, 0, 0, 0, ?, ?, ?)`,
      [crawlJobId, ownerId, siteUrl, siteUrl, now, now, now],
    );
    await db.run(
      `INSERT INTO page_analysis_jobs (
        id, ownerId, siteScopeId, siteUrl, crawlJobId, analysisType, status,
        progressTotal, progressCompleted, attemptCount, maxAttempts, startedAt,
        updatedAt, completedAt, provider, modelVersion, extractionVersion, metricsJson
      ) VALUES (?, ?, ?, ?, ?, 'content-authority', 'completed', 65, 65, 0, 3, ?, ?, ?, 'local', 'rules-v1', 3, '{}')`,
      [analysisJobId, ownerId, scopeId, siteUrl, crawlJobId, now, now, now],
    );
    await db.run(
      `INSERT INTO page_template_clusters (
        ownerId, siteUrl, siteScopeId, crawlJobId, templateKey, exemplarPageKey,
        urlSkeleton, domSignature, regionSequenceHash, memberCount, confidence, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, '/guide-1', '/guides/{slug}', 'dom-ready', 'regions-ready', 65, 0.92, ?, ?)`,
      [ownerId, siteUrl, scopeId, crawlJobId, templateKey, now, now],
    );

    for (let index = 1; index <= 65; index += 1) {
      const pageKey = `/guide-${index}`;
      const url = `${siteUrl}guides/guide-${index}`;
      await db.run(
        `INSERT INTO crawl_pages (
          ownerId, siteUrl, jobId, url, normalizedUrl, pageKey, resolvedCanonicalPageKey,
          finalUrl, statusCode, contentType, title, metaDescription, canonicalUrl, h1Text,
          h1Count, h2Count, wordCount, depth, discoveredFrom, discoveredFromUrl,
          discoveredAt, crawledAt, responseTimeMs, noindex, inboundLinkCount,
          internalLinkCount, outgoingLinkCount, errorMessage
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 200, 'text/html', ?, ?, ?, ?, 1, 3, ?, 2, 'seed', ?, ?, ?, 120, 0, 4, 12, 8, NULL)`,
        [ownerId, siteUrl, crawlJobId, url, url, pageKey, pageKey, url, `Acoustic guide ${index}`, `Evidence-led guide ${index}`, url, `Acoustic guide ${index}`, 900 + index, siteUrl, now, now],
      );
      await db.run(
        `INSERT INTO page_function_profiles (
          ownerId, siteUrl, siteScopeId, crawlJobId, pageKey, templateKey, pageType,
          primaryTask, secondaryTasksJson, centerpieceRegionIndex, confidence,
          featureBreakdownJson, manualOverrideJson, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, 'article', 'learn', '["compare"]', 0, ?, '{}', NULL, ?, ?)`,
        [ownerId, siteUrl, scopeId, crawlJobId, pageKey, templateKey, 0.8 + (index % 10) / 100, now, now],
      );
      await db.run(
        `INSERT INTO page_template_members (
          ownerId, siteUrl, siteScopeId, crawlJobId, templateKey, pageKey,
          distance, isExemplar, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ownerId, siteUrl, scopeId, crawlJobId, templateKey, pageKey, index / 100, index === 1 ? 1 : 0, now, now],
      );
      await db.run(
        `INSERT INTO crawl_page_regions (
          ownerId, siteUrl, jobId, pageUrl, pageKey, regionIndex, parentRegionIndex,
          regionRole, componentType, blockKey, blockIndex, headingChainJson, domPath,
          selector, text, textHash, textDensity, linkDensity, boilerplateScore,
          templateFrequency, bboxX, bboxY, bboxWidth, bboxHeight, viewportProminence,
          visible, confidence, featureBreakdownJson, extractionVersion
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, 'centerpiece', 'article', ?, 0,
          '["Acoustic performance"]', '/main/article', 'main article', ?, ?, 0.9, 0.08,
          0.04, 0.95, 0, 120, 1100, 540, 0.9, 1, 0.9, '{}', 3)`,
        [ownerId, siteUrl, crawlJobId, url, pageKey, `${pageKey}:centerpiece`, `This guide explains acoustic performance evidence for topic ${index}.`, `hash-${suffix}-${index}`],
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
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const apiEvents = [];
    const writeRequests = [];

    browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addCookies([{ name: SESSION_COOKIE_NAME, value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.on('request', (request) => {
      if (request.url().includes('/api/content-authority/') && request.method() !== 'GET') writeRequests.push(`${request.method()} ${request.url()}`);
    });
    page.on('response', (response) => {
      if (response.url().includes('/api/content-authority/')) apiEvents.push({ status: response.status(), url: response.url() });
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loadStartedAt = Date.now();
    await page.getByRole('button', { name: 'Visual Semantics' }).click();
    await page.getByText('Visual semantics evidence', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
    await page.getByText('Showing 1–50 of 65 pages', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
    const initialLoadMs = Date.now() - loadStartedAt;
    const authorityWorkspace = page.getByRole('region', { name: 'Visual semantics evidence' });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await authorityWorkspace.getByRole('button', { name: 'Next', exact: true }).click();
    await authorityWorkspace.getByText('Showing 51–65 of 65 pages', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const secondPageVisible = true;
    await authorityWorkspace.getByRole('button', { name: 'Previous', exact: true }).click();
    await authorityWorkspace.getByText('Showing 1–50 of 65 pages', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const firstPageVisible = true;

    const searchInput = authorityWorkspace.getByRole('textbox', { name: 'Search analyzed pages' });
    await searchInput.fill('Acoustic guide 65');
    await authorityWorkspace.getByText('Showing 1–1 of 1 pages', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const filteredRowVisible = await authorityWorkspace.getByText('Acoustic guide 65', { exact: true }).isVisible();
    await authorityWorkspace.getByRole('button', { name: 'Inspect evidence for Acoustic guide 65' }).click();
    await page.getByText('Semantic regions', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const evidenceVisible = await page.getByText('This guide explains acoustic performance evidence for topic 65.', { exact: true }).isVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await searchInput.fill('');
    await authorityWorkspace.getByText('Showing 1–50 of 65 pages', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const inspectCount = await authorityWorkspace.getByRole('button', { name: /Inspect evidence for Acoustic guide/ }).count();

    await authorityWorkspace.getByRole('button', { name: 'Templates', exact: true }).click();
    await authorityWorkspace.getByText('/guides/{slug}', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const templateVisible = await authorityWorkspace.getByText('65', { exact: true }).count() > 0;

    const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const desktopClippedControls = await page.locator('button:visible, input:visible').evaluateAll((elements) => elements.filter((element) => {
      if (element.closest('[data-slot="table-container"]')) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > window.innerWidth + 1;
    }).length);

    await page.setViewportSize({ width: 390, height: 844 });
    await authorityWorkspace.getByRole('button', { name: 'Pages', exact: true }).click();
    await authorityWorkspace.getByText('Showing 1–50 of 65 pages', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const mobileClippedControls = await page.locator('button:visible, input:visible').evaluateAll((elements) => elements.filter((element) => {
      if (element.closest('[data-slot="table-container"]')) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > window.innerWidth + 1;
    }).length);
    await page.screenshot({ path: mobileScreenshotPath, fullPage: true });

    const noCrawlMeta = {
      confidence: { label: 'unknown', value: null },
      counts: { pageCount: 0, profileCount: 0, regionCount: 0, regionPageCount: 0, templateCount: 0, templateMemberCount: 0, templateMemberPageCount: 0 },
      coverage: { profileCoverage: 0, regionCoverage: 0, templateCoverage: 0 },
      crawlJobId: null,
      freshness: { ageHours: null, analyzedAt: null, state: 'unknown', updatedAt: null },
      job: null,
      message: 'Run a crawl to collect visual semantics evidence.',
      status: 'no_crawl',
    };
    const emptyPage = await context.newPage();
    await emptyPage.route('**/api/content-authority/readiness*', (route) => route.fulfill({ json: noCrawlMeta }));
    await emptyPage.route('**/api/content-authority/pages*', (route) => route.fulfill({ json: { meta: noCrawlMeta, page: { limit: 50, offset: 0, total: 0 }, rows: [] } }));
    await emptyPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await emptyPage.getByRole('button', { name: 'Visual Semantics' }).click();
    await emptyPage.getByText('No analyzed pages found', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const emptyStateActionVisible = await emptyPage.getByRole('button', { name: 'Open Crawl Inventory' }).isVisible();
    const irrelevantDateControlsHidden = await emptyPage.locator('main').getByText('Compare', { exact: true }).count() === 0;
    await emptyPage.close();

    const racePage = await context.newPage();
    const raceMeta = (label) => ({
      confidence: { label: 'high', value: 0.9 },
      counts: { pageCount: 1, profileCount: 1, regionCount: 1, regionPageCount: 1, templateCount: 0, templateMemberCount: 0, templateMemberPageCount: 0 },
      coverage: { profileCoverage: 1, regionCoverage: 1, templateCoverage: 0 },
      crawlJobId: `crawl-${label}`,
      freshness: { ageHours: 0, analyzedAt: now, state: 'fresh', updatedAt: now },
      job: null,
      message: `${label} evidence ready`,
      status: 'ready',
    });
    const raceRow = (label, requestedSite) => ({
      confidence: { label: 'high', value: 0.9 }, depth: 1, pageKey: `/${label.toLowerCase()}`,
      pageType: 'article', primaryTask: 'learn', regions: { count: 1, roles: [{ count: 1, role: 'centerpiece' }] },
      template: null, title: `${label} race page`, topEvidence: { confidence: 0.9, role: 'centerpiece', text: `${label} summary` },
      url: `${requestedSite}${label.toLowerCase()}`, wordCount: 100,
    });
    const raceEvidence = (label, requestedSite) => ({
      found: true, meta: raceMeta(label),
      page: { confidence: { label: 'high', value: 0.9 }, crawl: { canonicalUrl: null, depth: 1, metaDescription: null, statusCode: 200, title: `${label} race page`, url: `${requestedSite}${label.toLowerCase()}`, wordCount: 100 }, pageKey: `/${label.toLowerCase()}`, pageType: 'article', primaryTask: 'learn', regions: [{ confidence: 0.9, headingChain: [label], regionIndex: 0, regionRole: 'centerpiece', selector: 'main', text: `${label} RACE EVIDENCE`, visible: true }], secondaryTasks: [], template: null },
    });
    let releaseAlphaEvidence;
    let markAlphaEvidenceStarted;
    const alphaEvidenceGate = new Promise((resolve) => { releaseAlphaEvidence = resolve; });
    const alphaEvidenceStarted = new Promise((resolve) => { markAlphaEvidenceStarted = resolve; });
    await racePage.route('**/api/content-authority/**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const requestedSite = requestUrl.searchParams.get('siteUrl') || siteUrl;
      const label = requestedSite === secondSiteUrl ? 'Beta' : 'Alpha';
      if (requestUrl.pathname.endsWith('/evidence')) {
        if (label === 'Alpha') { markAlphaEvidenceStarted(); await alphaEvidenceGate; }
        await route.fulfill({ json: raceEvidence(label, requestedSite) }); return;
      }
      if (requestUrl.pathname.endsWith('/readiness')) { await route.fulfill({ json: raceMeta(label) }); return; }
      if (requestUrl.pathname.endsWith('/pages')) { await route.fulfill({ json: { meta: raceMeta(label), page: { limit: 50, offset: 0, total: 1 }, rows: [raceRow(label, requestedSite)] } }); return; }
      if (requestUrl.pathname.endsWith('/templates')) { await route.fulfill({ json: { meta: raceMeta(label), rows: [] } }); return; }
      await route.continue();
    });
    await racePage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await racePage.getByRole('button', { name: 'Visual Semantics' }).click();
    await racePage.getByText('Alpha race page', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await racePage.getByRole('button', { name: 'Inspect evidence for Alpha race page' }).click();
    await alphaEvidenceStarted;
    await racePage.getByRole('button', { name: 'Close' }).click();
    await racePage.locator('header [data-slot="select-trigger"]').click();
    await racePage.getByRole('option').filter({ hasText: new URL(secondSiteUrl).hostname }).click();
    await racePage.getByText('Beta race page', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await racePage.getByRole('button', { name: 'Inspect evidence for Beta race page' }).click();
    await racePage.getByText('Beta RACE EVIDENCE', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const staleAlphaResponse = racePage.waitForResponse((response) => response.url().includes('/evidence') && response.url().includes(encodeURIComponent(siteUrl)));
    releaseAlphaEvidence();
    await staleAlphaResponse;
    await racePage.waitForTimeout(100);
    const staleCrossSiteEvidenceSuppressed = await racePage.getByText('Beta RACE EVIDENCE', { exact: true }).isVisible()
      && await racePage.getByText('Alpha RACE EVIDENCE', { exact: true }).count() === 0;
    await racePage.close();

    const failedApiEvents = apiEvents.filter((event) => event.status >= 400);
    const bodyText = await page.locator('main').innerText();
    const checks = {
      readinessVisible: /Evidence ready/.test(bodyText),
      coverageVisible: /Page roles 100%/.test(bodyText) && /Semantic regions 100%/.test(bodyText),
      pagesVisible: /Acoustic guide 1/.test(bodyText),
      paginationVisible: firstPageVisible && secondPageVisible,
      searchFiltersStoredPages: filteredRowVisible,
      evidenceInspectorVisible: evidenceVisible,
      templatesVisible: templateVisible,
      noCrawlStateActionVisible: emptyStateActionVisible,
      irrelevantDateControlsHidden,
      initialLoadUnderFiveSeconds: initialLoadMs < 5000,
      readOnlyOnOpen: writeRequests.length === 0,
      APIsSucceeded: failedApiEvents.length === 0,
      noDesktopHorizontalOverflow: desktopOverflow <= 1,
      noDesktopClippedControls: desktopClippedControls === 0,
      noMobileHorizontalOverflow: mobileOverflow <= 1,
      noMobileClippedControls: mobileClippedControls === 0,
      inspectControlAvailable: inspectCount === 50,
      staleCrossSiteEvidenceSuppressed,
    };
    const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
    console.log(JSON.stringify({ apiEvents, checks, failed, screenshotPath, mobileScreenshotPath }, null, 2));
    if (failed.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.run('DELETE FROM crawl_page_regions WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM page_template_members WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM page_template_clusters WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM page_function_profiles WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM page_analysis_jobs WHERE ownerId = ?', [ownerId]).catch(() => {});
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
