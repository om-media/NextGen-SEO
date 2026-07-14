import Database from 'better-sqlite3';
import fs from 'fs';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalPageKey, resolvedCanonicalPageKey } from './reporting/url.js';

const { Pool } = pg;
type PgQueryable = pg.Pool | pg.PoolClient;

const DB_FILENAME = 'sqlite.db';
const DB_BACKUP_FILENAME = `${DB_FILENAME}.bak`;

export type QueryParams = unknown[] | Record<string, unknown>;

export type RunResult = {
  changes: number;
  lastInsertRowid?: number | bigint;
};

export type AppDatabase = {
  dialect: 'sqlite' | 'postgres';
  prepare: (sql: string) => any;
  exec: (sql: string) => Promise<void>;
  get: <T = unknown>(sql: string, params?: QueryParams) => Promise<T | undefined>;
  all: <T = unknown>(sql: string, params?: QueryParams) => Promise<T[]>;
  run: (sql: string, params?: QueryParams) => Promise<RunResult>;
  transaction: <Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) => (...args: Args) => Promise<T>;
  getDiagnostics?: () => DatabaseDiagnostics;
  close?: () => Promise<void>;
};

export type PostgresPoolSettings = {
  max: number;
  min: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  maxLifetimeSeconds: number;
  queryTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTransactionSessionTimeoutMs: number;
  keepAlive: boolean;
  keepAliveInitialDelayMillis: number;
  applicationName: string;
};

export type DatabaseDiagnostics = {
  dialect: 'sqlite' | 'postgres';
  pool?: {
    max: number;
    min: number;
    totalCount: number;
    idleCount: number;
    waitingCount: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    maxLifetimeSeconds: number;
    queryTimeoutMs: number;
    statementTimeoutMs: number;
    idleInTransactionSessionTimeoutMs: number;
    keepAlive: boolean;
    keepAliveInitialDelayMillis: number;
    applicationName: string;
  };
  transactions?: {
    activeDepth: number;
    poisoned: boolean;
    started: number;
    nestedStarted: number;
    committed: number;
    rolledBack: number;
    failures: number;
    savepoints: number;
  };
  errors?: {
    idleClientRecoverable: number;
    idleClientFatal: number;
    lastIdleClientErrorCode?: string;
    lastIdleClientErrorMessage?: string;
    lastIdleClientErrorAt?: string;
  };
};

