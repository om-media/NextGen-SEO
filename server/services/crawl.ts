import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { canonicalPageKey, resolvedCanonicalPageKey } from '../reporting/url.js';
import type { AppDatabase } from '../database.js';
import { queueCompletedCrawlAnalysis } from './pageAnalysis.js';
import type { Browser } from 'puppeteer';

type CrawlRules = {
  allowPaths: string[];
  disallowPaths: string[];
  sitemaps: string[];
};

type CrawlUrlOptions = {
  includeQueryStrings: boolean;
};

const CRAWL_SENTENCE_EXTRACTION_VERSION = 3;

type CrawlRegionRole =
  | 'header'
  | 'navigation'
  | 'breadcrumb'
  | 'hero'
  | 'table_of_contents'
  | 'main'
  | 'section'
  | 'sidebar'
  | 'faq'
  | 'comparison'
  | 'product_grid'
  | 'tool'
  | 'form'
  | 'related_content'
  | 'cta'
  | 'footer'
  | 'unknown';

type CrawlPageType =
  | 'article'
  | 'comparison'
  | 'faq'
  | 'product'
  | 'tool'
  | 'category'
  | 'landing'
  | 'unknown';

type CrawlLinkSnapshot = {
  anchorText: string | null;
  blockType: string;
  contextText: string | null;
  regionRole: CrawlRegionRole;
  url: string;
  visualProminence: number;
};

type CrawlTextBlockSnapshot = {
  blockIndex: number;
  blockKey: string;
  blockType: string;
  boilerplateScore: number;
  domPath: string;
  extractionVersion: number;
  headingChainJson: string;
  linkDensity: number;
  regionIndex: number;
  regionRole: CrawlRegionRole;
  selector: string;
  text: string;
  textDensity: number;
  textHash: string;
};

type CrawlSentenceSnapshot = {
  blockIndex: number;
  blockKey: string;
  blockType: string;
  boilerplateScore: number;
  extractionVersion: number;
  headingText: string | null;
  linkDensity: number;
  pageType: CrawlPageType;
  paragraphIndex: number;
  regionIndex: number;
  regionRole: CrawlRegionRole;
  sentenceIndex: number;
  sentenceText: string;
  textHash: string;
  visualProminence: number;
};

type CrawlRegionSnapshot = {
  regionIndex: number;
  regionRole: CrawlRegionRole;
  selector: string;
  domPath: string;
};

export type CrawlJobRecord = {
  attemptCount: number | null;
  canonicalMetricsVersion: number | null;
  completedAt: string | null;
  crawledCount: number;
  discoveredCount: number;
  errorCount: number;
  id: string;
  jobId?: string;
  lastError: string | null;
  includeQueryStrings: number | null;
  lockedAt: string | null;
  maxDepth: number | null;
  maxAttempts: number | null;
  maxPages: number | null;
  nextRunAt: string | null;
  ownerId: string;
  queuedCount: number;
  renderMode: string | null;
  respectRobots: number | null;
  sitemapUrl: string | null;
  skippedCount: number;
  siteUrl: string;
  startedAt: string | null;
  startUrl: string | null;
  status: string;
  updatedAt: string | null;
  userAgent: string | null;
};

export type CrawlPageRecord = {
  canonicalUrl: string | null;
  contentType: string | null;
  crawledAt: string | null;
  depth: number;
  discoveredAt: string | null;
  discoveredFrom: string | null;
  discoveredFromUrl: string | null;
  errorMessage: string | null;
  finalUrl: string | null;
  h1Count: number;
  h1Text: string | null;
  h2Count: number;
  inboundLinkCount?: number;
  internalLinkCount: number;
  jobId: string;
  metaDescription: string | null;
  noindex: number;
  normalizedUrl: string;
  outgoingLinkCount: number;
  pageKey: string;
  resolvedCanonicalPageKey: string;
  responseTimeMs: number | null;
  ownerId: string;
  siteUrl: string;
  statusCode: number | null;
  title: string | null;
  url: string;
  wordCount: number;
};

export type CrawlLinkRecord = {
  depth: number;
  discoveredAt: string | null;
  anchorText: string | null;
  contextText: string | null;
  fromPageKey: string;
  fromUrl: string;
  jobId: string;
  ownerId: string;
  siteUrl: string;
  toPageKey: string;
  toUrl: string;
};

export type CrawlSummary = {
  canonicalizedPages: number;
  errorPages: number;
  missingMetaPages: number;
  missingTitlePages: number;
  noindexPages: number;
  orphanPages: number;
  redirectPages: number;
  successPages: number;
  totalPages: number;
};

export type CrawlStatusResponse = {
  job: CrawlJobRecord | null;
  summary: CrawlSummary | null;
};

export type CrawlJobListResponse = {
  jobs: CrawlJobRecord[];
};

export type CrawlPageListResponse = {
  job: CrawlJobRecord | null;
  page: {
    limit: number;
    offset: number;
    total: number;
  };
  rows: CrawlPageRecord[];
  summary: CrawlSummary | null;
};

export type CrawlLinkListResponse = {
  job: CrawlJobRecord | null;
  page: {
    limit: number;
    offset: number;
    total: number;
  };
  rows: CrawlLinkRecord[];
};

export type CrawlCompareResponse = {
  baseJob: CrawlJobRecord | null;
  compareJob: CrawlJobRecord | null;
  samples: {
    canonicalChanged: Array<{ currentCanonical: string | null; previousCanonical: string | null; url: string }>;
    missing: Array<{ url: string }>;
    new: Array<{ url: string }>;
    statusChanged: Array<{ currentStatus: number | null; previousStatus: number | null; url: string }>;
    titleChanged: Array<{ currentTitle: string | null; previousTitle: string | null; url: string }>;
  };
  summary: {
    canonicalChanged: number;
    missing: number;
    new: number;
    statusChanged: number;
    titleChanged: number;
    unchanged: number;
  };
};

export type StartCrawlInput = {
  includeQueryStrings?: boolean;
  maxDepth?: number;
  maxPages?: number;
  renderMode?: 'html' | 'javascript';
  respectRobots?: boolean;
  sitemapUrl?: string | null;
  siteUrl: string;
  startUrl: string;
  userAgent?: string | null;
};

export type CrawlIssueFilter =
  | 'all'
  | 'issues'
  | 'success'
  | 'redirect'
  | 'error'
  | 'no_response'
  | 'noindex'
  | 'orphan'
  | 'missing_title'
  | 'missing_meta'
  | 'canonicalized';

type CrawlQueueItem = {
  depth: number;
  discoveredFrom: string;
  discoveredFromUrl: string | null;
  discoveredAt: string;
  url: string;
};

type ClaimedCrawlJobRecord = CrawlJobRecord & {
  lockedAt: string;
};

type CrawlJobProgressSnapshot = Pick<
  CrawlJobRecord,
  'crawledCount' | 'discoveredCount' | 'errorCount' | 'queuedCount' | 'skippedCount'
>;

const DEFAULT_CRAWL_PAGE_CONCURRENCY = 4;
const DEFAULT_CRAWL_JOB_WORKERS = 2;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_PAGES = 25000;
const DEFAULT_MAX_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 15000;
const RENDER_TIMEOUT_MS = 30000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_SITEMAP_URLS = 50000;
const CRAWLER_USER_AGENT = 'NextGenSEO-Crawler/1.0';
const DEFAULT_CRAWL_QUEUE_POLL_MS = 5000;
const DEFAULT_CRAWL_RUNNING_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CRAWL_HEARTBEAT_MS = 30000;
const CRAWL_PROGRESS_BATCH_SIZE = 5;
const CRAWL_SQLITE_CLAIM_BATCH_SIZE = 12;
let crawlSqliteClaimTail: Promise<void> = Promise.resolve();

async function withCrawlSqliteClaimLock<T>(callback: () => Promise<T>): Promise<T> {
  const previous = crawlSqliteClaimTail;
  let release!: () => void;
  crawlSqliteClaimTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}
let renderBrowserPromise: Promise<Browser> | null = null;
let crawlTextBlocksSupportsBlockKey: boolean | null = null;
let crawlSentencesSupportsBlockKey: boolean | null = null;

class CrawlCancelledError extends Error {
  constructor() {
    super('Crawl cancelled by user.');
    this.name = 'CrawlCancelledError';
  }
}

class CrawlLeaseLostError extends Error {
  constructor() {
    super('Crawl worker lease was lost.');
    this.name = 'CrawlLeaseLostError';
  }
}

function getCrawlProgressSnapshot(
  seen: Set<string>,
  queue: CrawlQueueItem[],
  nextIndex: number,
  counters: { crawledCount: number; errorCount: number; skippedCount: number },
): CrawlJobProgressSnapshot {
  return {
    crawledCount: counters.crawledCount,
    discoveredCount: seen.size,
    errorCount: counters.errorCount,
    queuedCount: Math.max(0, queue.length - nextIndex),
    skippedCount: counters.skippedCount,
  };
}

function attachCrawlProgressSnapshot<T>(error: T, snapshot: CrawlJobProgressSnapshot): T {
  if (error && typeof error === 'object') {
    Object.assign(error as Record<string, unknown>, { crawlProgressSnapshot: snapshot });
  }
  return error;
}

function readCrawlProgressSnapshot(error: unknown): CrawlJobProgressSnapshot | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const candidate = (error as { crawlProgressSnapshot?: CrawlJobProgressSnapshot }).crawlProgressSnapshot;
  if (!candidate) {
    return null;
  }
  return {
    crawledCount: toFiniteNumber(candidate.crawledCount),
    discoveredCount: toFiniteNumber(candidate.discoveredCount),
    errorCount: toFiniteNumber(candidate.errorCount),
    queuedCount: toFiniteNumber(candidate.queuedCount),
    skippedCount: toFiniteNumber(candidate.skippedCount),
  };
}

const toFiniteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const toBoundedInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
};

const getCrawlPageConcurrency = () =>
  toBoundedInteger(process.env.CRAWL_PAGE_CONCURRENCY, DEFAULT_CRAWL_PAGE_CONCURRENCY, 1, 16);

const getCrawlJobWorkerCount = () =>
  toBoundedInteger(process.env.CRAWL_JOB_CONCURRENCY ?? process.env.CRAWL_JOB_WORKERS, DEFAULT_CRAWL_JOB_WORKERS, 1, 16);

const getCrawlQueuePollMs = () =>
  toBoundedInteger(process.env.CRAWL_QUEUE_POLL_MS, DEFAULT_CRAWL_QUEUE_POLL_MS, 250, 60000);

const getCrawlRunningLockTimeoutMs = () =>
  toBoundedInteger(process.env.CRAWL_LOCK_TIMEOUT_MS, DEFAULT_CRAWL_RUNNING_LOCK_TIMEOUT_MS, 30000, 60 * 60 * 1000);

const getCrawlHeartbeatIntervalMs = () => {
  const lockTimeoutMs = getCrawlRunningLockTimeoutMs();
  const fallback = Math.max(1000, Math.min(DEFAULT_CRAWL_HEARTBEAT_MS, Math.floor(lockTimeoutMs / 3)));
  return Math.max(1000, Math.min(lockTimeoutMs - 1000, toBoundedInteger(process.env.CRAWL_HEARTBEAT_MS, fallback, 1000, lockTimeoutMs)));
};

