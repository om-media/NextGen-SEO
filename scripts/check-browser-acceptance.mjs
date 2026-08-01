import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  clickDashboardSource,
  clickSidebarItem,
  createArtifactDir,
  escapeRegExp,
  findWorkingBaseUrl,
  installPageMonitor,
  launchAcceptanceBrowser,
  screenshot,
  selectComboboxOption,
  summarizeFailures,
  waitForCondition,
} from './lib/browserAcceptance.mjs';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { initializeDatabase } = await import('../.server-dist/server/database.js');
const { createUserSession, SESSION_COOKIE_NAME } = await import('../.server-dist/server/auth.js');

const DEFAULT_BASE_URLS = ['http://127.0.0.1:3000', 'http://127.0.0.1:3010'];
const VIEWPORT = { width: 1440, height: 1200 };
const ARTIFACT_DIR = createArtifactDir('browser-acceptance');
const REPORT_PATH = path.join(ARTIFACT_DIR, 'report.json');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parsePostData(request) {
  try {
    return JSON.parse(request.postData() || '{}');
  } catch {
    return null;
  }
}

async function fulfillRoute(route, options) {
  try {
    await route.fulfill(options);
  } catch (error) {
    if (!/Route is already handled!/i.test(String(error?.message || error))) {
      throw error;
    }
  }
}

function queuePayload(message = 'No background work queued.') {
  return {
    autoRefreshMs: 5000,
    estimatedCompletionInSeconds: null,
    estimatedStartInSeconds: null,
    message,
    position: null,
    workloadState: 'idle',
    workspaceQueued: 0,
    workspaceRunning: 0,
  };
}

function gscMockRows({ dimensions = [], siteUrl }) {
  const siteKey = siteUrl.includes('avancenatur') ? 'avancenatur' : 'avanterra';

  if (dimensions.join('|') === 'date|query') {
    return [
      { keys: ['2026-07-08', `${siteKey} tickets`], date: '2026-07-08', query: `${siteKey} tickets`, clicks: 18, impressions: 220, ctr: 0.081, position: 5.3, queryCount: 1 },
      { keys: ['2026-07-09', `${siteKey} prices`], date: '2026-07-09', query: `${siteKey} prices`, clicks: 12, impressions: 160, ctr: 0.075, position: 6.1, queryCount: 1 },
    ];
  }

  if (dimensions.join('|') === 'page|query') {
    const page = siteKey === 'avancenatur' ? 'https://www.avancenatur.es/entry/' : 'https://avanterrapark.com/tickets/';
    return [
      { keys: [page, `${siteKey} tickets`], page, query: `${siteKey} tickets`, clicks: 20, impressions: 240, ctr: 0.083, position: 4.2, queryCount: 1 },
      { keys: [page, `${siteKey} pricing`], page, query: `${siteKey} pricing`, clicks: 14, impressions: 180, ctr: 0.077, position: 5.1, queryCount: 1 },
    ];
  }

  if (dimensions.includes('page')) {
    return [
      {
        keys: [siteKey === 'avancenatur' ? 'https://www.avancenatur.es/entry/' : 'https://avanterrapark.com/tickets/'],
        page: siteKey === 'avancenatur' ? 'https://www.avancenatur.es/entry/' : 'https://avanterrapark.com/tickets/',
        clicks: 42,
        impressions: 610,
        ctr: 0.068,
        position: 4.8,
        queryCount: 9,
      },
    ];
  }

  if (dimensions.includes('country')) {
    return [
      { keys: [siteKey === 'avancenatur' ? 'es' : 'hr'], country: siteKey === 'avancenatur' ? 'es' : 'hr', clicks: 31, impressions: 420, ctr: 0.073, position: 6.4, queryCount: 0 },
    ];
  }

  if (dimensions.includes('query')) {
    return [
      { keys: [`${siteKey} tickets`], query: `${siteKey} tickets`, clicks: 28, impressions: 380, ctr: 0.073, position: 4.9, queryCount: 0 },
      { keys: [`${siteKey} family`], query: `${siteKey} family`, clicks: 15, impressions: 260, ctr: 0.058, position: 7.2, queryCount: 0 },
    ];
  }

  if (dimensions.includes('date')) {
    return [
      { keys: ['2026-07-08'], date: '2026-07-08', clicks: 26, impressions: 300, ctr: 0.087, position: 4.6, queryCount: 14 },
      { keys: ['2026-07-09'], date: '2026-07-09', clicks: 22, impressions: 280, ctr: 0.079, position: 5.2, queryCount: 13 },
    ];
  }

  return [];
}

function ga4MetricValues(metrics, seed = 1) {
  const values = {
    bounceRate: (0.18 + seed / 100).toFixed(4),
    eventCount: String(30 + seed * 4),
    screenPageViews: String(120 + seed * 10),
    sessions: String(90 + seed * 7),
    totalUsers: String(70 + seed * 5),
  };
  return metrics.map((metric) => ({ value: values[metric] || String(seed) }));
}

