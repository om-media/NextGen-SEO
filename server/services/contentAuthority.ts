import type { AppDatabase } from '../database.js';
import { resolveSiteScopeBySiteUrl } from './siteScopes.js';

type ReadinessStatus = 'no_crawl' | 'pending' | 'ready' | 'partial' | 'failed';

type EvidenceCounts = {
  pageCount: number;
  profileCount: number;
  regionCount: number;
  regionPageCount: number;
  templateCount: number;
  templateMemberCount: number;
  templateMemberPageCount: number;
};

type EvidenceVersion = {
  jobExtractionVersion: number | null;
  minimumExtractionVersion: number | null;
  regionExtractionVersion: number | null;
  requiredExtractionVersion: number;
  state: 'supported' | 'outdated' | 'unknown';
};

type Context = {
  confidence: { label: 'high' | 'medium' | 'low' | 'unknown'; value: number | null };
  counts: EvidenceCounts;
  crawlJobId: string | null;
  freshness: {
    ageHours: number | null;
    analyzedAt: string | null;
    crawlJobId: string | null;
    state: 'fresh' | 'stale' | 'pending' | 'failed' | 'unknown';
    updatedAt: string | null;
  };
  job: Record<string, unknown> | null;
  readiness: ReadinessStatus;
  siteScope: Record<string, unknown> | null;
  siteSources: Array<Record<string, unknown>>;
  version: EvidenceVersion;
};

type JobContext = {
  crawl: Record<string, unknown> | null;
  crawlJobId: string | null;
  hasCompletedCrawl: boolean;
  job: Record<string, unknown> | null;
};

type Region = {
  blockIndex: number | null;
  blockKey: string | null;
  boilerplateScore: number | null;
  componentType: string | null;
  confidence: number | null;
  domPath: string | null;
  evidence: unknown;
  extractionVersion: number | null;
  headingChain: string[];
  linkDensity: number | null;
  pageKey: string;
  parentRegionIndex: number | null;
  regionIndex: number | null;
  regionRole: string | null;
  selector: string | null;
  templateFrequency: number | null;
  text: string | null;
  textDensity: number | null;
  viewportProminence: number | null;
  visible: boolean;
};

const REQUIRED_EXTRACTION_VERSION = 3;

const PENDING = new Set(['created', 'pending', 'queued', 'retrying', 'running', 'starting']);
const FAILED = new Set(['canceled', 'cancelled', 'error', 'failed']);

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const numOrNull = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const bool = (value: unknown) => {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
};

const json = <T>(value: unknown): T | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return null;
  }
};

const normStatus = (value: unknown) => String(value ?? '').trim().toLowerCase();
const isPending = (value: unknown) => PENDING.has(normStatus(value));
const isFailed = (value: unknown) => FAILED.has(normStatus(value));
const placeholders = (count: number) => new Array(count).fill('?').join(', ');
const ratio = (value: number, total: number) => total ? Number((value / total).toFixed(4)) : 0;

function normalizeConfidence(value: unknown) {
  const parsed = numOrNull(value);
  if (parsed === null) return null;
  return parsed > 1 ? Math.max(0, Math.min(parsed / 100, 1)) : Math.max(0, Math.min(parsed, 1));
}

function confidenceSummary(values: unknown[]) {
  const normalized = values
    .map(normalizeConfidence)
    .filter((value): value is number => value !== null);

  if (!normalized.length) {
    return { label: 'unknown' as const, value: null };
  }

  const average = Number((normalized.reduce((sum, value) => sum + value, 0) / normalized.length).toFixed(4));
  return {
    label: average >= 0.75 ? 'high' as const : average >= 0.45 ? 'medium' as const : 'low' as const,
    value: average,
  };
}

function clip(text: unknown, max = 200) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function freshness(job: Record<string, unknown> | null, crawlJobId: string | null): Context['freshness'] {
  const analyzedAt = String(job?.completedAt || '') || null;
  const updatedAt = String(job?.completedAt || job?.updatedAt || job?.startedAt || '') || null;
  const stamp = analyzedAt || updatedAt;
  const ms = stamp ? new Date(stamp).getTime() : NaN;
  const ageHours = Number.isFinite(ms)
    ? Number(Math.max(0, (Date.now() - ms) / 3_600_000).toFixed(2))
    : null;

  let state: Context['freshness']['state'] = 'unknown';
  if (isPending(job?.status)) state = 'pending';
  else if (isFailed(job?.status)) state = 'failed';
  else if (ageHours === null) state = 'unknown';
  else state = ageHours <= 72 ? 'fresh' : 'stale';

  return { ageHours, analyzedAt, crawlJobId, state, updatedAt };
}

