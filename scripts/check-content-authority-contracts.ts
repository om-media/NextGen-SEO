import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SESSION_COOKIE_NAME, createUserSession } from '../server/auth.js';
import { initializeDatabase, type AppDatabase } from '../server/database.js';

type FakeRequest = {
  authUser?: { uid: string };
  body?: Record<string, unknown>;
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, unknown>;
};

class FakeResponse {
  statusCode = 200;
  body: unknown = null;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown) {
    this.body = payload;
    return this;
  }

  send(payload: unknown) {
    this.body = payload;
    return this;
  }

  type(_value: string) {
    return this;
  }
}

class FakeApp {
  routes = new Map<string, Array<(req: FakeRequest, res: FakeResponse, next: (err?: unknown) => Promise<void>) => unknown>>();

  get(pathname: string, ...handlers: Array<(req: FakeRequest, res: FakeResponse, next: (err?: unknown) => Promise<void>) => unknown>) {
    this.routes.set(`GET:${pathname}`, handlers);
  }
}

function isoNow() {
  return '2026-07-17T09:30:00.000Z';
}

async function invokeRoute(
  app: FakeApp,
  key: string,
  input: {
    body?: Record<string, unknown>;
    cookie?: string;
    params?: Record<string, string>;
    query?: Record<string, unknown>;
  } = {},
) {
  const handlers = app.routes.get(key);
  assert(handlers && handlers.length > 0, `Missing route ${key}`);

  const req: FakeRequest = {
    body: input.body || {},
    headers: input.cookie ? { cookie: input.cookie } : {},
    params: input.params || {},
    query: input.query || {},
  };
  const res = new FakeResponse();

  const runIndex = async (index: number): Promise<void> => {
    const handler = handlers[index];
    if (!handler) return;
    let downstream: Promise<void> | null = null;
    const next = async (err?: unknown) => {
      if (err) throw err;
      downstream = runIndex(index + 1);
      return downstream;
    };
    await handler(req, res, next);
    if (downstream) {
      await downstream;
    }
  };

  await runIndex(0);
  return res;
}

async function tableColumns(db: AppDatabase, tableName: string) {
  const rows = await db.all<Array<{ name?: string } & Record<string, unknown>>[number]>(`PRAGMA table_info(${tableName})`);
  return rows.map((row) => String(row.name || '')).filter(Boolean);
}

function sourcePath(relativePath: string) {
  return new URL(relativePath, import.meta.url);
}

function readSource(relativePath: string) {
  return fs.readFileSync(sourcePath(relativePath), 'utf8');
}

function sectionBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  if (start === -1) return '';
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

type ContentAuthorityReadinessFn = (db: AppDatabase, ownerId: string, input: { siteUrl: string; crawlJobId?: string | null }) => Promise<any>;
type ContentAuthorityPagesFn = (db: AppDatabase, ownerId: string, input: { siteUrl: string; crawlJobId?: string | null; limit: number; offset: number; search?: string | null }) => Promise<any>;
type ContentAuthorityTemplatesFn = (db: AppDatabase, ownerId: string, input: { siteUrl: string; crawlJobId?: string | null }) => Promise<any>;
type ContentAuthorityEvidenceFn = (db: AppDatabase, ownerId: string, input: { siteUrl: string; pageKey: string; crawlJobId?: string | null }) => Promise<any>;

type ContentAuthorityRuntime = {
  getContentAuthorityPageEvidence: ContentAuthorityEvidenceFn | null;
  getContentAuthorityReadiness: ContentAuthorityReadinessFn | null;
  listContentAuthorityPages: ContentAuthorityPagesFn | null;
  listContentAuthorityTemplates: ContentAuthorityTemplatesFn | null;
  registerContentAuthorityRoutes: ((app: any, db: AppDatabase) => void) | null;
  routeError: string | null;
  serviceError: string | null;
};