const nowIso = () => new Date().toISOString();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function stripWww(hostname: string) {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

function isInternalHost(candidateHost: string, startHost: string) {
  const normalizedCandidate = stripWww(candidateHost);
  const normalizedStart = stripWww(startHost);
  return normalizedCandidate === normalizedStart;
}

function normalizePathname(pathname: string) {
  const trimmed = String(pathname || '/').trim().split('#')[0].split('?')[0] || '/';
  if (trimmed === '/') return '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

function normalizeAbsoluteUrl(candidate: string, baseUrl: string, options: CrawlUrlOptions = { includeQueryStrings: false }) {
  const raw = String(candidate || '').trim();
  if (!raw) return null;
  if (/^(javascript:|mailto:|tel:|data:)/i.test(raw)) return null;
  if (raw.startsWith('#')) return null;

  try {
    const url = new URL(raw, baseUrl);
    if (!/^https?:$/i.test(url.protocol)) return null;
    url.hash = '';
    if (!options.includeQueryStrings) {
      url.search = '';
    }
    url.hostname = url.hostname.toLowerCase();
    url.pathname = normalizePathname(url.pathname);
    return url.toString();
  } catch {
    return null;
  }
}

function buildPageKey(value: string, siteUrl: string) {
  return canonicalPageKey(value, isHttpUrl(siteUrl) ? siteUrl : undefined);
}

async function fetchText(url: string, init: RequestInit = {}, userAgent = CRAWLER_USER_AGENT) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        'user-agent': userAgent,
        ...(init.headers || {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function getRenderBrowser() {
  if (!renderBrowserPromise) {
    renderBrowserPromise = import('puppeteer').then(({ default: puppeteer }) => puppeteer.launch({
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      headless: true,
    }));
  }

  return renderBrowserPromise;
}

async function renderPageHtml(url: string, userAgent: string) {
  const browser = await getRenderBrowser();
  const page = await browser.newPage();
  const startedAt = Date.now();

  try {
    await page.setUserAgent(userAgent);
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['font', 'image', 'media'].includes(resourceType)) {
        void request.abort();
        return;
      }
      void request.continue();
    });

    const response = await page.goto(url, {
      timeout: RENDER_TIMEOUT_MS,
      waitUntil: 'networkidle2',
    });

    if (!response) {
      throw new Error('Browser render produced no document response.');
    }

    const headers = response.headers();
    return {
      contentType: headers['content-type'] || 'text/html',
      finalUrl: page.url() || response.url() || url,
      headers,
      html: await page.content(),
      responseTimeMs: Date.now() - startedAt,
      statusCode: response.status(),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchRobotsRules(startUrl: string, userAgent: string): Promise<CrawlRules> {
  const rules: CrawlRules = { allowPaths: [], disallowPaths: [], sitemaps: [] };
  try {
    const robotsUrl = new URL('/robots.txt', startUrl).toString();
    const response = await fetchText(robotsUrl, {}, userAgent);
    if (!response.ok) return rules;
    const text = await response.text();
    const lines = text.split(/\r?\n/);
    let active = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const [keyRaw, ...rest] = trimmed.split(':');
      const key = keyRaw.trim().toLowerCase();
      const value = rest.join(':').trim();

      if (key === 'user-agent') {
        active = value === '*';
        continue;
      }

      if (!active) continue;

      if (key === 'allow' && value) {
        rules.allowPaths.push(value);
      } else if (key === 'disallow' && value) {
        rules.disallowPaths.push(value);
      } else if (key === 'sitemap' && value) {
        rules.sitemaps.push(value);
      }
    }
  } catch {
    return rules;
  }
  return rules;
}

function isPathAllowed(pathname: string, rules: CrawlRules) {
  const allowMatch = rules.allowPaths
    .filter((rule) => pathname.startsWith(rule))
    .sort((a, b) => b.length - a.length)[0];
  const disallowMatch = rules.disallowPaths
    .filter((rule) => pathname.startsWith(rule))
    .sort((a, b) => b.length - a.length)[0];

  if (allowMatch && disallowMatch) {
    return allowMatch.length >= disallowMatch.length;
  }

  if (allowMatch) return true;
  if (disallowMatch) return false;
  return true;
}

async function collectSitemapUrls(startUrl: string, sitemapUrl: string | null | undefined, options: CrawlUrlOptions & { respectRobots: boolean; userAgent: string }) {
  const robotsRules = await fetchRobotsRules(startUrl, options.userAgent);
  const rules = options.respectRobots ? robotsRules : { allowPaths: [], disallowPaths: [], sitemaps: robotsRules.sitemaps };
  const discovered = new Set<string>();
  const queue: string[] = [];

  const addCandidate = (candidate: string | null | undefined) => {
    if (!candidate) return;
    const normalized = normalizeAbsoluteUrl(candidate, startUrl, options);
    if (!normalized || discovered.has(normalized)) return;
    discovered.add(normalized);
    queue.push(normalized);
  };

  addCandidate(sitemapUrl || null);
  for (const candidate of robotsRules.sitemaps) {
    addCandidate(candidate);
  }
  addCandidate(new URL('/sitemap.xml', startUrl).toString());

  const urls = new Set<string>();
  const visitedSitemaps = new Set<string>();

  while (queue.length > 0 && urls.size < MAX_SITEMAP_URLS) {
    const current = queue.shift()!;
    if (visitedSitemaps.has(current)) continue;
    visitedSitemaps.add(current);

    try {
      const response = await fetchText(current, {}, options.userAgent);
      if (!response.ok) continue;
      const xml = await response.text();
      const $ = cheerio.load(xml, { xmlMode: true });

      if ($('sitemapindex').length > 0) {
        $('sitemapindex sitemap loc').each((_, element) => {
          const loc = $(element).text().trim();
          const normalized = normalizeAbsoluteUrl(loc, current, options);
          if (normalized && !visitedSitemaps.has(normalized)) {
            queue.push(normalized);
          }
        });
        continue;
      }

      $('urlset url loc').each((_, element) => {
        const loc = $(element).text().trim();
        const normalized = normalizeAbsoluteUrl(loc, current, options);
        if (normalized) {
          urls.add(normalized);
        }
      });
    } catch {
      continue;
    }
  }

  return { rules, urls: Array.from(urls) };
}

function cleanText(value: string, maxLength = 320) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function hashText(value: string) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function clampScore(value: number) {
  return Math.max(0, Math.min(1, value));
}

function splitSentences(text: string) {
  return cleanText(text, 2400)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((sentence) => cleanText(sentence, 420))
    .filter((sentence) => sentence.length >= 55 && sentence.split(/\s+/).length >= 8);
}

function normalizedSemanticTokens($: cheerio.CheerioAPI, element: any) {
  const tag = String((element as { tagName?: string } | undefined)?.tagName || 'div').toLowerCase();
  const role = String($(element).attr('role') || '').toLowerCase();
  const id = String($(element).attr('id') || '').toLowerCase();
  const className = String($(element).attr('class') || '').toLowerCase();
  const ariaLabel = String($(element).attr('aria-label') || '').toLowerCase();
  const dataRegion = String($(element).attr('data-region') || '').toLowerCase();
  const signal = [tag, role, id, className, ariaLabel, dataRegion].join(' ');
  const tokens = new Set(signal.split(/[^a-z0-9]+/).filter(Boolean));
  return { signal, tag, tokens, role };
}

function hasSemanticPhrase(tokens: Set<string>, ...phrase: string[]) {
  return phrase.every((token) => tokens.has(token));
}

function hasSemanticHint(signal: string, tokens: Set<string>, hints: string[]) {
  return hints.some((hint) => {
    if (hint.includes(' ')) {
      return hasSemanticPhrase(tokens, ...hint.split(' '));
    }
    return tokens.has(hint) || signal.includes(hint);
  });
}

function inferRegionRole($: cheerio.CheerioAPI, element: any): CrawlRegionRole {
  const { role, signal, tag, tokens } = normalizedSemanticTokens($, element);

  if (tag === 'footer' || role === 'contentinfo' || hasSemanticHint(signal, tokens, ['footer', 'site footer'])) return 'footer';
  if (hasSemanticHint(signal, tokens, ['breadcrumb', 'breadcrumbs'])) return 'breadcrumb';
  if (tag === 'aside' || role === 'complementary' || hasSemanticHint(signal, tokens, ['sidebar', 'rail', 'aside'])) return 'sidebar';
  if (hasSemanticHint(signal, tokens, ['table of contents', 'toc', 'contents', 'jump links'])) return 'table_of_contents';
  if (hasSemanticHint(signal, tokens, ['faq', 'faqs', 'questions', 'accordion'])) return 'faq';
  if (hasSemanticHint(signal, tokens, ['comparison', 'compare', 'versus', 'vs'])) return 'comparison';
  if (hasSemanticHint(signal, tokens, ['product grid', 'product list', 'products', 'catalog', 'collection grid'])) return 'product_grid';
  if (hasSemanticHint(signal, tokens, ['calculator', 'estimator', 'configurator', 'tool', 'widget'])) return 'tool';
  if (tag === 'form' || hasSemanticHint(signal, tokens, ['form', 'contact form', 'newsletter', 'signup', 'sign up', 'quote form'])) return 'form';
  if (hasSemanticHint(signal, tokens, ['related', 'recommended', 'similar', 'popular'])) return 'related_content';
  if (hasSemanticHint(signal, tokens, ['cta', 'call to action', 'get started', 'book demo', 'request quote', 'contact sales'])) return 'cta';
  if (tag === 'header' || role === 'banner' || hasSemanticHint(signal, tokens, ['header'])) return 'header';
  if (hasSemanticHint(signal, tokens, ['hero', 'masthead', 'intro', 'eyebrow'])) return 'hero';
  if (tag === 'nav' || role === 'navigation' || hasSemanticHint(signal, tokens, ['navigation', 'nav', 'menu'])) return 'navigation';
  if (tag === 'main' || role === 'main') return 'main';
  if (tag === 'section' || tag === 'article') return 'section';
  if (tag === 'body') return 'main';
  return 'unknown';
}

function inferPageType($: cheerio.CheerioAPI): CrawlPageType {
  const title = cleanText($('title').first().text(), 220).toLowerCase();
  const h1 = cleanText($('h1').first().text(), 220).toLowerCase();
  const body = cleanText($('main, article, body').first().text(), 2400).toLowerCase();
  const combined = [title, h1, body].join(' ');
  if (/\bfaq\b|frequently asked|common questions/.test(combined)) return 'faq';
  if (/\bcompare\b|\bcomparison\b|\bversus\b|\bvs\b/.test(combined)) return 'comparison';
  if (/\bcalculator\b|\bestimator\b|\btool\b|\bconfigurator\b/.test(combined)) return 'tool';
  if (/\bproducts\b|\bcollection\b|\bcatalog\b|shop all/.test(combined)) return 'category';
  if (/\bpricing\b|\bbook demo\b|\bget started\b|\brequest quote\b/.test(combined)) return 'landing';
  if ($('article').length > 0 || $('main h2, main h3, article h2, article h3').length >= 2) return 'article';
  if (/\bproduct\b/.test(combined)) return 'product';
  return 'unknown';
}

function buildSelectorToken(raw: string) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildSelector($: cheerio.CheerioAPI, element: any) {
  const { tag } = normalizedSemanticTokens($, element);
  const id = buildSelectorToken(String($(element).attr('id') || ''));
  const classTokens = String($(element).attr('class') || '')
    .split(/\s+/)
    .map(buildSelectorToken)
    .filter(Boolean)
    .slice(0, 2);
  return `${tag}${id ? `#${id}` : ''}${classTokens.map((token) => `.${token}`).join('')}`;
}

function buildBlockKey(regionRole: CrawlRegionRole, domPath: string, selector: string, headingChain: string[]) {
  const normalizedHeadingChain = headingChain.map((entry) => cleanText(entry, 180).toLowerCase()).join(' > ');
  return `blk_${hashText([regionRole, domPath.toLowerCase(), selector.toLowerCase(), normalizedHeadingChain].join('|')).slice(0, 20)}`;
}

function nthOfType($: cheerio.CheerioAPI, element: any) {
  const tagName = String((element as { tagName?: string } | undefined)?.tagName || '').toLowerCase();
  if (!tagName) return 1;
  const siblings = $(element).parent().children(tagName).toArray();
  const index = siblings.findIndex((candidate) => candidate === element);
  return index >= 0 ? index + 1 : 1;
}

function buildDomPath($: cheerio.CheerioAPI, element: any) {
  const nodes = $(element).parents().toArray().reverse().concat([element]);
  return nodes
    .filter((node) => ['html', 'body', 'main', 'header', 'nav', 'section', 'article', 'aside', 'footer', 'div', 'form', 'ul', 'ol', 'li'].includes(String((node as { tagName?: string } | undefined)?.tagName || '').toLowerCase()))
    .map((node) => {
      const tag = String((node as { tagName?: string } | undefined)?.tagName || 'div').toLowerCase();
      const id = buildSelectorToken(String($(node).attr('id') || ''));
      return `${tag}${id ? `#${id}` : `:nth-of-type(${nthOfType($, node)})`}`;
    })
    .join(' > ');
}

function computeTextDensity($: cheerio.CheerioAPI, element: any, text: string) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const childCount = Math.max(1, $(element).children().length);
  return clampScore(wordCount / Math.max(12, childCount * 10));
}

function linkDensityFor($: cheerio.CheerioAPI, element: any, text: string) {
  const linkText = cleanText($(element).find('a').text(), 2000);
  return text.length > 0 ? clampScore(linkText.length / text.length) : 0;
}

function computeVisualProminence(blockType: string, regionRole: CrawlRegionRole) {
  let score = 0.5;
  if (blockType === 'h1') score = 1;
  else if (blockType === 'h2') score = 0.9;
  else if (blockType === 'h3') score = 0.82;
  else if (blockType === 'h4') score = 0.74;
  else if (blockType === 'h5' || blockType === 'h6') score = 0.68;
  else if (blockType === 'p') score = 0.56;
  else if (blockType === 'li') score = 0.46;
  else if (blockType === 'blockquote') score = 0.6;

  if (regionRole === 'hero') score += 0.14;
  if (regionRole === 'cta' || regionRole === 'header') score += 0.08;
  if (regionRole === 'faq' || regionRole === 'comparison' || regionRole === 'tool') score += 0.04;
  if (regionRole === 'footer' || regionRole === 'related_content') score -= 0.1;
  if (regionRole === 'sidebar' || regionRole === 'navigation' || regionRole === 'table_of_contents') score -= 0.06;
  return clampScore(score);
}

function shouldIncludeBlock(blockType: string, text: string) {
  if (!text) return false;
  if (/^h[1-6]$/.test(blockType)) return text.length >= 4;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return text.length >= 35 && wordCount >= 6;
}

function buildBoilerplateScore(regionRole: CrawlRegionRole, text: string, linkDensity: number, repeatCount: number) {
  const lower = text.toLowerCase();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  let score = 0;
  if (['navigation', 'footer', 'sidebar', 'table_of_contents', 'related_content'].includes(regionRole)) score += 0.42;
  if (['cta', 'header', 'breadcrumb'].includes(regionRole)) score += 0.18;
  if (repeatCount > 1) score += Math.min(0.32, (repeatCount - 1) * 0.14);
  if (linkDensity > 0.45) score += 0.26;
  else if (linkDensity > 0.28) score += 0.16;
  if (/\b(table of contents|subscribe|newsletter|privacy policy|cookie|related posts|read more|contact us|terms|share this)\b/.test(lower)) score += 0.22;
  if (wordCount < 12) score += 0.08;
  return clampScore(score);
}

function collectSemanticRegions($: cheerio.CheerioAPI) {
  const selector = [
    'body',
    'header',
    'nav',
    'main',
    'aside',
    'footer',
    'section',
    'article',
    'form',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="main"]',
    '[role="contentinfo"]',
    '[role="complementary"]',
    '[class*="breadcrumb"]',
    '[id*="breadcrumb"]',
    '[class*="hero"]',
    '[id*="hero"]',
    '[class*="faq"]',
    '[id*="faq"]',
    '[class*="sidebar"]',
    '[id*="sidebar"]',
    '[class*="related"]',
    '[id*="related"]',
    '[class*="toc"]',
    '[class*="table-of-contents"]',
    '[class*="contents"]',
    '[id*="toc"]',
    '[id*="contents"]',
    '[class*="comparison"]',
    '[id*="comparison"]',
    '[class*="product"]',
    '[id*="product"]',
    '[class*="cta"]',
    '[id*="cta"]',
    '[class*="tool"]',
    '[id*="tool"]'
  ].join(',');

  const candidates: Array<CrawlRegionSnapshot & { element: any }> = [];
  const regionMap = new Map<any, CrawlRegionSnapshot>();
  const seen = new Set<string>();

  $(selector).each((_, element) => {
    const tag = String((element as { tagName?: string } | undefined)?.tagName || '').toLowerCase();
    const regionRole = inferRegionRole($, element);
    if (regionRole === 'unknown' && !['body', 'main', 'section', 'article'].includes(tag)) {
      return;
    }

    const parentRegionElement = $(element).parents().toArray().find((ancestor) => regionMap.has(ancestor));
    if (parentRegionElement) {
      const parentRegion = regionMap.get(parentRegionElement)!;
      if (parentRegion.regionRole === regionRole && !['section', 'main'].includes(regionRole)) {
        return;
      }
    }

    const domPath = buildDomPath($, element);
    const selectorText = buildSelector($, element);
    const key = `${regionRole}:${domPath}`;
    if (seen.has(key)) {
      return;
    }

    const region = {
      domPath,
      element,
      regionIndex: candidates.length,
      regionRole,
      selector: selectorText,
    };
    seen.add(key);
    candidates.push(region);
    regionMap.set(element, region);
  });

  if (candidates.length === 0) {
    const body = $('body').get(0);
    if (body) {
      const region = {
        domPath: buildDomPath($, body),
        element: body,
        regionIndex: 0,
        regionRole: 'main' as CrawlRegionRole,
        selector: buildSelector($, body),
      };
      candidates.push(region);
      regionMap.set(body, region);
    }
  }

  return { regions: candidates, regionMap };
}

function findNearestRegion($: cheerio.CheerioAPI, element: any, regionMap: Map<any, CrawlRegionSnapshot>) {
  const current = [element, ...$(element).parents().toArray()];
  const matchedRegions: CrawlRegionSnapshot[] = [];

  for (const node of current) {
    const region = regionMap.get(node);
    if (region) {
      matchedRegions.push(region);
    }
  }

  if (matchedRegions.length === 0) {
    return null;
  }

  const genericRoles = new Set<CrawlRegionRole>(['main', 'section', 'unknown']);
  const specificRegion = matchedRegions.find((region) => !genericRoles.has(region.regionRole));
  return specificRegion || matchedRegions[0] || null;
}

function headingTextFromChain(headingChainJson: string) {
  try {
    const chain = JSON.parse(headingChainJson);
    return Array.isArray(chain) && chain.length > 0 ? cleanText(String(chain[chain.length - 1] || ''), 180) || null : null;
  } catch {
    return null;
  }
}

function extractSemanticSnapshot($: cheerio.CheerioAPI, finalUrl: string, startUrl: string, options: CrawlUrlOptions) {
  const pageType = inferPageType($);
  const { regions, regionMap } = collectSemanticRegions($);
  const pageHeading = cleanText($('main h1, article h1, h1').first().text(), 180) || null;
  const rawBlocks: Array<CrawlTextBlockSnapshot & { pageType: CrawlPageType; visualProminence: number }> = [];
  const semanticBlockSelector = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote,figcaption';

  for (const region of regions) {
    const headingStack: Array<string | null> = [
      ['header', 'navigation', 'breadcrumb', 'footer'].includes(region.regionRole) ? null : pageHeading,
      null,
      null,
      null,
      null,
      null,
    ];
    $(region.element).find(semanticBlockSelector).addBack(semanticBlockSelector).each((_, element) => {
      if (rawBlocks.length >= 180) {
        return false;
      }
      const nearestRegion = findNearestRegion($, element, regionMap);
      if (!nearestRegion || nearestRegion.regionIndex !== region.regionIndex) {
        return;
      }

      const blockType = String((element as { tagName?: string } | undefined)?.tagName || 'text').toLowerCase();
      const text = cleanText($(element).text(), 900);
      if (!text) {
        return;
      }

      if (/^h[1-6]$/.test(blockType)) {
        const level = Math.max(1, Math.min(6, Number(blockType.slice(1)) || 1));
        headingStack[level - 1] = text;
        for (let index = level; index < headingStack.length; index += 1) {
          headingStack[index] = null;
        }
      }

      if (!shouldIncludeBlock(blockType, text)) {
        return;
      }

      const headingChain = headingStack.filter((entry) => entry).map((entry) => cleanText(String(entry), 180));
      const domPath = buildDomPath($, element);
      const selector = buildSelector($, element);
      const textHash = hashText(text.toLowerCase());
      rawBlocks.push({
        blockIndex: rawBlocks.length,
        blockKey: buildBlockKey(region.regionRole, domPath, selector, headingChain),
        blockType,
        boilerplateScore: 0,
        domPath,
        extractionVersion: CRAWL_SENTENCE_EXTRACTION_VERSION,
        headingChainJson: JSON.stringify(headingChain),
        linkDensity: linkDensityFor($, element, text),
        pageType,
        regionIndex: region.regionIndex,
        regionRole: region.regionRole,
        selector,
        text,
        textDensity: computeTextDensity($, element, text),
        textHash,
        visualProminence: computeVisualProminence(blockType, region.regionRole),
      });
    });
  }

  const repeatCountByHash = new Map<string, number>();
  for (const block of rawBlocks) {
    repeatCountByHash.set(block.textHash, (repeatCountByHash.get(block.textHash) || 0) + 1);
  }

  const textBlocks: CrawlTextBlockSnapshot[] = rawBlocks.slice(0, 120).map((block, index) => ({
    blockIndex: index,
    blockKey: block.blockKey,
    blockType: block.blockType,
    boilerplateScore: buildBoilerplateScore(block.regionRole, block.text, block.linkDensity, repeatCountByHash.get(block.textHash) || 1),
    domPath: block.domPath,
    extractionVersion: CRAWL_SENTENCE_EXTRACTION_VERSION,
    headingChainJson: block.headingChainJson,
    linkDensity: block.linkDensity,
    regionIndex: block.regionIndex,
    regionRole: block.regionRole,
    selector: block.selector,
    text: block.text,
    textDensity: block.textDensity,
    textHash: block.textHash,
  }));

  const finalizedBlockMeta = new Map<number, { pageType: CrawlPageType; visualProminence: number }>();
  textBlocks.forEach((block, index) => {
    const raw = rawBlocks[index];
    if (raw) {
      finalizedBlockMeta.set(block.blockIndex, { pageType: raw.pageType, visualProminence: raw.visualProminence });
    }
  });

  const sentences: CrawlSentenceSnapshot[] = [];
  const seenSentenceHashes = new Set<string>();
  const sentenceCountByBlock = new Map<number, number>();
  for (const block of textBlocks) {
    if (sentences.length >= 250) {
      break;
    }
    if (block.boilerplateScore >= 0.78 || block.textDensity < 0.18) {
      continue;
    }
    const sentenceCandidates = splitSentences(block.text).slice(0, 6);
    for (const sentenceText of sentenceCandidates) {
      if (sentences.length >= 250) {
        break;
      }
      const textHash = hashText(sentenceText.toLowerCase());
      if (seenSentenceHashes.has(textHash)) {
        continue;
      }
      seenSentenceHashes.add(textHash);
      const meta = finalizedBlockMeta.get(block.blockIndex);
      const sentenceIndex = sentenceCountByBlock.get(block.blockIndex) || 0;
      sentenceCountByBlock.set(block.blockIndex, sentenceIndex + 1);
      sentences.push({
        blockIndex: block.blockIndex,
        blockKey: block.blockKey,
        blockType: block.blockType,
        boilerplateScore: block.boilerplateScore,
        extractionVersion: CRAWL_SENTENCE_EXTRACTION_VERSION,
        headingText: headingTextFromChain(block.headingChainJson),
        linkDensity: block.linkDensity,
        pageType: meta?.pageType || pageType,
        paragraphIndex: block.blockIndex,
        regionIndex: block.regionIndex,
        regionRole: block.regionRole,
        sentenceIndex,
        sentenceText,
        textHash,
        visualProminence: meta?.visualProminence || computeVisualProminence(block.blockType, block.regionRole),
      });
    }
  }

  const internalLinks: CrawlLinkSnapshot[] = [];
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')?.trim() || '';
    const normalized = normalizeAbsoluteUrl(href, finalUrl, options);
    if (!normalized) return;
    try {
      const linkUrl = new URL(normalized);
      const startHost = new URL(startUrl).hostname;
      if (!isInternalHost(linkUrl.hostname, startHost)) {
        return;
      }
      const blockElement = $(element).closest('p, li, dt, dd, blockquote, figcaption, h1, h2, h3, h4, h5, h6').get(0) || element;
      const blockType = String((blockElement as { tagName?: string } | undefined)?.tagName || 'a').toLowerCase();
      const region = findNearestRegion($, blockElement, regionMap) || regions.find((candidate) => candidate.regionRole === 'main') || regions[0] || {
        domPath: 'body:nth-of-type(1)',
        regionIndex: 0,
        regionRole: 'main' as CrawlRegionRole,
        selector: 'body',
      };
      const anchorText = cleanText($(element).text(), 180) || null;
      const contextText = cleanText($(blockElement).text(), 360) || cleanText($(element).closest('section, article, div').text(), 360) || anchorText;
      internalLinks.push({
        anchorText,
        blockType,
        contextText,
        regionRole: region.regionRole,
        url: normalized,
        visualProminence: computeVisualProminence(blockType, region.regionRole),
      });
    } catch {
      // Ignore invalid links.
    }
  });

  return { internalLinks, pageType, regions, sentences, textBlocks };
}