function ga4MockRows({ dimensions = [], propertyId }) {
  const propertyKey = propertyId === 'properties/mock-avancenatur' ? 'avancenatur' : 'avanterra';
  const dimension = dimensions[0] || 'date';

  if (dimension === 'date') {
    return [
      { dimensionValues: [{ value: '20260708' }], metricValues: ga4MetricValues(['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'], propertyKey === 'avancenatur' ? 2 : 1) },
      { dimensionValues: [{ value: '20260709' }], metricValues: ga4MetricValues(['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'], propertyKey === 'avancenatur' ? 3 : 2) },
    ];
  }

  const valueMap = {
    browser: propertyKey === 'avancenatur' ? 'Safari' : 'Chrome',
    city: propertyKey === 'avancenatur' ? 'Madrid' : 'Sibenik',
    country: propertyKey === 'avancenatur' ? 'Spain' : 'Croatia',
    deviceCategory: 'mobile',
    eventName: propertyKey === 'avancenatur' ? 'book_now' : 'purchase_ticket',
    operatingSystem: propertyKey === 'avancenatur' ? 'iOS' : 'Android',
    pagePath: propertyKey === 'avancenatur' ? '/entry/' : '/tickets/',
    region: propertyKey === 'avancenatur' ? 'Catalonia' : 'Dalmatia',
    sessionSourceMedium: propertyKey === 'avancenatur' ? 'google / organic' : 'newsletter / email',
  };

  return [
    {
      dimensionValues: [{ value: valueMap[dimension] || propertyKey }],
      metricValues: ga4MetricValues(['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'], propertyKey === 'avancenatur' ? 4 : 2),
    },
  ];
}

function ga4MockCoverage() {
  return {
    activeDateCount: 0,
    activeJobCount: 0,
    coveredDateCount: 28,
    expectedDateCount: 28,
    missingDateCount: 0,
    queuedDateCount: 0,
  };
}

async function pickAcceptanceUser(db) {
  const rows = await db.all(`
    SELECT
      u.id,
      u.email,
      u.activatedSiteUrl,
      u.activatedGa4PropertyId,
      COALESCE(gsc.rows, 0) AS gscRows,
      COALESCE(ga4.rows, 0) AS ga4Rows,
      COALESCE(crawl.rows, 0) AS crawlRows,
      COALESCE(il.rows, 0) AS internalLinkRows
    FROM users u
    LEFT JOIN (
      SELECT ownerId, COUNT(*)::int AS rows
      FROM gsc_site_metrics
      GROUP BY ownerId
    ) gsc ON gsc.ownerId = u.id
    LEFT JOIN (
      SELECT ownerId, COUNT(*)::int AS rows
      FROM ga4_page_metrics
      GROUP BY ownerId
    ) ga4 ON ga4.ownerId = u.id
    LEFT JOIN (
      SELECT ownerId, COUNT(*)::int AS rows
      FROM crawl_pages
      GROUP BY ownerId
    ) crawl ON crawl.ownerId = u.id
    LEFT JOIN (
      SELECT ownerId, COUNT(*)::int AS rows
      FROM internal_link_opportunities
      GROUP BY ownerId
    ) il ON il.ownerId = u.id
    WHERE u.onboardingCompleted = 1
      AND u.activatedSiteUrl IS NOT NULL
      AND u.activatedSiteUrl <> ''
    ORDER BY
      CASE WHEN COALESCE(il.rows, 0) > 0 THEN 1 ELSE 0 END DESC,
      CASE WHEN COALESCE(ga4.rows, 0) > 0 THEN 1 ELSE 0 END DESC,
      CASE WHEN COALESCE(crawl.rows, 0) > 0 THEN 1 ELSE 0 END DESC,
      COALESCE(il.rows, 0) DESC,
      COALESCE(ga4.rows, 0) DESC,
      COALESCE(crawl.rows, 0) DESC,
      COALESCE(gsc.rows, 0) DESC
    LIMIT 1
  `);

  const user = rows[0] || null;
  assert(user, 'No completed user with an activated site was found for browser acceptance.');
  return user;
}

async function createAuthedContext(browser, baseUrl, token) {
  const context = await browser.newContext({ baseURL: baseUrl, viewport: VIEWPORT });
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: token, url: baseUrl }]);
  return context;
}

async function waitForAppShell(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForCondition(async () => {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    return /Dashboard|Crawl Inventory|Internal Links|Settings|Login|Sign in|Create your workspace/i.test(bodyText);
  }, { description: 'app shell' });
}

async function waitForMainToSettle(page) {
  await waitForCondition(async () => {
    const text = await page.locator('main').innerText().catch(() => '');
    if (!text.trim()) return false;
    if (/Loading view\.\.\./i.test(text)) return false;
    if (/Loading workspace\.\.\./i.test(text)) return false;
    return true;
  }, { description: 'main content' });
}

async function getMainText(page) {
  return page.locator('main').innerText().catch(() => '');
}

async function getHeaderText(page) {
  return page.locator('header').innerText().catch(() => '');
}