const commonSchemaSql = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    domain TEXT,
    ownerId TEXT,
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS filters (
    id TEXT PRIMARY KEY,
    name TEXT,
    projectId TEXT,
    ownerId TEXT,
    configuration TEXT,
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    passwordHash TEXT,
    authProvider TEXT DEFAULT 'local',
    name TEXT,
    company TEXT,
    avatarUrl TEXT,
    bio TEXT,
    tier TEXT,
    unlockedSites TEXT,
    createdAt TEXT,
    bingApiKey TEXT,
    gscRefreshToken TEXT,
    knownSites TEXT,
    onboardingCompleted INTEGER DEFAULT 0,
    activatedSiteUrl TEXT,
    activatedGa4PropertyId TEXT,
    activatedGa4DisplayName TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    tokenHash TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_ga4_mappings (
    ownerId TEXT NOT NULL,
    siteUrl TEXT NOT NULL,
    propertyId TEXT NOT NULL,
    displayName TEXT,
    propertyCreatedAt TEXT,
    updatedAt TEXT,
    PRIMARY KEY (ownerId, siteUrl)
  );

  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    userId TEXT,
    siteUrl TEXT,
    date TEXT,
    title TEXT,
    description TEXT,
    type TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS gsc_site_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    queryCount INTEGER,
    PRIMARY KEY (ownerId, siteUrl, date)
  );

  CREATE TABLE IF NOT EXISTS gsc_query_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date, query)
  );

  CREATE TABLE IF NOT EXISTS gsc_country_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    country TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date, country)
  );

  CREATE TABLE IF NOT EXISTS gsc_page_query_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    page TEXT,
    pageKey TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (ownerId, siteUrl, date, page, query)
  );

  CREATE TABLE IF NOT EXISTS gsc_page_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    page TEXT,
    pageKey TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    queryCount INTEGER,
    PRIMARY KEY (ownerId, siteUrl, date, pageKey)
  );

  CREATE TABLE IF NOT EXISTS gsc_site_monthly_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    monthStart TEXT,
    clicks INTEGER,
    impressions INTEGER,
    positionSum REAL,
    PRIMARY KEY (ownerId, siteUrl, monthStart)
  );

  CREATE TABLE IF NOT EXISTS gsc_query_monthly_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    monthStart TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    positionSum REAL,
    PRIMARY KEY (ownerId, siteUrl, monthStart, query)
  );

  CREATE TABLE IF NOT EXISTS gsc_country_monthly_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    monthStart TEXT,
    country TEXT,
    clicks INTEGER,
    impressions INTEGER,
    positionSum REAL,
    PRIMARY KEY (ownerId, siteUrl, monthStart, country)
  );

  CREATE TABLE IF NOT EXISTS gsc_page_monthly_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    monthStart TEXT,
    page TEXT,
    pageKey TEXT,
    clicks INTEGER,
    impressions INTEGER,
    positionSum REAL,
    queryCount INTEGER,
    PRIMARY KEY (ownerId, siteUrl, monthStart, pageKey)
  );

  CREATE TABLE IF NOT EXISTS gsc_page_query_monthly_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    monthStart TEXT,
    page TEXT,
    pageKey TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    positionSum REAL,
    PRIMARY KEY (ownerId, siteUrl, monthStart, pageKey, query)
  );

  CREATE TABLE IF NOT EXISTS ga4_page_metrics (
    ownerId TEXT,
    propertyId TEXT,
    siteUrl TEXT,
    date TEXT,
    pagePath TEXT,
    pageKey TEXT,
    sessions INTEGER,
    totalUsers INTEGER,
    pageViews INTEGER,
    bounceRate REAL,
    eventCount INTEGER,
    PRIMARY KEY (ownerId, propertyId, siteUrl, date, pageKey)
  );

  CREATE TABLE IF NOT EXISTS ga4_dimension_metrics (
    ownerId TEXT,
    propertyId TEXT,
    siteUrl TEXT,
    date TEXT,
    dimension TEXT,
    dimensionValue TEXT,
    sessions INTEGER,
    totalUsers INTEGER,
    pageViews INTEGER,
    bounceRate REAL,
    eventCount INTEGER,
    PRIMARY KEY (ownerId, propertyId, siteUrl, date, dimension, dimensionValue)
  );

  CREATE TABLE IF NOT EXISTS ga4_llm_referral_metrics (
    ownerId TEXT,
    propertyId TEXT,
    siteUrl TEXT,
    date TEXT,
    source TEXT,
    sourceClass TEXT,
    pagePath TEXT,
    pageKey TEXT,
    sessions INTEGER,
    engagedSessions INTEGER,
    keyEvents REAL,
    averageSessionDuration REAL,
    PRIMARY KEY (ownerId, propertyId, siteUrl, date, source, pageKey)
  );

  CREATE TABLE IF NOT EXISTS warehouse_dataset_coverage (
    ownerId TEXT,
    propertyId TEXT,
    siteUrl TEXT,
    date TEXT,
    dataset TEXT,
    status TEXT,
    rowCount INTEGER DEFAULT 0,
    truncated INTEGER DEFAULT 0,
    jobId TEXT,
    lastError TEXT,
    completedAt TEXT,
    updatedAt TEXT,
    PRIMARY KEY (ownerId, propertyId, siteUrl, date, dataset)
  );

  CREATE TABLE IF NOT EXISTS warehouse_sync_status (
    ownerId TEXT,
    siteUrl TEXT,
    lastSyncDate TEXT,
    earliestSyncDate TEXT,
    status TEXT,
    lastUpdated TEXT,
    PRIMARY KEY (ownerId, siteUrl)
  );

  CREATE TABLE IF NOT EXISTS bing_query_stats (
    ownerId TEXT,
    siteUrl TEXT,
    query TEXT,
    impressions INTEGER,
    clicks INTEGER,
    ctr REAL,
    avgClickPosition REAL,
    avgImpressionPosition REAL,
    fetchedAt TEXT,
    PRIMARY KEY (ownerId, siteUrl, query)
  );

  CREATE TABLE IF NOT EXISTS bing_query_metrics (
    ownerId TEXT,
    siteUrl TEXT,
    date TEXT,
    query TEXT,
    impressions INTEGER,
    clicks INTEGER,
    ctr REAL,
    avgClickPosition REAL,
    avgImpressionPosition REAL,
    fetchedAt TEXT,
    dateSource TEXT DEFAULT 'reported',
    PRIMARY KEY (ownerId, siteUrl, date, query)
  );

  CREATE TABLE IF NOT EXISTS tracked_keywords (
    id TEXT PRIMARY KEY,
    siteUrl TEXT,
    ownerId TEXT,
    keyword TEXT,
    location TEXT,
    device TEXT,
    tags TEXT,
    targetDomain TEXT,
    createdAt TEXT,
    UNIQUE(ownerId, siteUrl, keyword, location, device)
  );

  CREATE TABLE IF NOT EXISTS keyword_rankings (
    keywordId TEXT,
    date TEXT,
    position INTEGER,
    rankingUrl TEXT,
    PRIMARY KEY (keywordId, date)
  );

  CREATE TABLE IF NOT EXISTS url_inspection_cache (
    ownerId TEXT,
    siteUrl TEXT NOT NULL,
    url TEXT NOT NULL,
    inspectionResult TEXT,
    coverageState TEXT,
    lastInspectionTime TEXT NOT NULL,
    PRIMARY KEY (ownerId, siteUrl, url)
  );

  CREATE TABLE IF NOT EXISTS warehouse_jobs (
    id TEXT PRIMARY KEY,
    ownerId TEXT,
    siteUrl TEXT,
    propertyId TEXT,
    jobType TEXT,
    status TEXT,
    targetStartDate TEXT,
    targetDate TEXT,
    priority INTEGER DEFAULT 0,
    attemptCount INTEGER DEFAULT 0,
    maxAttempts INTEGER DEFAULT 3,
    lockedAt TEXT,
    nextRunAt TEXT,
    startedAt TEXT,
    updatedAt TEXT,
    completedAt TEXT,
    lastError TEXT,
    metricsJson TEXT,
    rowsSynced INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS crawl_jobs (
    id TEXT PRIMARY KEY,
    ownerId TEXT,
    siteUrl TEXT,
    startUrl TEXT,
    sitemapUrl TEXT,
    status TEXT,
    maxPages INTEGER,
    maxDepth INTEGER,
    discoveredCount INTEGER DEFAULT 0,
    crawledCount INTEGER DEFAULT 0,
    errorCount INTEGER DEFAULT 0,
    skippedCount INTEGER DEFAULT 0,
    queuedCount INTEGER DEFAULT 0,
    startedAt TEXT,
    updatedAt TEXT,
    completedAt TEXT,
    lastError TEXT,
    attemptCount INTEGER DEFAULT 0,
    maxAttempts INTEGER DEFAULT 3,
    lockedAt TEXT,
    nextRunAt TEXT,
    renderMode TEXT DEFAULT 'html',
    respectRobots INTEGER DEFAULT 1,
    includeQueryStrings INTEGER DEFAULT 0,
    userAgent TEXT,
    canonicalMetricsVersion INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS crawl_pages (
    ownerId TEXT,
    siteUrl TEXT,
    jobId TEXT,
    url TEXT,
    normalizedUrl TEXT,
    pageKey TEXT,
    resolvedCanonicalPageKey TEXT,
    finalUrl TEXT,
    statusCode INTEGER,
    contentType TEXT,
    title TEXT,
    metaDescription TEXT,
    canonicalUrl TEXT,
    h1Text TEXT,
    h1Count INTEGER,
    h2Count INTEGER,
    wordCount INTEGER,
    depth INTEGER,
    discoveredFrom TEXT,
    discoveredFromUrl TEXT,
    discoveredAt TEXT,
    crawledAt TEXT,
    responseTimeMs INTEGER,
    noindex INTEGER DEFAULT 0,
    inboundLinkCount INTEGER DEFAULT 0,
    internalLinkCount INTEGER DEFAULT 0,
    outgoingLinkCount INTEGER DEFAULT 0,
    errorMessage TEXT,
    PRIMARY KEY (ownerId, siteUrl, jobId, normalizedUrl)
  );

  CREATE TABLE IF NOT EXISTS crawl_links (
    ownerId TEXT,
    siteUrl TEXT,
    jobId TEXT,
    fromUrl TEXT,
    toUrl TEXT,
    fromPageKey TEXT,
    toPageKey TEXT,
    anchorText TEXT,
    contextText TEXT,
    discoveredAt TEXT,
    depth INTEGER,
    PRIMARY KEY (ownerId, siteUrl, jobId, fromUrl, toUrl)
  );

  CREATE TABLE IF NOT EXISTS crawl_page_text_blocks (
    ownerId TEXT,
    siteUrl TEXT,
    jobId TEXT,
    pageUrl TEXT,
    pageKey TEXT,
    blockIndex INTEGER,
    blockType TEXT,
    text TEXT,
    textHash TEXT,
    PRIMARY KEY (ownerId, siteUrl, jobId, pageUrl, blockIndex)
  );
  CREATE TABLE IF NOT EXISTS crawl_page_sentences (
    ownerId TEXT,
    siteUrl TEXT,
    jobId TEXT,
    pageUrl TEXT,
    pageKey TEXT,
    paragraphIndex INTEGER,
    sentenceIndex INTEGER,
    sentenceText TEXT,
    textHash TEXT,
    embeddingStatus TEXT,
    createdAt TEXT,
    PRIMARY KEY (ownerId, siteUrl, jobId, pageKey, paragraphIndex, sentenceIndex)
  );

  CREATE TABLE IF NOT EXISTS internal_link_embedding_cache (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    inputType TEXT NOT NULL,
    textHash TEXT NOT NULL,
    text TEXT,
    vectorJson TEXT NOT NULL,
    dimensions INTEGER,
    tokenCount INTEGER,
    useCount INTEGER DEFAULT 0,
    createdAt TEXT,
    lastUsedAt TEXT,
    PRIMARY KEY (provider, model, inputType, textHash)
  );

  CREATE TABLE IF NOT EXISTS internal_link_provider_settings (
    ownerId TEXT NOT NULL,
    provider TEXT NOT NULL,
    apiKeyEncrypted TEXT,
    baseUrl TEXT,
    embeddingModel TEXT,
    reviewModel TEXT,
    enabled INTEGER DEFAULT 1,
    createdAt TEXT,
    updatedAt TEXT,
    PRIMARY KEY (ownerId, provider)
  );

  CREATE TABLE IF NOT EXISTS internal_link_analysis_jobs (
    id TEXT PRIMARY KEY,
    ownerId TEXT,
    siteUrl TEXT,
    crawlJobId TEXT,
    startDate TEXT,
    endDate TEXT,
    status TEXT,
    progressTotal INTEGER,
    progressCompleted INTEGER,
    provider TEXT,
    embeddingProvider TEXT,
    embeddingModel TEXT,
    reviewProvider TEXT,
    reviewModel TEXT,
    maxPages INTEGER,
    maxSentencesPerPage INTEGER,
    maxRecommendations INTEGER,
    estimatedLocalUnits INTEGER,
    estimatedEmbeddingTokens INTEGER,
    estimatedHostedEmbeddingCost REAL,
    estimatedReviewTokens INTEGER,
    estimatedHostedReviewCost REAL,
    actualEmbeddingTokens INTEGER,
    actualReviewTokens INTEGER,
    actualCost REAL,
    startedAt TEXT,
    updatedAt TEXT,
    completedAt TEXT,
    lastError TEXT,
    lockedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS internal_link_opportunities (
    id TEXT PRIMARY KEY,
    jobId TEXT,
    ownerId TEXT,
    siteUrl TEXT,
    crawlJobId TEXT,
    sourceUrl TEXT,
    sourcePageKey TEXT,
    sourceTitle TEXT,
    sourceSentence TEXT,
    paragraphIndex INTEGER,
    sentenceIndex INTEGER,
    anchorText TEXT,
    anchorStart INTEGER,
    anchorEnd INTEGER,
    targetUrl TEXT,
    targetPageKey TEXT,
    targetTitle TEXT,
    readerBenefit TEXT,
    confidence TEXT,
    priorityScore INTEGER,
    scoreBreakdown TEXT,
    opportunityType TEXT,
    status TEXT,
    userNote TEXT,
    stale INTEGER DEFAULT 0,
    provider TEXT,
    modelVersion TEXT,
    annotationId TEXT,
    createdAt TEXT,
    updatedAt TEXT,
    implementedAt TEXT,
    UNIQUE (ownerId, siteUrl, crawlJobId, sourcePageKey, targetPageKey, anchorText)
  );
`;

const sqliteSchemaSql = `
  ${commonSchemaSql}
  CREATE TABLE IF NOT EXISTS server_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ownerId TEXT,
    siteUrl TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    ipAddress TEXT,
    httpMethod TEXT,
    urlPath TEXT NOT NULL,
    statusCode INTEGER,
    userAgent TEXT,
    botType TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

const postgresSchemaSql = `
  ${commonSchemaSql}
  CREATE TABLE IF NOT EXISTS server_logs (
    id BIGSERIAL PRIMARY KEY,
    ownerId TEXT,
    siteUrl TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    ipAddress TEXT,
    httpMethod TEXT,
    urlPath TEXT NOT NULL,
    statusCode INTEGER,
    userAgent TEXT,
    botType TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

const indexSql = `
  CREATE INDEX IF NOT EXISTS idx_server_logs_owner_site_time ON server_logs(ownerId, siteUrl, timestamp);
  CREATE INDEX IF NOT EXISTS idx_server_logs_owner_botType ON server_logs(ownerId, siteUrl, botType);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);
  CREATE INDEX IF NOT EXISTS idx_workspace_ga4_mappings_owner_property ON workspace_ga4_mappings(ownerId, propertyId);
  CREATE INDEX IF NOT EXISTS idx_gsc_site_owner_site_date ON gsc_site_metrics(ownerId, siteUrl, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_query_owner_site_date ON gsc_query_metrics(ownerId, siteUrl, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_query_owner_site_date_query ON gsc_query_metrics(ownerId, siteUrl, date, query);
  CREATE INDEX IF NOT EXISTS idx_gsc_query_owner_site_query_date ON gsc_query_metrics(ownerId, siteUrl, query, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_country_owner_site_date_country ON gsc_country_metrics(ownerId, siteUrl, date, country);
  CREATE INDEX IF NOT EXISTS idx_gsc_country_owner_site_country_date ON gsc_country_metrics(ownerId, siteUrl, country, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_date_page ON gsc_page_query_metrics(ownerId, siteUrl, date, page);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_date_query ON gsc_page_query_metrics(ownerId, siteUrl, date, query);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_page_date ON gsc_page_query_metrics(ownerId, siteUrl, page, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_pagekey_date ON gsc_page_query_metrics(ownerId, siteUrl, pageKey, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_date_pagekey ON gsc_page_query_metrics(ownerId, siteUrl, date, pageKey);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_owner_site_query_date ON gsc_page_query_metrics(ownerId, siteUrl, query, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_owner_site_date_key ON gsc_page_metrics(ownerId, siteUrl, date, pageKey);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_owner_site_key_date ON gsc_page_metrics(ownerId, siteUrl, pageKey, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_site_monthly_owner_site_month ON gsc_site_monthly_metrics(ownerId, siteUrl, monthStart);
  CREATE INDEX IF NOT EXISTS idx_gsc_query_monthly_owner_site_month_query ON gsc_query_monthly_metrics(ownerId, siteUrl, monthStart, query);
  CREATE INDEX IF NOT EXISTS idx_gsc_query_monthly_owner_site_query_month ON gsc_query_monthly_metrics(ownerId, siteUrl, query, monthStart);
  CREATE INDEX IF NOT EXISTS idx_gsc_country_monthly_owner_site_month_country ON gsc_country_monthly_metrics(ownerId, siteUrl, monthStart, country);
  CREATE INDEX IF NOT EXISTS idx_gsc_country_monthly_owner_site_country_month ON gsc_country_monthly_metrics(ownerId, siteUrl, country, monthStart);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_monthly_owner_site_month_key ON gsc_page_monthly_metrics(ownerId, siteUrl, monthStart, pageKey);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_monthly_owner_site_key_month ON gsc_page_monthly_metrics(ownerId, siteUrl, pageKey, monthStart);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_monthly_owner_site_month_pagekey ON gsc_page_query_monthly_metrics(ownerId, siteUrl, monthStart, pageKey);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_monthly_owner_site_pagekey_month ON gsc_page_query_monthly_metrics(ownerId, siteUrl, pageKey, monthStart);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_monthly_owner_site_month_query ON gsc_page_query_monthly_metrics(ownerId, siteUrl, monthStart, query);
  CREATE INDEX IF NOT EXISTS idx_gsc_page_query_monthly_owner_site_query_month ON gsc_page_query_monthly_metrics(ownerId, siteUrl, query, monthStart);
  CREATE INDEX IF NOT EXISTS idx_ga4_page_owner_property_date_key ON ga4_page_metrics(ownerId, propertyId, date, pageKey);
  CREATE INDEX IF NOT EXISTS idx_ga4_page_owner_property_key_date ON ga4_page_metrics(ownerId, propertyId, pageKey, date);
  CREATE INDEX IF NOT EXISTS idx_ga4_page_owner_property_date_path ON ga4_page_metrics(ownerId, propertyId, date, pagePath);
  CREATE INDEX IF NOT EXISTS idx_ga4_dimension_owner_property_dimension_date ON ga4_dimension_metrics(ownerId, propertyId, dimension, date);
  CREATE INDEX IF NOT EXISTS idx_ga4_dimension_owner_property_value_date ON ga4_dimension_metrics(ownerId, propertyId, dimension, dimensionValue, date);
  CREATE INDEX IF NOT EXISTS idx_ga4_llm_owner_property_date ON ga4_llm_referral_metrics(ownerId, propertyId, date);
  CREATE INDEX IF NOT EXISTS idx_ga4_llm_owner_property_source_date ON ga4_llm_referral_metrics(ownerId, propertyId, sourceClass, date);
  CREATE INDEX IF NOT EXISTS idx_ga4_llm_owner_property_page_date ON ga4_llm_referral_metrics(ownerId, propertyId, pageKey, date);
  CREATE INDEX IF NOT EXISTS idx_warehouse_dataset_coverage_scope_date ON warehouse_dataset_coverage(ownerId, propertyId, siteUrl, dataset, date);
  CREATE INDEX IF NOT EXISTS idx_bing_query_stats_owner_site_fetched ON bing_query_stats(ownerId, siteUrl, fetchedAt);
  CREATE INDEX IF NOT EXISTS idx_bing_query_metrics_owner_site_date ON bing_query_metrics(ownerId, siteUrl, date);
  CREATE INDEX IF NOT EXISTS idx_bing_query_metrics_owner_site_query_date ON bing_query_metrics(ownerId, siteUrl, query, date);
  CREATE INDEX IF NOT EXISTS idx_warehouse_jobs_queue ON warehouse_jobs(status, nextRunAt, updatedAt);
  CREATE INDEX IF NOT EXISTS idx_warehouse_jobs_queue_priority ON warehouse_jobs(status, priority, nextRunAt, targetDate);
  CREATE INDEX IF NOT EXISTS idx_warehouse_jobs_owner_site ON warehouse_jobs(ownerId, siteUrl, updatedAt);
  CREATE INDEX IF NOT EXISTS idx_warehouse_jobs_owner_site_target_status ON warehouse_jobs(ownerId, siteUrl, targetDate, status);
  CREATE INDEX IF NOT EXISTS idx_warehouse_jobs_owner_site_range_status ON warehouse_jobs(ownerId, siteUrl, targetStartDate, targetDate, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouse_jobs_one_running_per_site ON warehouse_jobs(ownerId, siteUrl) WHERE status = 'running';
  CREATE INDEX IF NOT EXISTS idx_crawl_jobs_owner_site_status ON crawl_jobs(ownerId, siteUrl, status, updatedAt);
  CREATE INDEX IF NOT EXISTS idx_crawl_jobs_queue ON crawl_jobs(status, nextRunAt, updatedAt);
  CREATE INDEX IF NOT EXISTS idx_crawl_pages_owner_site_job ON crawl_pages(ownerId, siteUrl, jobId);
  CREATE INDEX IF NOT EXISTS idx_crawl_pages_owner_site_job_crawled ON crawl_pages(ownerId, siteUrl, jobId, crawledAt, depth, url);
  CREATE INDEX IF NOT EXISTS idx_crawl_pages_owner_site_pagekey ON crawl_pages(ownerId, siteUrl, pageKey);
  CREATE INDEX IF NOT EXISTS idx_crawl_pages_owner_site_resolved_canonical ON crawl_pages(ownerId, siteUrl, jobId, resolvedCanonicalPageKey);
  CREATE INDEX IF NOT EXISTS idx_crawl_links_owner_site_job ON crawl_links(ownerId, siteUrl, jobId);
  CREATE INDEX IF NOT EXISTS idx_crawl_links_owner_site_job_tourl ON crawl_links(ownerId, siteUrl, jobId, toUrl);
  CREATE INDEX IF NOT EXISTS idx_crawl_links_owner_site_job_keys ON crawl_links(ownerId, siteUrl, jobId, fromPageKey, toPageKey);
  CREATE INDEX IF NOT EXISTS idx_crawl_links_owner_site_job_to_pagekey ON crawl_links(ownerId, siteUrl, jobId, toPageKey);
  CREATE INDEX IF NOT EXISTS idx_crawl_text_blocks_owner_site_job_key ON crawl_page_text_blocks(ownerId, siteUrl, jobId, pageKey);
  CREATE INDEX IF NOT EXISTS idx_crawl_sentences_owner_site_job_key ON crawl_page_sentences(ownerId, siteUrl, jobId, pageKey);
  CREATE INDEX IF NOT EXISTS idx_crawl_sentences_owner_site_job_hash ON crawl_page_sentences(ownerId, siteUrl, jobId, textHash);
  CREATE INDEX IF NOT EXISTS idx_crawl_sentences_owner_site_job_quality_hash ON crawl_page_sentences(ownerId, siteUrl, jobId, extractionVersion, linkDensity, boilerplateScore, textHash);
  CREATE INDEX IF NOT EXISTS idx_internal_link_embedding_cache_model ON internal_link_embedding_cache(provider, model, inputType, lastUsedAt);
  CREATE INDEX IF NOT EXISTS idx_internal_link_provider_settings_owner_enabled ON internal_link_provider_settings(ownerId, enabled, provider);
  CREATE INDEX IF NOT EXISTS idx_internal_link_jobs_owner_site_status ON internal_link_analysis_jobs(ownerId, siteUrl, status, updatedAt);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_link_jobs_active_unique ON internal_link_analysis_jobs(ownerId, siteUrl) WHERE status IN ('queued', 'running');
  CREATE INDEX IF NOT EXISTS idx_internal_link_opps_owner_site_status ON internal_link_opportunities(ownerId, siteUrl, status, stale, priorityScore);
  CREATE INDEX IF NOT EXISTS idx_internal_link_opps_job ON internal_link_opportunities(jobId, priorityScore);
`;

const requeueDuplicateRunningWarehouseJobsSql = `
  WITH ranked_running_jobs AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY ownerId, siteUrl
        ORDER BY COALESCE(lockedAt, updatedAt, startedAt) DESC, id
      ) AS siteRunRank
    FROM warehouse_jobs
    WHERE status = 'running'
  )
  UPDATE warehouse_jobs
  SET
    status = 'queued',
    lockedAt = NULL,
    nextRunAt = COALESCE(nextRunAt, updatedAt, lockedAt, startedAt, '1970-01-01T00:00:00.000Z'),
    updatedAt = COALESCE(updatedAt, lockedAt, startedAt, '1970-01-01T00:00:00.000Z'),
    lastError = COALESCE(lastError, 'Requeued to enforce one active import per site.')
  WHERE id IN (
    SELECT id
    FROM ranked_running_jobs
    WHERE siteRunRank > 1
  );
`;

const camelCaseColumns: Record<string, string> = {
  ownerid: 'ownerId',
  createdat: 'createdAt',
  projectid: 'projectId',
  userid: 'userId',
  siteurl: 'siteUrl',
  tokenhash: 'tokenHash',
  expiresat: 'expiresAt',
  passwordhash: 'passwordHash',
  authprovider: 'authProvider',
  avatarurl: 'avatarUrl',
  bingapikey: 'bingApiKey',
  gscrefreshtoken: 'gscRefreshToken',
  knownsites: 'knownSites',
  unlockedsites: 'unlockedSites',
  onboardingcompleted: 'onboardingCompleted',
  activatedsiteurl: 'activatedSiteUrl',
  activatedga4propertyid: 'activatedGa4PropertyId',
  activatedga4displayname: 'activatedGa4DisplayName',
  lastsyncdate: 'lastSyncDate',
  earliestsyncdate: 'earliestSyncDate',
  lastupdated: 'lastUpdated',
  jobtype: 'jobType',
  targetstartdate: 'targetStartDate',
  targetdate: 'targetDate',
  metricsjson: 'metricsJson',
  rowssynced: 'rowsSynced',
  keywordid: 'keywordId',
  rankingurl: 'rankingUrl',
  ipaddress: 'ipAddress',
  httpmethod: 'httpMethod',
  urlpath: 'urlPath',
  statuscode: 'statusCode',
  useragent: 'userAgent',
  bottype: 'botType',
  inspectionresult: 'inspectionResult',
  coveragestate: 'coverageState',
  lastinspectiontime: 'lastInspectionTime',
  earliestmetricdate: 'earliestMetricDate',
  lastmetricdate: 'lastMetricDate',
  startdate: 'startDate',
  enddate: 'endDate',
  metricdaycount: 'metricDayCount',
  detailrows: 'detailRows',
  minmonth: 'minMonth',
  maxmonth: 'maxMonth',
  rowcount: 'rowCount',
  fetchedat: 'fetchedAt',
  datesource: 'dateSource',
  avgclickposition: 'avgClickPosition',
  avgimpressionposition: 'avgImpressionPosition',
  totalrowcount: 'totalRowCount',
  querycount: 'queryCount',
  propertyid: 'propertyId',
  pagepath: 'pagePath',
  pagekey: 'pageKey',
  jobid: 'jobId',
  starturl: 'startUrl',
  sitemapurl: 'sitemapUrl',
  discoveredcount: 'discoveredCount',
  crawledcount: 'crawledCount',
  errorcount: 'errorCount',
  skippedcount: 'skippedCount',
  queuedcount: 'queuedCount',
  startedat: 'startedAt',
  updatedat: 'updatedAt',
  completedat: 'completedAt',
  lasterror: 'lastError',
  attemptcount: 'attemptCount',
  maxattempts: 'maxAttempts',
  lockedat: 'lockedAt',
  nextrunat: 'nextRunAt',
  rendermode: 'renderMode',
  respectrobots: 'respectRobots',
  includequerystrings: 'includeQueryStrings',
  normalizedurl: 'normalizedUrl',
  finalurl: 'finalUrl',
  contenttype: 'contentType',
  metadescription: 'metaDescription',
  canonicalurl: 'canonicalUrl',
  canonicalmetricsversion: 'canonicalMetricsVersion',
  resolvedcanonicalpagekey: 'resolvedCanonicalPageKey',
  h1text: 'h1Text',
  h1count: 'h1Count',
  h2count: 'h2Count',
  wordcount: 'wordCount',
  discoveredfrom: 'discoveredFrom',
  discoveredfromurl: 'discoveredFromUrl',
  discoveredat: 'discoveredAt',
  crawledat: 'crawledAt',
  responsetimems: 'responseTimeMs',
  internallinkcount: 'internalLinkCount',
  inboundlinkcount: 'inboundLinkCount',
  outgoinglinkcount: 'outgoingLinkCount',
  fromurl: 'fromUrl',
  tourl: 'toUrl',
  frompagekey: 'fromPageKey',
  topagekey: 'toPageKey',
  contexttext: 'contextText',
  pageurl: 'pageUrl',
  blockindex: 'blockIndex',
  blocktype: 'blockType',
  texthash: 'textHash',
  embeddingstatus: 'embeddingStatus',
  apikeyencrypted: 'apiKeyEncrypted',
  baseurl: 'baseUrl',
  inputtype: 'inputType',
  vectorjson: 'vectorJson',
  tokencount: 'tokenCount',
  usecount: 'useCount',
  lastusedat: 'lastUsedAt',
  paragraphindex: 'paragraphIndex',
  sentenceindex: 'sentenceIndex',
  sentencetext: 'sentenceText',
  headingtext: 'headingText',
  linkdensity: 'linkDensity',
  boilerplatescore: 'boilerplateScore',
  extractionversion: 'extractionVersion',
  crawljobid: 'crawlJobId',
  progresscompleted: 'progressCompleted',
  progresstotal: 'progressTotal',
  embeddingprovider: 'embeddingProvider',
  embeddingmodel: 'embeddingModel',
  reviewprovider: 'reviewProvider',
  reviewmodel: 'reviewModel',
  maxpages: 'maxPages',
  maxsentencesperpage: 'maxSentencesPerPage',
  maxrecommendations: 'maxRecommendations',
  estimatedlocalunits: 'estimatedLocalUnits',
  estimatedhostedembeddingcost: 'estimatedHostedEmbeddingCost',
  estimatedhostedreviewcost: 'estimatedHostedReviewCost',
  estimatedembeddingtokens: 'estimatedEmbeddingTokens',
  estimatedreviewtokens: 'estimatedReviewTokens',
  actualembeddingtokens: 'actualEmbeddingTokens',
  actualreviewtokens: 'actualReviewTokens',
  actualcost: 'actualCost',
  sourceurl: 'sourceUrl',
  sourcepagekey: 'sourcePageKey',
  sourcetitle: 'sourceTitle',
  sourcesentence: 'sourceSentence',
  anchortext: 'anchorText',
  anchorstart: 'anchorStart',
  anchorend: 'anchorEnd',
  targeturl: 'targetUrl',
  targetpagekey: 'targetPageKey',
  targettitle: 'targetTitle',
  readerbenefit: 'readerBenefit',
  priorityscore: 'priorityScore',
  scorebreakdown: 'scoreBreakdown',
  opportunitytype: 'opportunityType',
  usernote: 'userNote',
  modelversion: 'modelVersion',
  annotationid: 'annotationId',
  implementedat: 'implementedAt',
  totalusers: 'totalUsers',
  pageviews: 'pageViews',
  bouncerate: 'bounceRate',
  eventcount: 'eventCount',
  dimensionvalue: 'dimensionValue',
  sourceclass: 'sourceClass',
  engagedsessions: 'engagedSessions',
  keyevents: 'keyEvents',
  averagesessionduration: 'averageSessionDuration',
};

function normalizeRow<T>(row: T): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return row;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    normalized[camelCaseColumns[key] || key] = value;
  }
  return normalized as T;
}

function normalizeSqlForPostgres(sql: string) {
  return sql
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO')
    .replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'INSERT INTO')
    .replace(/\bIFNULL\s*\(/gi, 'COALESCE(')
    .replace(/MAX\(SUM\(impressions\),\s*1\)/gi, 'GREATEST(SUM(impressions), 1)')
    .replace(/\bAUTOINCREMENT\b/gi, '');
}

function bindPostgresParams(sql: string, params?: QueryParams) {
  const values: unknown[] = [];

  if (!params) {
    return { sql: normalizeSqlForPostgres(sql), values };
  }

  if (Array.isArray(params)) {
    let index = 0;
    return {
      sql: normalizeSqlForPostgres(sql.replace(/\?/g, () => `$${++index}`)),
      values: params,
    };
  }

  const positions = new Map<string, number>();
  const boundSql = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    if (!positions.has(name)) {
      positions.set(name, values.push(params[name]));
    }
    return `$${positions.get(name)}`;
  });

  return { sql: normalizeSqlForPostgres(boundSql), values };
}

type PostgresTransactionHealth = {
  poisonedBy?: Error;
};

type PostgresTransactionContext = {
  client: pg.PoolClient;
  depth: number;
  health: PostgresTransactionHealth;
};

type PostgresRuntimeCounters = {
  started: number;
  nestedStarted: number;
  committed: number;
  rolledBack: number;
  failures: number;
  savepoints: number;
  idleClientRecoverable: number;
  idleClientFatal: number;
  lastIdleClientErrorCode?: string;
  lastIdleClientErrorMessage?: string;
  lastIdleClientErrorAt?: string;
};

const recoverableIdlePostgresErrorCodes = new Set([
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08000',
  '08003',
  '08006',
  '08P01',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
]);

const recoverableIdlePostgresErrnos = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
]);

function parseIntegerEnv(name: string, defaultValue: number, minimum = 0) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`[db] ${name} must be a non-negative integer. Received "${raw}".`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`[db] ${name} must be at least ${minimum}. Received ${raw}.`);
  }

  return value;
}

function parseBooleanEnv(name: string, defaultValue: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }

  if (['1', 'true', 'yes', 'on'].includes(raw)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(raw)) {
    return false;
  }

  throw new Error(`[db] ${name} must be a boolean. Received "${process.env[name]}".`);
}

function parseStringEnv(name: string, defaultValue: string) {
  const raw = process.env[name]?.trim();
  return raw || defaultValue;
}

export function validatePostgresPoolSettings(settings: PostgresPoolSettings) {
  const errors: string[] = [];

  if (settings.max < 1) {
    errors.push('POSTGRES_POOL_MAX must be at least 1.');
  }
  if (settings.min > settings.max) {
    errors.push('POSTGRES_POOL_MIN cannot exceed POSTGRES_POOL_MAX.');
  }
  if (settings.connectionTimeoutMillis < 1) {
    errors.push('POSTGRES_CONNECTION_TIMEOUT_MS must be at least 1.');
  }
  if (settings.idleTimeoutMillis < 0) {
    errors.push('POSTGRES_IDLE_TIMEOUT_MS cannot be negative.');
  }
  if (settings.maxLifetimeSeconds < 0) {
    errors.push('POSTGRES_POOL_MAX_LIFETIME_SECONDS cannot be negative.');
  }
  if (settings.queryTimeoutMs < 0) {
    errors.push('POSTGRES_QUERY_TIMEOUT_MS cannot be negative.');
  }
  if (settings.statementTimeoutMs < 0) {
    errors.push('POSTGRES_STATEMENT_TIMEOUT_MS cannot be negative.');
  }
  if (settings.idleInTransactionSessionTimeoutMs < 0) {
    errors.push('POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS cannot be negative.');
  }
  if (settings.keepAliveInitialDelayMillis < 0) {
    errors.push('POSTGRES_KEEP_ALIVE_INITIAL_DELAY_MS cannot be negative.');
  }
  if (!settings.applicationName.trim()) {
    errors.push('POSTGRES_APPLICATION_NAME cannot be blank.');
  }

  if (errors.length > 0) {
    throw new Error(`[db] Invalid PostgreSQL pool configuration:\n- ${errors.join('\n- ')}`);
  }
}

export function getPostgresPoolSettingsFromEnv(): PostgresPoolSettings {
  const settings: PostgresPoolSettings = {
    max: parseIntegerEnv('POSTGRES_POOL_MAX', 20, 1),
    min: parseIntegerEnv('POSTGRES_POOL_MIN', 0, 0),
    idleTimeoutMillis: parseIntegerEnv('POSTGRES_IDLE_TIMEOUT_MS', 30000, 0),
    connectionTimeoutMillis: parseIntegerEnv('POSTGRES_CONNECTION_TIMEOUT_MS', 10000, 1),
    maxLifetimeSeconds: parseIntegerEnv('POSTGRES_POOL_MAX_LIFETIME_SECONDS', 1800, 0),
    queryTimeoutMs: parseIntegerEnv('POSTGRES_QUERY_TIMEOUT_MS', 0, 0),
    statementTimeoutMs: parseIntegerEnv('POSTGRES_STATEMENT_TIMEOUT_MS', 0, 0),
    idleInTransactionSessionTimeoutMs: parseIntegerEnv('POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS', 120000, 0),
    keepAlive: parseBooleanEnv('POSTGRES_KEEP_ALIVE', true),
    keepAliveInitialDelayMillis: parseIntegerEnv('POSTGRES_KEEP_ALIVE_INITIAL_DELAY_MS', 10000, 0),
    applicationName: parseStringEnv('POSTGRES_APPLICATION_NAME', 'gscplus'),
  };

  validatePostgresPoolSettings(settings);
  return settings;
}

function validatePostgresConnectionString(databaseUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('[db] DATABASE_URL/POSTGRES_URL must be a valid PostgreSQL connection string.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`[db] Expected a postgres:// or postgresql:// connection string, received ${parsed.protocol}`);
  }

  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('[db] PostgreSQL connection string must include a database name.');
  }
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function combineDatabaseErrors(message: string, errors: unknown[]) {
  const details = errors
    .filter((error) => error !== undefined && error !== null)
    .map((error) => formatErrorMessage(error));
  return new Error(`${message} ${details.join(' | ')}`.trim());
}

export function isRecoverablePostgresPoolError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: string; errno?: string };
  return recoverableIdlePostgresErrorCodes.has(candidate.code || '') || recoverableIdlePostgresErrnos.has(candidate.errno || '');
}

function formatPostgresPoolSettings(settings: PostgresPoolSettings) {
  return [
    `pool max=${settings.max}`,
    `min=${settings.min}`,
    `idleTimeoutMs=${settings.idleTimeoutMillis}`,
    `connectTimeoutMs=${settings.connectionTimeoutMillis}`,
    `maxLifetimeSec=${settings.maxLifetimeSeconds}`,
    `queryTimeoutMs=${settings.queryTimeoutMs}`,
    `statementTimeoutMs=${settings.statementTimeoutMs}`,
    `idleInTxTimeoutMs=${settings.idleInTransactionSessionTimeoutMs}`,
    `keepAlive=${settings.keepAlive}`,
  ].join(' ');
}

class SqliteAppDatabase implements AppDatabase {
  dialect = 'sqlite' as const;

  constructor(private readonly db: Database.Database) {}

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  async exec(sql: string) {
    this.db.exec(sql);
  }

  async get<T = unknown>(sql: string, params?: QueryParams) {
    const statement = this.db.prepare(sql);
    const row = params === undefined ? statement.get() : statement.get(params as any);
    return normalizeRow(row as T | undefined);
  }

  async all<T = unknown>(sql: string, params?: QueryParams) {
    const statement = this.db.prepare(sql);
    const rows = params === undefined ? statement.all() : statement.all(params as any);
    return rows.map((row) => normalizeRow(row as T));
  }

  async run(sql: string, params?: QueryParams) {
    const statement = this.db.prepare(sql);
    const result = params === undefined ? statement.run() : statement.run(params as any);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => {
      this.db.exec('BEGIN');
      try {
        const result = await callback(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    };
  }

  async close() {
    this.db.close();
  }
}

class PostgresAppDatabase implements AppDatabase {
  dialect = 'postgres' as const;
  private readonly transactionContext = new AsyncLocalStorage<PostgresTransactionContext>();
  private readonly runtime: PostgresRuntimeCounters = {
    started: 0,
    nestedStarted: 0,
    committed: 0,
    rolledBack: 0,
    failures: 0,
    savepoints: 0,
    idleClientRecoverable: 0,
    idleClientFatal: 0,
  };
  private savepointCounter = 0;

  constructor(private readonly pool: pg.Pool, private readonly settings: PostgresPoolSettings) {
    this.pool.on('error', this.handlePoolError);
  }

  private readonly handlePoolError = (error: Error & { code?: string; errno?: string }) => {
    this.runtime.lastIdleClientErrorCode = error.code || error.errno;
    this.runtime.lastIdleClientErrorMessage = error.message;
    this.runtime.lastIdleClientErrorAt = new Date().toISOString();

    if (isRecoverablePostgresPoolError(error)) {
      this.runtime.idleClientRecoverable += 1;
      console.warn(`[db] Recoverable PostgreSQL pool idle-client error: ${error.code || error.errno || 'unknown'} ${error.message}`);
      return;
    }

    this.runtime.idleClientFatal += 1;
    console.error('[db] PostgreSQL pool emitted a non-recoverable idle-client error.', error);
  };

  private getTransactionContext() {
    return this.transactionContext.getStore();
  }

  private currentQueryable() {
    const context = this.getTransactionContext();
    if (context?.health.poisonedBy) {
      throw context.health.poisonedBy;
    }
    return context?.client || this.pool;
  }

  getDiagnostics() {
    const context = this.getTransactionContext();
    return {
      dialect: 'postgres' as const,
      pool: {
        max: this.settings.max,
        min: this.settings.min,
        totalCount: this.pool.totalCount,
        idleCount: this.pool.idleCount,
        waitingCount: this.pool.waitingCount,
        idleTimeoutMillis: this.settings.idleTimeoutMillis,
        connectionTimeoutMillis: this.settings.connectionTimeoutMillis,
        maxLifetimeSeconds: this.settings.maxLifetimeSeconds,
        queryTimeoutMs: this.settings.queryTimeoutMs,
        statementTimeoutMs: this.settings.statementTimeoutMs,
        idleInTransactionSessionTimeoutMs: this.settings.idleInTransactionSessionTimeoutMs,
        keepAlive: this.settings.keepAlive,
        keepAliveInitialDelayMillis: this.settings.keepAliveInitialDelayMillis,
        applicationName: this.settings.applicationName,
      },
      transactions: {
        activeDepth: context?.depth || 0,
        poisoned: Boolean(context?.health.poisonedBy),
        started: this.runtime.started,
        nestedStarted: this.runtime.nestedStarted,
        committed: this.runtime.committed,
        rolledBack: this.runtime.rolledBack,
        failures: this.runtime.failures,
        savepoints: this.runtime.savepoints,
      },
      errors: {
        idleClientRecoverable: this.runtime.idleClientRecoverable,
        idleClientFatal: this.runtime.idleClientFatal,
        lastIdleClientErrorCode: this.runtime.lastIdleClientErrorCode,
        lastIdleClientErrorMessage: this.runtime.lastIdleClientErrorMessage,
        lastIdleClientErrorAt: this.runtime.lastIdleClientErrorAt,
      },
    } satisfies DatabaseDiagnostics;
  }

  private nextSavepointName() {
    this.savepointCounter += 1;
    this.runtime.savepoints += 1;
    return `gscplus_sp_${this.savepointCounter}`;
  }

  prepare(_sql: string) {
    throw new Error('This route still uses the legacy synchronous SQLite API and must be migrated before PostgreSQL mode can run it.');
  }

  async exec(sql: string) {
    await this.currentQueryable().query(normalizeSqlForPostgres(sql));
  }

  async get<T = unknown>(sql: string, params?: QueryParams) {
    const { sql: boundSql, values } = bindPostgresParams(sql, params);
    const result = await this.currentQueryable().query(boundSql, values);
    return normalizeRow(result.rows[0] as T | undefined);
  }

  async all<T = unknown>(sql: string, params?: QueryParams) {
    const { sql: boundSql, values } = bindPostgresParams(sql, params);
    const result = await this.currentQueryable().query(boundSql, values);
    return result.rows.map((row) => normalizeRow(row as T));
  }

  async run(sql: string, params?: QueryParams) {
    const { sql: boundSql, values } = bindPostgresParams(sql, params);
    const result = await this.currentQueryable().query(boundSql, values);
    return { changes: result.rowCount || 0 };
  }

  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => {
      const context = this.getTransactionContext();
      if (context) {
        return this.runNestedTransaction(context, callback, args);
      }
      return this.runTopLevelTransaction(callback, args);
    };
  }

  private async runTopLevelTransaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>, args: Args) {
    this.runtime.started += 1;
    const client = await this.pool.connect();
    const health: PostgresTransactionHealth = {};
    let releaseError: Error | undefined;

    try {
      await client.query('BEGIN');
      const result = await this.transactionContext.run({ client, depth: 1, health }, () => callback(...args));
      if (health.poisonedBy) {
        throw health.poisonedBy;
      }
      await client.query('COMMIT');
      this.runtime.committed += 1;
      return result;
    } catch (error) {
      this.runtime.failures += 1;
      const rollbackError = await this.rollbackTransaction(client, error);
      if (rollbackError) {
        releaseError = rollbackError;
        throw rollbackError;
      }
      this.runtime.rolledBack += 1;
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  private async runNestedTransaction<Args extends unknown[], T>(
    context: PostgresTransactionContext,
    callback: (...args: Args) => T | Promise<T>,
    args: Args,
  ) {
    this.runtime.started += 1;
    this.runtime.nestedStarted += 1;
    const savepointName = this.nextSavepointName();

    await context.client.query(`SAVEPOINT ${savepointName}`);
    try {
      const result = await this.transactionContext.run(
        { client: context.client, depth: context.depth + 1, health: context.health },
        () => callback(...args),
      );
      if (context.health.poisonedBy) {
        throw context.health.poisonedBy;
      }
      await context.client.query(`RELEASE SAVEPOINT ${savepointName}`);
      this.runtime.committed += 1;
      return result;
    } catch (error) {
      this.runtime.failures += 1;
      const rollbackError = await this.rollbackSavepoint(context, savepointName, error);
      if (rollbackError) {
        context.health.poisonedBy = rollbackError;
        throw rollbackError;
      }
      this.runtime.rolledBack += 1;
      throw error;
    }
  }

  private async rollbackTransaction(client: pg.PoolClient, cause: unknown) {
    try {
      await client.query('ROLLBACK');
      return undefined;
    } catch (rollbackError) {
      return combineDatabaseErrors('[db] PostgreSQL transaction rollback failed.', [cause, rollbackError]);
    }
  }

  private async rollbackSavepoint(context: PostgresTransactionContext, savepointName: string, cause: unknown) {
    let rollbackError: unknown;
    let releaseError: unknown;

    try {
      await context.client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    } catch (error) {
      rollbackError = error;
    }

    try {
      await context.client.query(`RELEASE SAVEPOINT ${savepointName}`);
    } catch (error) {
      releaseError = error;
    }

    if (!rollbackError && !releaseError) {
      return undefined;
    }

    return combineDatabaseErrors(`[db] PostgreSQL savepoint recovery failed for ${savepointName}.`, [cause, rollbackError, releaseError]);
  }

  async close() {
    this.pool.off('error', this.handlePoolError);
    await this.pool.end();
  }
}

function isSqliteCorruptionError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'SQLITE_CORRUPT',
  );
}

function removeIfExists(filePath: string) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function archiveIfExists(filePath: string, label: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const archivedPath = `${filePath}.${label}`;
  removeIfExists(archivedPath);
  fs.renameSync(filePath, archivedPath);
}

function archiveDatabaseFiles(label: string, includePrimary = true) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveLabel = `${label}.${timestamp}`;

  if (includePrimary) {
    archiveIfExists(DB_FILENAME, archiveLabel);
  }

  archiveIfExists(`${DB_FILENAME}-wal`, archiveLabel);
  archiveIfExists(`${DB_FILENAME}-shm`, archiveLabel);
}

function createSqliteConnection() {
  const configure = (db: Database.Database) => {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 30000');
    return db;
  };

  try {
    return configure(new Database(DB_FILENAME));
  } catch (error) {
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }
  }

  archiveDatabaseFiles('corrupt-wal-recovery', false);

  try {
    return configure(new Database(DB_FILENAME));
  } catch (error) {
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }
  }

  if (fs.existsSync(DB_BACKUP_FILENAME)) {
    archiveDatabaseFiles('corrupt-primary');
    fs.copyFileSync(DB_BACKUP_FILENAME, DB_FILENAME);

    try {
      return configure(new Database(DB_FILENAME));
    } catch (error) {
      if (!isSqliteCorruptionError(error)) {
        throw error;
      }
    }
  }

  archiveDatabaseFiles('fresh-db-reset');
  removeIfExists(DB_FILENAME);
  removeIfExists(`${DB_FILENAME}-wal`);
  removeIfExists(`${DB_FILENAME}-shm`);
  return configure(new Database(DB_FILENAME));
}

function runOptionalSqliteAlter(db: Database.Database, statement: string) {
  try {
    db.exec(statement);
  } catch {
    // Column likely already exists.
  }
}

function sqlitePrimaryKeyColumns(db: Database.Database, tableName: string) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .filter((row: any) => Number(row.pk || 0) > 0)
    .sort((a: any, b: any) => Number(a.pk) - Number(b.pk))
    .map((row: any) => String(row.name));
}

function migrateSqliteGa4SiteScopedKeys(db: Database.Database) {
  if (!sqlitePrimaryKeyColumns(db, 'ga4_page_metrics').includes('siteUrl')) {
    db.exec(`
      CREATE TABLE ga4_page_metrics_new (
        ownerId TEXT,
        propertyId TEXT,
        siteUrl TEXT,
        date TEXT,
        pagePath TEXT,
        pageKey TEXT,
        sessions INTEGER,
        totalUsers INTEGER,
        pageViews INTEGER,
        bounceRate REAL,
        eventCount INTEGER,
        PRIMARY KEY (ownerId, propertyId, siteUrl, date, pageKey)
      );
      INSERT OR REPLACE INTO ga4_page_metrics_new (ownerId, propertyId, siteUrl, date, pagePath, pageKey, sessions, totalUsers, pageViews, bounceRate, eventCount)
      SELECT ownerId, propertyId, COALESCE(siteUrl, ''), date, pagePath, pageKey, sessions, totalUsers, pageViews, bounceRate, eventCount
      FROM ga4_page_metrics;
      DROP TABLE ga4_page_metrics;
      ALTER TABLE ga4_page_metrics_new RENAME TO ga4_page_metrics;
    `);
  }

  if (!sqlitePrimaryKeyColumns(db, 'ga4_dimension_metrics').includes('siteUrl')) {
    db.exec(`
      CREATE TABLE ga4_dimension_metrics_new (
        ownerId TEXT,
        propertyId TEXT,
        siteUrl TEXT,
        date TEXT,
        dimension TEXT,
        dimensionValue TEXT,
        sessions INTEGER,
        totalUsers INTEGER,
        pageViews INTEGER,
        bounceRate REAL,
        eventCount INTEGER,
        PRIMARY KEY (ownerId, propertyId, siteUrl, date, dimension, dimensionValue)
      );
      INSERT OR REPLACE INTO ga4_dimension_metrics_new (ownerId, propertyId, siteUrl, date, dimension, dimensionValue, sessions, totalUsers, pageViews, bounceRate, eventCount)
      SELECT ownerId, propertyId, COALESCE(siteUrl, ''), date, dimension, dimensionValue, sessions, totalUsers, pageViews, bounceRate, eventCount
      FROM ga4_dimension_metrics;
      DROP TABLE ga4_dimension_metrics;
      ALTER TABLE ga4_dimension_metrics_new RENAME TO ga4_dimension_metrics;
    `);
  }

  if (!sqlitePrimaryKeyColumns(db, 'ga4_llm_referral_metrics').includes('siteUrl')) {
    db.exec(`
      CREATE TABLE ga4_llm_referral_metrics_new (
        ownerId TEXT,
        propertyId TEXT,
        siteUrl TEXT,
        date TEXT,
        source TEXT,
        sourceClass TEXT,
        pagePath TEXT,
        pageKey TEXT,
        sessions INTEGER,
        engagedSessions INTEGER,
        keyEvents REAL,
        averageSessionDuration REAL,
        PRIMARY KEY (ownerId, propertyId, siteUrl, date, source, pageKey)
      );
      INSERT OR REPLACE INTO ga4_llm_referral_metrics_new (ownerId, propertyId, siteUrl, date, source, sourceClass, pagePath, pageKey, sessions, engagedSessions, keyEvents, averageSessionDuration)
      SELECT ownerId, propertyId, COALESCE(siteUrl, ''), date, source, sourceClass, pagePath, pageKey, sessions, engagedSessions, keyEvents, averageSessionDuration
      FROM ga4_llm_referral_metrics;
      DROP TABLE ga4_llm_referral_metrics;
      ALTER TABLE ga4_llm_referral_metrics_new RENAME TO ga4_llm_referral_metrics;
    `);
  }
}

function applySqliteMigrations(db: Database.Database) {
  db.exec(sqliteSchemaSql);

  for (const statement of [
    'ALTER TABLE users ADD COLUMN passwordHash TEXT',
    "ALTER TABLE users ADD COLUMN authProvider TEXT DEFAULT 'local'",
    'ALTER TABLE users ADD COLUMN bingApiKey TEXT',
    'ALTER TABLE users ADD COLUMN name TEXT',
    'ALTER TABLE users ADD COLUMN company TEXT',
    'ALTER TABLE users ADD COLUMN avatarUrl TEXT',
    'ALTER TABLE users ADD COLUMN bio TEXT',
    'ALTER TABLE users ADD COLUMN onboardingCompleted INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN activatedSiteUrl TEXT',
    'ALTER TABLE users ADD COLUMN activatedGa4PropertyId TEXT',
    'ALTER TABLE users ADD COLUMN activatedGa4DisplayName TEXT',
    'ALTER TABLE workspace_ga4_mappings ADD COLUMN propertyCreatedAt TEXT',
    'ALTER TABLE tracked_keywords ADD COLUMN targetDomain TEXT',
    'ALTER TABLE tracked_keywords ADD COLUMN ownerId TEXT',
    'ALTER TABLE server_logs ADD COLUMN ownerId TEXT',
    'ALTER TABLE url_inspection_cache ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_site_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_site_metrics ADD COLUMN queryCount INTEGER',
    'ALTER TABLE gsc_query_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_page_query_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_page_query_metrics ADD COLUMN pageKey TEXT',
    'ALTER TABLE gsc_site_monthly_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_query_monthly_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_country_monthly_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE gsc_page_query_monthly_metrics ADD COLUMN ownerId TEXT',
    'ALTER TABLE warehouse_sync_status ADD COLUMN ownerId TEXT',
    'ALTER TABLE warehouse_jobs ADD COLUMN targetStartDate TEXT',
    'ALTER TABLE warehouse_jobs ADD COLUMN metricsJson TEXT',
    'ALTER TABLE warehouse_jobs ADD COLUMN priority INTEGER DEFAULT 0',
    'ALTER TABLE crawl_jobs ADD COLUMN ownerId TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN attemptCount INTEGER DEFAULT 0',
    'ALTER TABLE crawl_jobs ADD COLUMN maxAttempts INTEGER DEFAULT 3',
    'ALTER TABLE crawl_jobs ADD COLUMN lockedAt TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN nextRunAt TEXT',
    "ALTER TABLE crawl_jobs ADD COLUMN renderMode TEXT DEFAULT 'html'",
    'ALTER TABLE crawl_jobs ADD COLUMN respectRobots INTEGER DEFAULT 1',
    'ALTER TABLE crawl_jobs ADD COLUMN includeQueryStrings INTEGER DEFAULT 0',
    'ALTER TABLE crawl_jobs ADD COLUMN userAgent TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN canonicalMetricsVersion INTEGER DEFAULT 0',
    'ALTER TABLE crawl_pages ADD COLUMN ownerId TEXT',
    'ALTER TABLE crawl_pages ADD COLUMN inboundLinkCount INTEGER DEFAULT 0',
    'ALTER TABLE crawl_pages ADD COLUMN resolvedCanonicalPageKey TEXT',
    'ALTER TABLE crawl_links ADD COLUMN ownerId TEXT',
    'ALTER TABLE crawl_links ADD COLUMN anchorText TEXT',
    'ALTER TABLE crawl_links ADD COLUMN contextText TEXT',
    'ALTER TABLE crawl_page_sentences ADD COLUMN headingText TEXT',
    'ALTER TABLE crawl_page_sentences ADD COLUMN linkDensity REAL',
    'ALTER TABLE crawl_page_sentences ADD COLUMN boilerplateScore REAL',
    'ALTER TABLE crawl_page_sentences ADD COLUMN extractionVersion INTEGER',
    'ALTER TABLE internal_link_analysis_jobs ADD COLUMN lockedAt TEXT',
    'ALTER TABLE internal_link_opportunities ADD COLUMN scoreBreakdown TEXT',
  ]) {
    runOptionalSqliteAlter(db, statement);
  }

  migrateSqliteGa4SiteScopedKeys(db);
  db.exec(requeueDuplicateRunningWarehouseJobsSql);
  db.exec(indexSql);
}

async function applyOptionalPostgresVectorMigrations(db: AppDatabase) {
  const savepoint = 'optional_pgvector_migration';
  await db.exec(`SAVEPOINT ${savepoint}`);

  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
    await db.exec(`
      CREATE TABLE IF NOT EXISTS internal_link_embedding_vectors_1024 (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        inputType TEXT NOT NULL,
        textHash TEXT NOT NULL,
        text TEXT,
        embedding vector(1024) NOT NULL,
        tokenCount INTEGER,
        useCount INTEGER DEFAULT 0,
        createdAt TEXT,
        lastUsedAt TEXT,
        PRIMARY KEY (provider, model, inputType, textHash)
      );
      CREATE INDEX IF NOT EXISTS idx_internal_link_embedding_vectors_1024_hnsw
        ON internal_link_embedding_vectors_1024
        USING hnsw (embedding vector_cosine_ops);
      CREATE INDEX IF NOT EXISTS idx_internal_link_embedding_vectors_1024_model
        ON internal_link_embedding_vectors_1024(provider, model, inputType, lastUsedAt);
    `);
    await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error: any) {
    await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    console.warn('[db] pgvector extension unavailable; using JSON embedding cache only.', error?.message || error);
  }
}
const POSTGRES_SCHEMA_MIGRATION_LOCK_ID = 864203197;