function extractPageSnapshot(html: string, responseHeaders: Headers, finalUrl: string, startUrl: string, options: CrawlUrlOptions) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || null;
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;
  const canonicalHref = $('link[rel="canonical"]').attr('href')?.trim() || null;
  const canonicalUrl = canonicalHref ? normalizeAbsoluteUrl(canonicalHref, finalUrl, options) : null;
  const h1Items = $('h1')
    .map((_, element) => cleanText($(element).text(), 180))
    .get()
    .filter(Boolean);
  const h2Count = $('h2').length;
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
  const robotsMeta = $('meta[name="robots"]').attr('content')?.toLowerCase() || '';
  const xRobots = responseHeaders.get('x-robots-tag')?.toLowerCase() || '';
  const noindex = robotsMeta.includes('noindex') || xRobots.includes('noindex') ? 1 : 0;
  const contentType = responseHeaders.get('content-type') || null;
  const semantic = extractSemanticSnapshot($, finalUrl, startUrl, options);

  return {
    canonicalUrl,
    contentType,
    h1Count: h1Items.length,
    h1Text: h1Items[0] || null,
    h2Count,
    internalLinks: semantic.internalLinks,
    metaDescription,
    noindex,
    outgoingLinkCount: $('a[href]').length,
    pageType: semantic.pageType,
    regions: semantic.regions,
    sentences: semantic.sentences,
    textBlocks: semantic.textBlocks,
    title,
    wordCount,
  };
}
async function upsertCrawlPage(db: AppDatabase, page: CrawlPageRecord) {
  await db.run(
    `
      INSERT INTO crawl_pages (
        ownerId, siteUrl, jobId, url, normalizedUrl, pageKey, resolvedCanonicalPageKey, finalUrl, statusCode, contentType,
        title, metaDescription, canonicalUrl, h1Text, h1Count, h2Count, wordCount, depth,
        discoveredFrom, discoveredFromUrl, discoveredAt, crawledAt, responseTimeMs, noindex,
        inboundLinkCount, internalLinkCount, outgoingLinkCount, errorMessage
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ownerId, siteUrl, jobId, normalizedUrl) DO UPDATE SET
        url=excluded.url,
        pageKey=excluded.pageKey,
        resolvedCanonicalPageKey=excluded.resolvedCanonicalPageKey,
        finalUrl=excluded.finalUrl,
        statusCode=excluded.statusCode,
        contentType=excluded.contentType,
        title=excluded.title,
        metaDescription=excluded.metaDescription,
        canonicalUrl=excluded.canonicalUrl,
        h1Text=excluded.h1Text,
        h1Count=excluded.h1Count,
        h2Count=excluded.h2Count,
        wordCount=excluded.wordCount,
        depth=excluded.depth,
        discoveredFrom=excluded.discoveredFrom,
        discoveredFromUrl=excluded.discoveredFromUrl,
        discoveredAt=excluded.discoveredAt,
        crawledAt=excluded.crawledAt,
        responseTimeMs=excluded.responseTimeMs,
        noindex=excluded.noindex,
        inboundLinkCount=excluded.inboundLinkCount,
        internalLinkCount=excluded.internalLinkCount,
        outgoingLinkCount=excluded.outgoingLinkCount,
        errorMessage=excluded.errorMessage
    `,
    [
      page.ownerId,
      page.siteUrl,
      page.jobId,
      page.url,
      page.normalizedUrl,
      page.pageKey,
      page.resolvedCanonicalPageKey,
      page.finalUrl,
      page.statusCode,
      page.contentType,
      page.title,
      page.metaDescription,
      page.canonicalUrl,
      page.h1Text,
      page.h1Count,
      page.h2Count,
      page.wordCount,
      page.depth,
      page.discoveredFrom,
      page.discoveredFromUrl,
      page.discoveredAt,
      page.crawledAt,
      page.responseTimeMs,
      page.noindex,
      page.inboundLinkCount ?? 0,
      page.internalLinkCount,
      page.outgoingLinkCount,
      page.errorMessage,
    ],
  );
}