function readiness(crawl: Record<string, unknown> | null, job: Record<string, unknown> | null, counts: EvidenceCounts, hasCompletedCrawl: boolean, version: EvidenceVersion): ReadinessStatus {
  const hasEvidence = counts.pageCount > 0 || counts.profileCount > 0 || counts.regionCount > 0 || counts.templateCount > 0;
  const crawlStatus = normStatus(crawl?.status);

  if (!hasEvidence && !crawl && !job && !hasCompletedCrawl) return 'no_crawl';
  if (isPending(job?.status)) return hasEvidence ? 'partial' : 'pending';
  if (!hasEvidence && isPending(crawlStatus)) return 'pending';
  if (isFailed(job?.status)) return hasEvidence ? 'partial' : 'failed';
  if (!hasEvidence && isFailed(crawlStatus) && !hasCompletedCrawl) return 'failed';
  if (!hasEvidence) return hasCompletedCrawl ? 'pending' : 'failed';
  if (version.state === 'outdated') return 'partial';

  const profileCoverage = ratio(counts.profileCount, counts.pageCount || counts.profileCount);
  const regionCoverage = ratio(counts.regionPageCount, counts.pageCount || counts.regionPageCount);
  const templateCoverage = ratio(counts.templateMemberPageCount, counts.pageCount || counts.templateMemberPageCount);
  return counts.pageCount > 0 && counts.templateCount > 0 && profileCoverage >= 0.9 && regionCoverage >= 0.9 && templateCoverage >= 0.75
    ? 'ready'
    : 'partial';
}

async function resolveSiteScope(db: AppDatabase, ownerId: string, siteUrl: string) {
  const resolved = await resolveSiteScopeBySiteUrl(db, ownerId, siteUrl);
  if (!resolved) {
    return { siteScope: null, siteSources: [] as Array<Record<string, unknown>> };
  }
  return {
    siteScope: resolved.scope,
    siteSources: resolved.sources,
  };
}

async function resolveJobContext(db: AppDatabase, ownerId: string, siteScopeId: string, requestedCrawlJobId: string | null): Promise<JobContext> {
  const jobs = requestedCrawlJobId
    ? await db.all<Record<string, unknown>>(`
      SELECT *
      FROM page_analysis_jobs
      WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?
      ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
      LIMIT 25
    `, [ownerId, siteScopeId, requestedCrawlJobId])
    : await db.all<Record<string, unknown>>(`
      SELECT *
      FROM page_analysis_jobs
      WHERE ownerId = ? AND siteScopeId = ?
      ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC, id DESC
      LIMIT 50
    `, [ownerId, siteScopeId]);

  const loadCrawl = async (crawlJobId: string | null) => crawlJobId
    ? await db.get<Record<string, unknown>>(
      'SELECT * FROM crawl_jobs WHERE ownerId = ? AND id = ? LIMIT 1',
      [ownerId, crawlJobId],
    )
    : null;

  if (requestedCrawlJobId) {
    const job = jobs[0] || null;
    const crawlJobId = job ? String(job.crawlJobId || '') || null : null;
    const crawl = await loadCrawl(crawlJobId);
    return {
      crawl,
      crawlJobId,
      hasCompletedCrawl: normStatus(crawl?.status) === 'completed',
      job,
    };
  }

  for (const candidate of jobs) {
    if (normStatus(candidate.status) !== 'completed') continue;
    const candidateId = String(candidate.crawlJobId || '') || null;
    if (!candidateId) continue;
    const candidateCounts = await countEvidence(db, ownerId, siteScopeId, candidateId);
    const candidateVersion = await resolveEvidenceVersion(db, ownerId, candidateId, candidate);
    const hasEvidence = candidateCounts.pageCount > 0
      || candidateCounts.profileCount > 0
      || candidateCounts.regionCount > 0
      || candidateCounts.templateCount > 0;
    if (hasEvidence && candidateVersion.state === 'supported') {
      return {
        crawl: await loadCrawl(candidateId),
        crawlJobId: candidateId,
        hasCompletedCrawl: true,
        job: candidate,
      };
    }
  }

  const latestJob = jobs[0] || null;
  const latestJobId = String(latestJob?.crawlJobId || '') || null;
  const latestCrawl = await loadCrawl(latestJobId);
  return {
    crawl: latestCrawl,
    crawlJobId: latestJobId,
    hasCompletedCrawl: normStatus(latestCrawl?.status) === 'completed',
    job: latestJob,
  };
}

