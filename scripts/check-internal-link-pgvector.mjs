import crypto from 'crypto';
import fs from 'fs';
import dotenv from 'dotenv';
import { initializeDatabase } from '../.server-dist/server/database.js';
import { estimateInternalLinkAnalysis, queueInternalLinkAnalysis, runInternalLinkAnalysisJobNow, updateInternalLinkOpportunityStatus } from '../.server-dist/server/services/internalLinks.js';

dotenv.config({ path: '.env.local' });
dotenv.config();
process.env.START_BACKGROUND_WORKERS = 'false';
process.env.DATABASE_URL ||= 'postgres://nextgen_seo:nextgen_seo_dev_password@localhost:5432/nextgen_seo';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function embeddingTextHash(text) {
  return crypto.createHash('sha256').update(normalizeText(text).toLowerCase()).digest('hex');
}

function targetEmbeddingText(target, topQueries) {
  return normalizeText([
    target.title,
    target.h1Text,
    target.metaDescription,
    target.pageKey.replace(/[-_/]+/g, ' '),
    ...topQueries,
  ].filter(Boolean).join('. '));
}

function unitVector(axis) {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[axis] = 1;
  return vector;
}

async function insertEmbeddingCache(db, provider, model, inputType, text, vector) {
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO internal_link_embedding_cache (
      provider, model, inputType, textHash, text, vectorJson, dimensions, tokenCount, useCount, createdAt, lastUsedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(provider, model, inputType, textHash) DO UPDATE SET
      text = excluded.text,
      vectorJson = excluded.vectorJson,
      dimensions = excluded.dimensions,
      tokenCount = excluded.tokenCount,
      useCount = COALESCE(internal_link_embedding_cache.useCount, 0) + 1,
      lastUsedAt = excluded.lastUsedAt
  `, [
    provider,
    model,
    inputType,
    embeddingTextHash(text),
    text,
    JSON.stringify(vector),
    vector.length,
    Math.ceil(normalizeText(text).split(/\s+/).filter(Boolean).length * 1.35),
    now,
    now,
  ]);
}

function assertBuiltArtifacts() {
  const missing = [];
  if (!fs.existsSync('.server-dist/server/database.js')) missing.push('.server-dist/server/database.js');
  if (!fs.existsSync('.server-dist/server/services/internalLinks.js')) missing.push('.server-dist/server/services/internalLinks.js');
  if (missing.length) throw new Error(`Missing built artifacts: ${missing.join(', ')}. Run npm run build first.`);
}

async function main() {
  assertBuiltArtifacts();
  const db = await initializeDatabase();
  const suffix = Date.now();
  const ownerId = `internal-link-pgvector-smoke-${suffix}`;
  const siteUrl = `https://pgvector-internal-links-${suffix}.example/`;
  const crawlJobId = `crawl-${suffix}`;
  const provider = 'local';
  const model = 'BAAI/bge-m3';
  const now = new Date().toISOString();

  const target = {
    h1Text: 'Technical SEO Audits for JavaScript Websites',
    metaDescription: 'A practical guide to auditing crawl and rendering problems on JavaScript websites.',
    pageKey: '/technical-seo-audits',
    title: 'Technical SEO Audits for JavaScript Websites',
    url: `${siteUrl}technical-seo-audits/`,
  };
  const source = {
    h1Text: 'JavaScript Crawl Diagnostics',
    metaDescription: 'How to diagnose rendering, indexability, and crawl traps.',
    pageKey: '/javascript-crawl-diagnostics',
    title: 'JavaScript Crawl Diagnostics',
    url: `${siteUrl}javascript-crawl-diagnostics/`,
  };
  const sourceSentence = 'Our guide explains technical SEO audits for JavaScript websites with practical crawl diagnostics and rendering checks.';
  const weakSentence = 'The newsletter archive includes release notes, office updates, and unrelated community announcements.';
  const targetTextVariants = new Set([
    targetEmbeddingText(target, ['technical SEO audits']),
    targetEmbeddingText(target, []),
    targetEmbeddingText({ ...target, metaDescription: '' }, ['technical SEO audits']),
    targetEmbeddingText({ ...target, h1Text: '' }, ['technical SEO audits']),
  ]);

  try {
    await db.run(`
      INSERT INTO crawl_jobs (id, ownerId, siteUrl, startUrl, status, maxPages, maxDepth, discoveredCount, crawledCount, startedAt, updatedAt, completedAt)
      VALUES (?, ?, ?, ?, 'completed', 10, 3, 2, 2, ?, ?, ?)
    `, [crawlJobId, ownerId, siteUrl, siteUrl, now, now, now]);

    for (const page of [source, target]) {
      await db.run(`
        INSERT INTO crawl_pages (
          ownerId, siteUrl, jobId, url, normalizedUrl, pageKey, finalUrl, statusCode, contentType,
          title, metaDescription, canonicalUrl, h1Text, wordCount, depth, discoveredAt, crawledAt, noindex, inboundLinkCount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 200, 'text/html; charset=utf-8', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `, [
        ownerId,
        siteUrl,
        crawlJobId,
        page.url,
        page.url,
        page.pageKey,
        page.url,
        page.title,
        page.metaDescription,
        page.url,
        page.h1Text,
        page.pageKey === target.pageKey ? 1200 : 900,
        page.pageKey === target.pageKey ? 2 : 1,
        now,
        now,
        page.pageKey === target.pageKey ? 0 : 20,
      ]);
    }

    await db.run(`
      INSERT INTO crawl_page_sentences (
        ownerId, siteUrl, jobId, pageUrl, pageKey, paragraphIndex, sentenceIndex, sentenceText, textHash,
        embeddingStatus, createdAt, headingText, linkDensity, boilerplateScore, extractionVersion
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 'cached', ?, 'Audit workflow', 0.05, 0.05, 2)
    `, [ownerId, siteUrl, crawlJobId, source.url, source.pageKey, sourceSentence, embeddingTextHash(sourceSentence), now]);
    await db.run(`
      INSERT INTO crawl_page_sentences (
        ownerId, siteUrl, jobId, pageUrl, pageKey, paragraphIndex, sentenceIndex, sentenceText, textHash,
        embeddingStatus, createdAt, headingText, linkDensity, boilerplateScore, extractionVersion
      ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, 'cached', ?, 'Updates', 0.05, 0.05, 2)
    `, [ownerId, siteUrl, crawlJobId, source.url, source.pageKey, weakSentence, embeddingTextHash(weakSentence), now]);

    await db.run(`
      INSERT INTO gsc_page_query_metrics (ownerId, siteUrl, date, page, pageKey, query, clicks, impressions, ctr, position)
      VALUES (?, ?, '2026-06-20', ?, ?, 'technical SEO audits', 24, 1400, 0.017, 8)
    `, [ownerId, siteUrl, target.url, target.pageKey]);

    for (const targetText of targetTextVariants) {
      await insertEmbeddingCache(db, provider, model, 'target', targetText, unitVector(0));
    }
    await insertEmbeddingCache(db, provider, model, 'sentence', sourceSentence, unitVector(0));
    await insertEmbeddingCache(db, provider, model, 'sentence', weakSentence, unitVector(1));

    const estimate = await estimateInternalLinkAnalysis(db, ownerId, {
      embeddingModel: 'BAAI/bge-m3',
      embeddingProvider: 'local',
      endDate: '2026-06-29',
      maxPages: 10,
      maxRecommendations: 10,
      maxSentencesPerPage: 10,
      provider: 'local',
      reviewModel: 'rules-editorial-v1',
      reviewProvider: 'local',
      siteUrl,
      startDate: '2026-06-01',
    });
    assert(estimate.vectorStore?.provider === 'pgvector', `Expected estimate vectorStore provider pgvector, got ${JSON.stringify(estimate.vectorStore)}`);
    assert(estimate.vectorStore?.indexed === true, `Expected pgvector HNSW index to be reported, got ${JSON.stringify(estimate.vectorStore)}`);
    const job = await queueInternalLinkAnalysis(db, ownerId, {
      embeddingModel: 'BAAI/bge-m3',
      embeddingProvider: 'local',
      endDate: '2026-06-29',
      maxPages: 10,
      maxRecommendations: 10,
      maxSentencesPerPage: 10,
      provider: 'local',
      reviewModel: 'rules-editorial-v1',
      reviewProvider: 'local',
      siteUrl,
      startDate: '2026-06-01',
    });
    await runInternalLinkAnalysisJobNow(db, job.id);

    const completed = await db.get('SELECT status, actualEmbeddingTokens, progressCompleted, lastError FROM internal_link_analysis_jobs WHERE id = ?', [job.id]);
    const rows = await db.all('SELECT id, anchorText, sourceSentence, targetUrl, modelVersion, priorityScore FROM internal_link_opportunities WHERE jobId = ? ORDER BY priorityScore DESC', [job.id]);
    const vectorRows = await db.get('SELECT COUNT(*) AS count FROM internal_link_embedding_vectors_1024 WHERE provider = ? AND model = ?', [provider, model]);

    assert(completed?.status === 'completed', `Expected completed pgvector job, got ${JSON.stringify(completed)}`);
    assert(rows.some((row) => String(row.modelVersion || '').includes('retrieval:pgvector')), `Expected an opportunity modelVersion to include retrieval:pgvector, got ${rows.map((row) => row.modelVersion).join(', ')}`);
    assert(Number(completed?.actualEmbeddingTokens || 0) === 0, 'Expected all deterministic fixture embeddings to come from the built-in BGE-M3 cache');
    assert(rows.length >= 1, 'Expected at least one pgvector-backed internal-link opportunity');
    assert(rows.some((row) => /technical SEO audits/i.test(row.anchorText)), 'Expected exact contextual technical SEO audits anchor');
    assert(rows.every((row) => !/\.(?:jpg|jpeg|png|gif|webp|svg|pdf)(?:[?#].*)?$/i.test(row.targetUrl)), 'Expected no asset targets');
    assert(Number(vectorRows?.count || 0) >= 3, 'Expected pgvector mirror rows to be present');

    const implemented = await updateInternalLinkOpportunityStatus(db, ownerId, rows[0].id, { note: 'Implemented during pgvector smoke.', status: 'implemented' });
    const implementedAgain = await updateInternalLinkOpportunityStatus(db, ownerId, rows[0].id, { note: 'Implemented during pgvector smoke.', status: 'implemented' });
    const annotations = await db.all('SELECT id, title, description FROM annotations WHERE userId = ? AND siteUrl = ?', [ownerId, siteUrl]);
    assert(implemented.status === 'implemented', 'Expected opportunity to be marked implemented');
    assert(implementedAgain.annotationId === implemented.annotationId, 'Expected repeated implemented update to reuse the original annotation');
    assert(annotations.length === 1, `Expected exactly one implementation annotation, got ${annotations.length}`);
    assert(/Internal link implemented/.test(annotations[0]?.title || ''), 'Expected implementation annotation title');
    let rollbackBlocked = false;
    try {
      await updateInternalLinkOpportunityStatus(db, ownerId, rows[0].id, { note: null, status: 'rejected' });
    } catch {
      rollbackBlocked = true;
    }
    assert(rollbackBlocked, 'Expected implemented recommendation rollback to be rejected');

    console.log(JSON.stringify({
      status: completed.status,
      modelVersion: rows[0]?.modelVersion,
      actualEmbeddingTokens: completed.actualEmbeddingTokens,
      opportunities: rows.length,
      topAnchor: rows[0]?.anchorText,
      vectorRows: Number(vectorRows?.count || 0),
      vectorStore: estimate.vectorStore,
      annotationCount: annotations.length,
    }, null, 2));
  } finally {
    await db.run('DELETE FROM annotations WHERE userId = ? AND siteUrl = ?', [ownerId, siteUrl]).catch(() => {});
    await db.run('DELETE FROM internal_link_opportunities WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]).catch(() => {});
    await db.run('DELETE FROM internal_link_analysis_jobs WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]).catch(() => {});
    await db.run('DELETE FROM gsc_page_query_metrics WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]).catch(() => {});
    await db.run('DELETE FROM crawl_page_sentences WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]).catch(() => {});
    await db.run('DELETE FROM crawl_links WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]).catch(() => {});
    await db.run('DELETE FROM crawl_pages WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]).catch(() => {});
    await db.run('DELETE FROM crawl_jobs WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]).catch(() => {});
    await db.close?.();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