async function upsertCrawlLinks(
  db: AppDatabase,
  ownerId: string,
  siteUrl: string,
  jobId: string,
  fromUrl: string,
  fromPageKey: string,
  links: CrawlLinkSnapshot[],
  depth: number,
  discoveredAt: string,
) {
  for (const link of links) {
    const toPageKey = buildPageKey(link.url, siteUrl);
    await db.run(
      `
        INSERT INTO crawl_links (
          ownerId, siteUrl, jobId, fromUrl, toUrl, fromPageKey, toPageKey,
          anchorText, contextText, regionRole, blockType, visualProminence, discoveredAt, depth
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ownerId, siteUrl, jobId, fromUrl, toUrl) DO UPDATE SET
          fromPageKey=excluded.fromPageKey,
          toPageKey=excluded.toPageKey,
          anchorText=excluded.anchorText,
          contextText=excluded.contextText,
          regionRole=excluded.regionRole,
          blockType=excluded.blockType,
          visualProminence=excluded.visualProminence,
          discoveredAt=excluded.discoveredAt,
          depth=excluded.depth
      `,
      [
        ownerId,
        siteUrl,
        jobId,
        fromUrl,
        link.url,
        fromPageKey,
        toPageKey,
        link.anchorText,
        link.contextText,
        link.regionRole,
        link.blockType,
        link.visualProminence,
        discoveredAt,
        depth,
      ],
    );
  }
}

async function crawlPageSentencesHasBlockKeyColumn(db: AppDatabase) {
  if (crawlSentencesSupportsBlockKey !== null) {
    return crawlSentencesSupportsBlockKey;
  }

  if (db.dialect === 'postgres') {
    const row = await db.get<{ exists?: number }>(
      `
        SELECT 1 AS exists
        FROM information_schema.columns
        WHERE table_name = 'crawl_page_sentences'
          AND LOWER(column_name) = 'blockkey'
        LIMIT 1
      `,
    );
    crawlSentencesSupportsBlockKey = Boolean(row?.exists);
    return crawlSentencesSupportsBlockKey;
  }

  const columns = await db.all<{ name?: string }>(`PRAGMA table_info('crawl_page_sentences')`);
  crawlSentencesSupportsBlockKey = columns.some((column) => String(column?.name || '').toLowerCase() === 'blockkey');
  return crawlSentencesSupportsBlockKey;
}

async function replaceCrawlSentences(
  db: AppDatabase,
  ownerId: string,
  siteUrl: string,
  jobId: string,
  pageUrl: string,
  pageKey: string,
  sentences: CrawlSentenceSnapshot[],
) {
  await db.run(
    'DELETE FROM crawl_page_sentences WHERE ownerId = ? AND siteUrl = ? AND jobId = ? AND pageUrl = ?',
    [ownerId, siteUrl, jobId, pageUrl],
  );

  const supportsBlockKey = await crawlPageSentencesHasBlockKeyColumn(db);
  const createdAt = nowIso();
  for (const sentence of sentences) {
    if (supportsBlockKey) {
      await db.run(
        `
          INSERT INTO crawl_page_sentences (
            ownerId, siteUrl, jobId, pageUrl, pageKey, paragraphIndex, sentenceIndex,
            blockIndex, blockKey, regionIndex, regionRole, blockType, pageType, visualProminence,
            sentenceText, textHash, headingText, linkDensity, boilerplateScore, extractionVersion,
            embeddingStatus, createdAt
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          ownerId,
          siteUrl,
          jobId,
          pageUrl,
          pageKey,
          sentence.paragraphIndex,
          sentence.sentenceIndex,
          sentence.blockIndex,
          sentence.blockKey,
          sentence.regionIndex,
          sentence.regionRole,
          sentence.blockType,
          sentence.pageType,
          sentence.visualProminence,
          sentence.sentenceText,
          sentence.textHash,
          sentence.headingText,
          sentence.linkDensity,
          sentence.boilerplateScore,
          sentence.extractionVersion,
          'local-ready',
          createdAt,
        ],
      );
      continue;
    }

    await db.run(
      `
        INSERT INTO crawl_page_sentences (
          ownerId, siteUrl, jobId, pageUrl, pageKey, paragraphIndex, sentenceIndex,
          blockIndex, regionIndex, regionRole, blockType, pageType, visualProminence,
          sentenceText, textHash, headingText, linkDensity, boilerplateScore, extractionVersion,
          embeddingStatus, createdAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        ownerId,
        siteUrl,
        jobId,
        pageUrl,
        pageKey,
        sentence.paragraphIndex,
        sentence.sentenceIndex,
        sentence.blockIndex,
        sentence.regionIndex,
        sentence.regionRole,
        sentence.blockType,
        sentence.pageType,
        sentence.visualProminence,
        sentence.sentenceText,
        sentence.textHash,
        sentence.headingText,
        sentence.linkDensity,
        sentence.boilerplateScore,
        sentence.extractionVersion,
        'local-ready',
        createdAt,
      ],
    );
  }
}
async function crawlPageTextBlocksHasBlockKeyColumn(db: AppDatabase) {
  if (crawlTextBlocksSupportsBlockKey !== null) {
    return crawlTextBlocksSupportsBlockKey;
  }

  if (db.dialect === 'postgres') {
    const row = await db.get<{ exists?: number }>(
      `
        SELECT 1 AS exists
        FROM information_schema.columns
        WHERE table_name = 'crawl_page_text_blocks'
          AND LOWER(column_name) = 'blockkey'
        LIMIT 1
      `,
    );
    crawlTextBlocksSupportsBlockKey = Boolean(row?.exists);
    return crawlTextBlocksSupportsBlockKey;
  }

  const columns = await db.all<{ name?: string }>(`PRAGMA table_info('crawl_page_text_blocks')`);
  crawlTextBlocksSupportsBlockKey = columns.some((column) => String(column?.name || '').toLowerCase() === 'blockkey');
  return crawlTextBlocksSupportsBlockKey;
}

async function replaceCrawlTextBlocks(
  db: AppDatabase,
  ownerId: string,
  siteUrl: string,
  jobId: string,
  pageUrl: string,
  pageKey: string,
  blocks: CrawlTextBlockSnapshot[],
) {
  await db.run(
    'DELETE FROM crawl_page_text_blocks WHERE ownerId = ? AND siteUrl = ? AND jobId = ? AND pageUrl = ?',
    [ownerId, siteUrl, jobId, pageUrl],
  );

  const supportsBlockKey = await crawlPageTextBlocksHasBlockKeyColumn(db);

  for (const block of blocks) {
    if (supportsBlockKey) {
      await db.run(
        `
          INSERT INTO crawl_page_text_blocks (
            ownerId, siteUrl, jobId, pageUrl, pageKey, blockIndex, blockKey, blockType,
            regionIndex, regionRole, headingChainJson, domPath, selector,
            text, textHash, textDensity, linkDensity, boilerplateScore, extractionVersion
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          ownerId,
          siteUrl,
          jobId,
          pageUrl,
          pageKey,
          block.blockIndex,
          block.blockKey,
          block.blockType,
          block.regionIndex,
          block.regionRole,
          block.headingChainJson,
          block.domPath,
          block.selector,
          block.text,
          block.textHash,
          block.textDensity,
          block.linkDensity,
          block.boilerplateScore,
          block.extractionVersion,
        ],
      );
      continue;
    }

    await db.run(
      `
        INSERT INTO crawl_page_text_blocks (
          ownerId, siteUrl, jobId, pageUrl, pageKey, blockIndex, blockType,
          regionIndex, regionRole, headingChainJson, domPath, selector,
          text, textHash, textDensity, linkDensity, boilerplateScore, extractionVersion
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        ownerId,
        siteUrl,
        jobId,
        pageUrl,
        pageKey,
        block.blockIndex,
        block.blockType,
        block.regionIndex,
        block.regionRole,
        block.headingChainJson,
        block.domPath,
        block.selector,
        block.text,
        block.textHash,
        block.textDensity,
        block.linkDensity,
        block.boilerplateScore,
        block.extractionVersion,
      ],
    );
  }
}
async function updateCrawlJob(db: AppDatabase, jobId: string, fields: Partial<CrawlJobRecord>) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;

  const sets = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  values.push(nowIso());
  values.push(jobId);

  await db.run(`UPDATE crawl_jobs SET ${sets}, updatedAt = ? WHERE id = ?`, values);
}

async function isCrawlJobCancelled(db: AppDatabase, jobId: string) {
  const row = await db.get<{ status?: string }>('SELECT status FROM crawl_jobs WHERE id = ?', [jobId]);
  return row?.status === 'cancelled';
}

async function getCrawlJobLeaseError(db: AppDatabase, jobId: string) {
  const row = await db.get<{ status?: string }>('SELECT status FROM crawl_jobs WHERE id = ?', [jobId]);
  return row?.status === 'cancelled' ? new CrawlCancelledError() : new CrawlLeaseLostError();
}

async function refreshOwnedCrawlJobLease(db: AppDatabase, job: ClaimedCrawlJobRecord, fields: Partial<CrawlJobRecord> = {}) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  const nextLockedAt = nowIso();
  const updatedAt = nowIso();
  const sets = entries.map(([key]) => key + ' = ?').concat('lockedAt = ?', 'updatedAt = ?').join(', ');
  const values = entries.map(([, value]) => value);
  values.push(nextLockedAt, updatedAt, job.id, job.lockedAt);

  const result = await db.run(
    "UPDATE crawl_jobs SET " + sets + " WHERE id = ? AND status = 'running' AND lockedAt = ?",
    values,
  );

  if (result.changes === 0) {
    throw await getCrawlJobLeaseError(db, job.id);
  }

  Object.assign(job, fields, { lockedAt: nextLockedAt, updatedAt });
}

