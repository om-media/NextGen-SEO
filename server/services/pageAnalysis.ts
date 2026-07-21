import crypto from 'node:crypto';
import type { AppDatabase } from '../database.js';
import {
  analyzePageAuthorityDataset,
  type PageAuthorityBlockInput,
  type PageAuthorityDatasetAnalysis,
  type PageAuthorityPageAnalysis,
  type PageAuthorityPageInput,
  type PageAuthorityRegionInput,
  type PageAuthorityTemplateCluster,
} from './pageAuthority.js';
import { ensureSiteScope, type EnsureSiteScopeResult } from './siteScopes.js';

type PageAnalysisJobRow = {
  analysisType: string | null;
  attemptCount: number | null;
  completedAt: string | null;
  crawlJobId: string | null;
  id: string;
  lastError: string | null;
  lockedAt: string | null;
  maxAttempts: number | null;
  metricsJson: string | null;
  nextRunAt: string | null;
  ownerId: string;
  progressCompleted: number | null;
  progressTotal: number | null;
  siteScopeId: string | null;
  siteUrl: string;
  status: string | null;
  updatedAt: string | null;
};

type ClaimedPageAnalysisJob = PageAnalysisJobRow & {
  crawlJobId: string;
  lockedAt: string;
  siteScopeId: string;
};

type CrawlJobRow = {
  completedAt: string | null;
  id: string;
  ownerId: string;
  siteUrl: string;
  status: string | null;
  updatedAt: string | null;
};

type CrawlPageRow = {
  canonicalUrl: string | null;
  depth: number | null;
  h1Text: string | null;
  metaDescription: string | null;
  normalizedUrl: string | null;
  pageKey: string | null;
  resolvedCanonicalPageKey: string | null;
  title: string | null;
  url: string | null;
  wordCount: number | null;
};

type CrawlTextBlockRow = {
  blockIndex: number | null;
  blockKey?: string | null;
  blockType: string | null;
  boilerplateScore: number | null;
  domPath: string | null;
  headingChainJson: string | null;
  linkDensity: number | null;
  pageKey: string | null;
  pageUrl: string | null;
  regionIndex: number | null;
  regionRole: string | null;
  selector: string | null;
  text: string | null;
  textDensity: number | null;
};

type BuiltRegion = {
  blockCount: number;
  blockIndex: number;
  blockKeys: string[];
  boilerplateScore: number | null;
  domPath: string | null;
  headingChain: string[];
  index: number;
  linkDensity: number | null;
  role: string;
  selector: string | null;
  text: string;
  textDensity: number | null;
};

type BuiltPage = {
  input: PageAuthorityPageInput;
  pageKey: string;
  pageUrl: string;
  regions: BuiltRegion[];
};

type QueueInput = {
  crawlJobId: string;
  force?: boolean;
  ownerId: string;
  propertyId?: string | null;
  siteUrl: string;
  sourceKey?: string | null;
  sourceType?: string | null;
};

const ANALYSIS_TYPE = 'visual-semantics-foundation-v1';
const ANALYSIS_PROVIDER = 'rules-first';
const ANALYSIS_MODEL = 'visual-semantics-foundation-v1';
const ANALYSIS_POLL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_ERROR_RECOVERY_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_WORKERS = 1;
const MAX_AUTOQUEUE_CANDIDATES = 8;
const EXTRACTION_VERSION = 3;

let sqliteClaimTail: Promise<void> = Promise.resolve();
const blockKeyColumnSupport = new WeakMap<object, boolean>();