async function applyPostgresMigrations(db: AppDatabase) {
  await db.exec(postgresSchemaSql);
  await applyOptionalPostgresVectorMigrations(db);

  for (const statement of [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS passwordHash TEXT',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS authProvider TEXT DEFAULT 'local'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS bingApiKey TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS company TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatarUrl TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS onboardingCompleted INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS activatedSiteUrl TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS activatedGa4PropertyId TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS activatedGa4DisplayName TEXT',
    'ALTER TABLE workspace_ga4_mappings ADD COLUMN IF NOT EXISTS propertyCreatedAt TEXT',
    'ALTER TABLE tracked_keywords ADD COLUMN IF NOT EXISTS targetDomain TEXT',
    'ALTER TABLE tracked_keywords ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE server_logs ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE url_inspection_cache ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_site_metrics ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_site_metrics ADD COLUMN IF NOT EXISTS queryCount INTEGER',
    'ALTER TABLE gsc_query_metrics ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_page_query_metrics ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_page_query_metrics ADD COLUMN IF NOT EXISTS pageKey TEXT',
    'ALTER TABLE gsc_site_monthly_metrics ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_query_monthly_metrics ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_country_monthly_metrics ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE gsc_page_query_monthly_metrics ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE warehouse_sync_status ADD COLUMN IF NOT EXISTS ownerId TEXT',
    "ALTER TABLE bing_query_metrics ADD COLUMN IF NOT EXISTS dateSource TEXT DEFAULT 'reported'",
    'ALTER TABLE warehouse_jobs ADD COLUMN IF NOT EXISTS targetStartDate TEXT',
    'ALTER TABLE warehouse_jobs ADD COLUMN IF NOT EXISTS metricsJson TEXT',
    'ALTER TABLE warehouse_jobs ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS attemptCount INTEGER DEFAULT 0',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS maxAttempts INTEGER DEFAULT 3',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS lockedAt TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS nextRunAt TEXT',
    "ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS renderMode TEXT DEFAULT 'html'",
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS respectRobots INTEGER DEFAULT 1',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS includeQueryStrings INTEGER DEFAULT 0',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS userAgent TEXT',
    'ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS canonicalMetricsVersion INTEGER DEFAULT 0',
    'ALTER TABLE crawl_pages ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE crawl_pages ADD COLUMN IF NOT EXISTS inboundLinkCount INTEGER DEFAULT 0',
    'ALTER TABLE crawl_pages ADD COLUMN IF NOT EXISTS resolvedCanonicalPageKey TEXT',
    'ALTER TABLE crawl_links ADD COLUMN IF NOT EXISTS ownerId TEXT',
    'ALTER TABLE crawl_links ADD COLUMN IF NOT EXISTS anchorText TEXT',
    'ALTER TABLE crawl_links ADD COLUMN IF NOT EXISTS contextText TEXT',
    'ALTER TABLE crawl_page_sentences ADD COLUMN IF NOT EXISTS headingText TEXT',
    'ALTER TABLE crawl_page_sentences ADD COLUMN IF NOT EXISTS linkDensity REAL',
    'ALTER TABLE crawl_page_sentences ADD COLUMN IF NOT EXISTS boilerplateScore REAL',
    'ALTER TABLE crawl_page_sentences ADD COLUMN IF NOT EXISTS extractionVersion INTEGER',
    'ALTER TABLE internal_link_analysis_jobs ADD COLUMN IF NOT EXISTS lockedAt TEXT',
    'ALTER TABLE internal_link_opportunities ADD COLUMN IF NOT EXISTS scoreBreakdown TEXT',
  ]) {
    await db.exec(statement);
  }

  await db.exec("UPDATE crawl_pages SET jobId = 'legacy' WHERE jobId IS NULL");
  await db.exec("UPDATE crawl_links SET jobId = 'legacy' WHERE jobId IS NULL");
  await db.exec('ALTER TABLE crawl_pages DROP CONSTRAINT IF EXISTS crawl_pages_pkey');
  await db.exec('ALTER TABLE crawl_pages ADD PRIMARY KEY (ownerId, siteUrl, jobId, normalizedUrl)');
  await db.exec('ALTER TABLE crawl_links DROP CONSTRAINT IF EXISTS crawl_links_pkey');
  await db.exec('ALTER TABLE crawl_links ADD PRIMARY KEY (ownerId, siteUrl, jobId, fromUrl, toUrl)');
  await db.exec(`
    UPDATE ga4_page_metrics SET siteUrl = '' WHERE siteUrl IS NULL;
    WITH ranked AS (
      SELECT ctid, ROW_NUMBER() OVER (PARTITION BY ownerId, propertyId, siteUrl, date, pageKey ORDER BY ctid) AS row_number
      FROM ga4_page_metrics
    )
    DELETE FROM ga4_page_metrics WHERE ctid IN (SELECT ctid FROM ranked WHERE row_number > 1);
    ALTER TABLE ga4_page_metrics DROP CONSTRAINT IF EXISTS ga4_page_metrics_pkey;
    ALTER TABLE ga4_page_metrics ADD PRIMARY KEY (ownerId, propertyId, siteUrl, date, pageKey);

    UPDATE ga4_dimension_metrics SET siteUrl = '' WHERE siteUrl IS NULL;
    WITH ranked AS (
      SELECT ctid, ROW_NUMBER() OVER (PARTITION BY ownerId, propertyId, siteUrl, date, dimension, dimensionValue ORDER BY ctid) AS row_number
      FROM ga4_dimension_metrics
    )
    DELETE FROM ga4_dimension_metrics WHERE ctid IN (SELECT ctid FROM ranked WHERE row_number > 1);
    ALTER TABLE ga4_dimension_metrics DROP CONSTRAINT IF EXISTS ga4_dimension_metrics_pkey;
    ALTER TABLE ga4_dimension_metrics ADD PRIMARY KEY (ownerId, propertyId, siteUrl, date, dimension, dimensionValue);

    UPDATE ga4_llm_referral_metrics SET siteUrl = '' WHERE siteUrl IS NULL;
    WITH ranked AS (
      SELECT ctid, ROW_NUMBER() OVER (PARTITION BY ownerId, propertyId, siteUrl, date, source, pageKey ORDER BY ctid) AS row_number
      FROM ga4_llm_referral_metrics
    )
    DELETE FROM ga4_llm_referral_metrics WHERE ctid IN (SELECT ctid FROM ranked WHERE row_number > 1);
    ALTER TABLE ga4_llm_referral_metrics DROP CONSTRAINT IF EXISTS ga4_llm_referral_metrics_pkey;
    ALTER TABLE ga4_llm_referral_metrics ADD PRIMARY KEY (ownerId, propertyId, siteUrl, date, source, pageKey);
  `);

  await db.exec(requeueDuplicateRunningWarehouseJobsSql);
  await db.exec(indexSql);
}

