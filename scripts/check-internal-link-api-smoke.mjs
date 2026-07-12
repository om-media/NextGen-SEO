import crypto from 'crypto';
import fs from 'fs';
import dotenv from 'dotenv';
import multer from 'multer';
import { initializeDatabase } from '../.server-dist/server/database.js';
import { buildApp } from '../.server-dist/server/app.js';
import { createUserSession, SESSION_COOKIE_NAME } from '../.server-dist/server/auth.js';

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

function assertBuiltArtifacts() {
  const missing = [];
  if (!fs.existsSync('.server-dist/server/app.js')) missing.push('.server-dist/server/app.js');
  if (!fs.existsSync('.server-dist/server/database.js')) missing.push('.server-dist/server/database.js');
  if (missing.length) throw new Error(`Missing built artifacts: ${missing.join(', ')}. Run npm run build first.`);
}

async function jsonFetch(baseUrl, path, token, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  return { data, response };
}

async function main() {
  assertBuiltArtifacts();
  const db = await initializeDatabase();
  let server;
  const suffix = Date.now();
  const ownerId = `internal-link-api-smoke-${suffix}`;
  const siteUrl = `https://internal-link-api-smoke-${suffix}.example/`;
  const otherSiteUrl = `https://forbidden-api-smoke-${suffix}.example/`;
  const jobId = `job-${suffix}`;
  const opportunityId = `opp-${suffix}`;
  const now = new Date().toISOString();

  try {
    await db.run(`
      INSERT INTO users (id, email, passwordHash, activatedSiteUrl, knownSites, unlockedSites, createdAt)
      VALUES (?, ?, 'test', ?, ?, ?, ?)
    `, [ownerId, `${ownerId}@example.com`, siteUrl, JSON.stringify([siteUrl]), JSON.stringify([siteUrl]), now]);
    await db.run(`
      INSERT INTO internal_link_analysis_jobs (id, ownerId, siteUrl, crawlJobId, startDate, endDate, status, progressTotal, progressCompleted, provider, embeddingProvider, embeddingModel, reviewProvider, reviewModel, updatedAt)
      VALUES (?, ?, ?, 'crawl-api-smoke', '2026-06-01', '2026-06-29', 'completed', 1, 1, 'local', 'local', 'bge-m3-local', 'local', 'rules-editorial-v1', ?)
    `, [jobId, ownerId, siteUrl, now]);
    await db.run(`
      INSERT INTO internal_link_opportunities (
        id, jobId, ownerId, siteUrl, crawlJobId, sourceUrl, sourcePageKey, sourceTitle, sourceSentence,
        paragraphIndex, sentenceIndex, anchorText, anchorStart, anchorEnd, targetUrl, targetPageKey, targetTitle,
        readerBenefit, confidence, priorityScore, scoreBreakdown, opportunityType, status, stale, provider, modelVersion, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, 'crawl-api-smoke', ?, '/source', 'Source Article', ?, 0, 0, ?, 27, 50, ?, '/target', 'Target Article', ?, 'high', 91, ?, 'link-gap', 'new', 0, 'local', 'semantic:local:bge-m3:cache:2/2:retrieval:pgvector', ?, ?)
    `, [
      opportunityId,
      jobId,
      ownerId,
      siteUrl,
      `${siteUrl}source/`,
      'The source paragraph references technical SEO audits for JavaScript websites in context.',
      'technical SEO audits',
      `${siteUrl}target/`,
      'A reader here benefits from a deeper target article about the same technical SEO audit workflow.',
      JSON.stringify({ anchorQuality: 10, diversityPenalty: 0, notes: ['Route smoke.'], safety: 10, semanticBoost: 12, sourceAuthority: 24, targetNeed: 30, topicMatch: 20, total: 91 }),
      now,
      now,
    ]);

    const token = await createUserSession(db, ownerId);
    const app = buildApp({
      db,
      upload: multer({ dest: 'uploads/' }),
      syncJobs: new Map(),
      getSyncJobKey: (userId, scopedSiteUrl) => `${userId}:${scopedSiteUrl}`,
      startWorkers: false,
    });
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const initialProviderSettings = await jsonFetch(baseUrl, '/api/internal-links/provider-settings', token);
    assert(initialProviderSettings.response.status === 200, `Expected provider settings list 200, got ${initialProviderSettings.response.status}`);
    assert(Array.isArray(initialProviderSettings.data?.settings), 'Provider settings list returns an array');

    const savedProvider = await jsonFetch(baseUrl, '/api/internal-links/provider-settings/openai', token, {
      method: 'PUT',
      body: JSON.stringify({ apiKey: 'sk-test-provider-secret-1234', baseUrl: 'https://api.openai.com/v1/', embeddingModel: 'text-embedding-3-small', enabled: true, reviewModel: 'gpt-4.1-mini' }),
    });
    assert(savedProvider.response.status === 200, `Expected provider settings save 200, got ${savedProvider.response.status}: ${JSON.stringify(savedProvider.data)}`);
    assert(savedProvider.data?.setting?.hasApiKey === true, 'Saved provider setting reports an API key');
    assert(savedProvider.data?.setting?.apiKeyPreview?.endsWith('1234'), 'Saved provider setting returns a masked key preview');
    assert(savedProvider.data?.setting?.baseUrl === 'https://api.openai.com/v1', 'Saved provider setting normalizes baseUrl');
    assert(!JSON.stringify(savedProvider.data).includes('sk-test-provider-secret-1234'), 'Provider settings response never leaks the raw API key');

    const listedProviderSettings = await jsonFetch(baseUrl, '/api/internal-links/provider-settings', token);
    assert(listedProviderSettings.data?.settings?.some((setting) => setting.provider === 'openai' && setting.hasApiKey), 'Provider settings list includes saved OpenAI setting');
    assert(!JSON.stringify(listedProviderSettings.data).includes('sk-test-provider-secret-1234'), 'Provider settings list never leaks the raw API key');

    const clearedProvider = await jsonFetch(baseUrl, '/api/internal-links/provider-settings/openai', token, {
      method: 'PUT',
      body: JSON.stringify({ clearApiKey: true }),
    });
    assert(clearedProvider.response.status === 200, `Expected provider settings clear 200, got ${clearedProvider.response.status}: ${JSON.stringify(clearedProvider.data)}`);
    assert(clearedProvider.data?.setting?.hasApiKey === false, 'Clearing provider setting removes API key metadata');

    const deletedProvider = await jsonFetch(baseUrl, '/api/internal-links/provider-settings/openai', token, { method: 'DELETE' });
    assert(deletedProvider.response.status === 200 && deletedProvider.data?.deleted === true, 'Provider settings delete removes the saved provider row');
    const savedOllamaProvider = await jsonFetch(baseUrl, '/api/internal-links/provider-settings/ollama', token, {
      method: 'PUT',
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:11434/', embeddingModel: 'mxbai-embed-large', enabled: true, reviewModel: 'llama3.1:8b' }),
    });
    assert(savedOllamaProvider.response.status === 200, `Expected Ollama provider settings save 200, got ${savedOllamaProvider.response.status}: ${JSON.stringify(savedOllamaProvider.data)}`);
    const estimate = await jsonFetch(baseUrl, '/api/internal-links/estimate', token, {
      method: 'POST',
      body: JSON.stringify({ endDate: '2026-06-29', siteUrl, startDate: '2026-06-01' }),
    });
    assert(estimate.response.status === 200, `Expected estimate 200, got ${estimate.response.status}: ${JSON.stringify(estimate.data)}`);
    assert(estimate.data?.estimate?.vectorStore?.provider === 'pgvector', 'Estimate route exposes pgvector vector-store status');
    assert(estimate.data?.estimate?.embeddingModel === 'bge-m3-local', 'Default local estimate remains on Built-in BGE-M3 instead of inheriting Ollama settings');
    assert(estimate.data?.estimate?.reviewModel === 'rules-editorial-v1', 'Default local review remains on built-in editorial rules instead of inheriting Ollama settings');

    const forbidden = await jsonFetch(baseUrl, '/api/internal-links/estimate', token, {
      method: 'POST',
      body: JSON.stringify({ endDate: '2026-06-29', siteUrl: otherSiteUrl, startDate: '2026-06-01' }),
    });
    assert(forbidden.response.status === 403, `Expected forbidden site estimate 403, got ${forbidden.response.status}`);

    const ollamaEstimate = await jsonFetch(baseUrl, '/api/internal-links/estimate', token, {
      method: 'POST',
      body: JSON.stringify({ embeddingProvider: 'ollama', endDate: '2026-06-29', maxRecommendations: 25, reviewProvider: 'ollama', siteUrl, startDate: '2026-06-01' }),
    });
    assert(ollamaEstimate.response.status === 200, `Expected Ollama estimate 200, got ${ollamaEstimate.response.status}: ${JSON.stringify(ollamaEstimate.data)}`);
    assert(ollamaEstimate.data?.estimate?.embeddingModel === 'mxbai-embed-large', 'Explicit Ollama embedding provider applies saved Ollama model settings');
    assert(ollamaEstimate.data?.estimate?.reviewModel === 'llama3.1:8b', 'Explicit Ollama review provider applies saved Ollama model settings');
    assert(Number.isFinite(Number(ollamaEstimate.data?.estimate?.estimatedReviewTokens)), 'Ollama review estimate exposes review workload as a numeric field');
    assert(ollamaEstimate.data?.estimate?.estimatedHostedReviewCost === 0, 'Ollama review estimate remains zero hosted cost');

    const opportunitiesPath = `/api/internal-links/opportunities?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-06-01&endDate=2026-06-29&limit=20`;
    const opportunities = await jsonFetch(baseUrl, opportunitiesPath, token);
    assert(opportunities.response.status === 200, `Expected opportunities 200, got ${opportunities.response.status}`);
    assert(opportunities.data?.rows?.length === 1, `Expected one opportunity row, got ${opportunities.data?.rows?.length}`);
    assert(opportunities.data?.queue?.workloadState === 'idle', `Expected idle queue metadata, got ${JSON.stringify(opportunities.data?.queue)}`);
    assert(Number.isFinite(Number(opportunities.data?.queue?.workspaceActive)), 'Opportunities response exposes queue depth.');

    const jobs = await jsonFetch(baseUrl, `/api/internal-links/jobs?siteUrl=${encodeURIComponent(siteUrl)}&limit=20`, token);
    assert(jobs.response.status === 200, `Expected jobs 200, got ${jobs.response.status}`);
    assert(jobs.data?.queue?.message, 'Jobs response exposes queue status and ETA metadata.');

    const invalidStatus = await jsonFetch(baseUrl, `/api/internal-links/opportunities/${encodeURIComponent(opportunityId)}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'not-real' }),
    });
    assert(invalidStatus.response.status === 400, `Expected invalid status 400, got ${invalidStatus.response.status}: ${JSON.stringify(invalidStatus.data)}`);

    const implemented = await jsonFetch(baseUrl, `/api/internal-links/opportunities/${encodeURIComponent(opportunityId)}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'Implemented from API smoke.', status: 'implemented' }),
    });
    assert(implemented.response.status === 200, `Expected implemented status 200, got ${implemented.response.status}`);
    assert(implemented.data?.opportunity?.annotationId, 'Implemented API update returns annotationId');

    const rollback = await jsonFetch(baseUrl, `/api/internal-links/opportunities/${encodeURIComponent(opportunityId)}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'rejected' }),
    });
    assert(rollback.response.status === 409, `Expected implemented rollback 409, got ${rollback.response.status}: ${JSON.stringify(rollback.data)}`);

    const annotations = await db.all('SELECT id FROM annotations WHERE userId = ? AND siteUrl = ?', [ownerId, siteUrl]);
    assert(annotations.length === 1, `Expected exactly one annotation from API implementation, got ${annotations.length}`);

    console.log(JSON.stringify({
      estimateStatus: estimate.response.status,
      providerSettingsCreated: true,
      forbiddenStatus: forbidden.response.status,
      ollamaHostedReviewCost: ollamaEstimate.data.estimate.estimatedHostedReviewCost,
      ollamaReviewTokens: ollamaEstimate.data.estimate.estimatedReviewTokens,
      opportunities: opportunities.data.rows.length,
      queue: opportunities.data.queue,
      invalidStatus: invalidStatus.response.status,
      implementedStatus: implemented.response.status,
      rollbackStatus: rollback.response.status,
      annotationCount: annotations.length,
      vectorStore: estimate.data.estimate.vectorStore,
    }, null, 2));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.run('DELETE FROM annotations WHERE userId = ? AND siteUrl = ?', [ownerId, siteUrl]).catch(() => {});
    await db.run('DELETE FROM internal_link_provider_settings WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM internal_link_opportunities WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM internal_link_analysis_jobs WHERE ownerId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM sessions WHERE userId = ?', [ownerId]).catch(() => {});
    await db.run('DELETE FROM users WHERE id = ?', [ownerId]).catch(() => {});
    await db.close?.();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