class PageAnalysisLeaseLostError extends Error {
  constructor() {
    super('Page analysis worker lease was lost.');
    this.name = 'PageAnalysisLeaseLostError';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function statusValue(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values: Array<number | null | undefined>) {
  const valid = values.map((value) => (Number.isFinite(value) ? Number(value) : null)).filter((value): value is number => value !== null);
  if (!valid.length) return null;
  return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(4));
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function clampWorkerCount(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_WORKERS;
  return Math.max(1, Math.min(4, Math.trunc(parsed)));
}

function getLockTimeoutMs() {
  const parsed = Number(process.env.PAGE_ANALYSIS_LOCK_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_LOCK_TIMEOUT_MS;
  return Math.max(30000, Math.min(60 * 60 * 1000, Math.trunc(parsed)));
}

function getErrorRecoveryCooldownMs() {
  const parsed = Number(process.env.PAGE_ANALYSIS_ERROR_RECOVERY_COOLDOWN_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_ERROR_RECOVERY_COOLDOWN_MS;
  return Math.max(5 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, Math.trunc(parsed)));
}

function parseTimestampMs(value: string | null | undefined) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldRecoverErroredJob(job: Pick<PageAnalysisJobRow, 'completedAt' | 'status' | 'updatedAt'>, nowMs = Date.now()) {
  if (statusValue(job.status) !== 'error') return false;
  const terminalAtMs = parseTimestampMs(job.updatedAt) ?? parseTimestampMs(job.completedAt);
  if (terminalAtMs === null) return true;
  return nowMs - terminalAtMs >= getErrorRecoveryCooldownMs();
}

function stableJobId(ownerId: string, siteScopeId: string, crawlJobId: string) {
  return `pa_${crypto.createHash('sha256').update(`${ownerId}\n${siteScopeId}\n${crawlJobId}\n${ANALYSIS_TYPE}`).digest('hex').slice(0, 24)}`;
}

function parseHeadingChain(value: string | null) {
  if (!value) return [] as string[];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => normalizeText(entry)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function progressMetrics(progressCompleted: number, progressTotal: number, startedAtMs: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ elapsedMs: Date.now() - startedAtMs, progressCompleted, progressTotal, ...extra });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function tableHasColumn(db: AppDatabase, tableName: string, columnName: string) {
  const cached = tableName === 'crawl_page_text_blocks' ? blockKeyColumnSupport.get(db as object) : undefined;
  if (cached !== undefined) return cached;

  let exists = false;
  if (db.dialect === 'sqlite') {
    const rows = await db.all<{ name?: string }>(`PRAGMA table_info(${tableName})`);
    exists = rows.some((row) => normalizeText(row.name).toLowerCase() === columnName.toLowerCase());
  } else {
    const row = await db.get<{ exists?: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?) AS exists`,
      [tableName, columnName.toLowerCase()],
    );
    exists = Boolean(row?.exists);
  }

  if (tableName === 'crawl_page_text_blocks') blockKeyColumnSupport.set(db as object, exists);
  return exists;
}

async function withSqliteClaimLock<T>(callback: () => Promise<T>) {
  const previous = sqliteClaimTail;
  let release!: () => void;
  sqliteClaimTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}
async function recoverStaleJobs(db: AppDatabase, cutoff: string) {
  const stamp = nowIso();
  await db.run(
    `UPDATE page_analysis_jobs
     SET status = CASE WHEN COALESCE(attemptCount, 0) < COALESCE(maxAttempts, ?) THEN 'retrying' ELSE 'error' END,
         lockedAt = NULL,
         nextRunAt = CASE WHEN COALESCE(attemptCount, 0) < COALESCE(maxAttempts, ?) THEN ? ELSE NULL END,
         completedAt = CASE WHEN COALESCE(attemptCount, 0) < COALESCE(maxAttempts, ?) THEN NULL ELSE ? END,
         updatedAt = ?,
         lastError = COALESCE(NULLIF(lastError, ''), 'Recovered after interrupted page analysis worker.')
     WHERE status = 'running' AND (lockedAt IS NULL OR lockedAt < ?)`,
    [DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, stamp, DEFAULT_MAX_ATTEMPTS, stamp, stamp, cutoff],
  );
}

async function claimNextJobPostgres(db: AppDatabase, cutoff: string) {
  const claim = db.transaction(async () => {
    await db.exec('SELECT pg_advisory_xact_lock(864203200)');
    await recoverStaleJobs(db, cutoff);
    const stamp = nowIso();
    return db.get<ClaimedPageAnalysisJob>(
      `WITH ranked AS (
         SELECT job.id,
                ROW_NUMBER() OVER (PARTITION BY job.ownerId, job.siteScopeId ORDER BY COALESCE(job.nextRunAt, job.updatedAt) ASC NULLS FIRST, job.updatedAt ASC NULLS FIRST, job.id ASC) AS scopeRank,
                (SELECT COUNT(*) FROM page_analysis_jobs running_owner WHERE running_owner.status = 'running' AND running_owner.ownerId = job.ownerId) AS ownerRunningCount
         FROM page_analysis_jobs job
         WHERE job.status IN ('queued', 'retrying')
           AND (job.nextRunAt IS NULL OR job.nextRunAt <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM page_analysis_jobs running_scope
             WHERE running_scope.status = 'running' AND running_scope.ownerId = job.ownerId AND running_scope.siteScopeId = job.siteScopeId AND running_scope.analysisType = job.analysisType
           )
       ), candidate AS (
         SELECT job.id
         FROM page_analysis_jobs job
         INNER JOIN ranked ON ranked.id = job.id
         WHERE ranked.scopeRank = 1
         ORDER BY ranked.ownerRunningCount ASC, COALESCE(job.nextRunAt, job.updatedAt) ASC NULLS FIRST, job.updatedAt ASC NULLS FIRST, job.id ASC
         LIMIT 1 FOR UPDATE OF job SKIP LOCKED
       )
       UPDATE page_analysis_jobs job
       SET status = 'running', attemptCount = COALESCE(attemptCount, 0) + 1, updatedAt = ?, lockedAt = ?, completedAt = NULL, lastError = NULL
       FROM candidate
       WHERE job.id = candidate.id
       RETURNING job.*`,
      [stamp, stamp, stamp],
    );
  });
  return (await claim()) || null;
}

async function claimNextJobSqlite(db: AppDatabase, cutoff: string) {
  return withSqliteClaimLock(async () => {
    const claim = db.transaction(async () => {
      await recoverStaleJobs(db, cutoff);
      const stamp = nowIso();
      const candidates = await db.all<PageAnalysisJobRow>(
        `WITH ranked AS (
           SELECT job.*, ROW_NUMBER() OVER (PARTITION BY job.ownerId, job.siteScopeId ORDER BY COALESCE(job.nextRunAt, job.updatedAt) ASC, job.updatedAt ASC, job.id ASC) AS scopeRank,
                  (SELECT COUNT(*) FROM page_analysis_jobs running_owner WHERE running_owner.status = 'running' AND running_owner.ownerId = job.ownerId) AS ownerRunningCount
           FROM page_analysis_jobs job
           WHERE job.status IN ('queued', 'retrying')
             AND (job.nextRunAt IS NULL OR job.nextRunAt <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM page_analysis_jobs running_scope
               WHERE running_scope.status = 'running' AND running_scope.ownerId = job.ownerId AND running_scope.siteScopeId = job.siteScopeId AND running_scope.analysisType = job.analysisType
             )
         )
         SELECT * FROM ranked
         WHERE scopeRank = 1
         ORDER BY ownerRunningCount ASC, COALESCE(nextRunAt, updatedAt) ASC, updatedAt ASC, id ASC
         LIMIT 8`,
        [stamp],
      );

      for (const candidate of candidates) {
        const result = await db.run(
          `UPDATE page_analysis_jobs
           SET status = 'running', attemptCount = COALESCE(attemptCount, 0) + 1, updatedAt = ?, lockedAt = ?, completedAt = NULL, lastError = NULL
           WHERE id = ? AND status IN ('queued', 'retrying') AND (nextRunAt IS NULL OR nextRunAt <= ?)`,
          [stamp, stamp, candidate.id, stamp],
        );
        if (result.changes) {
          return (await db.get<ClaimedPageAnalysisJob>('SELECT * FROM page_analysis_jobs WHERE id = ?', [candidate.id])) || null;
        }
      }
      return null;
    });
    return claim();
  });
}

async function claimNextJob(db: AppDatabase) {
  const cutoff = new Date(Date.now() - getLockTimeoutMs()).toISOString();
  return db.dialect === 'postgres' ? claimNextJobPostgres(db, cutoff) : claimNextJobSqlite(db, cutoff);
}

async function updateOwnedJob(
  db: AppDatabase,
  job: ClaimedPageAnalysisJob,
  fields: Partial<Pick<PageAnalysisJobRow, 'completedAt' | 'lastError' | 'lockedAt' | 'metricsJson' | 'nextRunAt' | 'progressCompleted' | 'progressTotal' | 'siteScopeId' | 'status' | 'updatedAt'>>,
) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  values.push(job.id, job.lockedAt);
  const result = await db.run(`UPDATE page_analysis_jobs SET ${sets} WHERE id = ? AND status = 'running' AND lockedAt = ?`, values);
  if (!result.changes) throw new PageAnalysisLeaseLostError();
}

function createHeartbeat(db: AppDatabase, job: ClaimedPageAnalysisJob) {
  let currentLock = job.lockedAt;
  let lastBeat = 0;
  return async (progressCompleted?: number, progressTotal?: number, metricsJson?: string | null, force = false) => {
    const now = Date.now();
    if (!force && now - lastBeat < HEARTBEAT_INTERVAL_MS) return;
    const nextLock = nowIso();
    await updateOwnedJob(db, { ...job, lockedAt: currentLock }, { lockedAt: nextLock, metricsJson, progressCompleted, progressTotal, updatedAt: nextLock });
    currentLock = nextLock;
    lastBeat = now;
    job.lockedAt = nextLock;
  };
}

async function markJobForRetry(db: AppDatabase, job: ClaimedPageAnalysisJob, error: unknown) {
  const failedAt = nowIso();
  const attemptCount = toNumber(job.attemptCount);
  const maxAttempts = Math.max(1, toNumber(job.maxAttempts, DEFAULT_MAX_ATTEMPTS));
  const shouldRetry = attemptCount < maxAttempts;
  const retryDelayMs = Math.min(30 * 60 * 1000, 60_000 * Math.max(1, attemptCount));
  await updateOwnedJob(db, job, {
    completedAt: shouldRetry ? null : failedAt,
    lastError: error instanceof Error ? error.message : 'Page analysis failed',
    lockedAt: null,
    metricsJson: JSON.stringify({ attemptCount, failedAt, maxAttempts, retryDelayMs: shouldRetry ? retryDelayMs : 0 }),
    nextRunAt: shouldRetry ? new Date(Date.now() + retryDelayMs).toISOString() : null,
    status: shouldRetry ? 'retrying' : 'error',
    updatedAt: failedAt,
  });
}

async function completeJob(db: AppDatabase, job: ClaimedPageAnalysisJob, progressCompleted: number, progressTotal: number, metricsJson: string) {
  const completedAt = nowIso();
  await updateOwnedJob(db, job, {
    completedAt,
    lastError: null,
    lockedAt: null,
    metricsJson,
    nextRunAt: null,
    progressCompleted,
    progressTotal,
    status: 'completed',
    updatedAt: completedAt,
  });
}

async function queueMissingCompletedCrawls(db: AppDatabase) {
  const recoveryCutoff = new Date(Date.now() - getErrorRecoveryCooldownMs()).toISOString();
  const rows = await db.all<CrawlJobRow>(
    `SELECT job.id, job.ownerId, job.siteUrl, job.status, job.completedAt, job.updatedAt
     FROM crawl_jobs job
     WHERE job.status = 'completed'
       AND EXISTS (
         SELECT 1 FROM crawl_page_text_blocks blocks
         WHERE blocks.ownerId = job.ownerId AND blocks.siteUrl = job.siteUrl AND blocks.jobId = job.id
         LIMIT 1
       )
       AND (
         NOT EXISTS (
           SELECT 1 FROM page_analysis_jobs analysis
           WHERE analysis.ownerId = job.ownerId AND analysis.crawlJobId = job.id AND analysis.analysisType = ?
         )
         OR EXISTS (
           SELECT 1 FROM page_analysis_jobs analysis
           WHERE analysis.ownerId = job.ownerId
             AND analysis.crawlJobId = job.id
             AND analysis.analysisType = ?
             AND analysis.status = 'error'
             AND COALESCE(analysis.updatedAt, analysis.completedAt, '') <= ?
         )
       )
     ORDER BY COALESCE(job.completedAt, job.updatedAt) DESC, job.id DESC
     LIMIT ?`,
    [ANALYSIS_TYPE, ANALYSIS_TYPE, recoveryCutoff, MAX_AUTOQUEUE_CANDIDATES],
  );

  for (const row of rows) {
    try {
      await queueCompletedCrawlAnalysis(db, {
        crawlJobId: row.id,
        ownerId: row.ownerId,
        siteUrl: row.siteUrl,
        sourceKey: row.siteUrl,
        sourceType: 'crawl-site',
      });
    } catch (error) {
      console.error('[page-analysis] Failed to queue completed crawl analysis', { crawlJobId: row.id, error });
    }
  }
}

async function loadSourceRows(db: AppDatabase, job: ClaimedPageAnalysisJob) {
  const hasBlockKey = await tableHasColumn(db, 'crawl_page_text_blocks', 'blockKey');
  const blockKeySelect = hasBlockKey ? 'blockKey' : 'NULL AS blockKey';
  const pages = await db.all<CrawlPageRow>(
    `SELECT url, normalizedUrl, pageKey, resolvedCanonicalPageKey, canonicalUrl, title, metaDescription, h1Text, wordCount, depth
     FROM crawl_pages
     WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
     ORDER BY depth ASC, normalizedUrl ASC, url ASC`,
    [job.ownerId, job.siteUrl, job.crawlJobId],
  );
  const blocks = await db.all<CrawlTextBlockRow>(
    `SELECT pageUrl, pageKey, blockIndex, ${blockKeySelect}, blockType, regionIndex, regionRole, headingChainJson, domPath, selector, text, textDensity, linkDensity, boilerplateScore
     FROM crawl_page_text_blocks
     WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
     ORDER BY pageKey ASC, blockIndex ASC`,
    [job.ownerId, job.siteUrl, job.crawlJobId],
  );
  return { blocks, pages };
}
function buildBlocksForPage(blockRows: CrawlTextBlockRow[]): PageAuthorityBlockInput[] {
  return blockRows.map((block) => {
    const headingChain = parseHeadingChain(block.headingChainJson);
    return {
      action: null,
      classes: [],
      depth: block.domPath ? block.domPath.split('>').length : null,
      itemCount: null,
      kind: normalizeText(block.blockType || block.regionRole || 'content').toLowerCase() || 'content',
      label: headingChain.at(-1) || null,
      linkCount: null,
      repeatedHint: normalizeText(block.blockKey || block.regionRole) || null,
      text: normalizeText(block.text) || null,
    };
  });
}

function buildRegionsForPage(blockRows: CrawlTextBlockRow[], fallbackHeading: string | null) {
  const groups = new Map<string, CrawlTextBlockRow[]>();
  for (const block of blockRows) {
    const key = block.regionIndex !== null && block.regionIndex !== undefined ? `region:${block.regionIndex}` : `block:${block.blockIndex ?? groups.size}`;
    const rows = groups.get(key) || [];
    rows.push(block);
    groups.set(key, rows);
  }

  const persisted = Array.from(groups.values())
    .map((rows, position) => {
      const sorted = [...rows].sort((left, right) => toNumber(left.blockIndex) - toNumber(right.blockIndex));
      const first = sorted[0];
      const headingChain = unique(sorted.flatMap((row) => parseHeadingChain(row.headingChainJson)));
      const text = sorted.map((row) => normalizeText(row.text)).filter(Boolean).join(' ').trim();
      return {
        blockCount: sorted.length,
        blockIndex: toNumber(first?.blockIndex, position),
        blockKeys: unique(sorted.map((row) => normalizeText(row.blockKey)).filter(Boolean)),
        boilerplateScore: mean(sorted.map((row) => row.boilerplateScore)),
        domPath: sorted.find((row) => normalizeText(row.domPath))?.domPath || null,
        headingChain,
        index: first?.regionIndex ?? position,
        linkDensity: mean(sorted.map((row) => row.linkDensity)),
        role: normalizeText(first?.regionRole || first?.blockType || 'content').toLowerCase() || 'content',
        selector: sorted.find((row) => normalizeText(row.selector))?.selector || null,
        text,
        textDensity: mean(sorted.map((row) => row.textDensity)),
      } satisfies BuiltRegion;
    })
    .sort((left, right) => left.index - right.index || left.blockIndex - right.blockIndex);

  const inputs: PageAuthorityRegionInput[] = persisted.map((region) => ({
    attributes: region.blockKeys.length ? { blockKeyCount: region.blockKeys.length, blockKeysJson: JSON.stringify(region.blockKeys) } : {},
    classes: [],
    heading: region.headingChain.at(-1) || fallbackHeading || null,
    itemCount: region.blockCount,
    kind: region.role,
    label: region.headingChain.at(-1) || null,
    linkCount: null,
    textSample: region.text.slice(0, 320) || null,
  }));

  return { inputs, persisted };
}

async function buildPageInputs(pageRows: CrawlPageRow[], blockRows: CrawlTextBlockRow[], onProgress?: (completed: number, total: number) => Promise<void>) {
  const blocksByPageKey = new Map<string, CrawlTextBlockRow[]>();
  for (const block of blockRows) {
    const pageKey = normalizeText(block.pageKey);
    if (!pageKey) continue;
    const rows = blocksByPageKey.get(pageKey) || [];
    rows.push(block);
    blocksByPageKey.set(pageKey, rows);
  }

  const builtPages: BuiltPage[] = [];
  const total = pageRows.length;
  let completed = 0;

  for (const page of pageRows) {
    const pageKey = normalizeText(page.pageKey || page.resolvedCanonicalPageKey || page.normalizedUrl || page.url);
    const pageUrl = normalizeText(page.normalizedUrl || page.url);
    if (!pageKey || !pageUrl) {
      completed += 1;
      continue;
    }

    const blocks = (blocksByPageKey.get(pageKey) || []).sort((left, right) => toNumber(left.blockIndex) - toNumber(right.blockIndex));
    const hasSignals = blocks.some((block) => normalizeText(block.text)) || normalizeText(page.title) || toNumber(page.wordCount) > 0;
    if (!hasSignals) {
      completed += 1;
      continue;
    }

    const { inputs: regions, persisted } = buildRegionsForPage(blocks, page.h1Text);
    builtPages.push({
      input: {
        blocks: buildBlocksForPage(blocks),
        breadcrumbs: [],
        canonicalUrl: page.canonicalUrl,
        ctaTexts: [],
        headings: normalizeText(page.h1Text) ? [{ level: 1, text: normalizeText(page.h1Text) }] : [],
        id: pageKey,
        lang: null,
        metaDescription: page.metaDescription,
        ratingValue: null,
        regions,
        reviewCount: null,
        structuredDataTypes: [],
        title: page.title,
        url: pageUrl,
        wordCount: toNumberOrNull(page.wordCount),
      },
      pageKey,
      pageUrl,
      regions: persisted,
    });

    completed += 1;
    if (onProgress && (completed === total || completed % 25 === 0)) {
      await onProgress(completed, total);
    }
  }

  return builtPages;
}

function clusterMetadata(dataset: PageAuthorityDatasetAnalysis, pageId: string) {
  const clusterId = dataset.clusters.pageToClusterId[pageId] || null;
  const cluster = clusterId ? dataset.clusters.clusters.find((entry) => entry.clusterId === clusterId) || null : null;
  const exemplarPageKey = cluster?.memberPageIds[0] || null;
  return {
    cluster,
    clusterId,
    exemplarPageKey,
    isExemplar: exemplarPageKey === pageId,
  };
}

function chooseCenterpieceRegionIndex(page: BuiltPage) {
  if (!page.regions.length) return null;
  const sorted = [...page.regions].sort((left, right) => {
    const scoreLeft = normalizeText(left.text).length + toNumber(left.textDensity) * 100;
    const scoreRight = normalizeText(right.text).length + toNumber(right.textDensity) * 100;
    return scoreRight - scoreLeft || left.index - right.index;
  });
  return sorted[0]?.index ?? null;
}

function buildTextHash(text: string) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function clusterDistance(cluster: PageAuthorityTemplateCluster | null, memberPageId: string) {
  if (!cluster) return null;
  const size = Math.max(1, cluster.memberPageIds.length);
  const rank = Math.max(0, cluster.memberPageIds.indexOf(memberPageId));
  const confidencePenalty = 1 - Number(cluster.confidence || 0);
  return Number((confidencePenalty + rank / size / 10).toFixed(4));
}

async function persistAnalysis(
  db: AppDatabase,
  scope: EnsureSiteScopeResult,
  job: ClaimedPageAnalysisJob,
  dataset: PageAuthorityDatasetAnalysis,
  builtPages: BuiltPage[],
) {
  const analysisByPage = new Map<string, PageAuthorityPageAnalysis>(dataset.pages.map((page) => [page.pageId, page]));
  const pageBreakdown = dataset.repeatedBlocks.pageBreakdown || {};
  const stamp = nowIso();
  const hasRegionBlockKeyColumn = await tableHasColumn(db, 'crawl_page_regions', 'blockKey');

  const persist = db.transaction(async () => {
    await db.run(`DELETE FROM crawl_page_regions WHERE ownerId = ? AND siteUrl = ? AND jobId = ?`, [job.ownerId, job.siteUrl, job.crawlJobId]);
    await db.run(`DELETE FROM page_template_members WHERE ownerId = ? AND siteUrl = ? AND crawlJobId = ?`, [job.ownerId, job.siteUrl, job.crawlJobId]);
    await db.run(`DELETE FROM page_template_clusters WHERE ownerId = ? AND siteUrl = ? AND crawlJobId = ?`, [job.ownerId, job.siteUrl, job.crawlJobId]);
    await db.run(`DELETE FROM page_function_profiles WHERE ownerId = ? AND siteUrl = ? AND crawlJobId = ?`, [job.ownerId, job.siteUrl, job.crawlJobId]);

    for (const page of builtPages) {
      const analysis = analysisByPage.get(page.pageKey) || null;
      const repeated = pageBreakdown[page.pageKey] || null;
      const repeatedKeys = new Set(repeated?.repeatedBlockKeys || []);
      const clusterInfo = clusterMetadata(dataset, page.pageKey);

      for (const region of page.regions) {
        const matchedRepeatedBlockKeys = region.blockKeys.filter((blockKey) => repeatedKeys.has(blockKey));
        const templateFrequency = region.blockKeys.length
          ? Number((matchedRepeatedBlockKeys.length / region.blockKeys.length).toFixed(4))
          : toNumberOrNull(repeated?.repeatedShare);
        const regionBlockKey = region.blockKeys[0] || null;
        const featureBreakdownJson = JSON.stringify({
          blockKey: regionBlockKey,
          blockKeys: region.blockKeys,
          clusterId: clusterInfo.clusterId,
          domSignatureHash: analysis?.domSignature.hash || null,
          matchedRepeatedBlockKeys,
          pageType: analysis?.profile.pageType.label || null,
          primaryTask: analysis?.profile.task.label || null,
          regionSignatureHash: analysis?.regionSignature.hash || null,
          repeatedBlockShare: repeated?.repeatedShare ?? null,
        });

        const regionColumns = hasRegionBlockKeyColumn
          ? 'ownerId, siteUrl, jobId, pageUrl, pageKey, regionIndex, parentRegionIndex, regionRole, componentType, blockIndex, blockKey, headingChainJson, domPath, selector, text, textHash, textDensity, linkDensity, boilerplateScore, templateFrequency, bboxX, bboxY, bboxWidth, bboxHeight, viewportProminence, visible, confidence, featureBreakdownJson, extractionVersion'
          : 'ownerId, siteUrl, jobId, pageUrl, pageKey, regionIndex, parentRegionIndex, regionRole, componentType, blockIndex, headingChainJson, domPath, selector, text, textHash, textDensity, linkDensity, boilerplateScore, templateFrequency, bboxX, bboxY, bboxWidth, bboxHeight, viewportProminence, visible, confidence, featureBreakdownJson, extractionVersion';
        const regionPlaceholders = hasRegionBlockKeyColumn
          ? '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?'
          : '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';
        const regionValues = hasRegionBlockKeyColumn
          ? [
              job.ownerId,
              job.siteUrl,
              job.crawlJobId,
              page.pageUrl,
              page.pageKey,
              region.index,
              null,
              region.role,
              region.role,
              region.blockIndex,
              regionBlockKey,
              JSON.stringify(region.headingChain),
              region.domPath,
              region.selector,
              region.text,
              buildTextHash(region.text),
              region.textDensity,
              region.linkDensity,
              region.boilerplateScore,
              templateFrequency,
              null,
              null,
              null,
              null,
              region.textDensity,
              1,
              0.8,
              featureBreakdownJson,
              EXTRACTION_VERSION,
            ]
          : [
              job.ownerId,
              job.siteUrl,
              job.crawlJobId,
              page.pageUrl,
              page.pageKey,
              region.index,
              null,
              region.role,
              region.role,
              region.blockIndex,
              JSON.stringify(region.headingChain),
              region.domPath,
              region.selector,
              region.text,
              buildTextHash(region.text),
              region.textDensity,
              region.linkDensity,
              region.boilerplateScore,
              templateFrequency,
              null,
              null,
              null,
              null,
              region.textDensity,
              1,
              0.8,
              featureBreakdownJson,
              EXTRACTION_VERSION,
            ];

        await db.run(`INSERT INTO crawl_page_regions (${regionColumns}) VALUES (${regionPlaceholders})`, regionValues);
      }

      const secondaryTasksJson = JSON.stringify(
        (analysis?.profile.task.candidates || [])
          .filter((candidate) => candidate.label !== analysis?.profile.task.label)
          .slice(0, 3)
          .map((candidate) => ({
            confidence: candidate.confidence,
            confidenceLabel: candidate.confidenceLabel,
            label: candidate.label,
            normalizedScore: candidate.normalizedScore,
            score: candidate.score,
          })),
      );
      const featureBreakdownJson = JSON.stringify({
        clusterConfidence: clusterInfo.cluster?.confidence || null,
        clusterId: clusterInfo.clusterId,
        clusterReasons: clusterInfo.cluster?.reasons || [],
        domSignature: analysis?.domSignature || null,
        featureSnapshot: analysis?.profile.featureSnapshot || null,
        pageTypeReasons: analysis?.profile.pageType.reasons || [],
        repeatedBlocks: pageBreakdown[page.pageKey] || null,
        taskReasons: analysis?.profile.task.reasons || [],
        urlSkeleton: analysis?.urlSkeleton || null,
      });
      const confidence = analysis
        ? Number((((analysis.profile.pageType.confidence || 0) + (analysis.profile.task.confidence || 0)) / 2).toFixed(4))
        : 0;

      await db.run(
        `INSERT INTO page_function_profiles (
           ownerId, siteUrl, siteScopeId, crawlJobId, pageKey, templateKey, pageType, primaryTask,
           secondaryTasksJson, centerpieceRegionIndex, confidence, featureBreakdownJson, manualOverrideJson,
           createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.ownerId,
          job.siteUrl,
          scope.scope.id,
          job.crawlJobId,
          page.pageKey,
          clusterInfo.clusterId,
          analysis?.profile.pageType.label || null,
          analysis?.profile.task.label || null,
          secondaryTasksJson,
          chooseCenterpieceRegionIndex(page),
          confidence,
          featureBreakdownJson,
          null,
          stamp,
          stamp,
        ],
      );
    }

    for (const cluster of dataset.clusters.clusters) {
      const exemplarPageKey = cluster.memberPageIds[0] || null;
      const exemplarAnalysis = exemplarPageKey ? analysisByPage.get(exemplarPageKey) || null : null;
      await db.run(
        `INSERT INTO page_template_clusters (
           ownerId, siteUrl, siteScopeId, crawlJobId, templateKey, exemplarPageKey, urlSkeleton,
           domSignature, regionSequenceHash, memberCount, confidence, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.ownerId,
          job.siteUrl,
          scope.scope.id,
          job.crawlJobId,
          cluster.clusterId,
          exemplarPageKey,
          exemplarAnalysis?.urlSkeleton.familyKey || exemplarAnalysis?.urlSkeleton.skeletonPath || null,
          exemplarAnalysis?.domSignature.hash || null,
          exemplarAnalysis?.regionSignature.hash || null,
          cluster.memberPageIds.length,
          cluster.confidence,
          stamp,
          stamp,
        ],
      );

      for (const memberPageId of cluster.memberPageIds) {
        await db.run(
          `INSERT INTO page_template_members (
             ownerId, siteUrl, siteScopeId, crawlJobId, templateKey, pageKey, distance, isExemplar, createdAt, updatedAt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            job.ownerId,
            job.siteUrl,
            scope.scope.id,
            job.crawlJobId,
            cluster.clusterId,
            memberPageId,
            clusterDistance(cluster, memberPageId),
            memberPageId === exemplarPageKey ? 1 : 0,
            stamp,
            stamp,
          ],
        );
      }
    }
  });
  await persist();
}