type LegacyGscPageKeyRow = {
  ownerId: string | null;
  siteUrl: string;
  page: string;
};

type LegacyCrawlCanonicalKeyRow = {
  canonicalUrl: string | null;
  finalUrl: string | null;
  jobId: string;
  normalizedUrl: string;
  ownerId: string;
  pageKey: string;
  siteUrl: string;
  url: string;
};

async function backfillCrawlCanonicalPageKeys(db: AppDatabase) {
  let totalUpdated = 0;
  const affectedJobs = new Map<string, { jobId: string; ownerId: string; siteUrl: string }>();

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const rows = await db.all<LegacyCrawlCanonicalKeyRow>(
      `
        SELECT ownerId, siteUrl, jobId, url, normalizedUrl, pageKey, finalUrl, canonicalUrl
        FROM crawl_pages
        WHERE resolvedCanonicalPageKey IS NULL OR resolvedCanonicalPageKey = ''
        LIMIT 1000
      `,
    );
    if (!rows.length) break;

    const updateBatch = db.transaction(async () => {
      let batchUpdated = 0;
      for (const row of rows) {
        const fallbackUrl = row.finalUrl || row.normalizedUrl || row.url;
        const resolvedKey = resolvedCanonicalPageKey(row.canonicalUrl, fallbackUrl, row.siteUrl);
        const result = await db.run(
          `
            UPDATE crawl_pages
            SET resolvedCanonicalPageKey = ?
            WHERE ownerId = ? AND siteUrl = ? AND jobId = ? AND normalizedUrl = ?
              AND (resolvedCanonicalPageKey IS NULL OR resolvedCanonicalPageKey = '')
          `,
          [resolvedKey, row.ownerId, row.siteUrl, row.jobId, row.normalizedUrl],
        );
        batchUpdated += result.changes;
        if (result.changes) {
          affectedJobs.set(
            [row.ownerId, row.siteUrl, row.jobId].join('\u0000'),
            { jobId: row.jobId, ownerId: row.ownerId, siteUrl: row.siteUrl },
          );
        }
      }
      return batchUpdated;
    });

    const batchUpdated = await updateBatch();
    totalUpdated += batchUpdated;
    if (!batchUpdated) break;
  }

  const incompleteJobs = await db.all<{ jobId: string; ownerId: string; siteUrl: string }>(
    `
      SELECT id AS "jobId", ownerId, siteUrl
      FROM crawl_jobs
      WHERE status = 'completed' AND COALESCE(canonicalMetricsVersion, 0) < 1
    `,
  );
  for (const job of incompleteJobs) {
    affectedJobs.set([job.ownerId, job.siteUrl, job.jobId].join('\u0000'), job);
  }

  for (const job of affectedJobs.values()) {
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
      [
        job.ownerId, job.siteUrl, job.jobId,
        job.ownerId, job.siteUrl, job.jobId,
        job.ownerId, job.siteUrl, job.jobId,
      ],
    );
    await db.run(
      'UPDATE crawl_jobs SET canonicalMetricsVersion = 1 WHERE id = ? AND ownerId = ? AND siteUrl = ?',
      [job.jobId, job.ownerId, job.siteUrl],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (totalUpdated || affectedJobs.size) {
    console.log(`[db] Prepared canonical crawl metrics for ${affectedJobs.size} jobs (${totalUpdated} page keys updated)`);
  }
}
function scheduleCrawlCanonicalPageKeyBackfill(db: AppDatabase) {
  const timer = setTimeout(() => {
    void (async () => {
      const lockId = 4_271_923_117;
      let lockAcquired = db.dialect === 'sqlite';

      try {
        if (db.dialect === 'postgres') {
          const row = await db.get<{ acquired: boolean }>(
            'SELECT pg_try_advisory_lock(?) AS "acquired"',
            [lockId],
          );
          lockAcquired = Boolean(row?.acquired);
        }
        if (lockAcquired) await backfillCrawlCanonicalPageKeys(db);
      } catch (error) {
        console.error('[db] Crawl canonical key backfill failed', error);
      } finally {
        if (lockAcquired && db.dialect === 'postgres') {
          await db.run('SELECT pg_advisory_unlock(?)', [lockId]).catch(() => undefined);
        }
      }
    })();
  }, 10_000);
  timer.unref();
}