async function finalizeOwnedCrawlJob(db: AppDatabase, job: ClaimedCrawlJobRecord, fields: Partial<CrawlJobRecord>) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  const updatedAt = nowIso();
  const sets = entries.map(([key]) => key + ' = ?').concat('lockedAt = NULL', 'updatedAt = ?').join(', ');
  const values = entries.map(([, value]) => value);
  values.push(updatedAt, job.id, job.lockedAt);

  const result = await db.run(
    "UPDATE crawl_jobs SET " + sets + " WHERE id = ? AND status = 'running' AND lockedAt = ?",
    values,
  );

  if (result.changes === 0) {
    throw await getCrawlJobLeaseError(db, job.id);
  }

  Object.assign(job, fields, { updatedAt });
}

async function computeInboundCounts(db: AppDatabase, ownerId: string, siteUrl: string, jobId: string) {
  await db.run(
    `
      WITH page_targets AS (
        SELECT
          pageKey,
          MIN(COALESCE(NULLIF(resolvedCanonicalPageKey, ''), pageKey)) AS resolvedPageKey
        FROM crawl_pages
        WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
        GROUP BY pageKey
      ),
      link_counts AS (
        SELECT
          COALESCE(page_targets.resolvedPageKey, crawl_links.toPageKey) AS resolvedPageKey,
          COUNT(*) AS inboundCount
        FROM crawl_links
        LEFT JOIN page_targets ON page_targets.pageKey = crawl_links.toPageKey
        WHERE crawl_links.ownerId = ? AND crawl_links.siteUrl = ? AND crawl_links.jobId = ?
        GROUP BY COALESCE(page_targets.resolvedPageKey, crawl_links.toPageKey)
      )
      UPDATE crawl_pages
      SET inboundLinkCount = COALESCE(
        (
          SELECT link_counts.inboundCount
          FROM link_counts
          WHERE link_counts.resolvedPageKey =
            COALESCE(NULLIF(crawl_pages.resolvedCanonicalPageKey, ''), crawl_pages.pageKey)
        ),
        0
      )
      WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
    `,
    [ownerId, siteUrl, jobId, ownerId, siteUrl, jobId, ownerId, siteUrl, jobId],
  );
}

async function processCrawlPage(
  db: AppDatabase,
  input: StartCrawlInput & { ownerId: string; jobId: string; rules: CrawlRules },
  item: CrawlQueueItem,
  seen: Set<string>,
  queue: CrawlQueueItem[],
  counters: { crawledCount: number; errorCount: number; skippedCount: number },
  ensureJobActive: () => Promise<void>,
) {
  await ensureJobActive();
  const startHost = new URL(input.startUrl).hostname;
  const urlOptions = { includeQueryStrings: Boolean(input.includeQueryStrings) };
  const normalizedUrl = normalizeAbsoluteUrl(item.url, input.startUrl, urlOptions);
  if (!normalizedUrl) {
    counters.skippedCount += 1;
    return;
  }

  const normalizedUrlObject = new URL(normalizedUrl);
  if (!isInternalHost(normalizedUrlObject.hostname, startHost)) {
    counters.skippedCount += 1;
    return;
  }

  if (!isPathAllowed(normalizedUrlObject.pathname, input.rules)) {
    counters.skippedCount += 1;
    return;
  }

  const startedAt = Date.now();
  try {
    const userAgent = input.userAgent || CRAWLER_USER_AGENT;
    const useJavaScriptRendering = input.renderMode === 'javascript';
    const rendered = useJavaScriptRendering ? await renderPageHtml(normalizedUrl, userAgent) : null;
    const response = rendered ? null : await fetchText(normalizedUrl, {}, userAgent);
    const responseHeaders = rendered ? new Headers(rendered.headers as Record<string, string>) : response!.headers;
    const finalUrl = normalizeAbsoluteUrl(rendered?.finalUrl || response?.url || normalizedUrl, input.startUrl, urlOptions) || normalizedUrl;
    const statusCode = rendered?.statusCode ?? response!.status;
    const responseTimeMs = rendered?.responseTimeMs ?? (Date.now() - startedAt);
    const discoveredAt = item.discoveredAt;
    const pageKey = buildPageKey(finalUrl, input.siteUrl);

    let internalLinks: CrawlLinkSnapshot[] = [];
    let contentType = rendered?.contentType || responseHeaders.get('content-type') || null;
    let title: string | null = null;
    let metaDescription: string | null = null;
    let canonicalUrl: string | null = null;
    let h1Text: string | null = null;
    let h1Count = 0;
    let h2Count = 0;
    let wordCount = 0;
    let noindex = 0;
    let outgoingLinkCount = 0;
    let sentences: CrawlSentenceSnapshot[] = [];
    let textBlocks: CrawlTextBlockSnapshot[] = [];

    if (contentType?.includes('text/html')) {
      const contentLength = Number(responseHeaders.get('content-length') || '0');
      if (contentLength && contentLength > MAX_HTML_BYTES) {
        throw new Error(`Skipped oversized HTML response (${Math.round(contentLength / 1024)}KB)`);
      }

      const html = rendered?.html ?? await response!.text();
      if (html.length > MAX_HTML_BYTES) {
        throw new Error(`Skipped oversized HTML response (${Math.round(html.length / 1024)}KB)`);
      }
      const snapshot = extractPageSnapshot(html, responseHeaders, finalUrl, input.startUrl, urlOptions);
      contentType = snapshot.contentType;
      title = snapshot.title;
      metaDescription = snapshot.metaDescription;
      canonicalUrl = snapshot.canonicalUrl;
      h1Text = snapshot.h1Text;
      h1Count = snapshot.h1Count;
      h2Count = snapshot.h2Count;
      wordCount = snapshot.wordCount;
      noindex = snapshot.noindex;
      internalLinks = snapshot.internalLinks;
      sentences = snapshot.sentences;
      textBlocks = snapshot.textBlocks;
      outgoingLinkCount = snapshot.outgoingLinkCount;
    }

    await ensureJobActive();
    await db.transaction(async () => {
      await upsertCrawlPage(db, {
        canonicalUrl,
        contentType,
        crawledAt: nowIso(),
        depth: item.depth,
        discoveredAt,
        discoveredFrom: item.discoveredFrom,
        discoveredFromUrl: item.discoveredFromUrl,
        errorMessage: null,
        finalUrl,
        h1Count,
        h1Text,
        h2Count,
        internalLinkCount: internalLinks.length,
        jobId: input.jobId,
        metaDescription,
        noindex,
        normalizedUrl,
        outgoingLinkCount,
        pageKey,
        resolvedCanonicalPageKey: resolvedCanonicalPageKey(canonicalUrl, finalUrl, input.siteUrl),
        responseTimeMs,
        ownerId: input.ownerId,
        siteUrl: input.siteUrl,
        statusCode,
        title,
        url: normalizedUrl,
        wordCount,
      });

      await replaceCrawlSentences(db, input.ownerId, input.siteUrl, input.jobId, normalizedUrl, pageKey, sentences);
      await replaceCrawlTextBlocks(db, input.ownerId, input.siteUrl, input.jobId, normalizedUrl, pageKey, textBlocks);

      if (internalLinks.length > 0) {
        await upsertCrawlLinks(
          db,
          input.ownerId,
          input.siteUrl,
          input.jobId,
          normalizedUrl,
          pageKey,
          internalLinks,
          item.depth,
          discoveredAt,
        );
      }
    })();

    if (item.depth < input.maxDepth) {
      for (const link of internalLinks) {
        if (seen.size >= input.maxPages) break;
        const normalizedLink = normalizeAbsoluteUrl(link.url, finalUrl, urlOptions);
        if (!normalizedLink) continue;
        const linkUrl = new URL(normalizedLink);
        if (!isInternalHost(linkUrl.hostname, startHost)) continue;
        if (!isPathAllowed(linkUrl.pathname, input.rules)) continue;
        if (seen.has(normalizedLink)) continue;
        seen.add(normalizedLink);
        queue.push({
          depth: item.depth + 1,
          discoveredAt,
          discoveredFrom: 'internal-link',
          discoveredFromUrl: normalizedUrl,
          url: normalizedLink,
        });
      }
    }

    counters.crawledCount += 1;
    return { responseTimeMs, finalUrl, pageKey, statusCode, url: normalizedUrlObject.toString() };
  } catch (error: any) {
    if (error instanceof CrawlCancelledError || error instanceof CrawlLeaseLostError) {
      throw error;
    }
    counters.errorCount += 1;
    await db.transaction(async () => {
      await upsertCrawlPage(db, {
        canonicalUrl: null,
        contentType: null,
        crawledAt: nowIso(),
        depth: item.depth,
        discoveredAt: item.discoveredAt,
        discoveredFrom: item.discoveredFrom,
        discoveredFromUrl: item.discoveredFromUrl,
        errorMessage: error?.message || 'Crawl failed',
        finalUrl: null,
        h1Count: 0,
        h1Text: null,
        h2Count: 0,
        internalLinkCount: 0,
        jobId: input.jobId,
        metaDescription: null,
        noindex: 0,
        normalizedUrl,
        outgoingLinkCount: 0,
        pageKey: buildPageKey(normalizedUrl, input.siteUrl),
        resolvedCanonicalPageKey: buildPageKey(normalizedUrl, input.siteUrl),
        responseTimeMs: Date.now() - startedAt,
        ownerId: input.ownerId,
        siteUrl: input.siteUrl,
        statusCode: null,
        title: null,
        url: normalizedUrl,
        wordCount: 0,
      });
    })();
    return null;
  }
}