async function runPageAnalysis(db: AppDatabase, job: ClaimedPageAnalysisJob) {
  const startedAtMs = Date.now();
  const scope = await ensureSiteScope(db, {
    ownerId: job.ownerId,
    siteUrl: job.siteUrl,
    sourceKey: job.siteUrl,
    sourceType: 'crawl-site',
  });
  if (scope.scope.id !== job.siteScopeId) {
    await updateOwnedJob(db, job, { siteScopeId: scope.scope.id, updatedAt: nowIso() });
    job.siteScopeId = scope.scope.id;
  }

  const heartbeat = createHeartbeat(db, job);
  await heartbeat(0, 0, progressMetrics(0, 0, startedAtMs, { stage: 'loading-source' }), true);

  const { pages, blocks } = await loadSourceRows(db, job);
  const builtPages = await buildPageInputs(pages, blocks, async (completed, total) => {
    await heartbeat(completed, total, progressMetrics(completed, total, startedAtMs, { blockCount: blocks.length, pageCount: pages.length, stage: 'building-pages' }));
  });

  const buildTotal = Math.max(1, pages.length);
  await heartbeat(buildTotal, buildTotal, progressMetrics(buildTotal, buildTotal, startedAtMs, { blockCount: blocks.length, builtPages: builtPages.length, pageCount: pages.length, stage: 'analyzing' }), true);

  const dataset = analyzePageAuthorityDataset(builtPages.map((page) => page.input));

  await heartbeat(buildTotal, buildTotal, progressMetrics(buildTotal, buildTotal, startedAtMs, {
    builtPages: builtPages.length,
    clusterCount: dataset.clusters.clusters.length,
    repeatedBlockCount: dataset.repeatedBlocks.repeatedBlocks.length,
    stage: 'persisting',
  }), true);

  await persistAnalysis(db, scope, job, dataset, builtPages);

  const finalMetrics = progressMetrics(buildTotal, buildTotal, startedAtMs, {
    blockCount: blocks.length,
    builtPages: builtPages.length,
    clusterCount: dataset.clusters.clusters.length,
    pageCount: pages.length,
    persistedRegionCount: builtPages.reduce((sum, page) => sum + page.regions.length, 0),
    repeatedBlockCount: dataset.repeatedBlocks.repeatedBlocks.length,
    stage: 'completed',
  });
  await completeJob(db, job, buildTotal, buildTotal, finalMetrics);
}
export async function queueCompletedCrawlAnalysis(db: AppDatabase, input: QueueInput) {
  const scope = await ensureSiteScope(db, {
    ownerId: input.ownerId,
    propertyId: input.propertyId,
    siteUrl: input.siteUrl,
    sourceKey: input.sourceKey || input.siteUrl,
    sourceType: input.sourceType || 'crawl-site',
  });
  const stableId = stableJobId(input.ownerId, scope.scope.id, input.crawlJobId);
  const stamp = nowIso();
  const allowErrorRecoveryAt = Date.now();

  const queue = db.transaction(async () => {
    const exactExisting = await db.get<PageAnalysisJobRow>(
      `SELECT * FROM page_analysis_jobs
       WHERE ownerId = ? AND crawlJobId = ? AND analysisType = ?
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, COALESCE(updatedAt, completedAt) DESC, id ASC
       LIMIT 1`,
      [input.ownerId, input.crawlJobId, ANALYSIS_TYPE, stableId],
    );

    const recoverErroredJob = Boolean(exactExisting && !input.force && shouldRecoverErroredJob(exactExisting, allowErrorRecoveryAt));
    if (exactExisting && !input.force && !recoverErroredJob) {
      return exactExisting;
    }

    const conflicts = await db.all<PageAnalysisJobRow>(
      `SELECT * FROM page_analysis_jobs
       WHERE ownerId = ? AND siteScopeId = ? AND analysisType = ? AND status IN ('queued', 'running', 'retrying') AND (crawlJobId IS NULL OR crawlJobId <> ?)
       ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, updatedAt ASC, id ASC`,
      [input.ownerId, scope.scope.id, ANALYSIS_TYPE, input.crawlJobId],
    );

    const runningConflict = conflicts.find((row) => statusValue(row.status) === 'running');
    if (runningConflict) {
      return runningConflict;
    }

    for (const conflict of conflicts) {
      await db.run(
        `UPDATE page_analysis_jobs
         SET status = 'cancelled', lockedAt = NULL, nextRunAt = NULL, completedAt = ?, updatedAt = ?, lastError = ?
         WHERE id = ?`,
        [stamp, stamp, `Superseded by crawl ${input.crawlJobId}.`, conflict.id],
      );
    }

    const jobId = exactExisting?.id || stableId;
    const maxAttempts = Math.max(1, toNumber(exactExisting?.maxAttempts, DEFAULT_MAX_ATTEMPTS));
    const attemptCount = input.force || recoverErroredJob ? 0 : toNumber(exactExisting?.attemptCount, 0);

    if (exactExisting) {
      await db.run(
        `UPDATE page_analysis_jobs
         SET siteScopeId = ?, siteUrl = ?, crawlJobId = ?, analysisType = ?, status = 'queued',
             progressCompleted = 0, progressTotal = 0, attemptCount = ?, maxAttempts = ?, lockedAt = NULL,
             nextRunAt = ?, startedAt = NULL, completedAt = NULL, updatedAt = ?, lastError = NULL,
             provider = ?, modelVersion = ?, extractionVersion = ?, metricsJson = ?
         WHERE id = ?`,
        [
          scope.scope.id,
          input.siteUrl,
          input.crawlJobId,
          ANALYSIS_TYPE,
          attemptCount,
          maxAttempts,
          stamp,
          stamp,
          ANALYSIS_PROVIDER,
          ANALYSIS_MODEL,
          EXTRACTION_VERSION,
          JSON.stringify({
            queuedAt: stamp,
            source: 'crawl-complete',
            recoveredFromError: recoverErroredJob,
            previousAttemptCount: toNumber(exactExisting?.attemptCount, 0),
          }),
          jobId,
        ],
      );
    } else {
      await db.run(
        `INSERT INTO page_analysis_jobs (
           id, ownerId, siteScopeId, siteUrl, crawlJobId, analysisType, status, progressTotal,
           progressCompleted, attemptCount, maxAttempts, lockedAt, nextRunAt, startedAt,
           updatedAt, completedAt, lastError, provider, modelVersion, extractionVersion, metricsJson
         ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 0, 0, ?, NULL, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?)`,
        [
          jobId,
          input.ownerId,
          scope.scope.id,
          input.siteUrl,
          input.crawlJobId,
          ANALYSIS_TYPE,
          maxAttempts,
          stamp,
          stamp,
          ANALYSIS_PROVIDER,
          ANALYSIS_MODEL,
          EXTRACTION_VERSION,
          JSON.stringify({ queuedAt: stamp, source: 'crawl-complete' }),
        ],
      );
    }

    const queued = await db.get<PageAnalysisJobRow>('SELECT * FROM page_analysis_jobs WHERE id = ? LIMIT 1', [jobId]);
    if (!queued) throw new Error(`Failed to queue page analysis job ${jobId}.`);
    return queued;
  });
  return queue();
}