async function countEvidence(db: AppDatabase, ownerId: string, siteScopeId: string, crawlJobId: string | null): Promise<EvidenceCounts> {
  if (!crawlJobId) {
    return { pageCount: 0, profileCount: 0, regionCount: 0, regionPageCount: 0, templateCount: 0, templateMemberCount: 0, templateMemberPageCount: 0 };
  }

  const [pages, profiles, regions, regionPages, templates, templateMembers, templateMemberPages] = await Promise.all([
    db.get<{ count?: unknown }>(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT pageKey FROM page_function_profiles WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?
        UNION
        SELECT pageKey FROM page_template_members WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?
        UNION
        SELECT pageKey FROM crawl_page_regions WHERE ownerId = ? AND jobId = ?
      ) page_keys
    `, [ownerId, siteScopeId, crawlJobId, ownerId, siteScopeId, crawlJobId, ownerId, crawlJobId]),
    db.get<{ count?: unknown }>(
      'SELECT COUNT(*) AS count FROM page_function_profiles WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?',
      [ownerId, siteScopeId, crawlJobId],
    ),
    db.get<{ count?: unknown }>(
      'SELECT COUNT(*) AS count FROM crawl_page_regions WHERE ownerId = ? AND jobId = ?',
      [ownerId, crawlJobId],
    ),
    db.get<{ count?: unknown }>(
      'SELECT COUNT(DISTINCT pageKey) AS count FROM crawl_page_regions WHERE ownerId = ? AND jobId = ?',
      [ownerId, crawlJobId],
    ),
    db.get<{ count?: unknown }>(
      'SELECT COUNT(*) AS count FROM page_template_clusters WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?',
      [ownerId, siteScopeId, crawlJobId],
    ),
    db.get<{ count?: unknown }>(
      'SELECT COUNT(*) AS count FROM page_template_members WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?',
      [ownerId, siteScopeId, crawlJobId],
    ),
    db.get<{ count?: unknown }>(
      'SELECT COUNT(DISTINCT pageKey) AS count FROM page_template_members WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?',
      [ownerId, siteScopeId, crawlJobId],
    ),
  ]);

  return {
    pageCount: num(pages?.count),
    profileCount: num(profiles?.count),
    regionCount: num(regions?.count),
    regionPageCount: num(regionPages?.count),
    templateCount: num(templates?.count),
    templateMemberCount: num(templateMembers?.count),
    templateMemberPageCount: num(templateMemberPages?.count),
  };
}

async function resolveEvidenceVersion(db: AppDatabase, ownerId: string, crawlJobId: string | null, job: Record<string, unknown> | null): Promise<EvidenceVersion> {
  const jobExtractionVersion = numOrNull(job?.extractionVersion);
  if (!crawlJobId) {
    return {
      jobExtractionVersion,
      minimumExtractionVersion: null,
      regionExtractionVersion: null,
      requiredExtractionVersion: REQUIRED_EXTRACTION_VERSION,
      state: jobExtractionVersion !== null && jobExtractionVersion < REQUIRED_EXTRACTION_VERSION ? 'outdated' : 'unknown',
    };
  }

  const regionRow = await db.get<{ minimumExtractionVersion?: unknown; regionExtractionVersion?: unknown }>(`
    SELECT
      MIN(extractionVersion) AS minimumExtractionVersion,
      MAX(extractionVersion) AS regionExtractionVersion
    FROM crawl_page_regions
    WHERE ownerId = ? AND jobId = ?
  `, [ownerId, crawlJobId]);

  const minimumExtractionVersion = numOrNull(regionRow?.minimumExtractionVersion);
  const regionExtractionVersion = numOrNull(regionRow?.regionExtractionVersion);
  const known = [jobExtractionVersion, minimumExtractionVersion].filter((value): value is number => value !== null);
  const state = !known.length
    ? 'unknown'
    : known.some((value) => value < REQUIRED_EXTRACTION_VERSION)
      ? 'outdated'
      : 'supported';

  return {
    jobExtractionVersion,
    minimumExtractionVersion,
    regionExtractionVersion,
    requiredExtractionVersion: REQUIRED_EXTRACTION_VERSION,
    state,
  };
}
async function prepareContext(db: AppDatabase, ownerId: string, siteUrl: string, requestedCrawlJobId: string | null): Promise<Context> {
  const { siteScope, siteSources } = await resolveSiteScope(db, ownerId, siteUrl);
  if (!siteScope) {
    const counts = { pageCount: 0, profileCount: 0, regionCount: 0, regionPageCount: 0, templateCount: 0, templateMemberCount: 0, templateMemberPageCount: 0 };
    return {
      confidence: { label: 'unknown', value: null },
      counts,
      crawlJobId: requestedCrawlJobId,
      freshness: freshness(null, requestedCrawlJobId),
      job: null,
      readiness: 'no_crawl',
      siteScope: null,
      siteSources,
      version: {
        jobExtractionVersion: null,
        minimumExtractionVersion: null,
        regionExtractionVersion: null,
        requiredExtractionVersion: REQUIRED_EXTRACTION_VERSION,
        state: 'unknown',
      },
    };
  }

  const siteScopeId = String(siteScope.id);
  const jobContext = await resolveJobContext(db, ownerId, siteScopeId, requestedCrawlJobId);
  const counts = await countEvidence(db, ownerId, siteScopeId, jobContext.crawlJobId);
  const version = await resolveEvidenceVersion(db, ownerId, jobContext.crawlJobId, jobContext.job);
  const freshnessSource = jobContext.job || jobContext.crawl;
  return {
    confidence: confidenceSummary([
      counts.pageCount ? counts.profileCount / Math.max(counts.pageCount, 1) : null,
      counts.pageCount ? counts.regionPageCount / Math.max(counts.pageCount, 1) : null,
      counts.pageCount ? counts.templateMemberPageCount / Math.max(counts.pageCount, 1) : null,
    ]),
    counts,
    crawlJobId: jobContext.crawlJobId,
    freshness: freshness(freshnessSource, jobContext.crawlJobId),
    job: jobContext.job,
    readiness: readiness(jobContext.crawl, jobContext.job, counts, jobContext.hasCompletedCrawl, version),
    siteScope,
    siteSources,
    version,
  };
}

function extractionVersionMessage(version: EvidenceVersion) {
  if (version.state !== 'outdated') return null;
  const parts = [
    version.jobExtractionVersion !== null ? `analysis job version ${version.jobExtractionVersion}` : null,
    version.minimumExtractionVersion !== null ? `region evidence version ${version.minimumExtractionVersion}` : null,
  ].filter((value): value is string => Boolean(value));
  const source = parts.join(' and ');
  return `${source || 'Stored evidence'} is below extraction version ${version.requiredExtractionVersion}. Re-run analysis to upgrade the persisted content authority evidence.`;
}

function payloadFromContext(context: Context) {
  const coverageBase = context.counts.pageCount || 1;
  return {
    confidence: context.confidence,
    counts: context.counts,
    coverage: {
      profileCoverage: ratio(context.counts.profileCount, coverageBase),
      regionCoverage: ratio(context.counts.regionPageCount, coverageBase),
      templateCoverage: ratio(context.counts.templateMemberPageCount, coverageBase),
    },
    crawlJobId: context.crawlJobId,
    freshness: context.freshness,
    version: context.version,
    job: context.job ? {
      analysisType: context.job.analysisType || null,
      completedAt: context.job.completedAt || null,
      id: context.job.id || null,
      lastError: context.job.lastError || null,
      progressCompleted: numOrNull(context.job.progressCompleted),
      progressTotal: numOrNull(context.job.progressTotal),
      startedAt: context.job.startedAt || null,
      status: context.job.status || null,
      updatedAt: context.job.updatedAt || null,
    } : null,
    message: context.readiness === 'no_crawl'
      ? 'No stored content authority evidence is available for this site and crawl selection.'
      : context.readiness === 'pending'
        ? 'Stored content authority analysis is still being prepared for this crawl.'
        : context.readiness === 'failed'
          ? String(context.job?.lastError || 'The latest content authority analysis failed before producing usable evidence.')
          : context.readiness === 'partial'
            ? extractionVersionMessage(context.version) || (context.job?.lastError
              ? `Stored evidence is incomplete. Latest analysis error: ${context.job.lastError}`
              : 'Stored evidence is available, but profile, region, or template coverage is incomplete for this crawl.')
            : 'Stored content authority evidence is ready for this crawl.',
    siteScope: context.siteScope ? {
      canonicalDomain: context.siteScope.canonicalDomain || null,
      createdAt: context.siteScope.createdAt || null,
      id: context.siteScope.id,
      updatedAt: context.siteScope.updatedAt || null,
    } : null,
    sources: context.siteSources.map((source) => ({
      propertyId: source.propertyId || null,
      siteUrl: source.siteUrl || null,
      sourceKey: source.sourceKey || null,
      sourceType: source.sourceType || null,
    })),
    status: context.readiness,
  };
}

function mapRegions(rows: Array<Record<string, unknown>>): Region[] {
  return rows.map((row) => ({
    blockIndex: numOrNull(row.blockIndex),
    blockKey: String(row.blockKey || '') || null,
    boilerplateScore: numOrNull(row.boilerplateScore),
    componentType: String(row.componentType || '') || null,
    confidence: numOrNull(row.confidence),
    domPath: String(row.domPath || '') || null,
    evidence: json(row.featureBreakdownJson),
    extractionVersion: numOrNull(row.extractionVersion),
    headingChain: json<string[]>(row.headingChainJson) || [],
    linkDensity: numOrNull(row.linkDensity),
    pageKey: String(row.pageKey || ''),
    parentRegionIndex: numOrNull(row.parentRegionIndex),
    regionIndex: numOrNull(row.regionIndex),
    regionRole: String(row.regionRole || '') || null,
    selector: String(row.selector || '') || null,
    templateFrequency: numOrNull(row.templateFrequency),
    text: clip(row.text, 500),
    textDensity: numOrNull(row.textDensity),
    viewportProminence: numOrNull(row.viewportProminence),
    visible: bool(row.visible),
  }));
}

function regionScore(region: Region) {
  return (normalizeConfidence(region.confidence) ?? 0) * 100
    + (region.viewportProminence ?? 0) * 25
    + (region.visible ? 10 : 0)
    + (region.textDensity ?? 0) * 10
    - (region.linkDensity ?? 0) * 8
    - (region.boilerplateScore ?? 0) * 12;
}

function roleCounts(regions: Region[]) {
  const counts = new Map<string, number>();
  for (const region of regions) {
    const role = region.regionRole || 'unknown';
    counts.set(role, (counts.get(role) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([role, count]) => ({ count, role }))
    .sort((left, right) => right.count - left.count || left.role.localeCompare(right.role));
}

async function loadRegions(db: AppDatabase, ownerId: string, crawlJobId: string, pageKeys: string[]) {
  const map = new Map<string, Region[]>();
  if (!pageKeys.length) return map;
  const rows = await db.all<Record<string, unknown>>(`
    SELECT *
    FROM crawl_page_regions
    WHERE ownerId = ? AND jobId = ? AND pageKey IN (${placeholders(pageKeys.length)})
  `, [ownerId, crawlJobId, ...pageKeys]);

  for (const region of mapRegions(rows)) {
    const current = map.get(region.pageKey) || [];
    current.push(region);
    map.set(region.pageKey, current);
  }

  for (const regions of map.values()) {
    regions.sort((left, right) => regionScore(right) - regionScore(left));
  }

  return map;
}

export async function getContentAuthorityReadiness(db: AppDatabase, ownerId: string, input: { siteUrl: string; crawlJobId?: string | null }) {
  return payloadFromContext(await prepareContext(db, ownerId, input.siteUrl, input.crawlJobId || null));
}

type PageListInput = {
  crawlJobId?: string | null;
  limit?: number;
  offset?: number;
  search?: string | null;
  siteUrl: string;
};

export async function listContentAuthorityPages(db: AppDatabase, ownerId: string, input: PageListInput) {
  const limit = Math.max(1, Math.min(Number(input.limit) || 50, 500));
  const offset = Math.max(0, Number(input.offset) || 0);
  const search = String(input.search || '').trim();
  const context = await prepareContext(db, ownerId, input.siteUrl, input.crawlJobId || null);
  const meta = payloadFromContext(context);

  if (!context.siteScope || !context.crawlJobId) {
    return { meta, page: { limit, offset, total: 0 }, rows: [] };
  }

  const siteScopeId = String(context.siteScope.id);
  const searchSql = search
    ? `WHERE COALESCE(crawl_pages.url, page_keys.pageKey) LIKE ? OR COALESCE(crawl_pages.title, '') LIKE ? OR page_keys.pageKey LIKE ?`
    : '';
  const searchParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

  const baseCtes = `
    WITH page_keys AS (
      SELECT pageKey FROM page_function_profiles
      WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?
      UNION
      SELECT pageKey FROM page_template_members
      WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?
      UNION
      SELECT pageKey FROM crawl_page_regions
      WHERE ownerId = ? AND jobId = ?
    ),
    member_templates AS (
      SELECT
        pageKey,
        MIN(templateKey) AS templateKey,
        MIN(distance) AS distance,
        MAX(COALESCE(isExemplar, 0)) AS isExemplar
      FROM page_template_members
      WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?
      GROUP BY pageKey
    )
  `;

  const baseParams = [
    ownerId, siteScopeId, context.crawlJobId,
    ownerId, siteScopeId, context.crawlJobId,
    ownerId, context.crawlJobId,
    ownerId, siteScopeId, context.crawlJobId,
  ];

  const totalRow = await db.get<{ count?: unknown }>(`
    ${baseCtes}
    SELECT COUNT(*) AS count
    FROM page_keys
    LEFT JOIN crawl_pages
      ON crawl_pages.ownerId = ? AND crawl_pages.jobId = ? AND crawl_pages.pageKey = page_keys.pageKey
    ${searchSql}
  `, [...baseParams, ownerId, context.crawlJobId, ...searchParams]);

  const rows = await db.all<Record<string, unknown>>(`
    ${baseCtes}
    SELECT
      page_keys.pageKey,
      crawl_pages.url,
      crawl_pages.title,
      crawl_pages.wordCount,
      crawl_pages.depth,
      profiles.pageType,
      profiles.primaryTask,
      profiles.centerpieceRegionIndex,
      profiles.confidence,
      profiles.featureBreakdownJson,
      COALESCE(profiles.templateKey, member_templates.templateKey) AS templateKey,
      member_templates.distance,
      member_templates.isExemplar,
      clusters.memberCount,
      clusters.urlSkeleton,
      clusters.exemplarPageKey,
      clusters.confidence AS templateConfidence,
      clusters.updatedAt AS templateUpdatedAt,
      clusters.createdAt AS templateCreatedAt
    FROM page_keys
    LEFT JOIN crawl_pages
      ON crawl_pages.ownerId = ?
      AND crawl_pages.jobId = ?
      AND crawl_pages.pageKey = page_keys.pageKey
    LEFT JOIN page_function_profiles profiles
      ON profiles.ownerId = ?
      AND profiles.siteScopeId = ?
      AND profiles.crawlJobId = ?
      AND profiles.pageKey = page_keys.pageKey
    LEFT JOIN member_templates
      ON member_templates.pageKey = page_keys.pageKey
    LEFT JOIN page_template_clusters clusters
      ON clusters.ownerId = ?
      AND clusters.siteScopeId = ?
      AND clusters.crawlJobId = ?
      AND clusters.templateKey = COALESCE(profiles.templateKey, member_templates.templateKey)
    ${searchSql}
    ORDER BY COALESCE(profiles.confidence, clusters.confidence, 0) DESC, COALESCE(crawl_pages.url, page_keys.pageKey) ASC
    LIMIT ? OFFSET ?
  `, [
    ...baseParams,
    ownerId, context.crawlJobId,
    ownerId, siteScopeId, context.crawlJobId,
    ownerId, siteScopeId, context.crawlJobId,
    ...searchParams,
    limit,
    offset,
  ]);

  const pageKeys = rows.map((row) => String(row.pageKey || '')).filter(Boolean);
  const regionsByPage = await loadRegions(db, ownerId, context.crawlJobId, pageKeys);

  return {
    meta,
    page: { limit, offset, total: num(totalRow?.count) },
    rows: rows.map((row) => {
      const pageKey = String(row.pageKey || '');
      const regions = regionsByPage.get(pageKey) || [];
      const topRegion = regions[0] || null;
      return {
        confidence: confidenceSummary([row.confidence, row.templateConfidence]),
        depth: numOrNull(row.depth),
        pageKey,
        pageType: String(row.pageType || '') || null,
        primaryTask: String(row.primaryTask || '') || null,
        template: row.templateKey ? {
          confidence: normalizeConfidence(row.templateConfidence),
          distance: numOrNull(row.distance),
          exemplarPageKey: String(row.exemplarPageKey || '') || null,
          isExemplar: bool(row.isExemplar),
          memberCount: num(row.memberCount),
          templateKey: String(row.templateKey || ''),
          urlSkeleton: String(row.urlSkeleton || '') || null,
        } : null,
        title: String(row.title || '') || null,
        topEvidence: topRegion ? {
          confidence: normalizeConfidence(topRegion.confidence),
          role: topRegion.regionRole,
          text: topRegion.text,
        } : null,
        url: String(row.url || '') || null,
        wordCount: numOrNull(row.wordCount),
        regions: {
          count: regions.length,
          roles: roleCounts(regions),
        },
        featureBreakdown: json(row.featureBreakdownJson),
      };
    }),
  };
}
export async function getContentAuthorityPageEvidence(db: AppDatabase, ownerId: string, input: { crawlJobId?: string | null; pageKey: string; siteUrl: string }) {
  const context = await prepareContext(db, ownerId, input.siteUrl, input.crawlJobId || null);
  const meta = payloadFromContext(context);

  if (!context.siteScope || !context.crawlJobId) {
    return { found: false, meta, page: null };
  }

  const siteScopeId = String(context.siteScope.id);
  const page = await db.get<Record<string, unknown>>(`
    SELECT
      crawl_pages.*,
      profiles.pageType,
      profiles.primaryTask,
      profiles.secondaryTasksJson,
      profiles.centerpieceRegionIndex,
      profiles.confidence,
      profiles.featureBreakdownJson,
      profiles.templateKey,
      profiles.manualOverrideJson,
      clusters.memberCount,
      clusters.urlSkeleton,
      clusters.exemplarPageKey,
      clusters.confidence AS templateConfidence
    FROM crawl_pages
    LEFT JOIN page_function_profiles profiles
      ON profiles.ownerId = ?
      AND profiles.siteScopeId = ?
      AND profiles.crawlJobId = ?
      AND profiles.pageKey = crawl_pages.pageKey
    LEFT JOIN page_template_clusters clusters
      ON clusters.ownerId = ?
      AND clusters.siteScopeId = ?
      AND clusters.crawlJobId = ?
      AND clusters.templateKey = profiles.templateKey
    WHERE crawl_pages.ownerId = ? AND crawl_pages.jobId = ? AND crawl_pages.pageKey = ?
    LIMIT 1
  `, [
    ownerId, siteScopeId, context.crawlJobId,
    ownerId, siteScopeId, context.crawlJobId,
    ownerId, context.crawlJobId, input.pageKey,
  ]);

  if (!page) {
    return { found: false, meta, page: null };
  }

  const templateMembership = page.templateKey
    ? await db.get<Record<string, unknown>>(`
      SELECT distance, isExemplar
      FROM page_template_members
      WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ? AND templateKey = ? AND pageKey = ?
      LIMIT 1
    `, [ownerId, siteScopeId, context.crawlJobId, String(page.templateKey), input.pageKey])
    : null;

  const regionsByPage = await loadRegions(db, ownerId, context.crawlJobId, [input.pageKey]);
  const regions = regionsByPage.get(input.pageKey) || [];

  return {
    found: true,
    meta,
    page: {
      confidence: confidenceSummary([page.confidence, page.templateConfidence]),
      crawl: {
        canonicalUrl: String(page.canonicalUrl || '') || null,
        depth: numOrNull(page.depth),
        metaDescription: String(page.metaDescription || '') || null,
        statusCode: numOrNull(page.statusCode),
        title: String(page.title || '') || null,
        url: String(page.url || '') || null,
        wordCount: numOrNull(page.wordCount),
      },
      featureBreakdown: json(page.featureBreakdownJson),
      manualOverride: json(page.manualOverrideJson),
      pageKey: input.pageKey,
      pageType: String(page.pageType || '') || null,
      primaryTask: String(page.primaryTask || '') || null,
      regions: regions.map((region) => ({
        ...region,
        confidence: normalizeConfidence(region.confidence),
      })),
      secondaryTasks: json<string[]>(page.secondaryTasksJson) || [],
      template: page.templateKey ? {
        confidence: normalizeConfidence(page.templateConfidence),
        distance: numOrNull(templateMembership?.distance),
        exemplarPageKey: String(page.exemplarPageKey || '') || null,
        isExemplar: bool(templateMembership?.isExemplar),
        memberCount: num(page.memberCount),
        templateKey: String(page.templateKey || ''),
        urlSkeleton: String(page.urlSkeleton || '') || null,
      } : null,
      topEvidence: regions[0] ? {
        confidence: normalizeConfidence(regions[0].confidence),
        role: regions[0].regionRole,
        text: regions[0].text,
      } : null,
    },
  };
}
export async function listContentAuthorityTemplates(db: AppDatabase, ownerId: string, input: { crawlJobId?: string | null; siteUrl: string }) {
  const context = await prepareContext(db, ownerId, input.siteUrl, input.crawlJobId || null);
  const meta = payloadFromContext(context);

  if (!context.siteScope || !context.crawlJobId) {
    return { meta, rows: [] };
  }

  const siteScopeId = String(context.siteScope.id);
  const templates = await db.all<Record<string, unknown>>(`
    SELECT *
    FROM page_template_clusters
    WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ?
    ORDER BY COALESCE(confidence, 0) DESC, templateKey ASC
  `, [ownerId, siteScopeId, context.crawlJobId]);

  if (!templates.length) {
    return { meta, rows: [] };
  }

  const templateKeys = templates.map((row) => String(row.templateKey || '')).filter(Boolean);
  const exemplarPageKeys = Array.from(new Set(templates.map((row) => String(row.exemplarPageKey || '')).filter(Boolean)));

  const [memberRows, profileRows, exemplarRows] = await Promise.all([
    db.all<Record<string, unknown>>(`
      SELECT templateKey, pageKey, distance, isExemplar
      FROM page_template_members
      WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ? AND templateKey IN (${placeholders(templateKeys.length)})
    `, [ownerId, siteScopeId, context.crawlJobId, ...templateKeys]),
    db.all<Record<string, unknown>>(`
      SELECT templateKey, pageKey, pageType, primaryTask, confidence
      FROM page_function_profiles
      WHERE ownerId = ? AND siteScopeId = ? AND crawlJobId = ? AND templateKey IN (${placeholders(templateKeys.length)})
    `, [ownerId, siteScopeId, context.crawlJobId, ...templateKeys]),
    exemplarPageKeys.length
      ? db.all<Record<string, unknown>>(`
        SELECT *
        FROM crawl_page_regions
        WHERE ownerId = ? AND jobId = ? AND pageKey IN (${placeholders(exemplarPageKeys.length)})
      `, [ownerId, context.crawlJobId, ...exemplarPageKeys])
      : Promise.resolve([] as Array<Record<string, unknown>>),
  ]);

  const memberMap = new Map<string, Array<Record<string, unknown>>>();
  for (const row of memberRows) {
    const key = String(row.templateKey || '');
    const current = memberMap.get(key) || [];
    current.push(row);
    memberMap.set(key, current);
  }

  const profileMap = new Map<string, Array<Record<string, unknown>>>();
  for (const row of profileRows) {
    const key = String(row.templateKey || '');
    const current = profileMap.get(key) || [];
    current.push(row);
    profileMap.set(key, current);
  }

  const exemplarRegionMap = new Map<string, Region[]>();
  for (const region of mapRegions(exemplarRows)) {
    const current = exemplarRegionMap.get(region.pageKey) || [];
    current.push(region);
    exemplarRegionMap.set(region.pageKey, current);
  }
  for (const regions of exemplarRegionMap.values()) {
    regions.sort((left, right) => regionScore(right) - regionScore(left));
  }

  const summarize = (rows: Array<Record<string, unknown>>, field: string) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = String(row[field] || '').trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([value, count]) => ({ count, value }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
  };

  return {
    meta,
    rows: templates.map((template) => {
      const templateKey = String(template.templateKey || '');
      const members = memberMap.get(templateKey) || [];
      const profiles = profileMap.get(templateKey) || [];
      const exemplarPageKey = String(template.exemplarPageKey || '') || null;
      const exemplarRegions = exemplarPageKey ? exemplarRegionMap.get(exemplarPageKey) || [] : [];
      const topRegion = exemplarRegions[0] || null;
      return {
        confidence: confidenceSummary([template.confidence, ...profiles.map((row) => row.confidence)]),
        evidence: {
          exemplarRegions: exemplarRegions.length,
          members: members.length,
          pageTypes: summarize(profiles, 'pageType'),
          primaryTasks: summarize(profiles, 'primaryTask'),
        },
        exemplarPageKey,
        freshness: {
          createdAt: String(template.createdAt || '') || null,
          updatedAt: String(template.updatedAt || '') || null,
        },
        memberCount: num(template.memberCount) || members.length,
        templateKey,
        topEvidence: topRegion ? {
          confidence: normalizeConfidence(topRegion.confidence),
          role: topRegion.regionRole,
          text: topRegion.text,
        } : null,
        urlSkeleton: String(template.urlSkeleton || '') || null,
      };
    }),
  };
}