import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function sanitizeFilePart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'artifact';
}

export function createArtifactDir(prefix = 'browser-acceptance') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve('.tmp', `${prefix}-${stamp}`);
  ensureDir(dir);
  return dir;
}

export async function launchAcceptanceBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--no-sandbox'],
  });
}

export async function screenshot(page, artifactDir, name, options = {}) {
  const filePath = path.join(artifactDir, `${sanitizeFilePart(name)}.png`);
  await page.screenshot({ path: filePath, fullPage: true, ...options });
  return filePath;
}

function shouldIgnore(url, patterns = []) {
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(url);
    return url.includes(pattern);
  });
}

export function installPageMonitor(page, options = {}) {
  const {
    ignoreConsole = [],
    ignoreRequestFailures = [],
    ignoreResponseFailures = [],
  } = options;
  const events = {
    consoleErrors: [],
    requestFailures: [],
    responseFailures: [],
  };

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (shouldIgnore(text, ignoreConsole)) return;
    events.consoleErrors.push({ text, location: message.location() });
  });

  page.on('requestfailed', (request) => {
    const url = request.url();
    if (shouldIgnore(url, ignoreRequestFailures)) return;
    events.requestFailures.push({
      method: request.method(),
      url,
      failureText: request.failure()?.errorText || 'unknown',
    });
  });

  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('/api/')) return;
    if (response.status() < 400) return;
    if (shouldIgnore(url, ignoreResponseFailures)) return;
    events.responseFailures.push({
      method: response.request().method(),
      status: response.status(),
      url,
    });
  });

  return {
    events,
    hasUnexpectedFailures() {
      return events.consoleErrors.length > 0 || events.requestFailures.length > 0 || events.responseFailures.length > 0;
    },
  };
}

export async function findWorkingBaseUrl(candidates) {
  for (const candidate of candidates) {
    try {
      const response = await fetch(new URL('/api/health', candidate), { redirect: 'manual' });
      if (response.ok) return candidate.replace(/\/+$/, '');
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

export async function waitForCondition(fn, options = {}) {
  const {
    timeoutMs = 20000,
    intervalMs = 250,
    description = 'condition',
  } = options;
  const start = Date.now();

  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForTextState(page, states, options = {}) {
  const result = await waitForCondition(async () => {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    for (const state of states) {
      if (state.pattern.test(bodyText)) {
        return { state: state.name, bodyText };
      }
    }
    return null;
  }, options);

  return result;
}

export async function clickSidebarItem(page, name) {
  await page.getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}$`, 'i') }).click();
}

export async function clickDashboardSource(page, label) {
  const sourceButton = page.locator('header button:visible').filter({ hasText: new RegExp(escapeRegExp(label), 'i') }).first();
  if (await sourceButton.count()) {
    await sourceButton.click();
    return;
  }
  const headerText = await page.locator('header').innerText().catch(() => '');
  if (!new RegExp(escapeRegExp(label), 'i').test(headerText)) {
    throw new Error(`Dashboard source control not found: ${label}`);
  }
}

export async function openCombobox(page, index = 0) {
  await page.getByRole('combobox').nth(index).click();
}

export async function chooseComboboxOption(page, optionName) {
  const option = page.getByRole('option', { name: new RegExp(escapeRegExp(optionName), 'i') }).first();
  await option.click();
}

export async function selectComboboxOption(page, index, optionName) {
  await openCombobox(page, index);
  await chooseComboboxOption(page, optionName);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function summarizeFailures(events) {
  return [
    ...events.consoleErrors.map((entry) => `console error: ${entry.text}`),
    ...events.requestFailures.map((entry) => `request failed: ${entry.method} ${entry.url} (${entry.failureText})`),
    ...events.responseFailures.map((entry) => `api failure: ${entry.method} ${entry.url} -> ${entry.status}`),
  ];
}