export function startPageAnalysisWorker(db: AppDatabase) {
  const workerCount = clampWorkerCount(process.env.PAGE_ANALYSIS_WORKERS);
  let stopped = false;

  async function runLoop(index: number) {
    while (!stopped) {
      try {
        if (index === 0) {
          await queueMissingCompletedCrawls(db);
        }

        const job = await claimNextJob(db);
        if (!job) {
          await sleep(ANALYSIS_POLL_MS);
          continue;
        }

        try {
          await runPageAnalysis(db, job);
        } catch (error) {
          if (error instanceof PageAnalysisLeaseLostError) {
            console.warn('[page-analysis] Lease lost while processing job', job.id);
          } else {
            console.error('[page-analysis] Job failed', { crawlJobId: job.crawlJobId, jobId: job.id, siteUrl: job.siteUrl, error });
            await markJobForRetry(db, job, error);
          }
        }
      } catch (error) {
        console.error('[page-analysis] Worker loop failed', error);
        await sleep(ANALYSIS_POLL_MS);
      }
    }
  }

  for (let index = 0; index < workerCount; index += 1) {
    void runLoop(index);
  }

  return () => {
    stopped = true;
  };
}

export const __pageAnalysisTestUtils = {
  claimNextJob,
  queueMissingCompletedCrawls,
  recoverStaleJobs,
};