async function loadContentAuthorityRuntime(): Promise<ContentAuthorityRuntime> {
  const runtime: ContentAuthorityRuntime = {
    getContentAuthorityPageEvidence: null,
    getContentAuthorityReadiness: null,
    listContentAuthorityPages: null,
    listContentAuthorityTemplates: null,
    registerContentAuthorityRoutes: null,
    routeError: null,
    serviceError: null,
  };

  try {
    const serviceModule = await import('../server/services/contentAuthority.js');
    const missing: string[] = [];

    runtime.getContentAuthorityPageEvidence = typeof serviceModule.getContentAuthorityPageEvidence === 'function'
      ? serviceModule.getContentAuthorityPageEvidence as ContentAuthorityEvidenceFn
      : (missing.push('getContentAuthorityPageEvidence'), null);
    runtime.getContentAuthorityReadiness = typeof serviceModule.getContentAuthorityReadiness === 'function'
      ? serviceModule.getContentAuthorityReadiness as ContentAuthorityReadinessFn
      : (missing.push('getContentAuthorityReadiness'), null);
    runtime.listContentAuthorityPages = typeof serviceModule.listContentAuthorityPages === 'function'
      ? serviceModule.listContentAuthorityPages as ContentAuthorityPagesFn
      : (missing.push('listContentAuthorityPages'), null);
    runtime.listContentAuthorityTemplates = typeof serviceModule.listContentAuthorityTemplates === 'function'
      ? serviceModule.listContentAuthorityTemplates as ContentAuthorityTemplatesFn
      : (missing.push('listContentAuthorityTemplates'), null);

    if (missing.length) {
      runtime.serviceError = `server/services/contentAuthority.ts is missing expected exports: ${missing.join(', ')}.`;
    }
  } catch (error) {
    runtime.serviceError = `Failed to import server/services/contentAuthority.js: ${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    const routeModule = await import('../server/routes/contentAuthority.js');
    runtime.registerContentAuthorityRoutes = typeof routeModule.registerContentAuthorityRoutes === 'function'
      ? routeModule.registerContentAuthorityRoutes as (app: any, db: AppDatabase) => void
      : null;
    if (!runtime.registerContentAuthorityRoutes) {
      runtime.routeError = 'server/routes/contentAuthority.ts is missing export registerContentAuthorityRoutes.';
    }
  } catch (error) {
    runtime.routeError = `Failed to import server/routes/contentAuthority.js: ${error instanceof Error ? error.message : String(error)}`;
  }

  return runtime;
}

async function requireRegionJobSchema(db: AppDatabase) {
  const columns = await tableColumns(db, 'crawl_page_regions');
  const missing = ['ownerId', 'siteUrl', 'jobId', 'pageKey', 'extractionVersion'].filter((name) => !columns.includes(name));
  if (missing.length) {
    throw new Error(`crawl_page_regions is missing required columns for the agreed contract: ${missing.join(', ')}.`);
  }
}

async function requireTextBlockSchema(db: AppDatabase) {
  const columns = await tableColumns(db, 'crawl_page_text_blocks');
  const missing = ['ownerId', 'siteUrl', 'jobId', 'pageKey', 'blockKey', 'regionIndex', 'extractionVersion'].filter((name) => !columns.includes(name));
  if (missing.length) {
    throw new Error(`crawl_page_text_blocks is missing required columns for stable blockKey evidence: ${missing.join(', ')}.`);
  }
}

async function requireTemplateMembershipSchema(db: AppDatabase) {
  const columns = await tableColumns(db, 'page_template_members');
  const missing = ['ownerId', 'siteUrl', 'siteScopeId', 'crawlJobId', 'templateKey', 'pageKey'].filter((name) => !columns.includes(name));
  if (!missing.length) return;
  throw new Error(`page_template_members is missing expected scope columns: ${missing.join(', ')}.`);
}

async function checkStableBlockKeySupport(db: AppDatabase, notes: string[]) {
  await requireRegionJobSchema(db);
  notes.push('Verified crawl_page_regions contract requires ownerId/siteUrl/jobId/pageKey/extractionVersion columns.');
}

async function requireExtractionVersionReadinessGate(db: AppDatabase) {
  await requireRegionJobSchema(db);

  const siteUrl = 'https://legacy-authority.example/';
  await seedSiteScope(db, {
    ownerId: 'owner-a',
    scopeId: 'scope-legacy',
    canonicalDomain: 'legacy-authority.example',
    siteUrl,
  });
  await seedCrawlJob(db, { id: 'crawl-legacy', ownerId: 'owner-a', siteUrl });
  await seedAnalysisJob(db, {
    id: 'analysis-legacy',
    ownerId: 'owner-a',
    siteScopeId: 'scope-legacy',
    siteUrl,
    crawlJobId: 'crawl-legacy',
    status: 'completed',
    extractionVersion: 2,
  });
  await seedCrawlPage(db, {
    ownerId: 'owner-a',
    siteUrl,
    jobId: 'crawl-legacy',
    url: `${siteUrl}guide`,
    pageKey: 'legacy-guide',
    title: 'Legacy guide',
  });
  await seedTemplateCluster(db, {
    ownerId: 'owner-a',
    siteUrl,
    siteScopeId: 'scope-legacy',
    crawlJobId: 'crawl-legacy',
    templateKey: 'tpl-legacy',
    exemplarPageKey: 'legacy-guide',
    memberCount: 1,
    confidence: 0.95,
  });
  await seedTemplateMember(db, {
    ownerId: 'owner-a',
    siteUrl,
    siteScopeId: 'scope-legacy',
    crawlJobId: 'crawl-legacy',
    templateKey: 'tpl-legacy',
    pageKey: 'legacy-guide',
    distance: 0,
    isExemplar: true,
  });
  await seedProfile(db, {
    ownerId: 'owner-a',
    siteUrl,
    siteScopeId: 'scope-legacy',
    crawlJobId: 'crawl-legacy',
    pageKey: 'legacy-guide',
    templateKey: 'tpl-legacy',
    pageType: 'article',
    primaryTask: 'learn',
    confidence: 0.91,
  });
  await seedRegion(db, {
    ownerId: 'owner-a',
    siteUrl,
    crawlJobId: 'crawl-legacy',
    pageUrl: `${siteUrl}guide`,
    pageKey: 'legacy-guide',
    regionIndex: 0,
    regionRole: 'main',
    text: 'Legacy evidence region',
    extractionVersion: 2,
    confidence: 0.9,
  });

  const serviceModule = await import('../server/services/contentAuthority.js');
  assert.equal(typeof serviceModule.getContentAuthorityReadiness, 'function', 'Missing getContentAuthorityReadiness export.');
  const payload = await serviceModule.getContentAuthorityReadiness(db, 'owner-a', { siteUrl });

  assertStatus(payload.status, 'partial', 'legacy extraction readiness');
  assert.notEqual(payload.status, 'ready', 'Legacy extraction evidence must not report ready.');
  assert.equal(payload.version?.state, 'outdated', `Expected outdated version state, got ${String(payload.version?.state)}`);
  assert.equal(payload.version?.requiredExtractionVersion, 3);
  assert.equal(payload.version?.jobExtractionVersion, 2);
  assert.equal(payload.version?.minimumExtractionVersion, 2);
}

function requireScopedTemplateMemberGuards() {
  const serviceSource = readSource('../server/services/contentAuthority.ts');
  const deficiencies: string[] = [];

  if (serviceSource.includes('JOIN page_template_clusters clusters ON clusters.templateKey = members.templateKey')) {
    deficiencies.push('page_template_members is joined to page_template_clusters by templateKey alone, without ownerId/siteScopeId/siteUrl/crawlJobId guards.');
  }
  if (serviceSource.includes('LEFT JOIN page_template_members members ON members.pageKey = keys.pageKey AND members.templateKey = profiles.templateKey')) {
    deficiencies.push('listContentAuthorityPages resolves template membership by pageKey/templateKey only, so a shared templateKey can attach foreign membership rows.');
  }
  if (serviceSource.includes("SELECT distance, isExemplar FROM page_template_members WHERE templateKey = ? AND pageKey = ? LIMIT 1")) {
    deficiencies.push('getContentAuthorityPageEvidence reads membership by templateKey/pageKey only and can leak foreign distance/isExemplar state when template keys collide across sites or owners.');
  }

  if (deficiencies.length) {
    throw new Error([
      'Content-authority template membership joins are not fully scope-guarded.',
      ...deficiencies,
    ].join(' '));
  }
}

async function seedUser(db: AppDatabase, input: { id: string; knownSites: string[] }) {
  await db.run(
    `INSERT INTO users (
      id, email, passwordHash, authProvider, name, tier, unlockedSites, knownSites, onboardingCompleted, createdAt
    ) VALUES (?, ?, ?, 'local', ?, 'enterprise', ?, ?, 1, ?)`,
    [
      input.id,
      `${input.id}@example.com`,
      'hash',
      input.id,
      JSON.stringify([]),
      JSON.stringify(input.knownSites),
      isoNow(),
    ],
  );
}

async function seedSiteScope(db: AppDatabase, input: {
  ownerId: string;
  scopeId: string;
  canonicalDomain: string;
  siteUrl: string;
  sourceKey?: string;
  sourceType?: string;
}) {
  await db.run(
    'INSERT INTO site_scopes (id, ownerId, canonicalDomain, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
    [input.scopeId, input.ownerId, input.canonicalDomain, isoNow(), isoNow()],
  );
  await db.run(
    'INSERT INTO site_scope_sources (siteScopeId, sourceType, sourceKey, siteUrl, propertyId, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, ?, ?)',
    [input.scopeId, input.sourceType || 'gsc', input.sourceKey || input.siteUrl, input.siteUrl, isoNow(), isoNow()],
  );
}

async function seedCrawlJob(db: AppDatabase, input: {
  id: string;
  ownerId: string;
  siteUrl: string;
  status?: string;
}) {
  await db.run(
    `INSERT INTO crawl_jobs (
      id, ownerId, siteUrl, startUrl, sitemapUrl, status, maxPages, maxDepth,
      discoveredCount, crawledCount, errorCount, skippedCount, queuedCount,
      startedAt, updatedAt, completedAt, lastError, attemptCount, maxAttempts,
      lockedAt, nextRunAt, renderMode, respectRobots, includeQueryStrings, userAgent, canonicalMetricsVersion
    ) VALUES (?, ?, ?, ?, NULL, ?, 1000, 3, 0, 0, 0, 0, 0, ?, ?, ?, NULL, 0, 3, NULL, NULL, 'html', 1, 0, 'contract-check', 1)`,
    [
      input.id,
      input.ownerId,
      input.siteUrl,
      input.siteUrl,
      input.status || 'completed',
      isoNow(),
      isoNow(),
      input.status === 'completed' ? isoNow() : null,
    ],
  );
}

async function seedAnalysisJob(db: AppDatabase, input: {
  id: string;
  ownerId: string;
  siteScopeId: string;
  siteUrl: string;
  crawlJobId: string;
  status: string;
  extractionVersion?: number;
  lastError?: string | null;
}) {
  await db.run(
    `INSERT INTO page_analysis_jobs (
      id, ownerId, siteScopeId, siteUrl, crawlJobId, analysisType, status,
      progressTotal, progressCompleted, attemptCount, maxAttempts, lockedAt, nextRunAt,
      startedAt, updatedAt, completedAt, lastError, provider, modelVersion, extractionVersion, metricsJson
    ) VALUES (?, ?, ?, ?, ?, 'content-authority', ?, 10, 10, 0, 3, NULL, NULL, ?, ?, ?, ?, 'local', 'rules-v1', ?, '{}')`,
    [
      input.id,
      input.ownerId,
      input.siteScopeId,
      input.siteUrl,
      input.crawlJobId,
      input.status,
      isoNow(),
      isoNow(),
      input.status === 'completed' ? isoNow() : null,
      input.lastError || null,
      input.extractionVersion ?? 3,
    ],
  );
}

async function seedCrawlPage(db: AppDatabase, input: {
  ownerId: string;
  siteUrl: string;
  jobId: string;
  url: string;
  pageKey: string;
  title?: string;
  statusCode?: number;
  wordCount?: number;
  depth?: number;
}) {
  await db.run(
    `INSERT INTO crawl_pages (
      ownerId, siteUrl, jobId, url, normalizedUrl, pageKey, resolvedCanonicalPageKey, finalUrl,
      statusCode, contentType, title, metaDescription, canonicalUrl, h1Text, h1Count, h2Count,
      wordCount, depth, discoveredFrom, discoveredFromUrl, discoveredAt, crawledAt, responseTimeMs,
      noindex, inboundLinkCount, internalLinkCount, outgoingLinkCount, errorMessage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'text/html', ?, NULL, ?, ?, 1, 1, ?, ?, 'seed', ?, ?, ?, 120, 0, 0, 0, 0, NULL)`,
    [
      input.ownerId,
      input.siteUrl,
      input.jobId,
      input.url,
      input.url,
      input.pageKey,
      input.pageKey,
      input.url,
      input.statusCode ?? 200,
      input.title ?? input.pageKey,
      input.url,
      input.title ?? input.pageKey,
      input.wordCount ?? 1200,
      input.depth ?? 1,
      input.url,
      isoNow(),
      isoNow(),
    ],
  );
}

async function seedProfile(db: AppDatabase, input: {
  ownerId: string;
  siteUrl: string;
  siteScopeId: string;
  crawlJobId: string;
  pageKey: string;
  templateKey?: string | null;
  pageType: string;
  primaryTask: string;
  confidence: number;
}) {
  await db.run(
    `INSERT INTO page_function_profiles (
      ownerId, siteUrl, siteScopeId, crawlJobId, pageKey, templateKey, pageType, primaryTask,
      secondaryTasksJson, centerpieceRegionIndex, confidence, featureBreakdownJson, manualOverrideJson,
      createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, '{"source":"seed"}', NULL, ?, ?)`,
    [
      input.ownerId,
      input.siteUrl,
      input.siteScopeId,
      input.crawlJobId,
      input.pageKey,
      input.templateKey || null,
      input.pageType,
      input.primaryTask,
      input.confidence,
      isoNow(),
      isoNow(),
    ],
  );
}

async function seedTemplateCluster(db: AppDatabase, input: {
  ownerId: string;
  siteUrl: string;
  siteScopeId: string;
  crawlJobId: string;
  templateKey: string;
  exemplarPageKey: string;
  memberCount: number;
  confidence: number;
}) {
  await db.run(
    `INSERT INTO page_template_clusters (
      ownerId, siteUrl, siteScopeId, crawlJobId, templateKey, exemplarPageKey,
      urlSkeleton, domSignature, regionSequenceHash, memberCount, confidence, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.ownerId,
      input.siteUrl,
      input.siteScopeId,
      input.crawlJobId,
      input.templateKey,
      input.exemplarPageKey,
      '/articles/{slug}',
      'dom-ready',
      'region-ready',
      input.memberCount,
      input.confidence,
      isoNow(),
      isoNow(),
    ],
  );
}