async function getLatestJob(db: AppDatabase, ownerId: string, siteUrl: string) {
  return db.get<CrawlJobRecord>(
    `
      SELECT *
      FROM crawl_jobs
      WHERE ownerId = ? AND siteUrl = ?
      ORDER BY updatedAt DESC, startedAt DESC
      LIMIT 1
    `,
    [ownerId, siteUrl],
  );
}

async function getJobById(db: AppDatabase, ownerId: string, siteUrl: string, jobId: string) {
  return db.get<CrawlJobRecord>(
    `
      SELECT *
      FROM crawl_jobs
      WHERE ownerId = ? AND siteUrl = ? AND id = ?
      LIMIT 1
    `,
    [ownerId, siteUrl, jobId],
  );
}

async function getCrawlJob(db: AppDatabase, ownerId: string, siteUrl: string, jobId?: string | null) {
  if (jobId) {
    const selectedJob = await getJobById(db, ownerId, siteUrl, jobId);
    if (selectedJob) {
      return selectedJob;
    }
  }

  return getLatestJob(db, ownerId, siteUrl);
}

async function listJobsForSite(db: AppDatabase, ownerId: string, siteUrl: string, limit = 20) {
  return db.all<CrawlJobRecord>(
    `
      SELECT *
      FROM crawl_jobs
      WHERE ownerId = ? AND siteUrl = ?
      ORDER BY updatedAt DESC, startedAt DESC
      LIMIT ?
    `,
    [ownerId, siteUrl, limit],
  );
}

async function getPreviousJob(db: AppDatabase, ownerId: string, siteUrl: string, currentJobId: string) {
  const currentJob = await getJobById(db, ownerId, siteUrl, currentJobId);
  if (!currentJob) return null;
  return db.get<CrawlJobRecord>(
    `
      SELECT *
      FROM crawl_jobs
      WHERE ownerId = ? AND siteUrl = ? AND id <> ?
        AND COALESCE(completedAt, updatedAt, startedAt) < COALESCE(?, ?, ?)
      ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
      LIMIT 1
    `,
    [ownerId, siteUrl, currentJobId, currentJob.completedAt, currentJob.updatedAt, currentJob.startedAt],
  );
}

async function getSummaryForJob(db: AppDatabase, ownerId: string, siteUrl: string, jobId: string): Promise<CrawlSummary> {
  const summary = await db.get<any>(
    `
      SELECT
        COUNT(*) AS "totalPages",
        SUM(CASE WHEN statusCode BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS "successPages",
        SUM(CASE WHEN statusCode BETWEEN 300 AND 399 THEN 1 ELSE 0 END) AS "redirectPages",
        SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) AS "errorPages",
        SUM(CASE WHEN noindex = 1 THEN 1 ELSE 0 END) AS "noindexPages",
        SUM(CASE WHEN title IS NULL OR TRIM(title) = '' THEN 1 ELSE 0 END) AS "missingTitlePages",
        SUM(CASE WHEN metaDescription IS NULL OR TRIM(metaDescription) = '' THEN 1 ELSE 0 END) AS "missingMetaPages",
        SUM(CASE WHEN canonicalUrl IS NOT NULL AND canonicalUrl <> '' AND canonicalUrl <> normalizedUrl THEN 1 ELSE 0 END) AS "canonicalizedPages"
      FROM crawl_pages
      WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
    `,
    [ownerId, siteUrl, jobId],
  );

  const orphanCount = await db.get<any>(
    `
      SELECT COUNT(*) AS "orphanPages"
      FROM crawl_pages
      WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
        AND COALESCE(inboundLinkCount, 0) = 0
    `,
    [ownerId, siteUrl, jobId],
  );

  return {
    canonicalizedPages: toFiniteNumber(summary?.canonicalizedPages),
    errorPages: toFiniteNumber(summary?.errorPages),
    missingMetaPages: toFiniteNumber(summary?.missingMetaPages),
    missingTitlePages: toFiniteNumber(summary?.missingTitlePages),
    noindexPages: toFiniteNumber(summary?.noindexPages),
    orphanPages: toFiniteNumber(orphanCount?.orphanPages),
    redirectPages: toFiniteNumber(summary?.redirectPages),
    successPages: toFiniteNumber(summary?.successPages),
    totalPages: toFiniteNumber(summary?.totalPages),
  };
}