async function backfillGscPageKeys(db: AppDatabase) {
  if (process.env.RUN_LEGACY_GSC_PAGEKEY_BACKFILL !== 'true') {
    return;
  }

  let totalUpdated = 0;

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const rows = await db.all<LegacyGscPageKeyRow>(
      `
        SELECT DISTINCT ownerId, siteUrl, page
        FROM gsc_page_query_metrics
        WHERE page IS NOT NULL
          AND page != ''
          AND (pageKey IS NULL OR pageKey = '')
        LIMIT 1000
      `,
    );

    if (!rows.length) break;

    let batchUpdated = 0;
    for (const row of rows) {
      const pageKey = canonicalPageKey(row.page, row.siteUrl);
      const result = await db.run(
        `
          UPDATE gsc_page_query_metrics
          SET pageKey = @pageKey
          WHERE siteUrl = @siteUrl
            AND page = @page
            AND (ownerId = @ownerId OR (ownerId IS NULL AND @ownerId IS NULL))
            AND (pageKey IS NULL OR pageKey = '')
        `,
        {
          ownerId: row.ownerId,
          siteUrl: row.siteUrl,
          page: row.page,
          pageKey,
        },
      );
      batchUpdated += result.changes;
    }

    totalUpdated += batchUpdated;
    if (!batchUpdated) break;
  }

  if (totalUpdated) {
    console.log(`[db] Backfilled pageKey for ${totalUpdated} legacy GSC page-query rows`);
  }
}