async function installSecondaryWorkflowMocks(page, user) {
  const emptyQueue = queuePayload();
  const json = (route, body) => fulfillRoute(route, {
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/rank-tracking/keywords**', (route) => json(route, []));
  await page.route('**/api/rank-tracking/status**', (route) => json(route, {
    autoCollectionEnabled: true,
    collectionCadence: 'daily',
    freshCount: 0,
    latestUpdated: null,
    neverCollectedCount: 0,
    staleCount: 0,
    today: '2026-08-01',
    totalKeywords: 0,
  }));
  await page.route('**/api/logs/stats**', (route) => json(route, []));
  await page.route('**/api/logs/errors**', (route) => json(route, []));
  await page.route('**/api/logs/insights**', (route) => json(route, {
    efficiency: [],
    llmTraffic: [],
    mostCrawled: [],
  }));
  await page.route('**/api/indexing/auto-sync/status**', (route) => json(route, { status: 'idle' }));
  await page.route('**/api/indexing/grid**', (route) => json(route, []));
  await page.route('**/api/workspace/sites/status', (route) => json(route, {
    ga4PropertyId: user.activatedGa4PropertyId || null,
    sites: [{
      crawl: null,
      isDefault: true,
      isUnlocked: true,
      siteUrl: user.activatedSiteUrl,
      warehouse: {
        earliestMetricDate: null,
        jobs: { completed: 0, error: 0, latest: null, latestUpdatedAt: null, queued: 0, retrying: 0, running: 0, total: 0 },
        lastMetricDate: null,
        metricDayCount: 0,
        rowCount: 0,
        status: 'empty',
        updatedAt: null,
      },
    }],
  }));
  await page.route('**/api/warehouse/raw/gsc**', (route) => json(route, { page: { limit: 100, offset: 0, total: 0 }, rows: [] }));
  await page.route('**/api/reconciliation/pages**', (route) => json(route, {
    meta: {
      crawlJobId: null,
      ga4Coverage: null,
      totals: { crawlErrors: 0, issues: 0, matched: 0, missingCrawl: 0, missingGa4: 0, missingGsc: 0, total: 0 },
    },
    page: { limit: 100, offset: 0, total: 0 },
    rows: [],
  }));
  await page.route('**/api/crawl/jobs**', (route) => json(route, { jobs: [], queue: emptyQueue }));
  await page.route('**/api/crawl/pages**', (route) => json(route, {
    job: null,
    page: { limit: 5000, offset: 0, total: 0 },
    queue: emptyQueue,
    rows: [],
    summary: null,
  }));
  await page.route('**/api/warehouse/query', (route) => json(route, []));
}

async function clickTab(page, name) {
  const tab = page.locator('[data-slot="tabs-trigger"]').filter({ hasText: new RegExp(`^${escapeRegExp(name)}$`, 'i') }).first();
  await tab.waitFor({ state: 'visible', timeout: 30000 });
  await tab.click();
  await waitForCondition(async () => {
    const selected = await tab.getAttribute('aria-selected').catch(() => null);
    const dataActive = await tab.getAttribute('data-active').catch(() => null);
    return selected === 'true' || dataActive !== null;
  }, { description: `${name} tab` });
}

async function runScenario(report, name, fn) {
  const scenario = {
    failures: [],
    name,
    notes: [],
    screenshots: [],
    status: 'passed',
  };
  report.scenarios.push(scenario);

  try {
    await fn(scenario);
  } catch (error) {
    scenario.status = 'failed';
    scenario.failures.push(error?.stack || error?.message || String(error));
  }

  if (scenario.failures.length > 0) {
    report.failures.push({ name, failures: scenario.failures.slice() });
  }
}

async function run() {
  const db = await initializeDatabase();
  let browser;

  const report = {
    artifactDir: ARTIFACT_DIR,
    baseUrl: null,
    failures: [],
    generatedAt: new Date().toISOString(),
    scenarios: [],
    selectedUser: null,
  };

  try {
    const baseUrl = process.argv[2] || process.env.ACCEPTANCE_BASE_URL || await findWorkingBaseUrl(DEFAULT_BASE_URLS);
    assert(baseUrl, `No running app found. Checked ${DEFAULT_BASE_URLS.join(', ')}.`);
    report.baseUrl = baseUrl;

    const user = await pickAcceptanceUser(db);
    report.selectedUser = user;

    const token = await createUserSession(db, user.id);
    browser = await launchAcceptanceBrowser();

    await runScenario(report, 'login-shell', async (scenario) => {
      const context = await browser.newContext({ baseURL: baseUrl, viewport: VIEWPORT });
      const page = await context.newPage();
      const monitor = installPageMonitor(page, {
        ignoreRequestFailures: ['/images/hero-mountains.png'],
        ignoreConsole: ['Failed to load resource: the server responded with a status of 401'],
        ignoreResponseFailures: ['/images/hero-mountains.png', '/api/auth/session', '/api/warehouse/status'],
      });

      try {
        await waitForAppShell(page);
        await waitForCondition(async () => {
          const text = await page.locator('body').innerText();
          return /Sign in or create an account|Welcome back|Create your workspace/i.test(text);
        }, { description: 'login shell copy' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'login-shell'));

        const bodyText = await page.locator('body').innerText();
        assert(/Login/i.test(bodyText), 'Login shell did not render the Login tab.');
        assert(/Register/i.test(bodyText), 'Login shell did not render the Register tab.');
        assert(/Google/i.test(bodyText), 'Login shell did not render Google sign-in.');

        if (monitor.hasUnexpectedFailures()) {
          scenario.failures.push(...summarizeFailures(monitor.events));
        }
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'workspace-settings', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      const monitor = installPageMonitor(page);

      try {
        await waitForAppShell(page);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Settings' });
        await dialog.waitFor({ state: 'visible', timeout: 30000 });
        await dialog.getByRole('tab', { name: 'Workspace', exact: true }).click();
        await dialog.getByText('Available properties', { exact: true }).waitFor({ state: 'visible' });
        const dialogText = await dialog.innerText();
        assert(!/billing|upgrade|current plan|known properties cache/i.test(dialogText), 'Settings exposed removed product assumptions.');
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'workspace-settings'));

        if (monitor.hasUnexpectedFailures()) {
          scenario.failures.push(...summarizeFailures(monitor.events));
        }
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'onboarding-desktop-mobile', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      const page = await context.newPage();
      const monitor = installPageMonitor(page);
      const onboardingSite = 'https://onboarding.example/';

      await page.route('**/api/auth/session', async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        payload.profile = {
          ...payload.profile,
          activatedGa4DisplayName: null,
          activatedGa4PropertyId: null,
          activatedSiteUrl: null,
          googleConnected: true,
          knownSites: [],
          onboardingCompleted: false,
          unlockedSites: [],
        };
        await fulfillRoute(route, { contentType: 'application/json', body: JSON.stringify(payload) });
      });
      await page.route('**/api/warehouse/status', (route) => fulfillRoute(route, {
        contentType: 'application/json',
        body: JSON.stringify([{ siteUrl: onboardingSite }]),
      }));
      await page.route('**/api/google/gsc/sites', (route) => fulfillRoute(route, {
        contentType: 'application/json',
        body: JSON.stringify([{ permissionLevel: 'siteOwner', siteUrl: onboardingSite }]),
      }));
      await page.route('**/api/google/ga4/properties', (route) => fulfillRoute(route, {
        contentType: 'application/json',
        body: JSON.stringify([{
          account: 'accounts/onboarding',
          displayName: 'Onboarding account',
          name: 'accountSummaries/onboarding',
          propertySummaries: [{ displayName: 'onboarding.example', property: 'properties/123', propertyType: 'PROPERTY_TYPE_ORDINARY' }],
        }]),
      }));

      try {
        await waitForAppShell(page);
        await waitForCondition(async () => /Choose your default property/i.test(await page.locator('body').innerText()), { description: 'onboarding site selection' });
        await page.getByRole('button', { name: new RegExp(escapeRegExp(onboardingSite), 'i') }).click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await waitForCondition(async () => /Optional Bing setup/i.test(await page.locator('body').innerText()), { description: 'onboarding Bing step' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'onboarding-desktop'));
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Onboarding overflowed the mobile viewport.');
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'onboarding-mobile'));
        if (monitor.hasUnexpectedFailures()) scenario.failures.push(...summarizeFailures(monitor.events));
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'settings-save-success', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      const page = await context.newPage();
      const monitor = installPageMonitor(page);
      let savedBody = null;
      await page.route('**/api/users/*/profile', async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        savedBody = route.request().postDataJSON();
        await fulfillRoute(route, { contentType: 'application/json', body: JSON.stringify({ success: true }) });
      });

      try {
        await waitForAppShell(page);
        await clickSidebarItem(page, 'Settings');
        await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Settings' });
        await dialog.waitFor({ state: 'visible' });
        await dialog.locator('#profile-name').fill('Acceptance Profile');
        await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert(savedBody?.name === 'Acceptance Profile', 'Settings save did not send the edited profile name.');
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'settings-save-success'));
        if (monitor.hasUnexpectedFailures()) scenario.failures.push(...summarizeFailures(monitor.events));
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'settings-save-error', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      const page = await context.newPage();
      const monitor = installPageMonitor(page, {
        ignoreConsole: ['Failed to load resource: the server responded with a status of 500'],
        ignoreResponseFailures: ['/api/users/'],
      });
      await page.route('**/api/users/*/profile', async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        await fulfillRoute(route, {
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Forced profile save failure' }),
        });
      });

      try {
        await waitForAppShell(page);
        await clickSidebarItem(page, 'Settings');
        await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Settings' });
        await dialog.waitFor({ state: 'visible' });
        await dialog.locator('#profile-name').fill('Acceptance Failure');
        await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
        await waitForCondition(async () => /Forced profile save failure/i.test(await page.locator('body').innerText()), { description: 'settings save error' });
        assert(await dialog.isVisible(), 'Settings dialog closed after a failed save.');
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'settings-save-error'));
        if (monitor.hasUnexpectedFailures()) scenario.failures.push(...summarizeFailures(monitor.events));
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'secondary-workflows-desktop', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      const page = await context.newPage();
      const monitor = installPageMonitor(page, { ignoreResponseFailures: ['/api/warehouse/coverage'] });
      await installSecondaryWorkflowMocks(page, user);

      try {
        await waitForAppShell(page);
        for (const [menu, expected, shot] of [
          ['Rank Tracker', /No keywords tracked yet|Tracked Keywords/i, 'rank-tracker'],
          ['Server Logs', /Server Log Analysis/i, 'server-logs'],
          ['Page Indexing', /Hybrid Page Indexing/i, 'page-indexing'],
        ]) {
          await clickSidebarItem(page, menu);
          await waitForCondition(async () => expected.test(await getMainText(page)), { description: menu });
          scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, `secondary-${shot}`));
        }

        await clickSidebarItem(page, 'Sites');
        await waitForCondition(async () => /Workspace sites/i.test(await getMainText(page)), { description: 'workspace sites' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'secondary-sites'));
        await page.getByRole('button', { name: 'Match', exact: true }).click();
        await waitForCondition(async () => /Page reconciliation/i.test(await getMainText(page)), { description: 'reconciliation' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'secondary-reconciliation'));

        await clickSidebarItem(page, 'Dashboard');
        await page.getByRole('button', { name: 'Source data', exact: true }).click();
        await waitForCondition(async () => /Source data/i.test(await getMainText(page)), { description: 'source data' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'secondary-source-data'));

        await clickSidebarItem(page, 'AI Content Auditor');
        await waitForCondition(async () => /AI content auditor/i.test(await getMainText(page)), { description: 'AI content auditor' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'secondary-ai-auditor'));
        if (monitor.hasUnexpectedFailures()) scenario.failures.push(...summarizeFailures(monitor.events));
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'secondary-workflows-mobile', async (scenario) => {
      const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 390, height: 844 } });
      await context.addCookies([{ name: SESSION_COOKIE_NAME, value: token, url: baseUrl }]);
      const page = await context.newPage();
      const monitor = installPageMonitor(page, { ignoreResponseFailures: ['/api/warehouse/coverage'] });
      await installSecondaryWorkflowMocks(page, user);

      try {
        await waitForAppShell(page);
        await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
        await page.getByRole('button', { name: 'Rank Tracker', exact: true }).click();
        await waitForCondition(async () => /No keywords tracked yet|Tracked Keywords/i.test(await getMainText(page)), { description: 'mobile rank tracker' });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Rank Tracker overflowed the mobile viewport.');
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'secondary-mobile-rank-tracker'));

        const mobilePageIndexing = page.getByRole('button', { name: 'Page Indexing', exact: true });
        if (!(await mobilePageIndexing.isVisible().catch(() => false))) {
          await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
        }
        await mobilePageIndexing.click();
        await waitForCondition(async () => /Hybrid Page Indexing/i.test(await getMainText(page)), { description: 'mobile page indexing' });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Page Indexing overflowed the mobile viewport.');
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'secondary-mobile-page-indexing'));
        if (monitor.hasUnexpectedFailures()) scenario.failures.push(...summarizeFailures(monitor.events));
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'gsc-dashboard-live', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      const monitor = installPageMonitor(page);
      const seenDimensions = [];
      let sawDailyQueryCount = false;

      await page.route('**/api/google/gsc/sites', async (route) => {
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify([{ permissionLevel: 'siteOwner', siteUrl: user.activatedSiteUrl }]),
        });
      });

      page.on('request', (request) => {
        if (!request.url().includes('/api/warehouse/query') || request.method() !== 'POST') return;
        const body = parsePostData(request);
        if (Array.isArray(body?.dimensions)) {
          seenDimensions.push(body.dimensions.join('|'));
        }
        if (body?.metric === 'queryCount' && body?.dimensions?.join('|') === 'date') {
          sawDailyQueryCount = true;
        }
      });

      try {
        await waitForAppShell(page);
        await waitForMainToSettle(page);
        const shellText = await page.locator('body').innerText();
        assert(!/Sign in or create an account|Welcome back/i.test(shellText), 'Authenticated session landed on the login shell instead of the dashboard.');
        await clickDashboardSource(page, 'Google Search Console');

        for (const tabName of ['Overview', 'Pages', 'Queries', 'Countries', 'Visible Queries']) {
          await clickTab(page, tabName);
          await page.waitForTimeout(1200);
          scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, `gsc-${tabName}`));
        }

        const mainText = await getMainText(page);
        assert(/Visible Queries by Page|Daily Visible Queries|No data found for this date range\./i.test(mainText), 'Visible Queries tab did not render its chart or empty state.');
        assert(seenDimensions.some((value) => value === 'date'), 'GSC overview did not request date warehouse rows.');
        assert(seenDimensions.some((value) => value === 'page'), 'GSC pages tab did not request page warehouse rows.');
        assert(seenDimensions.some((value) => value === 'query'), 'GSC queries tab did not request query warehouse rows.');
        assert(seenDimensions.some((value) => value === 'country'), 'GSC countries tab did not request country warehouse rows.');
        assert(sawDailyQueryCount, 'GSC visible queries tab did not request daily summary query counts.');

        if (monitor.hasUnexpectedFailures()) {
          scenario.failures.push(...summarizeFailures(monitor.events));
        }
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'bing-dashboard-range', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      const monitor = installPageMonitor(page);
      let requestedRange = null;

      await page.route('**/api/auth/session', async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        payload.profile = { ...payload.profile, bingConnected: true };
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify(payload),
        });
      });

      await page.route('**/api/bing/sites', async (route) => {
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify({ d: [{ Url: user.activatedSiteUrl }] }),
        });
      });

      await page.route('**/api/bing/stats?*', async (route) => {
        const url = new URL(route.request().url());
        requestedRange = {
          endDate: url.searchParams.get('endDate'),
          siteUrl: url.searchParams.get('siteUrl'),
          startDate: url.searchParams.get('startDate'),
        };
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify({
            d: [{ AvgClickPosition: 2.4, AvgImpressionPosition: 4.2, Clicks: 12, Ctr: 0.12, Impressions: 100, Query: 'acceptance bing query' }],
            meta: {
              cache: null,
              fromCache: true,
              range: {
                availableEndDate: requestedRange.endDate,
                availableStartDate: requestedRange.startDate,
                compatibilityBackfill: { dateCount: 0, rowCount: 0, semantics: null },
                factRowCount: 1,
                latestFetchedAt: new Date().toISOString(),
                matchedDateCount: 1,
                mode: 'date-range-aggregate',
                queryCount: 1,
                requestedEndDate: requestedRange.endDate,
                requestedStartDate: requestedRange.startDate,
                semantics: null,
              },
              source: 'dated-facts',
            },
          }),
        });
      });

      try {
        await waitForAppShell(page);
        await waitForMainToSettle(page);
        await clickDashboardSource(page, 'Bing Webmaster');
        await waitForCondition(async () => /acceptance bing query/i.test(await getMainText(page)), { description: 'dated Bing warehouse rows' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'bing-dashboard-range'));

        assert(requestedRange?.siteUrl === user.activatedSiteUrl, 'Bing dashboard did not request the active workspace site.');
        assert(/^\d{4}-\d{2}-\d{2}$/.test(requestedRange?.startDate || ''), 'Bing dashboard did not send a valid startDate.');
        assert(/^\d{4}-\d{2}-\d{2}$/.test(requestedRange?.endDate || ''), 'Bing dashboard did not send a valid endDate.');
        assert(!/Compare/i.test(await getHeaderText(page)), 'Bing dashboard exposed an unsupported comparison control.');

        if (monitor.hasUnexpectedFailures()) {
          scenario.failures.push(...summarizeFailures(monitor.events));
        }
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'source-site-property-switching', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      const monitor = installPageMonitor(page, {
        ignoreConsole: ['Failed to load resource: the server responded with a status of 403'],
        ignoreResponseFailures: ['/api/indexing/auto-sync/status', '/api/rank-tracking/keywords', '/api/warehouse/coverage'],
      });

      const siteA = 'https://avanterrapark.com/';
      const siteB = 'https://www.avancenatur.es/';
      const propertyA = 'properties/529759264';
      const propertyB = 'properties/mock-avancenatur';

      await page.route('**/api/auth/session', async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        payload.profile = {
          ...payload.profile,
          activatedGa4DisplayName: 'avanterrapark.com',
          activatedGa4PropertyId: propertyA,
          activatedSiteUrl: siteA,
          googleConnected: true,
          knownSites: [siteA, siteB],
          onboardingCompleted: true,
          unlockedSites: [siteA, siteB],
        };
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify(payload),
        });
      });

      await page.route('**/api/warehouse/status', async (route) => {
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify([{ siteUrl: siteA }, { siteUrl: siteB }]),
        });
      });

      await page.route('**/api/google/gsc/sites', async (route) => {
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify([
            { permissionLevel: 'siteOwner', siteUrl: siteA },
            { permissionLevel: 'siteOwner', siteUrl: siteB },
          ]),
        });
      });

      await page.route('**/api/google/ga4/properties', async (route) => {
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify([
            {
              account: 'accounts/mock',
              displayName: 'Mock Account',
              name: 'accountSummaries/mock',
              propertySummaries: [
                { displayName: 'avanterrapark.com', property: propertyA, propertyType: 'PROPERTY_TYPE_ORDINARY' },
                { displayName: 'avancenatur.es', property: propertyB, propertyType: 'PROPERTY_TYPE_ORDINARY' },
              ],
            },
          ]),
        });
      });

      await page.route('**/api/warehouse/query', async (route) => {
        const body = route.request().postDataJSON();
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify(gscMockRows(body)),
        });
      });

      await page.route('**/api/warehouse/ga4/report', async (route) => {
        const body = route.request().postDataJSON();
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify({
            metadata: { coverage: ga4MockCoverage(), source: 'mock' },
            rows: ga4MockRows(body),
          }),
        });
      });

      try {
        await waitForAppShell(page);
        await waitForMainToSettle(page);
        const shellText = await page.locator('body').innerText();
        assert(!/Sign in or create an account|Welcome back/i.test(shellText), 'Authenticated session landed on the login shell instead of the dashboard.');

        await clickDashboardSource(page, 'Google Search Console');
        await selectComboboxOption(page, 0, 'avancenatur.es');
        await waitForCondition(async () => /avancenatur\.es/i.test(await getHeaderText(page)), { description: 'mock site switch' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'switching-gsc-site'));

        await clickDashboardSource(page, 'Google Analytics 4');
        await selectComboboxOption(page, 0, 'avancenatur.es');
        await waitForCondition(async () => /Site\s+www\.avancenatur\.es/i.test(await getHeaderText(page)), { description: 'workspace site context update' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'switching-ga4-property'));

        const headerText = await getHeaderText(page);
        assert(/Analytics property/i.test(headerText), 'GA4 property selector did not render during source/property switching.');
        assert(/Site\s+www\.avancenatur\.es/i.test(headerText), 'Switching GA4 property did not update the workspace site context pill.');

        if (monitor.hasUnexpectedFailures()) {
          scenario.failures.push(...summarizeFailures(monitor.events));
        }
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'ga4-dashboard-live', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      const monitor = installPageMonitor(page);
      const seenDimensions = [];

      page.on('request', (request) => {
        if (!request.url().includes('/api/warehouse/ga4/report') || request.method() !== 'POST') return;
        const body = parsePostData(request);
        if (Array.isArray(body?.dimensions)) {
          seenDimensions.push(body.dimensions.join('|'));
        }
      });

      try {
        await waitForAppShell(page);
        await waitForMainToSettle(page);
        const shellText = await page.locator('body').innerText();
        assert(!/Sign in or create an account|Welcome back/i.test(shellText), 'Authenticated session landed on the login shell instead of the dashboard.');
        await clickDashboardSource(page, 'Google Analytics 4');

        for (const tabName of ['Overview', 'Events', 'Pages', 'Traffic', 'Users']) {
          await clickTab(page, tabName);
          await page.waitForTimeout(1500);
          scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, `ga4-${tabName}`));
        }

        const mainText = await getMainText(page);
        assert(/Detailed user data|No data available\.|GA4 .* report is updating|Could not load Analytics report/i.test(mainText), 'GA4 users tab did not render a data, updating, or error surface.');
        assert(seenDimensions.some((value) => value === 'date'), 'GA4 overview did not request date dimensions.');
        assert(seenDimensions.some((value) => value === 'eventName'), 'GA4 events tab did not request eventName dimensions.');
        assert(seenDimensions.some((value) => value === 'pagePath'), 'GA4 pages tab did not request pagePath dimensions.');
        assert(seenDimensions.some((value) => value === 'sessionSourceMedium'), 'GA4 traffic tab did not request sessionSourceMedium dimensions.');
        assert(seenDimensions.some((value) => value === 'country'), 'GA4 users tab did not request country dimensions.');

        if (monitor.hasUnexpectedFailures()) {
          scenario.failures.push(...summarizeFailures(monitor.events));
        }
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'llm-traffic-raw-source', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      const monitor = installPageMonitor(page);

      await page.route('**/api/warehouse/ga4/llm/report', async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          status: 200,
          body: JSON.stringify({
            coverage: { activeJobCount: 0, coveredDateCount: 1, expectedDateCount: 1, missingDateCount: 0 },
            daily: { rows: [{ dimensionValues: [{ value: '20260712' }], metricValues: [{ value: '3' }] }] },
            landingPage: { rows: [{ dimensionValues: [{ value: '/' }, { value: 'chatgpt.com' }, { value: 'ChatGPT' }], metricValues: [{ value: '3' }, { value: '2' }, { value: '1' }, { value: '42' }] }] },
            metadata: { source: 'warehouse' },
            source: { rows: [{ dimensionValues: [{ value: 'chatgpt.com' }, { value: 'ChatGPT' }], metricValues: [{ value: '3' }, { value: '2' }, { value: '1' }, { value: '42' }] }] },
            totals: { rows: [{ metricValues: [{ value: '3' }, { value: '2' }, { value: '1' }, { value: '42' }] }] },
          }),
        });
      });

      try {
        await waitForAppShell(page);
        await clickSidebarItem(page, 'LLM Traffic');
        await waitForCondition(async () => /Traffic by LLM referral source/i.test(await getMainText(page)), { description: 'LLM traffic source table' });
        const mainText = await getMainText(page);
        assert(/Provider/i.test(mainText), 'LLM traffic table did not render the provider column.');
        assert(/Referral source/i.test(mainText), 'LLM traffic table did not render the raw source column.');
        assert(/ChatGPT/i.test(mainText) && /chatgpt\.com/i.test(mainText), 'LLM traffic table did not preserve provider and exact source values.');
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'llm-traffic-raw-source'));

        if (monitor.hasUnexpectedFailures()) {
          scenario.failures.push(...summarizeFailures(monitor.events));
        }
      } finally {
        await context.close();
      }
    });
    await runScenario(report, 'crawl-inventory-live', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      const monitor = installPageMonitor(page);

      try {
        await waitForAppShell(page);
        await clickSidebarItem(page, 'Crawl Inventory');
        await waitForCondition(async () => {
          const text = await getMainText(page);
          return /No crawl yet|Start fresh crawl|Latest crawl|No crawl has been started|Loading crawl inventory/i.test(text);
        }, { description: 'crawl inventory view' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'crawl-inventory-live'));

        const mainText = await getMainText(page);
        assert(/Start fresh crawl|Current crawl|No crawl has been started for this site yet\.|No crawl rows yet|Page \d+ of \d+/i.test(mainText), 'Crawl Inventory did not render its primary summary or table state.');

        if (monitor.hasUnexpectedFailures()) {
          scenario.failures.push(...summarizeFailures(monitor.events));
        }
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'internal-links-live', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      const monitor = installPageMonitor(page);

      try {
        await waitForAppShell(page);
        await clickSidebarItem(page, 'Internal Links');
        await waitForCondition(async () => {
          const text = await getMainText(page);
          return /Internal links|Loading recommendations|Run analysis after a fresh crawl|Queue position|Built-in BGE-M3|Ollama judge/i.test(text);
        }, { description: 'internal links view' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'internal-links-live'));

        const mainText = await getMainText(page);
        assert(/Run analysis after a fresh crawl|Queue position|Built-in BGE-M3|Estimated workload|internal link/i.test(mainText), 'Internal Links did not render recommendations, queue, or empty-state content.');

        if (monitor.hasUnexpectedFailures()) {
          scenario.failures.push(...summarizeFailures(monitor.events));
        }
      } finally {
        await context.close();
      }
    });

    await runScenario(report, 'state-coverage-loading-error-empty', async (scenario) => {
      const context = await createAuthedContext(browser, baseUrl, token);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      const monitor = installPageMonitor(page, {
        ignoreConsole: ['Forced GA4 acceptance failure', 'Failed to load resource: the server responded with a status of 500'],
        ignoreResponseFailures: ['/api/warehouse/ga4/report'],
      });

      const emptyQueue = queuePayload();

      await page.route('**/api/warehouse/query', async (route) => {
        const body = route.request().postDataJSON();
        if (Array.isArray(body?.dimensions) && body.dimensions.join('|') === 'page') {
          await new Promise((resolve) => setTimeout(resolve, 1800));
        }
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify(gscMockRows(body)),
        });
      });

      try {
        await waitForAppShell(page);
        await clickDashboardSource(page, 'Google Search Console');
        await clickTab(page, 'Pages');
        await waitForCondition(async () => /Loading stored page data/i.test(await getMainText(page)), { description: 'GSC loading state' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'state-loading-gsc-pages'));
      } finally {
        await page.unroute('**/api/warehouse/query');
      }

      await page.route('**/api/warehouse/ga4/report', async (route) => {
        const body = route.request().postDataJSON();
        if (Array.isArray(body?.dimensions) && body.dimensions.includes('eventName')) {
          await fulfillRoute(route, {
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Forced GA4 acceptance failure' }),
          });
          return;
        }
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify({
            metadata: { coverage: ga4MockCoverage(), source: 'mock' },
            rows: ga4MockRows(body),
          }),
        });
      });

      try {
        await clickDashboardSource(page, 'Google Analytics 4');
        await clickTab(page, 'Events');
        await waitForCondition(async () => /Could not load Analytics report|Forced GA4 acceptance failure/i.test(await getMainText(page)), { description: 'GA4 error state' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'state-error-ga4-events'));
      } finally {
        await page.unroute('**/api/warehouse/ga4/report');
      }

      await page.route('**/api/crawl/jobs**', async (route) => {
        await fulfillRoute(route, { contentType: 'application/json', body: JSON.stringify({ jobs: [], queue: emptyQueue }) });
      });
      await page.route('**/api/crawl/status**', async (route) => {
        await fulfillRoute(route, { contentType: 'application/json', body: JSON.stringify({ job: null, queue: emptyQueue, summary: null }) });
      });
      await page.route('**/api/crawl/pages**', async (route) => {
        const url = new URL(route.request().url());
        const limit = Number(url.searchParams.get('limit') || 50);
        const offset = Number(url.searchParams.get('offset') || 0);
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify({
            job: null,
            page: { limit, offset, total: 0 },
            queue: emptyQueue,
            rows: [],
            summary: null,
          }),
        });
      });
      await page.route('**/api/crawl/compare**', async (route) => {
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify({
            baseJob: null,
            compareJob: null,
            samples: { canonicalChanged: [], missing: [], new: [], statusChanged: [], titleChanged: [] },
            summary: { canonicalChanged: 0, missing: 0, new: 0, statusChanged: 0, titleChanged: 0, unchanged: 0 },
          }),
        });
      });

      try {
        await clickSidebarItem(page, 'Crawl Inventory');
        await waitForCondition(async () => /No crawl has been started for this site yet\.|Automatic crawl collection is being prepared for this site\./i.test(await getMainText(page)), { description: 'crawl empty state' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'state-empty-crawl'));
      } finally {
        await page.unroute('**/api/crawl/jobs**');
        await page.unroute('**/api/crawl/status**');
        await page.unroute('**/api/crawl/pages**');
        await page.unroute('**/api/crawl/compare**');
      }

      await page.route('**/api/internal-links/jobs**', async (route) => {
        await fulfillRoute(route, { contentType: 'application/json', body: JSON.stringify({ jobs: [], queue: emptyQueue }) });
      });
      await page.route('**/api/internal-links/opportunities**', async (route) => {
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify({
            job: null,
            meta: {
              folders: [],
              message: null,
              totals: { highPriority: 0, implemented: 0, opportunities: 0, ready: 0, stale: 0 },
            },
            page: { filteredTotal: 0, limit: 200, offset: 0, total: 0 },
            queue: emptyQueue,
            rows: [],
          }),
        });
      });
      await page.route('**/api/internal-links/estimate', async (route) => {
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify({
            estimate: {
              crawlJobId: '',
              embeddingModel: 'BAAI/bge-m3',
              embeddingProvider: 'local',
              estimatedEmbeddingTokens: 0,
              estimatedHostedEmbeddingCost: 0,
              estimatedHostedReviewCost: 0,
              estimatedLocalUnits: 0,
              estimatedReviewTokens: 0,
              maxPages: 250,
              maxRecommendations: 100,
              maxSentencesPerPage: 5,
              reviewModel: 'rules-editorial-v1',
              reviewProvider: 'local',
              totalHostedCost: 0,
              vectorStore: {
                available: false,
                dimensions: null,
                indexed: false,
                provider: 'json-cache',
                reason: 'mock',
              },
            },
            success: true,
          }),
        });
      });
      await page.route('**/api/internal-links/provider-settings', async (route) => {
        await fulfillRoute(route, { contentType: 'application/json', body: JSON.stringify({ settings: [] }) });
      });
      await page.route('**/api/internal-links/provider-status**', async (route) => {
        await fulfillRoute(route, {
          contentType: 'application/json',
          body: JSON.stringify({
            status: {
              available: true,
              baseUrl: 'http://127.0.0.1:8091',
              dimensions: 1024,
              message: 'Mock provider ready',
              model: 'BAAI/bge-m3',
              modelAvailable: true,
            },
            success: true,
          }),
        });
      });
      await page.route('**/api/crawl/status**', async (route) => {
        await fulfillRoute(route, { contentType: 'application/json', body: JSON.stringify({ job: null, queue: emptyQueue, summary: null }) });
      });

      try {
        await clickSidebarItem(page, 'Internal Links');
        await waitForCondition(async () => /Start a fresh crawl to collect the sentence context needed for recommendations\.|No recommendations are available yet\. Choose Analyze site to generate them from the latest crawl\./i.test(await getMainText(page)), { description: 'internal links empty state' });
        scenario.screenshots.push(await screenshot(page, ARTIFACT_DIR, 'state-empty-internal-links'));
      } finally {
        await page.unroute('**/api/internal-links/jobs**');
        await page.unroute('**/api/internal-links/opportunities**');
        await page.unroute('**/api/internal-links/estimate');
        await page.unroute('**/api/internal-links/provider-settings');
        await page.unroute('**/api/internal-links/provider-status**');
        await page.unroute('**/api/crawl/status**');
      }

      if (monitor.hasUnexpectedFailures()) {
        scenario.failures.push(...summarizeFailures(monitor.events));
      }

      await context.close();
    });
  } finally {
    if (browser) {
      await browser.close();
    }
    await db.close?.();
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  const failureReport = {
    artifactDir: ARTIFACT_DIR,
    failures: [error?.stack || error?.message || String(error)],
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(failureReport, null, 2));
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