async function createQueuedCrawlJob(db: AppDatabase, input: StartCrawlInput & { ownerId: string }) {
  const startUrl = normalizeAbsoluteUrl(input.startUrl, input.startUrl, { includeQueryStrings: Boolean(input.includeQueryStrings) });
  if (!startUrl) {
    throw new Error('A valid http(s) start URL is required to crawl a site.');
  }

  const jobId = crypto.randomUUID();
  const maxDepth = Math.max(0, Math.min(Number(input.maxDepth ?? DEFAULT_MAX_DEPTH), 10));
  const maxPages = Math.max(1, Math.min(Number(input.maxPages ?? DEFAULT_MAX_PAGES), 100000));
  const renderMode = input.renderMode === 'javascript' ? 'javascript' : 'html';
  const respectRobots = input.respectRobots === undefined ? 1 : input.respectRobots ? 1 : 0;
  const includeQueryStrings = input.includeQueryStrings ? 1 : 0;
  const userAgent = String(input.userAgent || CRAWLER_USER_AGENT).trim().slice(0, 200) || CRAWLER_USER_AGENT;
  const queuedAt = nowIso();

  await db.run(
    `
      INSERT INTO crawl_jobs (
        id, ownerId, siteUrl, startUrl, sitemapUrl, status, maxPages, maxDepth,
        discoveredCount, crawledCount, errorCount, skippedCount, queuedCount,
        startedAt, updatedAt, completedAt, lastError, attemptCount, maxAttempts, lockedAt, nextRunAt,
        renderMode, respectRobots, includeQueryStrings, userAgent
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      jobId,
      input.ownerId,
      input.siteUrl,
      startUrl,
      input.sitemapUrl || null,
      'queued',
      maxPages,
      maxDepth,
      0,
      0,
      0,
      0,
      0,
      null,
      queuedAt,
      null,
      null,
      0,
      DEFAULT_MAX_ATTEMPTS,
      null,
      queuedAt,
      renderMode,
      respectRobots,
      includeQueryStrings,
      userAgent,
    ],
  );

  return (await db.get<CrawlJobRecord>('SELECT * FROM crawl_jobs WHERE id = ?', [jobId])) || null;
}

async function executeCrawlJob(db: AppDatabase, job: ClaimedCrawlJobRecord) {
  const includeQueryStrings = Boolean(job.includeQueryStrings);
  const urlOptions = { includeQueryStrings };
  const userAgent = String(job.userAgent || CRAWLER_USER_AGENT).trim() || CRAWLER_USER_AGENT;
  const respectRobots = job.respectRobots !== 0;
  const startUrl = normalizeAbsoluteUrl(job.startUrl || '', job.startUrl || '', urlOptions);
  if (!startUrl) {
    throw new Error('A valid http(s) start URL is required to crawl a site.');
  }

  const maxDepth = Math.max(0, Math.min(Number(job.maxDepth ?? DEFAULT_MAX_DEPTH), 10));
  const maxPages = Math.max(1, Math.min(Number(job.maxPages ?? DEFAULT_MAX_PAGES), 100000));
  const pageConcurrency = getCrawlPageConcurrency();
  const heartbeatIntervalMs = getCrawlHeartbeatIntervalMs();
  const counters = {
    crawledCount: 0,
    errorCount: 0,
    skippedCount: 0,
  };
  const seen = new Set<string>();
  const queue: CrawlQueueItem[] = [];
  const inFlight = new Set<Promise<void>>();
  let nextIndex = 0;
  let leaseError: Error | null = null;
  let lastPersistedProcessedCount = 0;
  let heartbeatPending = false;
  let leaseUpdateChain: Promise<void> = Promise.resolve();

  const runLeaseMutation = async (action: () => Promise<void>) => {
    const next = leaseUpdateChain.then(action, action);
    leaseUpdateChain = next.catch(() => undefined);
    await next;
  };

  const ensureJobActive = async () => {
    if (leaseError) {
      throw leaseError;
    }
    if (await isCrawlJobCancelled(db, job.id)) {
      leaseError = new CrawlCancelledError();
      throw leaseError;
    }
  };

  const persistProgress = async (force = false) => {
    const processedCount = counters.crawledCount + counters.errorCount + counters.skippedCount;
    if (!force && processedCount - lastPersistedProcessedCount < CRAWL_PROGRESS_BATCH_SIZE) {
      return;
    }
    lastPersistedProcessedCount = processedCount;
    await runLeaseMutation(async () => {
      await ensureJobActive();
      await refreshOwnedCrawlJobLease(db, job, {
        crawledCount: counters.crawledCount,
        discoveredCount: seen.size,
        errorCount: counters.errorCount,
        queuedCount: Math.max(0, queue.length - nextIndex),
        skippedCount: counters.skippedCount,
        status: 'running',
      });
    });
  };

  const heartbeat = async () => {
    try {
      await runLeaseMutation(async () => {
        await ensureJobActive();
        await refreshOwnedCrawlJobLease(db, job);
      });
    } catch (error) {
      leaseError = error instanceof Error ? error : new CrawlLeaseLostError();
      throw leaseError;
    }
  };

  const heartbeatTimer = setInterval(() => {
    if (heartbeatPending || leaseError) {
      return;
    }
    heartbeatPending = true;
    void heartbeat().catch(() => undefined).finally(() => {
      heartbeatPending = false;
    });
  }, heartbeatIntervalMs);

  try {
    await ensureJobActive();
    const { rules, urls: sitemapUrls } = await collectSitemapUrls(startUrl, job.sitemapUrl || null, {
      includeQueryStrings,
      respectRobots,
      userAgent,
    });
    const enqueue = (url: string, depth: number, discoveredFrom: string, discoveredFromUrl: string | null) => {
      if (seen.size >= maxPages) return;
      const normalized = normalizeAbsoluteUrl(url, startUrl, urlOptions);
      if (!normalized || seen.has(normalized)) return;
      const normalizedUrlObject = new URL(normalized);
      if (!isInternalHost(normalizedUrlObject.hostname, new URL(startUrl).hostname)) return;
      if (!isPathAllowed(normalizedUrlObject.pathname, rules)) return;
      seen.add(normalized);
      queue.push({
        depth,
        discoveredAt: nowIso(),
        discoveredFrom,
        discoveredFromUrl,
        url: normalized,
      });
    };

    enqueue(startUrl, 0, 'seed', null);
    sitemapUrls.forEach((url) => enqueue(url, 0, 'sitemap', job.sitemapUrl || null));
    const previousSeedRows = await db.all<{ normalizedUrl: string | null; url: string | null }>(
      `
        SELECT normalizedUrl, url
        FROM crawl_pages
        WHERE ownerId = ? AND siteUrl = ?
          AND jobId = (
            SELECT id
            FROM crawl_jobs
            WHERE ownerId = ? AND siteUrl = ? AND id != ? AND status IN ('completed', 'error')
            ORDER BY completedAt DESC, updatedAt DESC
            LIMIT 1
          )
        ORDER BY depth ASC, url ASC
        LIMIT ?
      `,
      [job.ownerId, job.siteUrl, job.ownerId, job.siteUrl, job.id, maxPages],
    );
    previousSeedRows.forEach((row) => enqueue(row.normalizedUrl || row.url || '', 0, 'previous-crawl', null));

    while (nextIndex < queue.length || inFlight.size > 0) {
      await ensureJobActive();

      while (nextIndex < queue.length && inFlight.size < pageConcurrency) {
        const item = queue[nextIndex++];
        let task: Promise<void>;
        task = (async () => {
          await processCrawlPage(
            db,
            {
              maxDepth,
              maxPages,
              includeQueryStrings,
              jobId: job.id,
              ownerId: job.ownerId,
              renderMode: job.renderMode === 'javascript' ? 'javascript' : 'html',
              respectRobots,
              rules,
              sitemapUrl: job.sitemapUrl,
              siteUrl: job.siteUrl,
              startUrl,
              userAgent,
            },
            item,
            seen,
            queue,
            counters,
            ensureJobActive,
          );
          await persistProgress();
        })().finally(() => {
          inFlight.delete(task);
        });
        inFlight.add(task);
      }

      if (inFlight.size === 0) {
        break;
      }

      await Promise.race(inFlight);
    }

    await Promise.all(Array.from(inFlight));
    await ensureJobActive();
    await computeInboundCounts(db, job.ownerId, job.siteUrl, job.id);
    await runLeaseMutation(async () => {
      await ensureJobActive();
      await finalizeOwnedCrawlJob(db, job, {
        canonicalMetricsVersion: 1,
        completedAt: nowIso(),
        crawledCount: counters.crawledCount,
        discoveredCount: seen.size,
        errorCount: counters.errorCount,
        lastError: null,
        nextRunAt: null,
        queuedCount: 0,
        skippedCount: counters.skippedCount,
        status: 'completed',
      });
    });

    try {
      await queueCompletedCrawlAnalysis(db, {
        crawlJobId: job.id,
        ownerId: job.ownerId,
        siteUrl: job.siteUrl,
      });
    } catch (enqueueError) {
      console.error('[crawl] Completed crawl analysis enqueue failed:', enqueueError);
    }
  } catch (error) {
    throw attachCrawlProgressSnapshot(error, getCrawlProgressSnapshot(seen, queue, nextIndex, counters));
  } finally {
    clearInterval(heartbeatTimer);
    await Promise.allSettled(Array.from(inFlight));
    await leaseUpdateChain;
  }
}

async function markCrawlJobCancelled(db: AppDatabase, job: CrawlJobRecord) {
  await updateCrawlJob(db, job.id, {
    completedAt: nowIso(),
    lastError: null,
    lockedAt: null,
    nextRunAt: null,
    queuedCount: 0,
    status: 'cancelled',
  });
}

async function markOwnedCrawlJobCancelled(db: AppDatabase, job: ClaimedCrawlJobRecord, progress?: CrawlJobProgressSnapshot | null) {
  await finalizeOwnedCrawlJob(db, job, {
    completedAt: nowIso(),
    crawledCount: progress?.crawledCount,
    discoveredCount: progress?.discoveredCount,
    errorCount: progress?.errorCount,
    lastError: null,
    nextRunAt: null,
    queuedCount: 0,
    skippedCount: progress?.skippedCount,
    status: 'cancelled',
  });
}

async function syncCancelledCrawlJobProgress(db: AppDatabase, jobId: string, progress?: CrawlJobProgressSnapshot | null) {
  if (!progress) {
    return;
  }

  await db.run(
    `
      UPDATE crawl_jobs
      SET crawledCount = ?,
          discoveredCount = ?,
          errorCount = ?,
          queuedCount = 0,
          skippedCount = ?,
          updatedAt = ?
      WHERE id = ?
        AND status = 'cancelled'
    `,
    [progress.crawledCount, progress.discoveredCount, progress.errorCount, progress.skippedCount, nowIso(), jobId],
  );
}

async function recoverInterruptedCrawlJobs(db: AppDatabase) {
  const cutoff = new Date(Date.now() - getCrawlRunningLockTimeoutMs()).toISOString();
  await db.run(
    `
      UPDATE crawl_jobs
      SET status = 'queued',
          lockedAt = NULL,
          nextRunAt = ?,
          updatedAt = ?,
          lastError = COALESCE(lastError, 'Recovered after interrupted crawl worker.')
      WHERE status = 'running'
        AND (lockedAt IS NULL OR lockedAt < ?)
    `,
    [nowIso(), nowIso(), cutoff],
  );
}

async function claimNextQueuedCrawlJobPostgres(db: AppDatabase) {
  const claim = db.transaction(async () => {
    await db.exec('SELECT pg_advisory_xact_lock(864203198)');
    const now = nowIso();
    return db.get<ClaimedCrawlJobRecord>(
      `
        WITH ranked AS (
          SELECT
            j.id,
            ROW_NUMBER() OVER (
              PARTITION BY j.ownerId, j.siteUrl
              ORDER BY COALESCE(j.nextRunAt, j.updatedAt) ASC, j.updatedAt ASC, j.id ASC
            ) AS siteRank,
            (
              SELECT COUNT(*)
              FROM crawl_jobs running_owner
              WHERE running_owner.status = 'running'
                AND running_owner.ownerId = j.ownerId
            ) AS ownerRunningCount
          FROM crawl_jobs j
          WHERE j.status IN ('queued', 'retrying')
            AND (j.nextRunAt IS NULL OR j.nextRunAt <= ?)
            AND NOT EXISTS (
              SELECT 1
              FROM crawl_jobs running_site
              WHERE running_site.status = 'running'
                AND running_site.ownerId = j.ownerId
                AND running_site.siteUrl = j.siteUrl
            )
        ),
        candidate AS (
          SELECT j.id
          FROM crawl_jobs j
          INNER JOIN ranked ON ranked.id = j.id
          WHERE ranked.siteRank = 1
          ORDER BY ranked.ownerRunningCount ASC, COALESCE(j.nextRunAt, j.updatedAt) ASC, j.updatedAt ASC, j.id ASC
          LIMIT 1
          FOR UPDATE OF j SKIP LOCKED
        )
        UPDATE crawl_jobs j
        SET status = 'running',
            attemptCount = COALESCE(attemptCount, 0) + 1,
            startedAt = COALESCE(startedAt, ?),
            updatedAt = ?,
            lockedAt = ?,
            completedAt = NULL,
            lastError = NULL
        FROM candidate
        WHERE j.id = candidate.id
        RETURNING j.*
      `,
      [now, now, now, now],
    );
  });
  return (await claim()) || null;
}

async function claimNextQueuedCrawlJobSqlite(db: AppDatabase) {
  const claim = db.transaction(async () => {
    const now = nowIso();
    const candidates = await db.all<CrawlJobRecord>(
      `
        WITH ranked AS (
          SELECT
            j.*,
            ROW_NUMBER() OVER (
              PARTITION BY j.ownerId, j.siteUrl
              ORDER BY COALESCE(j.nextRunAt, j.updatedAt) ASC, j.updatedAt ASC, j.id ASC
            ) AS siteRank,
            (
              SELECT COUNT(*)
              FROM crawl_jobs running_owner
              WHERE running_owner.status = 'running'
                AND running_owner.ownerId = j.ownerId
            ) AS ownerRunningCount
          FROM crawl_jobs j
          WHERE j.status IN ('queued', 'retrying')
            AND (j.nextRunAt IS NULL OR j.nextRunAt <= ?)
            AND NOT EXISTS (
              SELECT 1
              FROM crawl_jobs running_site
              WHERE running_site.status = 'running'
                AND running_site.ownerId = j.ownerId
                AND running_site.siteUrl = j.siteUrl
            )
        )
        SELECT *
        FROM ranked
        WHERE siteRank = 1
        ORDER BY ownerRunningCount ASC, COALESCE(nextRunAt, updatedAt) ASC, updatedAt ASC, id ASC
        LIMIT ?
      `,
      [now, CRAWL_SQLITE_CLAIM_BATCH_SIZE],
    );

    for (const candidate of candidates) {
      const result = await db.run(
        `
          UPDATE crawl_jobs
          SET status = 'running',
              attemptCount = COALESCE(attemptCount, 0) + 1,
              startedAt = COALESCE(startedAt, ?),
              updatedAt = ?,
              lockedAt = ?,
              completedAt = NULL,
              lastError = NULL
          WHERE id = ?
            AND status IN ('queued', 'retrying')
            AND (nextRunAt IS NULL OR nextRunAt <= ?)
            AND NOT EXISTS (
              SELECT 1
              FROM crawl_jobs running_site
              WHERE running_site.status = 'running'
                AND running_site.ownerId = ?
                AND running_site.siteUrl = ?
                AND running_site.id <> ?
            )
        `,
        [now, now, now, candidate.id, now, candidate.ownerId, candidate.siteUrl, candidate.id],
      );

      if (result.changes > 0) {
        return (await db.get<ClaimedCrawlJobRecord>('SELECT * FROM crawl_jobs WHERE id = ?', [candidate.id])) || null;
      }
    }

    return null;
  });

  return withCrawlSqliteClaimLock(() => claim());
}

async function claimNextQueuedCrawlJob(db: AppDatabase) {
  return db.dialect === 'postgres' ? claimNextQueuedCrawlJobPostgres(db) : claimNextQueuedCrawlJobSqlite(db);
}

async function markOwnedCrawlJobForRetry(
  db: AppDatabase,
  job: ClaimedCrawlJobRecord,
  error: unknown,
  progress?: CrawlJobProgressSnapshot | null,
) {
  const attemptCount = Number(job.attemptCount || 0);
  const maxAttempts = Number(job.maxAttempts || DEFAULT_MAX_ATTEMPTS);
  const message = error instanceof Error ? error.message : 'Crawl failed';
  const shouldRetry = attemptCount < maxAttempts;
  const retryDelayMs = Math.min(30 * 60 * 1000, 60 * 1000 * Math.max(1, attemptCount));
  const nextRunAt = new Date(Date.now() + retryDelayMs).toISOString();

  await finalizeOwnedCrawlJob(db, job, {
    completedAt: shouldRetry ? null : nowIso(),
    crawledCount: progress?.crawledCount,
    discoveredCount: progress?.discoveredCount,
    errorCount: progress?.errorCount,
    lastError: message,
    nextRunAt: shouldRetry ? nextRunAt : null,
    queuedCount: 0,
    skippedCount: progress?.skippedCount,
    status: shouldRetry ? 'retrying' : 'error',
  });
}

export function startCrawlQueueWorker(db: AppDatabase) {
  let stopped = false;
  let ticking = false;
  const activeJobs = new Set<Promise<void>>();
  const pollMs = getCrawlQueuePollMs();
  const maxConcurrentJobs = getCrawlJobWorkerCount();

  const launchJob = (job: ClaimedCrawlJobRecord) => {
    let task: Promise<void>;
    task = (async () => {
      try {
        await executeCrawlJob(db, job);
      } catch (error) {
        const progress = readCrawlProgressSnapshot(error);
        if (error instanceof CrawlLeaseLostError) {
          return;
        }
        if (error instanceof CrawlCancelledError) {
          try {
            await markOwnedCrawlJobCancelled(db, job, progress);
          } catch (finalizeError) {
            if (finalizeError instanceof CrawlCancelledError) {
              await syncCancelledCrawlJobProgress(db, job.id, progress);
              return;
            }
            if (!(finalizeError instanceof CrawlLeaseLostError)) {
              throw finalizeError;
            }
          }
          return;
        }
        try {
          await markOwnedCrawlJobForRetry(db, job, error, progress);
        } catch (finalizeError) {
          if (finalizeError instanceof CrawlCancelledError) {
            await syncCancelledCrawlJobProgress(db, job.id, progress);
            return;
          }
          if (!(finalizeError instanceof CrawlLeaseLostError)) {
            throw finalizeError;
          }
        }
      }
    })()
      .catch((error) => {
        console.error('[crawl] Job execution failed:', error);
      })
      .finally(() => {
        activeJobs.delete(task);
        void tick();
      });
    activeJobs.add(task);
  };

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await recoverInterruptedCrawlJobs(db);
      while (!stopped && activeJobs.size < maxConcurrentJobs) {
        const job = await claimNextQueuedCrawlJob(db);
        if (!job) {
          break;
        }
        launchJob(job);
      }
    } catch (error) {
      console.error('[crawl] Queue worker failed:', error);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, pollMs);

  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function listCrawlPages(
  db: AppDatabase,
  ownerId: string,
  siteUrl: string,
  limit: number,
  offset: number,
  search?: string | null,
  jobId?: string | null,
  issue?: CrawlIssueFilter | null,
) {
  const activeJob = await getCrawlJob(db, ownerId, siteUrl, jobId);
  if (!activeJob) {
    return { job: null, page: { limit, offset, total: 0 }, rows: [] as CrawlPageRecord[], summary: null };
  }

  const params: unknown[] = [ownerId, siteUrl, activeJob.id];
  const where: string[] = ['p.ownerId = ?', 'p.siteUrl = ?', 'p.jobId = ?'];
  if (search) {
    const term = `%${search.trim().toLowerCase()}%`;
    where.push('(LOWER(p.url) LIKE ? OR LOWER(p.title) LIKE ? OR LOWER(p.canonicalUrl) LIKE ?)');
    params.push(term, term, term);
  }
  switch (issue) {
    case 'issues':
      where.push(`(
        p.statusCode IS NULL
        OR p.statusCode >= 400
        OR p.noindex = 1
        OR p.title IS NULL
        OR TRIM(p.title) = ''
        OR p.metaDescription IS NULL
        OR TRIM(p.metaDescription) = ''
        OR (p.canonicalUrl IS NOT NULL AND p.canonicalUrl <> '' AND p.canonicalUrl <> p.normalizedUrl)
        OR COALESCE(p.inboundLinkCount, 0) = 0
      )`);
      break;
    case 'success':
      where.push('p.statusCode BETWEEN 200 AND 299');
      break;
    case 'redirect':
      where.push('p.statusCode BETWEEN 300 AND 399');
      break;
    case 'error':
      where.push('p.statusCode >= 400');
      break;
    case 'no_response':
      where.push('p.statusCode IS NULL');
      break;
    case 'noindex':
      where.push('p.noindex = 1');
      break;
    case 'orphan':
      where.push('COALESCE(p.inboundLinkCount, 0) = 0');
      break;
    case 'missing_title':
      where.push("(p.title IS NULL OR TRIM(p.title) = '')");
      break;
    case 'missing_meta':
      where.push("(p.metaDescription IS NULL OR TRIM(p.metaDescription) = '')");
      break;
    case 'canonicalized':
      where.push("(p.canonicalUrl IS NOT NULL AND p.canonicalUrl <> '' AND p.canonicalUrl <> p.normalizedUrl)");
      break;
  }

  const total = await db.get<any>(
    `SELECT COUNT(*) AS total FROM crawl_pages p WHERE ${where.join(' AND ')}`,
    params,
  );

  const rows = await db.all<CrawlPageRecord & { inboundLinkCount: number }>(
    `
      SELECT
        p.siteUrl,
        p.url,
        p.normalizedUrl,
        p.pageKey,
        p.resolvedCanonicalPageKey,
        p.finalUrl,
        p.statusCode,
        p.contentType,
        p.title,
        p.metaDescription,
        p.h1Text,
        p.h1Count,
        p.h2Count,
        p.wordCount,
        p.canonicalUrl,
        p.noindex,
        p.depth,
        p.discoveredFrom,
        p.discoveredFromUrl,
        p.discoveredAt,
        p.crawledAt,
        p.responseTimeMs,
        p.internalLinkCount,
        p.outgoingLinkCount,
        p.errorMessage,
        COALESCE(p.inboundLinkCount, 0) AS "inboundLinkCount"
      FROM crawl_pages p
      WHERE ${where.join(' AND ')}
      ORDER BY p.crawledAt DESC, p.depth ASC, p.url ASC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );

  const summary = await getSummaryForJob(db, ownerId, siteUrl, activeJob.id);

  return {
    job: activeJob,
    page: {
      limit,
      offset,
      total: toFiniteNumber(total?.total),
    },
    rows,
    summary,
  };
}