async function backfillGscPageMetrics(db: AppDatabase) {
  if (process.env.RUN_LEGACY_GSC_PAGE_METRICS_BACKFILL !== 'true') {
    return;
  }

  const existing = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM gsc_page_metrics');
  if (Number(existing?.count || 0) > 0) {
    return;
  }

  await db.run(`
    INSERT INTO gsc_page_metrics (ownerId, siteUrl, date, page, pageKey, clicks, impressions, ctr, position, queryCount)
    SELECT
      ownerId,
      siteUrl,
      date,
      MIN(page) AS page,
      COALESCE(NULLIF(pageKey, ''), page) AS pageKey,
      SUM(clicks) AS clicks,
      SUM(impressions) AS impressions,
      CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END AS ctr,
      CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)*1.0/SUM(impressions) ELSE 0 END AS position,
      COUNT(DISTINCT query) AS queryCount
    FROM gsc_page_query_metrics
    WHERE COALESCE(NULLIF(pageKey, ''), page) <> ''
    GROUP BY ownerId, siteUrl, date, COALESCE(NULLIF(pageKey, ''), page)
    ON CONFLICT(ownerId, siteUrl, date, pageKey) DO UPDATE SET
      page=excluded.page,
      clicks=excluded.clicks,
      impressions=excluded.impressions,
      ctr=excluded.ctr,
      position=excluded.position,
      queryCount=excluded.queryCount
  `);

  const updated = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM gsc_page_metrics');
  console.log(`[db] Backfilled ${Number(updated?.count || 0)} legacy GSC page summary rows`);
}