async function seedTemplateMember(db: AppDatabase, input: {
  ownerId: string;
  siteUrl: string;
  siteScopeId: string;
  crawlJobId: string;
  templateKey: string;
  pageKey: string;
  distance: number;
  isExemplar?: boolean;
}) {
  await db.run(
    `INSERT INTO page_template_members (
      ownerId, siteUrl, siteScopeId, crawlJobId, templateKey, pageKey, distance, isExemplar, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.ownerId,
      input.siteUrl,
      input.siteScopeId,
      input.crawlJobId,
      input.templateKey,
      input.pageKey,
      input.distance,
      input.isExemplar ? 1 : 0,
      isoNow(),
      isoNow(),
    ],
  );
}

async function seedRegion(db: AppDatabase, input: {
  ownerId: string;
  siteUrl: string;
  crawlJobId: string;
  pageUrl: string;
  pageKey: string;
  regionIndex: number;
  regionRole: string;
  text: string;
  blockKey?: string;
  extractionVersion?: number;
  confidence: number;
}) {
  await db.run(
    `INSERT INTO crawl_page_regions (
      ownerId, siteUrl, jobId, pageUrl, pageKey, regionIndex, parentRegionIndex, regionRole,
      componentType, blockKey, blockIndex, headingChainJson, domPath, selector, text, textHash,
      textDensity, linkDensity, boilerplateScore, templateFrequency, bboxX, bboxY, bboxWidth,
      bboxHeight, viewportProminence, visible, confidence, featureBreakdownJson, extractionVersion
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'hero', ?, 0, '["Hero"]', '/main', 'main', ?, 'hash',
      0.9, 0.1, 0.05, 1, 0, 0, 1200, 400, 0.95, 1, ?, '{"source":"seed"}', ?)`,
    [
      input.ownerId,
      input.siteUrl,
      input.crawlJobId,
      input.pageUrl,
      input.pageKey,
      input.regionIndex,
      input.regionRole,
      input.blockKey || `${input.pageKey}:region:${input.regionIndex}`,
      input.text,
      input.confidence,
      input.extractionVersion ?? 3,
    ],
  );
}

async function seedSentinelMetricRows(db: AppDatabase, ownerId: string, siteUrl: string) {
  await db.run(
    'INSERT INTO gsc_query_metrics (ownerId, siteUrl, date, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, 0, 0, 0, 0)',
    [ownerId, siteUrl, '2026-07-01', ''],
  );
  await db.run(
    'INSERT INTO gsc_page_metrics (ownerId, siteUrl, date, page, pageKey, clicks, impressions, ctr, position, queryCount) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0)',
    [ownerId, siteUrl, '2026-07-01', '', ''],
  );
  await db.run(
    'INSERT INTO ga4_dimension_metrics (ownerId, propertyId, siteUrl, date, dimension, dimensionValue, sessions, totalUsers, pageViews, bounceRate, eventCount) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)',
    [ownerId, 'prop-sentinel', siteUrl, '2026-07-01', 'browser', 'sentinel'],
  );
  await db.run(
    'INSERT INTO ga4_llm_referral_metrics (ownerId, propertyId, siteUrl, date, source, sourceClass, pagePath, pageKey, sessions, engagedSessions, keyEvents, averageSessionDuration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)',
    [ownerId, 'prop-sentinel', siteUrl, '2026-07-01', '', '', '', ''],
  );
}

type CheckContext = {
  ownerAToken: string;
  ownerBToken: string;
  sites: Record<string, string>;
};

async function seedFixture(db: AppDatabase): Promise<CheckContext> {
  const sites = {
    missing: 'https://missing-authority.example/',
    pending: 'https://pending-authority.example/',
    partial: 'https://partial-authority.example/',
    ready: 'https://ready-authority.example/',
    readyAlias: 'https://www.ready-authority.example/',
    scopedA: 'https://scoped-a.example/',
    scopedB: 'https://scoped-b.example/',
    sentinel: 'https://sentinel-authority.example/',
  };

  await seedUser(db, {
    id: 'owner-a',
    knownSites: [sites.missing, sites.pending, sites.partial, sites.ready, sites.readyAlias, sites.scopedA, sites.sentinel],
  });
  await seedUser(db, {
    id: 'owner-b',
    knownSites: [sites.scopedB],
  });

  await seedSiteScope(db, {
    ownerId: 'owner-a',
    scopeId: 'scope-pending',
    canonicalDomain: 'pending-authority.example',
    siteUrl: sites.pending,
  });
  await seedSiteScope(db, {
    ownerId: 'owner-a',
    scopeId: 'scope-partial',
    canonicalDomain: 'partial-authority.example',
    siteUrl: sites.partial,
  });
  await seedSiteScope(db, {
    ownerId: 'owner-a',
    scopeId: 'scope-ready',
    canonicalDomain: 'ready-authority.example',
    siteUrl: sites.ready,
  });
  await db.run(
    'INSERT INTO site_scope_sources (siteScopeId, sourceType, sourceKey, siteUrl, propertyId, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, ?, ?)',
    ['scope-ready', 'gsc-alias', sites.readyAlias, sites.readyAlias, isoNow(), isoNow()],
  );

  await seedSiteScope(db, {
    ownerId: 'owner-a',
    scopeId: 'scope-scoped-a',
    canonicalDomain: 'scoped-a.example',
    siteUrl: sites.scopedA,
  });
  await seedSiteScope(db, {
    ownerId: 'owner-b',
    scopeId: 'scope-scoped-b',
    canonicalDomain: 'scoped-b.example',
    siteUrl: sites.scopedB,
  });

  await seedCrawlJob(db, { id: 'crawl-pending', ownerId: 'owner-a', siteUrl: sites.pending, status: 'running' });
  await seedCrawlJob(db, { id: 'crawl-partial', ownerId: 'owner-a', siteUrl: sites.partial });
  await seedCrawlJob(db, { id: 'crawl-ready', ownerId: 'owner-a', siteUrl: sites.ready });
  await seedCrawlJob(db, { id: 'crawl-scoped-a', ownerId: 'owner-a', siteUrl: sites.scopedA });
  await seedCrawlJob(db, { id: 'crawl-scoped-b', ownerId: 'owner-b', siteUrl: sites.scopedB });

  await seedAnalysisJob(db, {
    id: 'analysis-pending',
    ownerId: 'owner-a',
    siteScopeId: 'scope-pending',
    siteUrl: sites.pending,
    crawlJobId: 'crawl-pending',
    status: 'running',
  });
  await seedAnalysisJob(db, {
    id: 'analysis-partial',
    ownerId: 'owner-a',
    siteScopeId: 'scope-partial',
    siteUrl: sites.partial,
    crawlJobId: 'crawl-partial',
    status: 'completed',
  });
  await seedAnalysisJob(db, {
    id: 'analysis-ready',
    ownerId: 'owner-a',
    siteScopeId: 'scope-ready',
    siteUrl: sites.ready,
    crawlJobId: 'crawl-ready',
    status: 'completed',
  });
  await seedAnalysisJob(db, {
    id: 'analysis-scoped-a',
    ownerId: 'owner-a',
    siteScopeId: 'scope-scoped-a',
    siteUrl: sites.scopedA,
    crawlJobId: 'crawl-scoped-a',
    status: 'completed',
  });
  await seedAnalysisJob(db, {
    id: 'analysis-scoped-b',
    ownerId: 'owner-b',
    siteScopeId: 'scope-scoped-b',
    siteUrl: sites.scopedB,
    crawlJobId: 'crawl-scoped-b',
    status: 'completed',
  });

  await seedProfile(db, {
    ownerId: 'owner-a',
    siteUrl: sites.partial,
    siteScopeId: 'scope-partial',
    crawlJobId: 'crawl-partial',
    pageKey: 'partial-page',
    pageType: 'article',
    primaryTask: 'learn',
    confidence: 0.81,
  });

  await seedCrawlPage(db, {
    ownerId: 'owner-a',
    siteUrl: sites.ready,
    jobId: 'crawl-ready',
    url: `${sites.ready}home`,
    pageKey: 'ready-home',
    title: 'Ready home',
  });
  await seedTemplateCluster(db, {
    ownerId: 'owner-a',
    siteUrl: sites.ready,
    siteScopeId: 'scope-ready',
    crawlJobId: 'crawl-ready',
    templateKey: 'tpl-ready',
    exemplarPageKey: 'ready-home',
    memberCount: 1,
    confidence: 0.96,
  });
  await seedTemplateMember(db, {
    ownerId: 'owner-a',
    siteUrl: sites.ready,
    siteScopeId: 'scope-ready',
    crawlJobId: 'crawl-ready',
    templateKey: 'tpl-ready',
    pageKey: 'ready-home',
    distance: 0,
    isExemplar: true,
  });
  await seedProfile(db, {
    ownerId: 'owner-a',
    siteUrl: sites.ready,
    siteScopeId: 'scope-ready',
    crawlJobId: 'crawl-ready',
    pageKey: 'ready-home',
    templateKey: 'tpl-ready',
    pageType: 'article',
    primaryTask: 'learn',
    confidence: 0.93,
  });
  await seedRegion(db, {
    ownerId: 'owner-a',
    siteUrl: sites.ready,
    crawlJobId: 'crawl-ready',
    pageUrl: `${sites.ready}home`,
    pageKey: 'ready-home',
    regionIndex: 0,
    regionRole: 'hero',
    text: 'Ready authority hero evidence',
    confidence: 0.92,
  });

  await seedCrawlJob(db, { id: 'crawl-ready-newer', ownerId: 'owner-a', siteUrl: sites.readyAlias, status: 'completed' });
  await seedAnalysisJob(db, {
    id: 'analysis-ready-newer',
    ownerId: 'owner-a',
    siteScopeId: 'scope-ready',
    siteUrl: sites.readyAlias,
    crawlJobId: 'crawl-ready-newer',
    status: 'running',
  });
  await db.run('UPDATE page_analysis_jobs SET updatedAt = ? WHERE id = ?', [new Date(Date.now() + 60000).toISOString(), 'analysis-ready-newer']);
  await seedTemplateCluster(db, {
    ownerId: 'owner-a',
    siteUrl: sites.scopedA,
    siteScopeId: 'scope-scoped-a',
    crawlJobId: 'crawl-scoped-a',
    templateKey: 'tpl-shared',
    exemplarPageKey: 'alpha-visible',
    memberCount: 1,
    confidence: 0.9,
  });
  await seedTemplateMember(db, {
    ownerId: 'owner-a',
    siteUrl: sites.scopedA,
    siteScopeId: 'scope-scoped-a',
    crawlJobId: 'crawl-scoped-a',
    templateKey: 'tpl-shared',
    pageKey: 'alpha-visible',
    distance: 0,
    isExemplar: true,
  });
  await seedProfile(db, {
    ownerId: 'owner-a',
    siteUrl: sites.scopedA,
    siteScopeId: 'scope-scoped-a',
    crawlJobId: 'crawl-scoped-a',
    pageKey: 'alpha-visible',
    templateKey: 'tpl-shared',
    pageType: 'article',
    primaryTask: 'learn',
    confidence: 0.88,
  });
  await seedRegion(db, {
    ownerId: 'owner-a',
    siteUrl: sites.scopedA,
    crawlJobId: 'crawl-scoped-a',
    pageUrl: `${sites.scopedA}alpha-visible`,
    pageKey: 'alpha-visible',
    regionIndex: 0,
    regionRole: 'main',
    text: 'Owner A evidence block',
    confidence: 0.87,
  });

  await seedTemplateCluster(db, {
    ownerId: 'owner-b',
    siteUrl: sites.scopedB,
    siteScopeId: 'scope-scoped-b',
    crawlJobId: 'crawl-scoped-b',
    templateKey: 'tpl-shared',
    exemplarPageKey: 'beta-secret',
    memberCount: 1,
    confidence: 0.91,
  });
  await seedTemplateMember(db, {
    ownerId: 'owner-b',
    siteUrl: sites.scopedB,
    siteScopeId: 'scope-scoped-b',
    crawlJobId: 'crawl-scoped-b',
    templateKey: 'tpl-shared',
    pageKey: 'beta-secret',
    distance: 0.42,
    isExemplar: true,
  });
  await seedProfile(db, {
    ownerId: 'owner-b',
    siteUrl: sites.scopedB,
    siteScopeId: 'scope-scoped-b',
    crawlJobId: 'crawl-scoped-b',
    pageKey: 'beta-secret',
    templateKey: 'tpl-shared',
    pageType: 'service',
    primaryTask: 'buy_or_hire',
    confidence: 0.84,
  });
  await seedRegion(db, {
    ownerId: 'owner-b',
    siteUrl: sites.scopedB,
    crawlJobId: 'crawl-scoped-b',
    pageUrl: `${sites.scopedB}beta-secret`,
    pageKey: 'beta-secret',
    regionIndex: 0,
    regionRole: 'hero',
    text: 'Owner B secret evidence block',
    confidence: 0.9,
  });

  await seedSentinelMetricRows(db, 'owner-a', sites.sentinel);

  const ownerAToken = await createUserSession(db, 'owner-a');
  const ownerBToken = await createUserSession(db, 'owner-b');

  return { ownerAToken, ownerBToken, sites };
}

function cookieFor(token: string) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

function assertStatus(actual: unknown, expected: string, label: string) {
  assert.equal(actual, expected, `${label}: expected status ${expected}, got ${String(actual)}`);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gscplus-content-authority-contracts-'));
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;
  const originalBackfills = process.env.RUN_DATABASE_BACKFILLS;
  const originalFetch = globalThis.fetch;
  const failures: string[] = [];
  const notes: string[] = [];

  const recordFailure = (label: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: ${message}`);
    console.error(`FAIL ${label}`);
    console.error(message);
  };

  const run = async (label: string, check: () => Promise<void>) => {
    try {
      await check();
      console.log(`PASS ${label}`);
    } catch (error) {
      recordFailure(label, error);
    }
  };

  try {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    process.env.RUN_DATABASE_BACKFILLS = 'false';
    process.chdir(tempDir);

    const db = await initializeDatabase();
    try {
      const runtime = await loadContentAuthorityRuntime();
      const { ownerAToken, ownerBToken, sites } = await seedFixture(db);
      const app = runtime.registerContentAuthorityRoutes ? new FakeApp() : null;
      if (app && runtime.registerContentAuthorityRoutes) {
        runtime.registerContentAuthorityRoutes(app as any, db);
      }

      const requireApp = () => {
        if (!app) {
          throw new Error(runtime.routeError || 'Content-authority routes are unavailable.');
        }
        return app;
      };
      const requireServiceRuntime = () => {
        if (
          !runtime.getContentAuthorityPageEvidence
          || !runtime.getContentAuthorityReadiness
          || !runtime.listContentAuthorityPages
          || !runtime.listContentAuthorityTemplates
        ) {
          throw new Error(runtime.serviceError || 'Content-authority service exports are unavailable.');
        }
        return runtime as Required<Pick<ContentAuthorityRuntime,
          'getContentAuthorityPageEvidence'
          | 'getContentAuthorityReadiness'
          | 'listContentAuthorityPages'
          | 'listContentAuthorityTemplates'
        >> & ContentAuthorityRuntime;
      };

      await checkStableBlockKeySupport(db, notes);

      await run('content-authority service exports are available', async () => {
        if (runtime.serviceError) throw new Error(runtime.serviceError);
      });

      await run('content-authority route wiring is available', async () => {
        if (runtime.routeError) throw new Error(runtime.routeError);
      });

      await run('route requires auth', async () => {
        const res = await invokeRoute(requireApp(), 'GET:/api/content-authority/readiness', {
          query: { siteUrl: sites.ready },
        });
        assert.equal(res.statusCode, 401, `Expected 401 without session, got ${res.statusCode}`);
      });

      await run('route enforces site access', async () => {
        const res = await invokeRoute(requireApp(), 'GET:/api/content-authority/readiness', {
          cookie: cookieFor(ownerAToken),
          query: { siteUrl: sites.scopedB },
        });
        assert.equal(res.statusCode, 403, `Expected 403 for foreign site access, got ${res.statusCode}`);
      });

      await run('readiness distinguishes missing crawl', async () => {
        const res = await invokeRoute(requireApp(), 'GET:/api/content-authority/readiness', {
          cookie: cookieFor(ownerAToken),
          query: { siteUrl: sites.missing },
        });
        assert.equal(res.statusCode, 200, `Expected 200 for missing but accessible site, got ${res.statusCode}`);
        assertStatus((res.body as any)?.status, 'no_crawl', 'missing crawl readiness');
      });

      await run('readiness distinguishes pending analysis', async () => {
        const service = requireServiceRuntime();
        const payload = await service.getContentAuthorityReadiness(db, 'owner-a', { siteUrl: sites.pending });
        assertStatus(payload.status, 'pending', 'pending readiness');
      });

      await run('readiness distinguishes partial analysis', async () => {
        const service = requireServiceRuntime();
        const payload = await service.getContentAuthorityReadiness(db, 'owner-a', { siteUrl: sites.partial });
        assertStatus(payload.status, 'partial', 'partial readiness');
      });

      await run('readiness distinguishes ready analysis', async () => {
        const service = requireServiceRuntime();
        const payload = await service.getContentAuthorityReadiness(db, 'owner-a', { siteUrl: sites.ready });
        assertStatus(payload.status, 'ready', 'ready readiness');
        assert.equal(payload.counts.pageCount, 1);
        assert.equal(payload.counts.profileCount, 1);
        assert.equal(payload.counts.regionPageCount, 1);
        assert.equal(payload.counts.templateMemberPageCount, 1);
      });

      await run('legacy extraction versions do not count as Phase 1 ready evidence', async () => {
        await requireExtractionVersionReadinessGate(db);
      });

      await run('default reads keep newest usable evidence while newer analysis is pending', async () => {
        const service = requireServiceRuntime();
        const readiness = await service.getContentAuthorityReadiness(db, 'owner-a', { siteUrl: sites.ready });
        assertStatus(readiness.status, 'ready', 'ready fallback readiness');
        assert.equal(readiness.crawlJobId, 'crawl-ready', 'Default readiness should keep the usable completed crawl');

        const pages = await service.listContentAuthorityPages(db, 'owner-a', {
          siteUrl: sites.ready,
          limit: 50,
          offset: 0,
        });
        assert.equal(pages.page.total, 1, 'Default pages should keep serving the completed evidence');
        assert.equal(pages.rows[0]?.pageKey, 'ready-home');

        const explicitReadiness = await service.getContentAuthorityReadiness(db, 'owner-a', {
          siteUrl: sites.ready,
          crawlJobId: 'crawl-ready-newer',
        });
        assertStatus(explicitReadiness.status, 'pending', 'explicit newer crawl readiness');
        assert.equal(explicitReadiness.crawlJobId, 'crawl-ready-newer');
        assert.equal((explicitReadiness.job as any)?.status, 'running');

        const explicitPages = await service.listContentAuthorityPages(db, 'owner-a', {
          siteUrl: sites.ready,
          crawlJobId: 'crawl-ready-newer',
          limit: 50,
          offset: 0,
        });
        assert.equal(explicitPages.page.total, 0, 'Explicit pending crawl should not borrow completed evidence');
        assert.equal(explicitPages.rows.length, 0);
      });

      await run('site scope aliases resolve pages templates and evidence without owner leakage', async () => {
        const service = requireServiceRuntime();
        const pages = await service.listContentAuthorityPages(db, 'owner-a', {
          siteUrl: sites.readyAlias,
          limit: 50,
          offset: 0,
        });
        const templates = await service.listContentAuthorityTemplates(db, 'owner-a', { siteUrl: sites.readyAlias });
        const evidence = await service.getContentAuthorityPageEvidence(db, 'owner-a', {
          siteUrl: sites.readyAlias,
          pageKey: 'ready-home',
        });

        assert.equal(pages.page.total, 1, 'Alias pages should resolve the logical site scope');
        assert.equal(pages.rows[0]?.pageKey, 'ready-home');
        assert.equal(templates.rows.length, 1, 'Alias templates should resolve the logical site scope');
        assert.equal(templates.rows[0]?.templateKey, 'tpl-ready');
        assert.equal(evidence.found, true, 'Alias evidence should resolve the logical site scope');
        assert.equal(evidence.page?.pageKey, 'ready-home');

        const foreignPages = await service.listContentAuthorityPages(db, 'owner-b', {
          siteUrl: sites.readyAlias,
          limit: 50,
          offset: 0,
        });
        assert.equal(foreignPages.page.total, 0, 'Foreign owners must not resolve another owner alias');
        assert.equal(foreignPages.rows.length, 0);
      });
      await run('pages/templates/evidence use stored data only', async () => {
        const service = requireServiceRuntime();
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
          fetchCalls += 1;
          throw new Error('content authority contracts must not fetch live data');
        }) as typeof fetch;

        const pages = await service.listContentAuthorityPages(db, 'owner-a', {
          siteUrl: sites.ready,
          limit: 50,
          offset: 0,
        });
        const templates = await service.listContentAuthorityTemplates(db, 'owner-a', {
          siteUrl: sites.ready,
        });
        const evidence = await service.getContentAuthorityPageEvidence(db, 'owner-a', {
          siteUrl: sites.ready,
          pageKey: 'ready-home',
        });

        assert.equal(fetchCalls, 0, `Expected zero fetch calls, got ${fetchCalls}`);
        assert.equal(pages.page.total, 1, `Expected one ready page, got ${pages.page.total}`);
        assert.equal(pages.rows.length, 1, `Expected one ready row, got ${pages.rows.length}`);
        assert.equal((pages.rows[0] as any)?.pageKey, 'ready-home');
        assert.equal(templates.rows.length, 1, `Expected one ready template row, got ${templates.rows.length}`);
        assert.equal((templates.rows[0] as any)?.templateKey, 'tpl-ready');
        assert.equal(evidence.found, true, 'Expected stored page evidence to be found');
        assert.equal(evidence.page?.pageKey, 'ready-home');
        assert.equal((evidence.page?.regions || [])[0]?.blockKey, 'ready-home:region:0');
      });

      await run('sentinel empty query results do not count as evidence', async () => {
        const service = requireServiceRuntime();
        const readiness = await service.getContentAuthorityReadiness(db, 'owner-a', { siteUrl: sites.sentinel });
        const pages = await service.listContentAuthorityPages(db, 'owner-a', {
          siteUrl: sites.sentinel,
          limit: 50,
          offset: 0,
        });
        const templates = await service.listContentAuthorityTemplates(db, 'owner-a', { siteUrl: sites.sentinel });
        const evidence = await service.getContentAuthorityPageEvidence(db, 'owner-a', {
          siteUrl: sites.sentinel,
          pageKey: 'ghost-page',
        });

        assertStatus(readiness.status, 'no_crawl', 'sentinel readiness');
        assert.equal(pages.page.total, 0, `Expected sentinel rows to add no content-authority pages, got ${pages.page.total}`);
        assert.equal(templates.rows.length, 0, `Expected sentinel rows to add no templates, got ${templates.rows.length}`);
        assert.equal(evidence.found, false, 'Expected sentinel rows to add no evidence');
      });

      await run('owner/site-scoped pages do not leak via shared template keys', async () => {
        const service = requireServiceRuntime();
        requireScopedTemplateMemberGuards();
        await requireTemplateMembershipSchema(db);
        const pages = await service.listContentAuthorityPages(db, 'owner-a', {
          siteUrl: sites.scopedA,
          limit: 50,
          offset: 0,
        });
        const pageKeys = pages.rows.map((row: any) => row.pageKey).sort();
        assert.deepEqual(
          pageKeys,
          ['alpha-visible'],
          [
            'Foreign page keys leaked into owner/site-scoped content authority pages.',
            `Expected only ["alpha-visible"] for ${sites.scopedA}.`,
            `Got ${JSON.stringify(pageKeys)}.`,
            'Likely cause: page_template_members joins in server/services/contentAuthority.ts are keyed only by templateKey/pageKey instead of ownerId/siteScopeId/siteUrl/crawlJobId.',
          ].join(' '),
        );
      });

      await run('owner/site-scoped templates do not inflate member counts from foreign members', async () => {
        const service = requireServiceRuntime();
        requireScopedTemplateMemberGuards();
        await requireTemplateMembershipSchema(db);
        const templates = await service.listContentAuthorityTemplates(db, 'owner-a', {
          siteUrl: sites.scopedA,
        });
        assert.equal(templates.rows.length, 1, `Expected one scoped template, got ${templates.rows.length}`);
        assert.equal(
          (templates.rows[0] as any)?.memberCount,
          1,
          [
            'Foreign template members inflated the scoped template member count.',
            `Expected memberCount 1 for ${sites.scopedA}, got ${String((templates.rows[0] as any)?.memberCount)}.`,
            'Likely cause: page_template_members lookup in server/services/contentAuthority.ts is filtered only by templateKey and ignores owner/site/crawl scope.',
          ].join(' '),
        );
      });

      await run('foreign token still cannot access owner A site', async () => {
        const res = await invokeRoute(requireApp(), 'GET:/api/content-authority/pages', {
          cookie: cookieFor(ownerBToken),
          query: { siteUrl: sites.ready, limit: 10, offset: 0 },
        });
        assert.equal(res.statusCode, 403, `Expected owner B to receive 403 for owner A site, got ${res.statusCode}`);
      });
    } finally {
      await db.close?.();
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = originalPostgresUrl;
    if (originalBackfills === undefined) delete process.env.RUN_DATABASE_BACKFILLS; else process.env.RUN_DATABASE_BACKFILLS = originalBackfills;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn('[contract cleanup] unable to remove ' + tempDir + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  if (failures.length) {
    throw new Error(`Content authority contract check failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  }

  if (notes.length) {
    console.log(`Contract notes (${notes.length}):`);
    for (const note of notes) {
      console.log(`- ${note}`);
    }
  }

  console.log('All content authority contract checks passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