async function listCrawlLinks(
  db: AppDatabase,
  ownerId: string,
  siteUrl: string,
  limit: number,
  offset: number,
  search?: string | null,
  jobId?: string | null,
) {
  const activeJob = await getCrawlJob(db, ownerId, siteUrl, jobId);
  if (!activeJob) {
    return { job: null, page: { limit, offset, total: 0 }, rows: [] as CrawlLinkRecord[] };
  }

  const params: unknown[] = [ownerId, siteUrl, activeJob.id];
  const where = ['ownerId = ?', 'siteUrl = ?', 'jobId = ?'];
  if (search) {
    const term = `%${search.trim().toLowerCase()}%`;
    where.push(`(
      LOWER(fromUrl) LIKE ?
      OR LOWER(toUrl) LIKE ?
      OR LOWER(fromPageKey) LIKE ?
      OR LOWER(toPageKey) LIKE ?
      OR LOWER(COALESCE(anchorText, '')) LIKE ?
      OR LOWER(COALESCE(contextText, '')) LIKE ?
    )`);
    params.push(term, term, term, term, term, term);
  }

  const total = await db.get<any>(
    `SELECT COUNT(*) AS total FROM crawl_links WHERE ${where.join(' AND ')}`,
    params,
  );
  const rows = await db.all<CrawlLinkRecord>(
    `
      SELECT siteUrl, fromUrl, toUrl, fromPageKey, toPageKey, anchorText, contextText, discoveredAt, depth
      FROM crawl_links
      WHERE ${where.join(' AND ')}
      ORDER BY depth ASC, fromUrl ASC, toUrl ASC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );

  return {
    job: activeJob,
    page: {
      limit,
      offset,
      total: toFiniteNumber(total?.total),
    },
    rows,
  };
}

export const __crawlExtractionTestUtils = {
  extractPageSnapshot,
};

export const __crawlQueueTestUtils = {
  claimNextQueuedCrawlJob,
  computeInboundCounts,
  recoverInterruptedCrawlJobs,
};

export async function getCrawlStatus(db: AppDatabase, ownerId: string, siteUrl: string, jobId?: string | null): Promise<CrawlStatusResponse> {
  const job = await getCrawlJob(db, ownerId, siteUrl, jobId);
  if (!job) {
    return { job: null, summary: null };
  }
  return {
    job,
    summary: await getSummaryForJob(db, ownerId, siteUrl, job.id),
  };
}

export async function getCrawlJobs(db: AppDatabase, ownerId: string, siteUrl: string, limit = 20): Promise<CrawlJobListResponse> {
  return {
    jobs: await listJobsForSite(db, ownerId, siteUrl, limit),
  };
}

export async function getCrawlPages(
  db: AppDatabase,
  ownerId: string,
  siteUrl: string,
  limit: number,
  offset: number,
  search?: string | null,
  jobId?: string | null,
  issue?: CrawlIssueFilter | null,
): Promise<CrawlPageListResponse> {
  return listCrawlPages(db, ownerId, siteUrl, limit, offset, search, jobId, issue);
}

export async function getCrawlLinks(
  db: AppDatabase,
  ownerId: string,
  siteUrl: string,
  limit: number,
  offset: number,
  search?: string | null,
  jobId?: string | null,
): Promise<CrawlLinkListResponse> {
  return listCrawlLinks(db, ownerId, siteUrl, limit, offset, search, jobId);
}

export async function queueCrawlJob(db: AppDatabase, input: StartCrawlInput & { ownerId: string }) {
  return createQueuedCrawlJob(db, input);
}

export async function cancelCrawlJob(db: AppDatabase, ownerId: string, siteUrl: string, jobId: string) {
  const job = await getJobById(db, ownerId, siteUrl, jobId);
  if (!job) {
    return null;
  }

  if (!['queued', 'retrying', 'running'].includes(job.status)) {
    return job;
  }

  await markCrawlJobCancelled(db, job);
  return (await getJobById(db, ownerId, siteUrl, jobId)) || job;
}

export async function compareCrawlJobs(
  db: AppDatabase,
  ownerId: string,
  siteUrl: string,
  baseJobId?: string | null,
  compareJobId?: string | null,
): Promise<CrawlCompareResponse> {
  const baseJob = await getCrawlJob(db, ownerId, siteUrl, baseJobId);
  const compareJob = baseJob
    ? compareJobId
      ? await getJobById(db, ownerId, siteUrl, compareJobId)
      : await getPreviousJob(db, ownerId, siteUrl, baseJob.id)
    : null;

  if (!baseJob || !compareJob) {
    return {
      baseJob: baseJob || null,
      compareJob: compareJob || null,
      samples: { canonicalChanged: [], missing: [], new: [], statusChanged: [], titleChanged: [] },
      summary: { canonicalChanged: 0, missing: 0, new: 0, statusChanged: 0, titleChanged: 0, unchanged: 0 },
    };
  }

  const [baseRows, compareRows] = await Promise.all([
    db.all<CrawlPageRecord>('SELECT * FROM crawl_pages WHERE ownerId = ? AND siteUrl = ? AND jobId = ?', [ownerId, siteUrl, baseJob.id]),
    db.all<CrawlPageRecord>('SELECT * FROM crawl_pages WHERE ownerId = ? AND siteUrl = ? AND jobId = ?', [ownerId, siteUrl, compareJob.id]),
  ]);

  const previousByKey = new Map(compareRows.map((row) => [row.pageKey || row.normalizedUrl, row]));
  const currentByKey = new Map(baseRows.map((row) => [row.pageKey || row.normalizedUrl, row]));
  const samples: CrawlCompareResponse['samples'] = {
    canonicalChanged: [],
    missing: [],
    new: [],
    statusChanged: [],
    titleChanged: [],
  };
  const summary = {
    canonicalChanged: 0,
    missing: 0,
    new: 0,
    statusChanged: 0,
    titleChanged: 0,
    unchanged: 0,
  };

  for (const row of baseRows) {
    const key = row.pageKey || row.normalizedUrl;
    const previous = previousByKey.get(key);
    if (!previous) {
      summary.new += 1;
      if (samples.new.length < 20) samples.new.push({ url: row.url });
      continue;
    }

    let changed = false;
    if ((row.statusCode || null) !== (previous.statusCode || null)) {
      changed = true;
      summary.statusChanged += 1;
      if (samples.statusChanged.length < 20) samples.statusChanged.push({ currentStatus: row.statusCode || null, previousStatus: previous.statusCode || null, url: row.url });
    }
    if ((row.title || '') !== (previous.title || '')) {
      changed = true;
      summary.titleChanged += 1;
      if (samples.titleChanged.length < 20) samples.titleChanged.push({ currentTitle: row.title || null, previousTitle: previous.title || null, url: row.url });
    }
    if ((row.canonicalUrl || '') !== (previous.canonicalUrl || '')) {
      changed = true;
      summary.canonicalChanged += 1;
      if (samples.canonicalChanged.length < 20) samples.canonicalChanged.push({ currentCanonical: row.canonicalUrl || null, previousCanonical: previous.canonicalUrl || null, url: row.url });
    }
    if (!changed) {
      summary.unchanged += 1;
    }
  }

  for (const row of compareRows) {
    const key = row.pageKey || row.normalizedUrl;
    if (!currentByKey.has(key)) {
      summary.missing += 1;
      if (samples.missing.length < 20) samples.missing.push({ url: row.url });
    }
  }

  return {
    baseJob,
    compareJob,
    samples,
    summary,
  };
}