async function backfillGscSiteQueryCounts(db: AppDatabase) {
  const pending = await db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM gsc_site_metrics WHERE queryCount IS NULL',
  );
  if (Number(pending?.count || 0) === 0) return;

  await db.run(`
    UPDATE gsc_site_metrics
    SET queryCount = (
      SELECT COUNT(*)
      FROM gsc_query_metrics
      WHERE gsc_query_metrics.siteUrl = gsc_site_metrics.siteUrl
        AND gsc_query_metrics.date = gsc_site_metrics.date
        AND (
          gsc_query_metrics.ownerId = gsc_site_metrics.ownerId
          OR (gsc_query_metrics.ownerId IS NULL AND gsc_site_metrics.ownerId IS NULL)
        )
        AND gsc_query_metrics.query <> ''
    )
    WHERE queryCount IS NULL
  `);

  console.log(`[db] Backfilled query counts for ${Number(pending?.count || 0)} GSC daily summary rows`);
}

type LegacyBingQueryStatRow = {
  ownerId: string | null;
  siteUrl: string | null;
  query: string | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  avgClickPosition: number | null;
  avgImpressionPosition: number | null;
  fetchedAt: string | null;
};

function extractIsoDatePrefix(value: string | null | undefined) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export async function backfillLegacyBingQueryMetrics(db: AppDatabase) {
  const legacyRows = await db.all<LegacyBingQueryStatRow>(`
    SELECT ownerId, siteUrl, query, impressions, clicks, ctr, avgClickPosition, avgImpressionPosition, fetchedAt
    FROM bing_query_stats
    WHERE fetchedAt IS NOT NULL AND fetchedAt != ''
  `);

  if (!legacyRows.length) {
    return;
  }

  let insertedOrUpdated = 0;
  const applyBackfill = db.transaction(async () => {
    for (const row of legacyRows) {
      const ownerId = typeof row.ownerId === 'string' ? row.ownerId : '';
      const siteUrl = typeof row.siteUrl === 'string' ? row.siteUrl : '';
      const query = typeof row.query === 'string' ? row.query.trim() : '';
      const fetchedAt = typeof row.fetchedAt === 'string' ? row.fetchedAt : '';
      const date = extractIsoDatePrefix(fetchedAt);
      if (!ownerId || !siteUrl || !query || !date) continue;

      const existing = await db.get<{ dateSource?: string | null }>(
        `SELECT dateSource
         FROM bing_query_metrics
         WHERE ownerId = ? AND siteUrl = ? AND date = ? AND query = ?`,
        [ownerId, siteUrl, date, query],
      );

      if (existing) {
        continue;
      }

      const result = await db.run(
        `INSERT INTO bing_query_metrics
          (ownerId, siteUrl, date, query, impressions, clicks, ctr, avgClickPosition, avgImpressionPosition, fetchedAt, dateSource)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ownerId, siteUrl, date, query) DO UPDATE SET
           impressions = excluded.impressions,
           clicks = excluded.clicks,
           ctr = excluded.ctr,
           avgClickPosition = excluded.avgClickPosition,
           avgImpressionPosition = excluded.avgImpressionPosition,
           fetchedAt = excluded.fetchedAt,
           dateSource = excluded.dateSource`,
        [
          ownerId,
          siteUrl,
          date,
          query,
          Number(row.impressions || 0),
          Number(row.clicks || 0),
          Number(row.ctr || 0),
          Number(row.avgClickPosition || 0),
          Number(row.avgImpressionPosition || 0),
          fetchedAt,
          'compatibility-fetchedAt',
        ],
      );
      insertedOrUpdated += result.changes;
    }
  });

  await applyBackfill();

  if (insertedOrUpdated > 0) {
    console.log(`[db] Backfilled ${insertedOrUpdated} Bing fact rows from legacy mirror using fetchedAt calendar dates`);
  }
}

async function validatePostgresRuntime(db: AppDatabase) {
  const row = await db.get<{
    ready: number;
    statementTimeout: string;
    idleInTransactionSessionTimeout: string;
  }>(
    `SELECT
      1 AS ready,
      current_setting('statement_timeout') AS "statementTimeout",
      current_setting('idle_in_transaction_session_timeout') AS "idleInTransactionSessionTimeout"`,
  );

  if (Number(row?.ready || 0) !== 1) {
    throw new Error('[db] PostgreSQL validation query failed.');
  }
}

function formatPostgresConnectionLog(db: AppDatabase) {
  const diagnostics = db.getDiagnostics?.();
  if (!diagnostics?.pool) {
    return '[db] Connected to PostgreSQL';
  }

  return `[db] Connected to PostgreSQL (${formatPostgresPoolSettings(diagnostics.pool)}) total=${diagnostics.pool.totalCount} idle=${diagnostics.pool.idleCount} waiting=${diagnostics.pool.waitingCount}`;
}

export async function initializeDatabase(): Promise<AppDatabase> {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

  if (databaseUrl) {
    validatePostgresConnectionString(databaseUrl);
    const poolSettings = getPostgresPoolSettingsFromEnv();
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: poolSettings.max,
      min: poolSettings.min,
      idleTimeoutMillis: poolSettings.idleTimeoutMillis,
      connectionTimeoutMillis: poolSettings.connectionTimeoutMillis,
      maxLifetimeSeconds: poolSettings.maxLifetimeSeconds,
      query_timeout: poolSettings.queryTimeoutMs,
      statement_timeout: poolSettings.statementTimeoutMs,
      idle_in_transaction_session_timeout: poolSettings.idleInTransactionSessionTimeoutMs,
      keepAlive: poolSettings.keepAlive,
      keepAliveInitialDelayMillis: poolSettings.keepAliveInitialDelayMillis,
      application_name: poolSettings.applicationName,
    });
    const db = new PostgresAppDatabase(pool, poolSettings);

    try {
      const runMigrations = db.transaction(async () => {
        await db.exec(`SELECT pg_advisory_xact_lock(${POSTGRES_SCHEMA_MIGRATION_LOCK_ID})`);
        await applyPostgresMigrations(db);
      });
      await runMigrations();
      await backfillLegacyBingQueryMetrics(db);
      await validatePostgresRuntime(db);
      if (process.env.RUN_DATABASE_BACKFILLS !== 'false') {
        scheduleCrawlCanonicalPageKeyBackfill(db);
        await backfillGscPageKeys(db);
        await backfillGscPageMetrics(db);
        await backfillGscSiteQueryCounts(db);
      }
      console.log(formatPostgresConnectionLog(db));
      return db;
    } catch (error) {
      await db.close().catch(() => undefined);
      throw error;
    }
  }

  const sqlite = createSqliteConnection();
  applySqliteMigrations(sqlite);
  const db = new SqliteAppDatabase(sqlite);
  await backfillLegacyBingQueryMetrics(db);
  if (process.env.RUN_DATABASE_BACKFILLS !== 'false') {
    scheduleCrawlCanonicalPageKeyBackfill(db);
  }
  await backfillGscPageKeys(db);
  await backfillGscPageMetrics(db);
  await backfillGscSiteQueryCounts(db);
  console.log('[db] Connected to local SQLite');
  return db;
}
