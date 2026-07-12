// @ts-nocheck
import crypto from 'crypto';
import { canonicalPageKey } from '../reporting/url.js';
import { getInternalLinkProviderSettings } from './internalLinkProviderSettings.js';
const ANALYSIS_POLL_MS = 5000;
const DEFAULT_ANALYSIS_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

function getAnalysisLockTimeoutMs() {
    const parsed = Number(process.env.INTERNAL_LINK_LOCK_TIMEOUT_MS);
    if (!Number.isFinite(parsed))
        return DEFAULT_ANALYSIS_LOCK_TIMEOUT_MS;
    return Math.max(30_000, Math.min(60 * 60 * 1000, Math.trunc(parsed)));
}

class AnalysisLeaseLostError extends Error {
    constructor() {
        super('Internal link analysis worker lease was lost.');
        this.name = 'AnalysisLeaseLostError';
    }
}
const LOCAL_PROVIDER = 'local';
const LOCAL_RULES_PROVIDER = 'local-rules';
const OLLAMA_PROVIDER = 'ollama';
const FREE_EMBEDDING_PROVIDERS = new Set([LOCAL_PROVIDER, LOCAL_RULES_PROVIDER, OLLAMA_PROVIDER]);
const FREE_REVIEW_PROVIDERS = new Set([LOCAL_PROVIDER, LOCAL_RULES_PROVIDER, OLLAMA_PROVIDER]);
const HOSTED_EMBEDDING_PROVIDERS = new Set(['cohere', 'gemini', 'jina', 'openai', 'voyage']);
const HOSTED_REVIEW_PROVIDERS = new Set(['anthropic', 'gemini', 'openai', 'openrouter']);
const DEFAULT_EMBEDDING_MODEL = 'bge-m3-local';
const DEFAULT_BUILT_IN_BGE_MODEL = 'BAAI/bge-m3';
const DEFAULT_BUILT_IN_BGE_URL = 'http://127.0.0.1:8091';
const DEFAULT_OLLAMA_BGE_MODEL = 'bge-m3';
const DEFAULT_REVIEW_MODEL = 'rules-editorial-v1';
const DEFAULT_OLLAMA_REVIEW_MODEL = 'llama3.1';
const REQUIRED_SENTENCE_EXTRACTION_VERSION = 2;
const PGVECTOR_RETRIEVAL_LIMIT_PER_TARGET = 80;
const HOSTED_RETRY_ATTEMPTS = 3;
const ANALYSIS_HEARTBEAT_INTERVAL_MS = 15_000;
const STOP_WORDS = new Set([
    'a', 'about', 'also', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'has', 'have', 'how', 'in', 'into', 'is', 'it', 'its', 'more', 'of', 'on', 'or', 'our', 'page', 'post', 'the', 'this', 'to', 'with', 'your', 'you', 'we', 'what', 'when', 'where', 'why', 'vs', 'best', 'guide', 'home', 'learn'
]);
const nowIso = () => new Date().toISOString();
function createAnalysisHeartbeat(db, job) {
    let lastHeartbeatAt = 0;
    return async (force = false) => {
        const now = Date.now();
        if (!force && now - lastHeartbeatAt < ANALYSIS_HEARTBEAT_INTERVAL_MS)
            return;
        const currentLease = job.lockedAt;
        if (!currentLease)
            throw new AnalysisLeaseLostError();
        const nextLease = new Date(now).toISOString();
        const result = await db.run(
            'UPDATE internal_link_analysis_jobs SET lockedAt = ?, updatedAt = ? WHERE id = ? AND status = ? AND lockedAt = ?',
            [nextLease, nextLease, job.id, 'running', currentLease],
        );
        if (!result.changes)
            throw new AnalysisLeaseLostError();
        job.lockedAt = nextLease;
        job.updatedAt = nextLease;
        lastHeartbeatAt = now;
    };
}
const toFiniteNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function clampWorkerCount(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return clamp(Math.trunc(parsed), 1, 16);
}
const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const ASSET_URL_PATTERN = /\.(?:avif|css|gif|ico|jpe?g|js|json|mov|mp3|mp4|pdf|png|svg|webm|webp|woff2?|xml|zip)(?:[?#].*)?$/i;
const ASSET_PATH_PATTERN = /\/(?:wp-content\/uploads|uploads|assets|static|media)\//i;
const UTILITY_PAGE_PATTERN = /\/(?:privacy-policy|privacy|politika-privatnosti|datenschutz|terms|uvjeti|legal|impressum|cookie|cookies|login|account|cart|checkout|thank-you|search|tag|category|author|feed|attachment|wp-json)(?:\/|$)|\/(?:page)\/\d+(?:\/|$)|[?&](?:filter|sort|s|q|replytocom)=/i;
const HOME_PAGE_KEY_PATTERN = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:home|homepage|startseite)?\/?$/i;
const GENERIC_SINGLE_ANCHOR_TOKENS = new Set([
    'activities', 'activity', 'aktivitaet', 'adventure', 'article', 'avanterra', 'blog', 'click', 'content', 'details', 'guide', 'home', 'information', 'learn', 'link', 'lopar', 'overview', 'page', 'parcours', 'park', 'post', 'resource', 'resources', 'route', 'service', 'services', 'site', 'solution', 'solutions', 'staza', 'trail', 'website',
]);
const WEAK_ANCHOR_HEAD_TERMS = new Set([
    'article', 'blog', 'click', 'content', 'details', 'information', 'link', 'overview', 'page', 'post', 'resource', 'resources', 'service', 'services', 'solution', 'solutions', 'website',
]);
function isHtmlContentType(value) {
    const contentType = normalizeText(value).toLowerCase();
    if (!contentType)
        return true;
    return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
}
function pageIdentityText(page) {
    return `${page.url || ''} ${page.normalizedUrl || ''} ${page.pageKey || ''}`;
}
function isUtilityPage(page) {
    return UTILITY_PAGE_PATTERN.test(pageIdentityText(page));
}
function normalizedUrlForComparison(value) {
    return normalizeText(value).replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
}
function isCanonicalizedAway(page) {
    const canonicalUrl = normalizedUrlForComparison(page.canonicalUrl);
    const normalizedUrl = normalizedUrlForComparison(page.normalizedUrl || page.url);
    return !!canonicalUrl && !!normalizedUrl && canonicalUrl !== normalizedUrl;
}
function isIndexableContentPage(page) {
    const url = pageIdentityText(page);
    if (ASSET_URL_PATTERN.test(url))
        return false;
    if (ASSET_PATH_PATTERN.test(url))
        return false;
    if (!isHtmlContentType(page.contentType))
        return false;
    if (toFiniteNumber(page.statusCode) < 200 || toFiniteNumber(page.statusCode) >= 300)
        return false;
    if (toFiniteNumber(page.noindex))
        return false;
    if (isCanonicalizedAway(page))
        return false;
    if (toFiniteNumber(page.wordCount) < 20 && !normalizeText(page.title) && !normalizeText(page.h1Text))
        return false;
    return true;
}
function isEligibleTargetPage(page) {
    if (toFiniteNumber(page.wordCount) < 120)
        return false;
    return !HOME_PAGE_KEY_PATTERN.test(page.pageKey || '/') && !isUtilityPage(page);
}
function isEligibleSourcePage(page) {
    return !isUtilityPage(page);
}
function lastMeaningfulSlug(pageKey) {
    const parts = normalizeText(pageKey).toLowerCase().split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}
function compactTitle(value) {
    return normalizeText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function isNearDuplicatePagePair(source, target) {
    const sourceSlug = lastMeaningfulSlug(source.pageKey);
    const targetSlug = lastMeaningfulSlug(target.pageKey);
    if (sourceSlug && sourceSlug === targetSlug)
        return true;
    const sourceCanonical = normalizedUrlForComparison(source.canonicalUrl || source.normalizedUrl);
    const targetCanonical = normalizedUrlForComparison(target.canonicalUrl || target.normalizedUrl);
    if (sourceCanonical && targetCanonical && sourceCanonical === targetCanonical)
        return true;
    const sourceTitle = compactTitle(source.h1Text || source.title);
    const targetTitle = compactTitle(target.h1Text || target.title);
    return !!sourceTitle && sourceTitle.length >= 24 && sourceTitle === targetTitle;
}
function tokenize(value) {
    return normalizeText(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/[\s-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}
function uniqueTokens(values, limit = 32) {
    return Array.from(new Set(values.flatMap((value) => tokenize(value)))).slice(0, limit);
}
function getFolderKey(pageKey) {
    if (!pageKey || pageKey === '/')
        return '/';
    const parts = pageKey.split('/').filter(Boolean);
    return parts.length > 1 ? `/${parts[0]}/` : '/';
}
function confidenceFromScore(score) {
    if (score >= 84)
        return 'high';
    if (score >= 66)
        return 'medium';
    return 'low';
}
function countApproxTokens(text) {
    return Math.ceil(normalizeText(text).split(/\s+/).filter(Boolean).length * 1.35);
}
function embeddingTextHash(text) {
    return crypto.createHash('sha256').update(normalizeText(text).toLowerCase()).digest('hex');
}
function sentenceEmbeddingHash(sentence) {
    return normalizeText(sentence.textHash) || embeddingTextHash(sentence.sentenceText);
}
function sentenceVectorKey(sentence) {
    return `${sentence.pageKey}:${sentence.paragraphIndex}:${sentence.sentenceIndex}`;
}
function cosineSimilarity(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length)
        return 0;
    let dot = 0;
    let aMag = 0;
    let bMag = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        aMag += a[i] * a[i];
        bMag += b[i] * b[i];
    }
    if (!aMag || !bMag)
        return 0;
    return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}
function targetEmbeddingText(target, gsc) {
    return normalizeText([
        target.title,
        target.h1Text,
        target.metaDescription,
        target.pageKey.replace(/[-_/]+/g, ' '),
        ...(gsc?.topQueries || []),
    ].filter(Boolean).join('. '));
}
const HOSTED_PROVIDER_BASE_URLS = {
    anthropic: 'https://api.anthropic.com',
    cohere: 'https://api.cohere.com',
    gemini: 'https://generativelanguage.googleapis.com',
    jina: 'https://api.jina.ai/v1',
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    voyage: 'https://api.voyageai.com/v1',
};
function hostedProviderBaseUrl(provider, settings) {
    return normalizeText(settings?.baseUrl || HOSTED_PROVIDER_BASE_URLS[provider] || '').replace(/\/+$/, '');
}
function hostedProviderApiKey(provider, settings) {
    const envName = `INTERNAL_LINK_${provider.toUpperCase()}_API_KEY`;
    return normalizeText(settings?.apiKey || process.env[envName] || process.env[`${provider.toUpperCase()}_API_KEY`]);
}
function defaultHostedEmbeddingModel(provider) {
    if (provider === 'cohere')
        return 'embed-v4.0';
    if (provider === 'gemini')
        return 'text-embedding-004';
    if (provider === 'jina')
        return 'jina-embeddings-v3';
    if (provider === 'voyage')
        return 'voyage-3-lite';
    return 'text-embedding-3-small';
}
function defaultHostedReviewModel(provider) {
    if (provider === 'anthropic')
        return 'claude-3-5-haiku-latest';
    if (provider === 'gemini')
        return 'gemini-1.5-flash';
    if (provider === 'openrouter')
        return 'openai/gpt-4.1-mini';
    return 'gpt-4.1-mini';
}
function hostedEmbeddingCostPerMillion(provider, model) {
    const normalized = `${provider}:${model}`.toLowerCase();
    if (normalized.includes('cohere'))
        return 0.10;
    if (normalized.includes('voyage'))
        return 0.12;
    if (normalized.includes('jina'))
        return 0.02;
    if (normalized.includes('gemini'))
        return 0.15;
    return 0.02;
}
function hostedReviewCostPerMillion(provider, model) {
    const normalized = `${provider}:${model}`.toLowerCase();
    if (normalized.includes('anthropic'))
        return 0.80;
    if (normalized.includes('gemini'))
        return 0.15;
    if (normalized.includes('openrouter'))
        return 0.30;
    return 0.20;
}
function estimatedHostedCostForUsage(job, embeddingTokens, reviewTokens) {
    const embeddingProvider = normalizeText(job.embeddingProvider || LOCAL_PROVIDER).toLowerCase();
    const reviewProvider = normalizeText(job.reviewProvider || LOCAL_PROVIDER).toLowerCase();
    const embeddingCost = FREE_EMBEDDING_PROVIDERS.has(embeddingProvider)
        ? 0
        : (Math.max(0, embeddingTokens) / 1_000_000) * hostedEmbeddingCostPerMillion(embeddingProvider, job.embeddingModel || defaultHostedEmbeddingModel(embeddingProvider));
    const reviewCost = FREE_REVIEW_PROVIDERS.has(reviewProvider)
        ? 0
        : (Math.max(0, reviewTokens) / 1_000_000) * hostedReviewCostPerMillion(reviewProvider, job.reviewModel || defaultHostedReviewModel(reviewProvider));
    return Number((embeddingCost + reviewCost).toFixed(6));
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isRetryableHostedError(error) {
    if (error?.name === 'AbortError')
        return true;
    if (error?.retryable)
        return true;
    const message = String(error?.message || '');
    return /\b(408|409|425|429|500|502|503|504)\b/.test(message);
}
async function postHostedJson(url, payload, headers) {
    let lastError = null;
    for (let attempt = 0; attempt < HOSTED_RETRY_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            const text = await response.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : null;
            }
            catch {
                data = { message: text };
            }
            if (!response.ok) {
                const detail = normalizeText(data?.error?.message || data?.message || text || response.statusText);
                const error = new Error(`${response.status}${detail ? ` ${detail}` : ''}`);
                error.retryable = response.status === 429 || response.status >= 500 || response.status === 408;
                throw error;
            }
            return data;
        }
        catch (error) {
            lastError = error;
            if (attempt >= HOSTED_RETRY_ATTEMPTS - 1 || !isRetryableHostedError(error))
                throw error;
            await sleep(450 * 2 ** attempt);
        }
        finally {
            clearTimeout(timeout);
        }
    }
    throw lastError || new Error('Hosted provider request failed.');
}
function normalizeHostedVectors(provider, data, expected) {
    let raw = [];
    if (provider === 'cohere')
        raw = Array.isArray(data?.embeddings?.float) ? data.embeddings.float : Array.isArray(data?.embeddings) ? data.embeddings : [];
    else if (provider === 'gemini')
        raw = Array.isArray(data?.embeddings) ? data.embeddings.map((entry) => entry?.values) : [];
    else
        raw = Array.isArray(data?.data) ? data.data.map((entry) => entry?.embedding) : Array.isArray(data?.embeddings) ? data.embeddings : [];
    const vectors = raw.map((vector) => Array.isArray(vector) ? vector.map(Number) : []);
    if (vectors.length !== expected || vectors.some((vector) => !vector.length || vector.some((value) => !Number.isFinite(value)))) {
        throw new Error(`${provider} returned invalid embedding vectors.`);
    }
    return vectors;
}
async function embedWithHostedProvider(provider, texts, model, settings, heartbeat) {
    if (!HOSTED_EMBEDDING_PROVIDERS.has(provider))
        throw new Error(`${provider} hosted embeddings are not supported yet.`);
    const apiKey = hostedProviderApiKey(provider, settings);
    const baseUrl = hostedProviderBaseUrl(provider, settings);
    if (!apiKey)
        throw new Error(`${provider} API key is missing. Add it in Settings > Integrations > Internal Links AI providers.`);
    if (!baseUrl)
        throw new Error(`${provider} base URL is missing.`);
    const vectors = [];
    const batchSize = provider === 'gemini' || provider === 'cohere' ? 64 : 96;
    for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize);
        let data;
        if (provider === 'cohere') {
            data = await postHostedJson(`${baseUrl}/v2/embed`, { embedding_types: ['float'], input_type: 'search_document', model, texts: chunk }, { Authorization: `Bearer ${apiKey}` });
        }
        else if (provider === 'gemini') {
            const endpointModel = encodeURIComponent(model || defaultHostedEmbeddingModel(provider));
            data = await postHostedJson(`${baseUrl}/v1beta/models/${endpointModel}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`, {
                requests: chunk.map((text) => ({ content: { parts: [{ text }] }, model: `models/${model}` })),
            }, {});
        }
        else if (provider === 'voyage') {
            data = await postHostedJson(`${baseUrl}/embeddings`, { input: chunk, input_type: 'document', model }, { Authorization: `Bearer ${apiKey}` });
        }
        else {
            const payload = { input: chunk, model };
            if (provider === 'openai' && /^text-embedding-3-/i.test(model))
                payload.dimensions = 1024;
            data = await postHostedJson(`${baseUrl}/embeddings`, payload, { Authorization: `Bearer ${apiKey}` });
        }
        vectors.push(...normalizeHostedVectors(provider, data, chunk.length));
        await heartbeat?.();
    }
    return vectors;
}
async function postOllamaJson(baseUrl, endpoint, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        if (!response.ok)
            throw new Error(`Ollama ${endpoint} returned ${response.status}`);
        return await response.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
async function embedWithOllama(texts, model, configuredBaseUrl, heartbeat) {
    const baseUrl = (configuredBaseUrl || process.env.INTERNAL_LINK_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const vectors = [];
    let batchEndpointError = null;
    for (let i = 0; i < texts.length; i += 32) {
        const chunk = texts.slice(i, i + 32);
        try {
            const data = await postOllamaJson(baseUrl, '/api/embed', { model, input: chunk });
            if (Array.isArray(data?.embeddings) && data.embeddings.length === chunk.length) {
                vectors.push(...data.embeddings.map((vector) => Array.isArray(vector) ? vector.map(Number) : []));
                continue;
            }
            throw new Error('Ollama /api/embed did not return one embedding per input.');
        }
        catch (error) {
            batchEndpointError = error;
            for (const text of chunk) {
                const data = await postOllamaJson(baseUrl, '/api/embeddings', { model, prompt: text });
                if (!Array.isArray(data?.embedding))
                    throw new Error('Ollama /api/embeddings did not return an embedding vector.');
                vectors.push(data.embedding.map(Number));
            }
        }
        await heartbeat?.();
    }
    if (vectors.length !== texts.length || vectors.some((vector) => !vector.length || vector.some((value) => !Number.isFinite(value)))) {
        throw batchEndpointError instanceof Error ? batchEndpointError : new Error('Ollama returned invalid embedding vectors.');
    }
    return vectors;
}
async function embedWithBuiltInBge(texts, heartbeat) {
    const baseUrl = (process.env.INTERNAL_LINK_EMBEDDING_WORKER_URL || DEFAULT_BUILT_IN_BGE_URL).replace(/\/+$/, '');
    const vectors = [];
    for (let i = 0; i < texts.length; i += 32) {
        const chunk = texts.slice(i, i + 32);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
        try {
            const response = await fetch(baseUrl + '/embed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ normalize: true, texts: chunk }),
                signal: controller.signal,
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                const detail = data?.detail || data?.error || 'HTTP ' + response.status;
                throw new Error('Built-in embedding worker returned ' + detail);
            }
            if (!Array.isArray(data?.embeddings) || data.embeddings.length !== chunk.length) {
                throw new Error('Built-in embedding worker did not return one embedding per input.');
            }
            vectors.push(...data.embeddings.map((vector) => Array.isArray(vector) ? vector.map(Number) : []));
        }
        finally {
            clearTimeout(timeout);
        }
        await heartbeat?.();
    }
    if (vectors.length !== texts.length ||
        vectors.some((vector) => vector.length !== 1024 || vector.some((value) => !Number.isFinite(value)))) {
        throw new Error('Built-in BGE-M3 worker returned invalid embedding vectors.');
    }
    return vectors;
}
function parseCachedVector(row) {
    try {
        const parsed = JSON.parse(row.vectorJson);
        if (!Array.isArray(parsed))
            return null;
        const vector = parsed.map(Number);
        return vector.length && vector.every((value) => Number.isFinite(value)) ? vector : null;
    }
    catch {
        return null;
    }
}
async function loadEmbeddingCache(db, provider, model, entries) {
    const vectors = new Map();
    const uniqueKeys = Array.from(new Set(entries.map((entry) => `${entry.inputType}\u001f${entry.textHash}`))).filter((key) => key.endsWith('\u001f') === false);
    const now = nowIso();
    for (let i = 0; i < uniqueKeys.length; i += 400) {
        const chunk = uniqueKeys.slice(i, i + 400).map((key) => {
            const [inputType, textHash] = key.split('\u001f');
            return { inputType, textHash };
        });
        if (!chunk.length)
            continue;
        const clauses = chunk.map(() => '(inputType = ? AND textHash = ?)').join(' OR ');
        const params = [provider, model, ...chunk.flatMap((entry) => [entry.inputType, entry.textHash])];
        const rows = await db.all(`
      SELECT provider, model, inputType, textHash, vectorJson, dimensions, tokenCount
      FROM internal_link_embedding_cache
      WHERE provider = ? AND model = ? AND (${clauses})
    `, params);
        for (const row of rows) {
            const vector = parseCachedVector(row);
            if (vector)
                vectors.set(`${row.inputType}\u001f${row.textHash}`, vector);
        }
        if (rows.length) {
            const updateClauses = rows.map(() => '(inputType = ? AND textHash = ?)').join(' OR ');
            await db.run(`
        UPDATE internal_link_embedding_cache
        SET lastUsedAt = ?, useCount = COALESCE(useCount, 0) + 1
        WHERE provider = ? AND model = ? AND (${updateClauses})
      `, [now, provider, model, ...rows.flatMap((row) => [row.inputType, row.textHash])]);
        }
    }
    return vectors;
}
function pgVectorLiteral(vector) {
    return `[${vector.map((value) => Number(value).toFixed(8)).join(',')}]`;
}
async function storePgvectorCache(db, provider, model, entries, now) {
    if (db.dialect !== 'postgres')
        return;
    const vectorEntries = entries.filter((entry) => entry.vector.length === 1024);
    if (!vectorEntries.length)
        return;
    try {
        for (let i = 0; i < vectorEntries.length; i += 100) {
            const chunk = vectorEntries.slice(i, i + 100);
            const valuesSql = chunk.map(() => '(?, ?, ?, ?, ?, ?::vector, ?, 1, ?, ?)').join(', ');
            await db.run(`
        INSERT INTO internal_link_embedding_vectors_1024 (
          provider, model, inputType, textHash, text, embedding, tokenCount, useCount, createdAt, lastUsedAt
        ) VALUES ${valuesSql}
        ON CONFLICT(provider, model, inputType, textHash) DO UPDATE SET
          text = excluded.text,
          embedding = excluded.embedding,
          tokenCount = excluded.tokenCount,
          useCount = COALESCE(internal_link_embedding_vectors_1024.useCount, 0) + 1,
          lastUsedAt = excluded.lastUsedAt
      `, chunk.flatMap((entry) => [
                provider,
                model,
                entry.inputType,
                entry.textHash,
                entry.text,
                pgVectorLiteral(entry.vector),
                entry.tokenCount,
                now,
                now,
            ]));
        }
    }
    catch (error) {
        console.warn('[internal-links] pgvector cache unavailable; using JSON embedding cache only.', error?.message || error);
    }
}
async function storeEmbeddingCache(db, provider, model, entries) {
    const now = nowIso();
    await storePgvectorCache(db, provider, model, entries, now);
    for (const entry of entries) {
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
            entry.inputType,
            entry.textHash,
            entry.text,
            JSON.stringify(entry.vector),
            entry.vector.length,
            entry.tokenCount,
            now,
            now,
        ]);
    }
}
async function loadPgvectorSentenceMatches(db, provider, model, targets, targetVectors, sentences, job) {
    const matchesByTarget = new Map();
    if (db.dialect !== 'postgres')
        return matchesByTarget;
    const sentenceByKey = new Map();
    for (const sentence of sentences) {
        sentenceByKey.set(sentenceVectorKey(sentence), sentence);
    }
    if (!sentenceByKey.size)
        return matchesByTarget;
    try {
        for (const target of targets) {
            const vector = targetVectors.get(target.pageKey);
            if (!vector || vector.length !== 1024)
                continue;
            const vectorLiteral = pgVectorLiteral(vector);
            const rows = await db.all(`
        SELECT
          s.pageKey,
          s.paragraphIndex,
          s.sentenceIndex,
          v.textHash,
          1 - (v.embedding <=> ?::vector) AS similarity
        FROM crawl_page_sentences s
        JOIN internal_link_embedding_vectors_1024 v
          ON v.provider = ?
          AND v.model = ?
          AND v.inputType = 'sentence'
          AND v.textHash = s.textHash
        WHERE s.ownerId = ?
          AND s.siteUrl = ?
          AND s.jobId = ?
          AND COALESCE(s.extractionVersion, 0) >= ?
          AND COALESCE(s.linkDensity, 0) <= 0.35
          AND COALESCE(s.boilerplateScore, 0) < 0.65
        ORDER BY v.embedding <=> ?::vector
        LIMIT ?
      `, [
                vectorLiteral,
                provider,
                model,
                job.ownerId,
                job.siteUrl,
                job.crawlJobId,
                REQUIRED_SENTENCE_EXTRACTION_VERSION,
                vectorLiteral,
                PGVECTOR_RETRIEVAL_LIMIT_PER_TARGET,
            ]);
            const targetMatches = new Map();
            for (const row of rows) {
                const similarity = toFiniteNumber(row.similarity);
                if (similarity < 0.58)
                    continue;
                const sentenceKey = `${canonicalPageKey(row.pageKey, job.siteUrl)}:${toFiniteNumber(row.paragraphIndex)}:${toFiniteNumber(row.sentenceIndex)}`;
                if (sentenceByKey.has(sentenceKey))
                    targetMatches.set(sentenceKey, similarity);
            }
            if (targetMatches.size)
                matchesByTarget.set(target.pageKey, targetMatches);
        }
    }
    catch (error) {
        console.warn('[internal-links] pgvector retrieval unavailable; using in-memory semantic scan.', error?.message || error);
    }
    return matchesByTarget;
}
function resolveOllamaEmbeddingModel(model) {
    const normalized = normalizeText(model || DEFAULT_EMBEDDING_MODEL);
    if (!normalized || normalized === DEFAULT_EMBEDDING_MODEL)
        return DEFAULT_OLLAMA_BGE_MODEL;
    return normalized;
}
function builtInEmbeddingSetupError(error) {
    const detail = error?.message || 'connection failed';
    return 'Built-in BGE-M3 is unavailable (' + detail + '). Start the managed local services with "npm run local:services:up" and wait for the model status to become ready.';
}
function ollamaEmbeddingSetupError(model, error) {
    const detail = error?.message || 'connection failed';
    return 'Ollama embeddings are unavailable (' + detail + '). Start Ollama and run "ollama pull ' + model + '", or select Built-in BGE-M3 instead.';
}
async function buildSemanticContext(db, job, targets, sentences, gsc, heartbeat) {
    const provider = normalizeText(job.embeddingProvider || LOCAL_PROVIDER).toLowerCase();
    const providerSettings = provider && provider !== LOCAL_PROVIDER && provider !== LOCAL_RULES_PROVIDER
        ? await getInternalLinkProviderSettings(db, job.ownerId, provider).catch(() => null)
        : null;
    const requestedModel = normalizeText(job.embeddingModel || providerSettings?.embeddingModel || process.env.INTERNAL_LINK_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL);
    if (provider === LOCAL_RULES_PROVIDER || requestedModel === LOCAL_RULES_PROVIDER || requestedModel.includes('rules'))
        return null;
    if (provider === LOCAL_PROVIDER || provider === OLLAMA_PROVIDER) {
        const model = provider === LOCAL_PROVIDER ? DEFAULT_BUILT_IN_BGE_MODEL : resolveOllamaEmbeddingModel(requestedModel);
        const targetEntries = targets.map((target) => {
            const text = targetEmbeddingText(target, gsc.get(target.pageKey));
            return { inputType: 'target', pageKey: target.pageKey, text, textHash: embeddingTextHash(text), tokenCount: countApproxTokens(text) };
        }).filter((entry) => entry.text && entry.textHash);
        const sentenceEntries = sentences.map((sentence) => {
            const text = normalizeText(sentence.sentenceText);
            return { inputType: 'sentence', sentence, text, textHash: sentenceEmbeddingHash(sentence), tokenCount: countApproxTokens(text) };
        }).filter((entry) => entry.text && entry.textHash);
        const entries = [...targetEntries, ...sentenceEntries];
        try {
            const cachedVectors = await loadEmbeddingCache(db, provider, model, entries);
            const missingByCacheKey = new Map();
            for (const entry of entries) {
                const cacheKey = `${entry.inputType}\u001f${entry.textHash}`;
                if (!cachedVectors.has(cacheKey))
                    missingByCacheKey.set(cacheKey, entry);
            }
            const missing = Array.from(missingByCacheKey.values());
            let actualEmbeddingTokens = 0;
            if (missing.length) {
                const vectors = provider === LOCAL_PROVIDER
                    ? await embedWithBuiltInBge(missing.map((entry) => entry.text), heartbeat)
                    : await embedWithOllama(missing.map((entry) => entry.text), model, providerSettings?.baseUrl, heartbeat);
                const cacheRows = missing.map((entry, index) => ({
                    inputType: entry.inputType,
                    text: entry.text,
                    textHash: entry.textHash,
                    tokenCount: entry.tokenCount,
                    vector: vectors[index],
                }));
                await storeEmbeddingCache(db, provider, model, cacheRows);
                cacheRows.forEach((entry) => cachedVectors.set(`${entry.inputType}\u001f${entry.textHash}`, entry.vector));
                actualEmbeddingTokens = missing.reduce((sum, entry) => sum + entry.tokenCount, 0);
            }
            const targetVectors = new Map();
            const sentenceVectors = new Map();
            for (const entry of targetEntries) {
                const vector = cachedVectors.get(`${entry.inputType}\u001f${entry.textHash}`);
                if (vector)
                    targetVectors.set(entry.pageKey, vector);
            }
            for (const entry of sentenceEntries) {
                const vector = cachedVectors.get(`${entry.inputType}\u001f${entry.textHash}`);
                if (vector)
                    sentenceVectors.set(sentenceVectorKey(entry.sentence), vector);
            }
            const pgvectorRows = entries
                .map((entry) => {
                const vector = cachedVectors.get(`${entry.inputType}\u001f${entry.textHash}`);
                return vector ? { inputType: entry.inputType, text: entry.text, textHash: entry.textHash, tokenCount: entry.tokenCount, vector } : null;
            })
                .filter((entry) => Boolean(entry));
            await storePgvectorCache(db, provider, model, pgvectorRows, nowIso());
            const pgvectorSentenceMatches = await loadPgvectorSentenceMatches(db, provider, model, targets, targetVectors, sentences, job);
            const retrievalMode = pgvectorSentenceMatches.size ? 'pgvector' : 'memory';
            return {
                actualEmbeddingTokens,
                model,
                modelVersionSuffix: `semantic:${provider}:${model}:cache:${entries.length - missing.length}/${entries.length}:retrieval:${retrievalMode}`,
                pgvectorSentenceMatches,
                provider,
                retrievalMode,
                sentenceVectors,
                targetVectors,
                warning: null,
            };
        }
        catch (error) {
            throw new Error(provider === LOCAL_PROVIDER ? builtInEmbeddingSetupError(error) : ollamaEmbeddingSetupError(model, error));
        }
    }
    if (HOSTED_EMBEDDING_PROVIDERS.has(provider)) {
        const model = requestedModel || defaultHostedEmbeddingModel(provider);
        const targetEntries = targets.map((target) => {
            const text = targetEmbeddingText(target, gsc.get(target.pageKey));
            return { inputType: 'target', pageKey: target.pageKey, text, textHash: embeddingTextHash(text), tokenCount: countApproxTokens(text) };
        }).filter((entry) => entry.text && entry.textHash);
        const sentenceEntries = sentences.map((sentence) => {
            const text = normalizeText(sentence.sentenceText);
            return { inputType: 'sentence', sentence, text, textHash: sentenceEmbeddingHash(sentence), tokenCount: countApproxTokens(text) };
        }).filter((entry) => entry.text && entry.textHash);
        const entries = [...targetEntries, ...sentenceEntries];
        const cachedVectors = await loadEmbeddingCache(db, provider, model, entries);
        const missingByCacheKey = new Map();
        for (const entry of entries) {
            const cacheKey = `${entry.inputType}\u001f${entry.textHash}`;
            if (!cachedVectors.has(cacheKey))
                missingByCacheKey.set(cacheKey, entry);
        }
        const missing = Array.from(missingByCacheKey.values());
        let actualEmbeddingTokens = 0;
        if (missing.length) {
            const vectors = await embedWithHostedProvider(provider, missing.map((entry) => entry.text), model, providerSettings, heartbeat);
            const cacheRows = missing.map((entry, index) => ({
                inputType: entry.inputType,
                text: entry.text,
                textHash: entry.textHash,
                tokenCount: entry.tokenCount,
                vector: vectors[index],
            }));
            await storeEmbeddingCache(db, provider, model, cacheRows);
            cacheRows.forEach((entry) => cachedVectors.set(`${entry.inputType}\u001f${entry.textHash}`, entry.vector));
            actualEmbeddingTokens = missing.reduce((sum, entry) => sum + entry.tokenCount, 0);
        }
        const targetVectors = new Map();
        const sentenceVectors = new Map();
        for (const entry of targetEntries) {
            const vector = cachedVectors.get(`${entry.inputType}\u001f${entry.textHash}`);
            if (vector)
                targetVectors.set(entry.pageKey, vector);
        }
        for (const entry of sentenceEntries) {
            const vector = cachedVectors.get(`${entry.inputType}\u001f${entry.textHash}`);
            if (vector)
                sentenceVectors.set(sentenceVectorKey(entry.sentence), vector);
        }
        const pgvectorRows = entries
            .map((entry) => {
            const vector = cachedVectors.get(`${entry.inputType}\u001f${entry.textHash}`);
            return vector ? { inputType: entry.inputType, text: entry.text, textHash: entry.textHash, tokenCount: entry.tokenCount, vector } : null;
        })
            .filter((entry) => Boolean(entry));
        await storePgvectorCache(db, provider, model, pgvectorRows, nowIso());
        const pgvectorSentenceMatches = await loadPgvectorSentenceMatches(db, provider, model, targets, targetVectors, sentences, job);
        const retrievalMode = pgvectorSentenceMatches.size ? 'pgvector' : 'memory';
        return {
            actualEmbeddingTokens,
            model,
            modelVersionSuffix: `semantic:${provider}:${model}:cache:${entries.length - missing.length}/${entries.length}:retrieval:${retrievalMode}`,
            pgvectorSentenceMatches,
            provider,
            retrievalMode,
            sentenceVectors,
            targetVectors,
            warning: null,
        };
    }
    return {
        actualEmbeddingTokens: 0,
        model: requestedModel,
        modelVersionSuffix: `semantic:${provider}:unsupported:${requestedModel}:retrieval:lexical`,
        pgvectorSentenceMatches: new Map(),
        provider,
        retrievalMode: 'lexical',
        sentenceVectors: new Map(),
        targetVectors: new Map(),
        warning: `${provider} hosted embeddings are not supported yet, so this job completed with the local lexical matcher.`,
    };
}
function isWordCharacter(value) {
    return /[\p{L}\p{N}]/u.test(value);
}
function findCaseInsensitiveSpan(text, phrase) {
    const lowerText = text.toLocaleLowerCase();
    const lowerPhrase = phrase.toLocaleLowerCase();
    let index = lowerText.indexOf(lowerPhrase);
    while (index >= 0) {
        const before = index > 0 ? text[index - 1] : '';
        const after = index + phrase.length < text.length ? text[index + phrase.length] : '';
        if ((!before || !isWordCharacter(before)) && (!after || !isWordCharacter(after))) {
            return { anchorText: text.slice(index, index + phrase.length), anchorStart: index, anchorEnd: index + phrase.length };
        }
        index = lowerText.indexOf(lowerPhrase, index + 1);
    }
    return null;
}
function isUsefulAnchorText(anchorText) {
    const tokens = tokenize(anchorText);
    if (!tokens.length)
        return false;
    if (tokens.length === 1 && (tokens[0].length < 8 || GENERIC_SINGLE_ANCHOR_TOKENS.has(tokens[0])))
        return false;
    if (tokens.every((token) => GENERIC_SINGLE_ANCHOR_TOKENS.has(token)))
        return false;
    if (tokens.length <= 2 && tokens.some((token) => WEAK_ANCHOR_HEAD_TERMS.has(token)))
        return false;
    return true;
}
function chooseAnchorSpan(sentence, target, gsc) {
    const candidatePhrases = [
        ...(gsc?.topQueries || []),
        target.h1Text,
        target.title,
        target.pageKey.split('/').filter(Boolean).slice(-1)[0]?.replace(/[-_]/g, ' '),
    ]
        .map((value) => normalizeText(value).replace(/[|:–].*$/, '').trim())
        .filter((value) => value.length >= 4 && value.length <= 90)
        .sort((a, b) => b.length - a.length);
    for (const phrase of candidatePhrases) {
        const span = findCaseInsensitiveSpan(sentence, phrase);
        if (span && isUsefulAnchorText(span.anchorText))
            return span;
    }
    const targetTokens = new Set(uniqueTokens([target.title, target.h1Text, target.pageKey, ...(gsc?.topQueries || [])]));
    const sentenceTokens = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || [];
    for (let i = 0; i < sentenceTokens.length; i += 1) {
        for (let size = 4; size >= 1; size -= 1) {
            const phrase = sentenceTokens.slice(i, i + size).join(' ');
            const tokens = tokenize(phrase);
            if (tokens.length >= 2 && tokens.every((token) => targetTokens.has(token))) {
                const span = findCaseInsensitiveSpan(sentence, phrase);
                if (span && span.anchorText.length >= 4 && isUsefulAnchorText(span.anchorText))
                    return span;
            }
        }
    }
    return null;
}
function sourceContextForBenefit(sentence) {
    const heading = normalizeText(sentence.headingText).replace(/[.!?]+$/, '');
    if (heading && heading.length <= 90)
        return `the "${heading}" section`;
    const sourceSentence = normalizeText(sentence.sentenceText);
    if (sourceSentence.length <= 140)
        return `the sentence "${sourceSentence}"`;
    return `the passage "${sourceSentence.slice(0, 132)}..."`;
}
function readerBenefitFor(sentence, target, gsc, ga4, overlap) {
    const sourceContext = sourceContextForBenefit(sentence);
    const targetLabel = target.title || target.h1Text || target.pageKey;
    if (gsc?.topQueries?.[0]) {
        return `A reader in ${sourceContext} is already considering this topic; ${targetLabel} expands on ${gsc.topQueries[0]} with a dedicated follow-up instead of leaving the next step implicit.`;
    }
    if (ga4?.sessions) {
        return `A reader in ${sourceContext} gets a proven next step because ${targetLabel} already attracts engaged visits and deepens the same topic.`;
    }
    if (overlap >= 3) {
        return `A reader in ${sourceContext} is already inside the same topic cluster, so ${targetLabel} gives them a more specific follow-up without breaking context.`;
    }
    return `A reader in ${sourceContext} benefits from a direct path to ${targetLabel}, which explains the linked concept in more depth.`;
}
function extractFirstJsonObject(value) {
    const text = String(value || '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start)
        return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
function normalizedJudgeConfidence(value, fallback) {
    const confidence = normalizeText(value).toLowerCase();
    if (confidence === 'high' || confidence === 'medium' || confidence === 'low')
        return confidence;
    return fallback;
}
function integerOffset(value) {
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
}
function applyStructuredJudgeResult(rec, result) {
    if (!result || result.accept !== true)
        return null;
    const sourceSentence = String(rec.sentence.sentenceText || '');
    const judgedSourceSentence = normalizeText(result.sourceSentence);
    if (!judgedSourceSentence || judgedSourceSentence !== normalizeText(sourceSentence))
        return null;
    const targetUrl = normalizeText(rec.target.url || rec.target.normalizedUrl);
    if (!targetUrl || normalizeText(result.targetUrl) !== targetUrl)
        return null;
    const anchorStart = integerOffset(result.anchorStart);
    const anchorEnd = integerOffset(result.anchorEnd);
    if (anchorStart === null || anchorEnd === null || anchorStart < 0 || anchorEnd <= anchorStart || anchorEnd > sourceSentence.length)
        return null;
    const anchorText = String(result.anchorText || '');
    const exactAnchorText = sourceSentence.slice(anchorStart, anchorEnd);
    if (!anchorText || exactAnchorText !== anchorText)
        return null;
    const before = anchorStart > 0 ? sourceSentence[anchorStart - 1] : '';
    const after = anchorEnd < sourceSentence.length ? sourceSentence[anchorEnd] : '';
    if ((before && isWordCharacter(before)) || (after && isWordCharacter(after)))
        return null;
    const readerBenefit = normalizeText(result.readerBenefit || rec.readerBenefit);
    if (!readerBenefit || readerBenefit.length < 45 || !isUsefulAnchorText(exactAnchorText))
        return null;
    return {
        ...rec,
        anchor: { anchorText: exactAnchorText, anchorStart, anchorEnd },
        confidence: normalizedJudgeConfidence(result.confidence, rec.confidence),
        readerBenefit,
    };
}
function ollamaJudgePrompt(rec) {
    const targetQueries = (rec.targetGsc?.topQueries || []).slice(0, 5).join(', ');
    return `You are an expert SEO editor reviewing one contextual internal link suggestion. Return only valid JSON.\n\nRules:\n- accept only if the target is a genuinely useful next step for a reader at this exact sentence\n- anchorText must appear exactly in sourceSentence\n- readerBenefit must be specific to both the source context and target page\n- reject generic, navigational, asset, circular, or same-topic-duplicate links\n\nJSON schema:\n{\"accept\":boolean,\"sourceSentence\":string,\"anchorText\":string,\"anchorStart\":number,\"anchorEnd\":number,\"targetUrl\":string,\"readerBenefit\":string,\"confidence\":\"high|medium|low\",\"rejectReason\":string}\n\nCandidate:\nsourceTitle: ${rec.source.title || ''}\nsourceUrl: ${rec.source.url || rec.source.normalizedUrl || ''}\nsourceSentence: ${rec.sentence.sentenceText}\nproposedAnchor: ${rec.anchor.anchorText}\ntargetTitle: ${rec.target.title || rec.target.h1Text || ''}\ntargetUrl: ${rec.target.url || rec.target.normalizedUrl || ''}\ntargetQueries: ${targetQueries}\ndeterministicScore: ${rec.priorityScore}\ncurrentReaderBenefit: ${rec.readerBenefit}`;
}
async function judgeRecommendationWithOllama(rec, model, configuredBaseUrl) {
    const data = await postOllamaJson((configuredBaseUrl || process.env.INTERNAL_LINK_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''), '/api/generate', {
        format: 'json',
        model,
        options: { temperature: 0.1 },
        prompt: ollamaJudgePrompt(rec),
        stream: false,
    });
    const parsed = typeof data?.response === 'string' ? extractFirstJsonObject(data.response) : data;
    return applyStructuredJudgeResult(rec, parsed);
}
function parseHostedJudgeResponse(provider, data) {
    if (provider === 'anthropic') {
        const text = Array.isArray(data?.content) ? data.content.map((part) => part?.text || '').join('\n') : '';
        return extractFirstJsonObject(text);
    }
    if (provider === 'gemini') {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = Array.isArray(parts) ? parts.map((part) => part?.text || '').join('\n') : '';
        return extractFirstJsonObject(text);
    }
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? extractFirstJsonObject(content) : content;
}
async function judgeRecommendationWithHostedProvider(provider, rec, model, settings) {
    if (!HOSTED_REVIEW_PROVIDERS.has(provider))
        throw new Error(`${provider} hosted review is not supported yet.`);
    const apiKey = hostedProviderApiKey(provider, settings);
    const baseUrl = hostedProviderBaseUrl(provider, settings);
    if (!apiKey)
        throw new Error(`${provider} API key is missing. Add it in Settings > Integrations > Internal Links AI providers.`);
    if (!baseUrl)
        throw new Error(`${provider} base URL is missing.`);
    const prompt = ollamaJudgePrompt(rec);
    let data;
    if (provider === 'anthropic') {
        data = await postHostedJson(`${baseUrl}/v1/messages`, {
            max_tokens: 700,
            messages: [{ content: prompt, role: 'user' }],
            model,
            temperature: 0.1,
        }, {
            'anthropic-version': '2023-06-01',
            'x-api-key': apiKey,
        });
    }
    else if (provider === 'gemini') {
        const endpointModel = encodeURIComponent(model || defaultHostedReviewModel(provider));
        data = await postHostedJson(`${baseUrl}/v1beta/models/${endpointModel}:generateContent?key=${encodeURIComponent(apiKey)}`, {
            contents: [{ parts: [{ text: prompt }], role: 'user' }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
        }, {});
    }
    else {
        data = await postHostedJson(`${baseUrl}/chat/completions`, {
            messages: [{ content: prompt, role: 'user' }],
            model,
            response_format: { type: 'json_object' },
            temperature: 0.1,
        }, { Authorization: `Bearer ${apiKey}` });
    }
    return applyStructuredJudgeResult(rec, parseHostedJudgeResponse(provider, data));
}
async function reviewEditorialRecommendations(db, job, recommendations, heartbeat) {
    const provider = normalizeText(job.reviewProvider || LOCAL_PROVIDER).toLowerCase();
    if (!recommendations.length || provider === LOCAL_PROVIDER || provider === LOCAL_RULES_PROVIDER || provider.includes('rules')) {
        return { recommendations, reviewTokens: 0, suffix: null };
    }
    if (provider === OLLAMA_PROVIDER) {
        const providerSettings = await getInternalLinkProviderSettings(db, job.ownerId, OLLAMA_PROVIDER).catch(() => null);
        const model = normalizeText(job.reviewModel || providerSettings?.reviewModel || process.env.INTERNAL_LINK_REVIEW_MODEL || DEFAULT_OLLAMA_REVIEW_MODEL);
        const judged = [];
        let reviewTokens = 0;
        for (const rec of recommendations) {
            reviewTokens += countApproxTokens(ollamaJudgePrompt(rec));
            const accepted = await judgeRecommendationWithOllama(rec, model, providerSettings?.baseUrl);
            if (accepted)
                judged.push(accepted);
        }
        return { recommendations: judged, reviewTokens, suffix: `judge:ollama:${model}:accepted:${judged.length}/${recommendations.length}` };
    }
    if (!HOSTED_REVIEW_PROVIDERS.has(provider)) {
        return { recommendations, reviewTokens: 0, suffix: `judge:${provider}:unsupported:${job.reviewModel || ''}` };
    }
    const providerSettings = await getInternalLinkProviderSettings(db, job.ownerId, provider).catch(() => null);
    const model = normalizeText(job.reviewModel || providerSettings?.reviewModel || defaultHostedReviewModel(provider));
    const judged = [];
    let reviewTokens = 0;
    for (const rec of recommendations) {
        reviewTokens += countApproxTokens(ollamaJudgePrompt(rec));
        const accepted = await judgeRecommendationWithHostedProvider(provider, rec, model, providerSettings);
        if (accepted)
            judged.push(accepted);
    }
    return { recommendations: judged, reviewTokens, suffix: `judge:${provider}:${model}:accepted:${judged.length}/${recommendations.length}` };
}
async function getLatestCompletedCrawlJob(db, ownerId, siteUrl) {
    return db.get(`
    SELECT id, completedAt, updatedAt
    FROM crawl_jobs
    WHERE ownerId = ? AND siteUrl = ? AND status = 'completed'
    ORDER BY COALESCE(completedAt, updatedAt, startedAt) DESC
    LIMIT 1
  `, [ownerId, siteUrl]);
}
async function loadGscAggregates(db, ownerId, siteUrl, startDate, endDate) {
    const rows = await db.all(`
    SELECT COALESCE(NULLIF(pageKey, ''), page) AS pageKey, query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
      CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) * 1.0 / SUM(impressions) ELSE 0 END AS position
    FROM gsc_page_query_metrics
    WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? AND COALESCE(NULLIF(pageKey, ''), page) <> ''
    GROUP BY COALESCE(NULLIF(pageKey, ''), page), query
  `, [ownerId, siteUrl, startDate, endDate]);
    const map = new Map();
    for (const row of rows) {
        const pageKey = canonicalPageKey(row.pageKey, siteUrl);
        if (!pageKey)
            continue;
        const current = map.get(pageKey) || { clicks: 0, impressions: 0, position: 0, queryCount: 0, topQueries: [], weightedPosition: 0, queryRows: [] };
        const clicks = toFiniteNumber(row.clicks);
        const impressions = toFiniteNumber(row.impressions);
        current.clicks += clicks;
        current.impressions += impressions;
        current.weightedPosition += toFiniteNumber(row.position) * impressions;
        current.queryCount += 1;
        const query = normalizeText(row.query);
        if (query)
            current.queryRows.push({ query, impressions });
        map.set(pageKey, current);
    }
    const output = new Map();
    for (const [pageKey, aggregate] of map) {
        output.set(pageKey, {
            clicks: aggregate.clicks,
            impressions: aggregate.impressions,
            position: aggregate.impressions > 0 ? aggregate.weightedPosition / aggregate.impressions : 0,
            queryCount: aggregate.queryCount,
            topQueries: aggregate.queryRows.sort((a, b) => b.impressions - a.impressions).slice(0, 6).map((row) => row.query),
        });
    }
    return output;
}
async function loadGa4Aggregates(db, ownerId, siteUrl, startDate, endDate) {
    const rows = await db.all(`
    SELECT pageKey, SUM(sessions) AS sessions, SUM(pageViews) AS pageViews
    FROM ga4_page_metrics
    WHERE ownerId = ? AND siteUrl = ? AND date >= ? AND date <= ? AND pageKey <> ''
    GROUP BY pageKey
  `, [ownerId, siteUrl, startDate, endDate]);
    return new Map(rows.map((row) => [canonicalPageKey(row.pageKey, siteUrl), {
            sessions: toFiniteNumber(row.sessions),
            pageViews: toFiniteNumber(row.pageViews),
        }]));
}
async function getVectorStoreStatus(db) {
    if (db.dialect !== 'postgres') {
        return {
            available: false,
            dimensions: null,
            indexed: false,
            provider: 'json-cache',
            reason: 'Postgres pgvector is not active; using the JSON embedding cache and in-memory semantic scan.',
        };
    }
    try {
        const status = await db.get(`
      SELECT
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS "hasExtension",
        to_regclass('public.internal_link_embedding_vectors_1024') IS NOT NULL AS "hasTable",
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE tablename = 'internal_link_embedding_vectors_1024'
            AND indexname = 'idx_internal_link_embedding_vectors_1024_hnsw'
        ) AS "hasHnswIndex"
    `);
        const available = Boolean(status?.hasExtension) && Boolean(status?.hasTable);
        return {
            available,
            dimensions: available ? 1024 : null,
            indexed: available && Boolean(status?.hasHnswIndex),
            provider: available ? 'pgvector' : 'json-cache',
            reason: available
                ? 'Self-hosted Postgres pgvector is available for free nearest-sentence retrieval.'
                : 'Postgres is active, but pgvector is unavailable; using the JSON embedding cache and in-memory semantic scan.',
        };
    }
    catch (error) {
        return {
            available: false,
            dimensions: null,
            indexed: false,
            provider: 'json-cache',
            reason: `Vector store check failed (${error?.message || 'unknown error'}); using the JSON embedding cache fallback.`,
        };
    }
}
async function resolveAnalysisInputDefaults(db, ownerId, input) {
    const embeddingProvider = normalizeText(input.embeddingProvider || LOCAL_PROVIDER).toLowerCase();
    const reviewProvider = normalizeText(input.reviewProvider || LOCAL_PROVIDER).toLowerCase();
    const embeddingSettings = embeddingProvider && embeddingProvider !== LOCAL_PROVIDER && embeddingProvider !== LOCAL_RULES_PROVIDER
        ? await getInternalLinkProviderSettings(db, ownerId, embeddingProvider).catch(() => null)
        : null;
    const reviewSettings = reviewProvider && reviewProvider !== LOCAL_PROVIDER && reviewProvider !== LOCAL_RULES_PROVIDER
        ? await getInternalLinkProviderSettings(db, ownerId, reviewProvider).catch(() => null)
        : null;
    return {
        ...input,
        embeddingModel: input.embeddingModel || embeddingSettings?.embeddingModel || null,
        reviewModel: input.reviewModel || reviewSettings?.reviewModel || null,
    };
}
async function estimateAnalysis(db, ownerId, siteUrl, crawlJobId, input) {
    const maxPages = Math.min(Math.max(Number(input.maxPages || 1000), 1), 10000);
    const maxSentencesPerPage = Math.min(Math.max(Number(input.maxSentencesPerPage || 50), 1), 250);
    const sentenceStats = await db.get(`
    SELECT COUNT(*) AS "sentenceCount", COALESCE(SUM(LENGTH(sentenceText)), 0) AS "charCount", COUNT(DISTINCT pageKey) AS "pageCount"
    FROM crawl_page_sentences
    WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
      AND COALESCE(extractionVersion, 0) >= ?
      AND COALESCE(linkDensity, 0) <= 0.35
      AND COALESCE(boilerplateScore, 0) < 0.65
  `, [ownerId, siteUrl, crawlJobId, REQUIRED_SENTENCE_EXTRACTION_VERSION]);
    const pageCount = Math.min(toFiniteNumber(sentenceStats?.pageCount), maxPages);
    const sentenceCount = Math.min(toFiniteNumber(sentenceStats?.sentenceCount), pageCount * maxSentencesPerPage);
    const avgChars = sentenceCount > 0 ? toFiniteNumber(sentenceStats?.charCount) / Math.max(1, toFiniteNumber(sentenceStats?.sentenceCount)) : 120;
    const estimatedEmbeddingTokens = Math.round(sentenceCount * Math.max(12, avgChars / 4));
    const estimatedReviewTokens = Math.min(Number(input.maxRecommendations || 500), 1000) * 450;
    const embeddingProvider = normalizeText(input.embeddingProvider || LOCAL_PROVIDER).toLowerCase();
    const reviewProvider = normalizeText(input.reviewProvider || LOCAL_PROVIDER).toLowerCase();
    const hostedEmbeddings = embeddingProvider && !FREE_EMBEDDING_PROVIDERS.has(embeddingProvider);
    const hostedReview = reviewProvider && !FREE_REVIEW_PROVIDERS.has(reviewProvider);
    return {
        estimatedEmbeddingTokens,
        estimatedHostedEmbeddingCost: hostedEmbeddings ? (estimatedEmbeddingTokens / 1_000_000) * hostedEmbeddingCostPerMillion(embeddingProvider, input.embeddingModel || defaultHostedEmbeddingModel(embeddingProvider)) : 0,
        estimatedHostedReviewCost: hostedReview ? (estimatedReviewTokens / 1_000_000) * hostedReviewCostPerMillion(reviewProvider, input.reviewModel || defaultHostedReviewModel(reviewProvider)) : 0,
        estimatedLocalUnits: sentenceCount,
        estimatedReviewTokens,
        maxPages,
        maxSentencesPerPage,
    };
}
export async function estimateInternalLinkAnalysis(db, ownerId, input) {
    input = await resolveAnalysisInputDefaults(db, ownerId, input);
    const vectorStore = await getVectorStoreStatus(db);
    const latestJob = await getLatestCompletedCrawlJob(db, ownerId, input.siteUrl);
    if (!latestJob?.id) {
        const maxPages = Math.min(Math.max(Number(input.maxPages || 1000), 1), 10000);
        const maxSentencesPerPage = Math.min(Math.max(Number(input.maxSentencesPerPage || 50), 1), 250);
        return {
            crawlJobId: '',
            embeddingModel: input.embeddingModel || DEFAULT_EMBEDDING_MODEL,
            embeddingProvider: input.embeddingProvider || LOCAL_PROVIDER,
            estimatedEmbeddingTokens: 0,
            estimatedHostedEmbeddingCost: 0,
            estimatedHostedReviewCost: 0,
            estimatedLocalUnits: 0,
            estimatedReviewTokens: 0,
            maxPages,
            maxRecommendations: Math.min(Math.max(Number(input.maxRecommendations || 500), 1), 2000),
            maxSentencesPerPage,
            reviewModel: input.reviewModel || DEFAULT_REVIEW_MODEL,
            reviewProvider: input.reviewProvider || LOCAL_PROVIDER,
            totalHostedCost: 0,
            vectorStore,
        };
    }
    const estimate = await estimateAnalysis(db, ownerId, input.siteUrl, latestJob.id, input);
    return {
        crawlJobId: latestJob.id,
        embeddingModel: input.embeddingModel || DEFAULT_EMBEDDING_MODEL,
        embeddingProvider: input.embeddingProvider || LOCAL_PROVIDER,
        estimatedEmbeddingTokens: estimate.estimatedEmbeddingTokens,
        estimatedHostedEmbeddingCost: estimate.estimatedHostedEmbeddingCost,
        estimatedHostedReviewCost: estimate.estimatedHostedReviewCost,
        estimatedLocalUnits: estimate.estimatedLocalUnits,
        estimatedReviewTokens: estimate.estimatedReviewTokens,
        maxPages: estimate.maxPages,
        maxRecommendations: Math.min(Math.max(Number(input.maxRecommendations || 500), 1), 2000),
        maxSentencesPerPage: estimate.maxSentencesPerPage,
        reviewModel: input.reviewModel || DEFAULT_REVIEW_MODEL,
        reviewProvider: input.reviewProvider || LOCAL_PROVIDER,
        totalHostedCost: estimate.estimatedHostedEmbeddingCost + estimate.estimatedHostedReviewCost,
        vectorStore,
    };
}
export async function queueInternalLinkAnalysis(db, ownerId, input) {
    input = await resolveAnalysisInputDefaults(db, ownerId, input);
    const latestJob = await getLatestCompletedCrawlJob(db, ownerId, input.siteUrl);
    if (!latestJob?.id)
        throw new Error('Run a crawl before analyzing internal links.');
    const estimate = await estimateAnalysis(db, ownerId, input.siteUrl, latestJob.id, input);
    if (toFiniteNumber(estimate.estimatedLocalUnits) <= 0) {
        throw new Error('Recrawl the site to collect sentence-level context before running premium internal link analysis.');
    }
    const estimatedHostedCost = estimate.estimatedHostedEmbeddingCost + estimate.estimatedHostedReviewCost;
    if (input.maxHostedSpend !== null && input.maxHostedSpend !== undefined && estimatedHostedCost > input.maxHostedSpend) {
        throw new Error(`Estimated hosted analysis cost ${estimatedHostedCost.toFixed(4)} exceeds the max hosted spend cap ${Number(input.maxHostedSpend).toFixed(4)}.`);
    }
    const jobId = crypto.randomUUID();
    const now = nowIso();
    await db.run(`
    INSERT INTO internal_link_analysis_jobs (
      id, ownerId, siteUrl, crawlJobId, startDate, endDate, status, progressTotal, progressCompleted,
      provider, embeddingProvider, embeddingModel, reviewProvider, reviewModel, maxPages, maxSentencesPerPage, maxRecommendations,
      estimatedLocalUnits, estimatedEmbeddingTokens, estimatedHostedEmbeddingCost, estimatedReviewTokens, estimatedHostedReviewCost,
      startedAt, updatedAt, completedAt, lastError
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
        jobId,
        ownerId,
        input.siteUrl,
        latestJob.id,
        input.startDate,
        input.endDate,
        'queued',
        estimate.estimatedLocalUnits,
        0,
        input.provider || LOCAL_PROVIDER,
        input.embeddingProvider || LOCAL_PROVIDER,
        input.embeddingModel || DEFAULT_EMBEDDING_MODEL,
        input.reviewProvider || LOCAL_PROVIDER,
        input.reviewModel || DEFAULT_REVIEW_MODEL,
        estimate.maxPages,
        estimate.maxSentencesPerPage,
        Math.min(Math.max(Number(input.maxRecommendations || 500), 1), 2000),
        estimate.estimatedLocalUnits,
        estimate.estimatedEmbeddingTokens,
        estimate.estimatedHostedEmbeddingCost,
        estimate.estimatedReviewTokens,
        estimate.estimatedHostedReviewCost,
        null,
        now,
        null,
        null,
    ]);
    return db.get('SELECT * FROM internal_link_analysis_jobs WHERE id = ?', [jobId]);
}
export async function listInternalLinkAnalysisJobs(db, ownerId, siteUrl, limit = 20) {
    return db.all(`
    SELECT *
    FROM internal_link_analysis_jobs
    WHERE ownerId = ? AND siteUrl = ?
    ORDER BY updatedAt DESC
    LIMIT ?
  `, [ownerId, siteUrl, limit]);
}
export async function cancelInternalLinkAnalysisJob(db, ownerId, jobId) {
    const job = await db.get('SELECT * FROM internal_link_analysis_jobs WHERE id = ? AND ownerId = ?', [jobId, ownerId]);
    if (!job)
        throw new Error('Internal link analysis job not found.');
    if (['completed', 'error', 'canceled'].includes(job.status))
        return job;
    const now = nowIso();
    await db.run(`
    UPDATE internal_link_analysis_jobs
    SET status = 'canceled', completedAt = ?, updatedAt = ?, lockedAt = NULL, lastError = 'Canceled by user.'
    WHERE id = ? AND ownerId = ? AND status IN ('queued', 'running')
  `, [now, now, jobId, ownerId]);
    return db.get('SELECT * FROM internal_link_analysis_jobs WHERE id = ? AND ownerId = ?', [jobId, ownerId]);
}
export async function rerunInternalLinkAnalysisJob(db, ownerId, jobId) {
    const job = await db.get('SELECT * FROM internal_link_analysis_jobs WHERE id = ? AND ownerId = ?', [jobId, ownerId]);
    if (!job)
        throw new Error('Internal link analysis job not found.');
    return queueInternalLinkAnalysis(db, ownerId, {
        embeddingModel: job.embeddingModel,
        embeddingProvider: job.embeddingProvider,
        endDate: job.endDate,
        maxHostedSpend: null,
        maxPages: job.maxPages,
        maxRecommendations: job.maxRecommendations,
        maxSentencesPerPage: job.maxSentencesPerPage,
        provider: job.provider,
        reviewModel: job.reviewModel,
        reviewProvider: job.reviewProvider,
        siteUrl: job.siteUrl,
        startDate: job.startDate,
    });
}
async function isAnalysisJobCanceled(db, jobId) {
    const row = await db.get('SELECT status FROM internal_link_analysis_jobs WHERE id = ?', [jobId]);
    return row?.status === 'canceled';
}
async function recoverStaleAnalysisJobs(db, cutoff, now) {
    await db.run(`
    UPDATE internal_link_analysis_jobs
    SET status = 'queued',
        startedAt = NULL,
        lockedAt = NULL,
        lastError = COALESCE(lastError, 'Recovered after interrupted analysis worker.'),
        updatedAt = ?
    WHERE status = 'running'
      AND (lockedAt IS NULL OR lockedAt < ?)
  `, [now, cutoff]);
}
async function claimNextAnalysisJobPostgres(db, cutoff) {
    const claim = db.transaction(async () => {
        await db.exec('SELECT pg_advisory_xact_lock(864203199)');
        const now = nowIso();
        await recoverStaleAnalysisJobs(db, cutoff, now);
        return db.get(`
      WITH ranked AS (
        SELECT
          job.id,
          ROW_NUMBER() OVER (
            PARTITION BY job.ownerId, job.siteUrl
            ORDER BY job.updatedAt ASC NULLS FIRST, job.id ASC
          ) AS siteRank,
          (
            SELECT COUNT(*)
            FROM internal_link_analysis_jobs running_owner
            WHERE running_owner.status = 'running'
              AND running_owner.ownerId = job.ownerId
          ) AS ownerRunningCount
        FROM internal_link_analysis_jobs job
        WHERE job.status = 'queued'
          AND NOT EXISTS (
            SELECT 1
            FROM internal_link_analysis_jobs running_site
            WHERE running_site.status = 'running'
              AND running_site.ownerId = job.ownerId
              AND running_site.siteUrl = job.siteUrl
          )
      ),
      next_job AS (
        SELECT job.id
        FROM internal_link_analysis_jobs job
        INNER JOIN ranked ON ranked.id = job.id
        WHERE ranked.siteRank = 1
        ORDER BY ranked.ownerRunningCount ASC, job.updatedAt ASC NULLS FIRST, job.id ASC
        FOR UPDATE OF job SKIP LOCKED
        LIMIT 1
      )
      UPDATE internal_link_analysis_jobs AS job
      SET status = 'running', startedAt = COALESCE(job.startedAt, ?), updatedAt = ?, lockedAt = ?, lastError = NULL
      FROM next_job
      WHERE job.id = next_job.id
      RETURNING job.*
    `, [now, now, now]);
    });
    return claim();
}
let sqliteClaimTail = Promise.resolve();
async function withSqliteClaimLock(callback) {
    const previous = sqliteClaimTail;
    let release;
    sqliteClaimTail = new Promise((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await callback();
    }
    finally {
        release();
    }
}
async function claimNextAnalysisJobSqlite(db, cutoff) {
    return withSqliteClaimLock(async () => {
        await db.exec('BEGIN IMMEDIATE');
        try {
            const now = nowIso();
            await recoverStaleAnalysisJobs(db, cutoff, now);
            const job = await db.get(`
        WITH ranked AS (
          SELECT
            queued.*,
            ROW_NUMBER() OVER (
              PARTITION BY queued.ownerId, queued.siteUrl
              ORDER BY queued.updatedAt ASC, queued.id ASC
            ) AS siteRank,
            (
              SELECT COUNT(*)
              FROM internal_link_analysis_jobs running_owner
              WHERE running_owner.status = 'running'
                AND running_owner.ownerId = queued.ownerId
            ) AS ownerRunningCount
          FROM internal_link_analysis_jobs queued
          WHERE queued.status = 'queued'
            AND NOT EXISTS (
              SELECT 1
              FROM internal_link_analysis_jobs running_site
              WHERE running_site.status = 'running'
                AND running_site.ownerId = queued.ownerId
                AND running_site.siteUrl = queued.siteUrl
            )
        )
        SELECT *
        FROM ranked
        WHERE siteRank = 1
        ORDER BY ownerRunningCount ASC, updatedAt ASC, id ASC
        LIMIT 1
      `);
            if (!job) {
                await db.exec('COMMIT');
                return null;
            }
            const result = await db.run(`
        UPDATE internal_link_analysis_jobs
        SET status = 'running', startedAt = COALESCE(startedAt, ?), updatedAt = ?, lockedAt = ?, lastError = NULL
        WHERE id = ? AND status = 'queued'
      `, [now, now, now, job.id]);
            if (!result.changes) {
                await db.exec('COMMIT');
                return null;
            }
            const claimed = await db.get('SELECT * FROM internal_link_analysis_jobs WHERE id = ?', [job.id]);
            await db.exec('COMMIT');
            return claimed || null;
        }
        catch (error) {
            await db.exec('ROLLBACK').catch(() => { });
            throw error;
        }
    });
}
async function claimNextAnalysisJob(db) {
    const cutoff = new Date(Date.now() - getAnalysisLockTimeoutMs()).toISOString();
    return db.dialect === 'postgres'
        ? claimNextAnalysisJobPostgres(db, cutoff)
        : claimNextAnalysisJobSqlite(db, cutoff);
}
function sourceAuthority(page, gsc) {
    return clamp(24 - toFiniteNumber(page.depth) * 3, 6, 24) + clamp(toFiniteNumber(gsc?.clicks) / 15, 0, 12) + clamp(toFiniteNumber(page.inboundLinkCount), 0, 10);
}
function targetNeed(page, gsc, ga4) {
    const inlinks = toFiniteNumber(page.inboundLinkCount);
    return clamp((10 - inlinks) * 4, 0, 36)
        + clamp(toFiniteNumber(gsc?.impressions) / 80, 0, 26)
        + (gsc?.position && gsc.position >= 4 && gsc.position <= 20 ? 16 : 0)
        + clamp(toFiniteNumber(ga4?.sessions) / 25, 0, 12);
}
function anchorQualityScore(anchorText) {
    const anchorTokens = tokenize(anchorText).length;
    return Math.round(clamp(anchorTokens * 3 + (anchorText.length >= 8 ? 3 : 0), 4, 12));
}
function scoreBreakdownFor(input) {
    const anchorTokens = tokenize(input.anchorText).length;
    const targetNeedScore = Math.round(clamp(input.targetBaseNeed, 0, 40));
    const sourceAuthorityScore = Math.round(clamp(input.sourceAuthorityScore, 0, 34));
    const topicMatch = Math.round(clamp(input.overlap * 8 + (input.semanticSimilarity > 0 ? input.semanticSimilarity * 12 : 0), 0, 28));
    const anchorQuality = anchorQualityScore(input.anchorText);
    const semanticBoost = Math.round(clamp(input.semanticBoost, 0, 24));
    const safety = 10;
    const rawTotal = targetNeedScore + sourceAuthorityScore + topicMatch + semanticBoost + anchorQuality + safety;
    const total = Math.round(clamp(input.score, 0, 100));
    const diversityPenalty = Math.max(0, Math.round(rawTotal - total));
    const notes = [
        input.targetGsc?.position && input.targetGsc.position >= 4 && input.targetGsc.position <= 20 ? 'Target has striking-distance search visibility.' : null,
        input.targetGsc?.impressions ? 'Target has GSC demand.' : null,
        input.semanticSimilarity >= 0.58 ? 'Semantic similarity supports the source-target match.' : null,
        input.overlap >= 2 ? 'Source sentence shares multiple target topic tokens.' : null,
        anchorTokens >= 2 ? 'Anchor is descriptive and multi-token.' : null,
    ].filter((note) => Boolean(note));
    return {
        anchorQuality,
        diversityPenalty,
        notes,
        safety,
        semanticBoost,
        sourceAuthority: sourceAuthorityScore,
        targetNeed: targetNeedScore,
        topicMatch,
        total,
    };
}
function parseScoreBreakdown(value, priorityScore) {
    if (typeof value === 'string' && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object') {
                return {
                    anchorQuality: toFiniteNumber(parsed.anchorQuality),
                    diversityPenalty: toFiniteNumber(parsed.diversityPenalty),
                    notes: Array.isArray(parsed.notes) ? parsed.notes.filter((entry) => typeof entry === 'string') : [],
                    safety: toFiniteNumber(parsed.safety),
                    semanticBoost: toFiniteNumber(parsed.semanticBoost),
                    sourceAuthority: toFiniteNumber(parsed.sourceAuthority),
                    targetNeed: toFiniteNumber(parsed.targetNeed),
                    topicMatch: toFiniteNumber(parsed.topicMatch),
                    total: toFiniteNumber(parsed.total) || priorityScore,
                };
            }
        }
        catch {
            // Older rows may not have score JSON yet.
        }
    }
    return {
        anchorQuality: 0,
        diversityPenalty: 0,
        notes: ['Legacy recommendation without component score breakdown.'],
        safety: 0,
        semanticBoost: 0,
        sourceAuthority: 0,
        targetNeed: 0,
        topicMatch: 0,
        total: priorityScore,
    };
}
function opportunityType(page, gsc, ga4) {
    if (toFiniteNumber(page.inboundLinkCount) <= 1)
        return 'orphan-risk';
    if (gsc?.position && gsc.position >= 4 && gsc.position <= 20)
        return 'striking-distance';
    if (ga4?.sessions && (!gsc || gsc.impressions < 250))
        return 'visibility-gap';
    return 'link-gap';
}
async function runInternalLinkAnalysis(db, job) {
    const heartbeat = createAnalysisHeartbeat(db, job);
    await heartbeat(true);
    const [crawlRows, linkRows, sentenceRows, gsc, ga4] = await Promise.all([
        db.all(`
      SELECT url, normalizedUrl, pageKey, statusCode, contentType, title, metaDescription, h1Text, wordCount, depth, noindex, inboundLinkCount, canonicalUrl
      FROM crawl_pages
      WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
      ORDER BY depth ASC, url ASC
      LIMIT ?
    `, [job.ownerId, job.siteUrl, job.crawlJobId, job.maxPages || 1000]),
        db.all(`
      SELECT fromPageKey, toPageKey
      FROM crawl_links
      WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
    `, [job.ownerId, job.siteUrl, job.crawlJobId]),
        db.all(`
      SELECT pageUrl, pageKey, paragraphIndex, sentenceIndex, sentenceText, textHash, headingText, linkDensity, boilerplateScore, extractionVersion
      FROM crawl_page_sentences
      WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
      ORDER BY pageKey, paragraphIndex, sentenceIndex
    `, [job.ownerId, job.siteUrl, job.crawlJobId]),
        loadGscAggregates(db, job.ownerId, job.siteUrl, job.startDate, job.endDate),
        loadGa4Aggregates(db, job.ownerId, job.siteUrl, job.startDate, job.endDate),
    ]);
    const currentSentenceRows = sentenceRows.filter((row) => toFiniteNumber(row.extractionVersion) >= REQUIRED_SENTENCE_EXTRACTION_VERSION);
    if (!currentSentenceRows.length) {
        const failedAt = nowIso();
        const failed = await db.run(`
      UPDATE internal_link_analysis_jobs
      SET status = 'error', completedAt = ?, updatedAt = ?, lockedAt = NULL, lastError = ?
      WHERE id = ? AND status = 'running' AND lockedAt = ?
    `, [failedAt, failedAt, sentenceRows.length
                ? 'Recrawl the site to refresh sentence extraction quality before running internal link analysis.'
                : 'Recrawl the site to collect sentence-level context before running premium internal link analysis.', job.id, job.lockedAt]);
        if (!failed.changes)
            throw new AnalysisLeaseLostError();
        return;
    }
    const pages = crawlRows
        .map((row) => ({ ...row, pageKey: canonicalPageKey(row.pageKey || row.normalizedUrl || row.url, job.siteUrl) }))
        .filter((row) => row.pageKey && isIndexableContentPage(row));
    const pageByKey = new Map(pages.map((row) => [row.pageKey, row]));
    const existingLinks = new Set(linkRows.map((row) => `${canonicalPageKey(row.fromPageKey, job.siteUrl)}=>${canonicalPageKey(row.toPageKey, job.siteUrl)}`));
    const maxSentencesPerPage = Math.max(1, Number(job.maxSentencesPerPage || 50));
    const sentenceCountByPage = new Map();
    const sentences = currentSentenceRows
        .map((row) => ({ ...row, pageKey: canonicalPageKey(row.pageKey || row.pageUrl, job.siteUrl) }))
        .filter((row) => {
        const sourcePage = pageByKey.get(row.pageKey);
        if (!sourcePage || !isEligibleSourcePage(sourcePage))
            return false;
        const count = sentenceCountByPage.get(row.pageKey) || 0;
        if (count >= maxSentencesPerPage)
            return false;
        sentenceCountByPage.set(row.pageKey, count + 1);
        return normalizeText(row.sentenceText).length >= 55 && toFiniteNumber(row.linkDensity) <= 0.35 && toFiniteNumber(row.boilerplateScore) < 0.65;
    });
    const targets = pages
        .filter((page) => {
        if (!isEligibleTargetPage(page))
            return false;
        const gscRow = gsc.get(page.pageKey);
        const ga4Row = ga4.get(page.pageKey);
        return toFiniteNumber(page.inboundLinkCount) <= 10 || toFiniteNumber(gscRow?.impressions) >= 100 || toFiniteNumber(ga4Row?.sessions) >= 25;
    })
        .sort((a, b) => targetNeed(b, gsc.get(b.pageKey), ga4.get(b.pageKey)) - targetNeed(a, gsc.get(a.pageKey), ga4.get(a.pageKey)))
        .slice(0, 400);
    const checkpoint = await db.get(
        'SELECT COUNT(*) AS count FROM internal_link_opportunities WHERE jobId = ?',
        [job.id],
    );
    const existingOpportunityCount = Math.max(0, toFiniteNumber(checkpoint?.count));
    if (!existingOpportunityCount) {
        await db.run('DELETE FROM internal_link_opportunities WHERE jobId = ?', [job.id]);
    }
    await db.run(`
    UPDATE internal_link_opportunities
    SET stale = 1, status = CASE WHEN status = 'implemented' THEN status ELSE 'stale' END, updatedAt = ?
    WHERE ownerId = ? AND siteUrl = ? AND crawlJobId != ? AND stale = 0
  `, [nowIso(), job.ownerId, job.siteUrl, job.crawlJobId]);
    if (await isAnalysisJobCanceled(db, job.id))
        return;
    const semantic = await buildSemanticContext(db, job, targets, sentences, gsc, heartbeat);
    if (await isAnalysisJobCanceled(db, job.id))
        return;
    const sentenceTokenSets = new Map();
    const sentencesByToken = new Map();
    const sourceAuthorityByPage = new Map();
    const sentenceByKey = new Map();
    for (const page of pages) {
        sourceAuthorityByPage.set(page.pageKey, sourceAuthority(page, gsc.get(page.pageKey)));
    }
    for (const sentence of sentences) {
        const key = sentenceVectorKey(sentence);
        sentenceByKey.set(key, sentence);
        const tokens = new Set(tokenize(sentence.sentenceText));
        sentenceTokenSets.set(key, tokens);
        for (const token of tokens) {
            const bucket = sentencesByToken.get(token) || [];
            bucket.push(sentence);
            sentencesByToken.set(token, bucket);
        }
    }
    const collectCandidateSentences = (target, targetTokenSet) => {
        const candidates = new Map();
        for (const token of targetTokenSet) {
            const bucket = sentencesByToken.get(token);
            if (!bucket)
                continue;
            for (const sentence of bucket) {
                if (sentence.pageKey === target.pageKey || existingLinks.has(`${sentence.pageKey}=>${target.pageKey}`))
                    continue;
                candidates.set(sentenceVectorKey(sentence), sentence);
            }
        }
        const pgvectorMatches = semantic?.pgvectorSentenceMatches.get(target.pageKey);
        if (pgvectorMatches?.size) {
            for (const sentenceKey of pgvectorMatches.keys()) {
                const sentence = sentenceByKey.get(sentenceKey);
                if (!sentence || sentence.pageKey === target.pageKey || existingLinks.has(`${sentence.pageKey}=>${target.pageKey}`))
                    continue;
                candidates.set(sentenceKey, sentence);
            }
        }
        else {
            const targetVector = semantic?.targetVectors.get(target.pageKey);
            if (targetVector) {
                const semanticMatches = sentences
                    .filter((sentence) => sentence.pageKey !== target.pageKey && !existingLinks.has(`${sentence.pageKey}=>${target.pageKey}`))
                    .map((sentence) => ({
                    sentence,
                    similarity: cosineSimilarity(semantic.sentenceVectors.get(sentenceVectorKey(sentence)), targetVector),
                }))
                    .filter((match) => match.similarity >= 0.58)
                    .sort((a, b) => b.similarity - a.similarity)
                    .slice(0, PGVECTOR_RETRIEVAL_LIMIT_PER_TARGET);
                for (const match of semanticMatches) {
                    candidates.set(sentenceVectorKey(match.sentence), match.sentence);
                }
            }
        }
        return Array.from(candidates.values());
    };
    const recommendations = [];
    let targetIndex = 0;
    for (const target of targets) {
        targetIndex += 1;
        if (targetIndex % 10 === 0) {
            await heartbeat();
            if (await isAnalysisJobCanceled(db, job.id))
                return;
        }
        const targetGsc = gsc.get(target.pageKey);
        const targetGa4 = ga4.get(target.pageKey);
        const targetTokens = uniqueTokens([target.title, target.h1Text, target.metaDescription, target.pageKey, ...(targetGsc?.topQueries || [])], 42);
        if (!targetTokens.length)
            continue;
        const targetTokenSet = new Set(targetTokens);
        const targetBaseNeed = targetNeed(target, targetGsc, targetGa4);
        const matches = collectCandidateSentences(target, targetTokenSet)
            .map((sentence) => {
            const source = pageByKey.get(sentence.pageKey);
            const sentenceKey = sentenceVectorKey(sentence);
            const sentenceTokens = sentenceTokenSets.get(sentenceKey) || new Set();
            const overlap = Array.from(sentenceTokens).filter((token) => targetTokenSet.has(token)).length;
            const semanticSimilarity = semantic?.pgvectorSentenceMatches.get(target.pageKey)?.get(sentenceKey) ?? cosineSimilarity(semantic?.sentenceVectors.get(sentenceKey), semantic?.targetVectors.get(target.pageKey));
            if (overlap < 2 && semanticSimilarity < 0.58)
                return null;
            const anchor = chooseAnchorSpan(sentence.sentenceText, target, targetGsc);
            if (!anchor)
                return null;
            const semanticBoost = semanticSimilarity > 0 ? clamp((semanticSimilarity - 0.42) * 58, 0, 24) : 0;
            const sourceAuthorityScore = sourceAuthorityByPage.get(source.pageKey) ?? sourceAuthority(source, gsc.get(source.pageKey));
            const score = Math.round(clamp(targetBaseNeed + sourceAuthorityScore + overlap * 8 + semanticBoost + anchorQualityScore(anchor.anchorText), 0, 100));
            if (score < 50)
                return null;
            return {
                anchor,
                confidence: confidenceFromScore(score),
                opportunityType: opportunityType(target, targetGsc, targetGa4),
                priorityScore: score,
                readerBenefit: readerBenefitFor(sentence, target, targetGsc, targetGa4, Math.max(overlap, semanticSimilarity >= 0.62 ? 3 : 0)),
                scoreBreakdown: scoreBreakdownFor({
                    anchorText: anchor.anchorText,
                    overlap,
                    score,
                    semanticBoost,
                    semanticSimilarity,
                    sourceAuthorityScore,
                    targetBaseNeed,
                    targetGsc,
                }),
                source,
                sentence,
                target,
            };
        })
            .filter(Boolean)
            .sort((a, b) => b.priorityScore - a.priorityScore)
            .slice(0, 3);
        recommendations.push(...matches);
    }
    recommendations.sort((a, b) => b.priorityScore - a.priorityScore);
    const usedSourceAnchor = new Set();
    const usedSourceTarget = new Set();
    const linksPerSourcePage = new Map();
    const linksPerTargetPage = new Map();
    const targetAnchorUse = new Map();
    const editorialRecommendations = [];
    for (const rec of recommendations) {
        const normalizedAnchor = normalizeText(rec.anchor.anchorText).toLowerCase();
        const sourceAnchorKey = `${rec.source.pageKey}:${normalizedAnchor}`;
        const sourceTargetKey = `${rec.source.pageKey}=>${rec.target.pageKey}`;
        const targetAnchorKey = `${rec.target.pageKey}:${normalizedAnchor}`;
        const sourceCount = linksPerSourcePage.get(rec.source.pageKey) || 0;
        const targetCount = linksPerTargetPage.get(rec.target.pageKey) || 0;
        const targetAnchorCount = targetAnchorUse.get(targetAnchorKey) || 0;
        if (sourceCount >= 3 || targetCount >= 5 || targetAnchorCount >= 2 || usedSourceAnchor.has(sourceAnchorKey) || usedSourceTarget.has(sourceTargetKey))
            continue;
        if (isNearDuplicatePagePair(rec.source, rec.target))
            continue;
        usedSourceAnchor.add(sourceAnchorKey);
        usedSourceTarget.add(sourceTargetKey);
        linksPerSourcePage.set(rec.source.pageKey, sourceCount + 1);
        linksPerTargetPage.set(rec.target.pageKey, targetCount + 1);
        targetAnchorUse.set(targetAnchorKey, targetAnchorCount + 1);
        editorialRecommendations.push(rec);
    }
    const preReview = editorialRecommendations.slice(0, Math.max(1, Number(job.maxRecommendations || 500)));
    const review = await reviewEditorialRecommendations(db, job, preReview, heartbeat);
    const limited = review.recommendations;
    const createdAt = nowIso();
    await heartbeat(true);
    let completed = existingOpportunityCount;
    for (const rec of limited.slice(existingOpportunityCount)) {
        if (completed % 25 === 0 && await isAnalysisJobCanceled(db, job.id))
            return;
        const id = crypto.randomUUID();
        await db.run(`
      INSERT INTO internal_link_opportunities (
        id, jobId, ownerId, siteUrl, crawlJobId, sourceUrl, sourcePageKey, sourceTitle, sourceSentence,
        paragraphIndex, sentenceIndex, anchorText, anchorStart, anchorEnd, targetUrl, targetPageKey, targetTitle,
        readerBenefit, confidence, priorityScore, scoreBreakdown, opportunityType, status, userNote, stale, provider, modelVersion,
        annotationId, createdAt, updatedAt, implementedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ownerId, siteUrl, crawlJobId, sourcePageKey, targetPageKey, anchorText) DO UPDATE SET
        jobId=excluded.jobId,
        sourceSentence=excluded.sourceSentence,
        paragraphIndex=excluded.paragraphIndex,
        sentenceIndex=excluded.sentenceIndex,
        anchorStart=excluded.anchorStart,
        anchorEnd=excluded.anchorEnd,
        readerBenefit=excluded.readerBenefit,
        confidence=excluded.confidence,
        priorityScore=excluded.priorityScore,
        scoreBreakdown=excluded.scoreBreakdown,
        opportunityType=excluded.opportunityType,
        stale=0,
        provider=excluded.provider,
        modelVersion=excluded.modelVersion,
        updatedAt=excluded.updatedAt
    `, [
            id,
            job.id,
            job.ownerId,
            job.siteUrl,
            job.crawlJobId,
            rec.source.url || rec.source.normalizedUrl,
            rec.source.pageKey,
            rec.source.title,
            rec.sentence.sentenceText,
            rec.sentence.paragraphIndex,
            rec.sentence.sentenceIndex,
            rec.anchor.anchorText,
            rec.anchor.anchorStart,
            rec.anchor.anchorEnd,
            rec.target.url || rec.target.normalizedUrl,
            rec.target.pageKey,
            rec.target.title,
            rec.readerBenefit,
            rec.confidence,
            rec.priorityScore,
            JSON.stringify(rec.scoreBreakdown),
            rec.opportunityType,
            'new',
            null,
            0,
            job.provider || LOCAL_PROVIDER,
            `${job.embeddingProvider || LOCAL_PROVIDER}:${job.embeddingModel || DEFAULT_EMBEDDING_MODEL}|${job.reviewProvider || LOCAL_PROVIDER}:${job.reviewModel || DEFAULT_REVIEW_MODEL}${semantic ? `|${semantic.modelVersionSuffix}` : ''}${review.suffix ? `|${review.suffix}` : ''}`,
            null,
            createdAt,
            createdAt,
            null,
        ]);
        completed += 1;
        if (completed % 25 === 0) {
            await heartbeat(true);
            const progress = await db.run(
                'UPDATE internal_link_analysis_jobs SET progressCompleted = ?, updatedAt = ? WHERE id = ? AND status = ? AND lockedAt = ?',
                [completed, nowIso(), job.id, 'running', job.lockedAt],
            );
            if (!progress.changes)
                throw new AnalysisLeaseLostError();
        }
        else {
            await heartbeat();
        }
    }
    if (await isAnalysisJobCanceled(db, job.id))
        return;
    const completedAt = nowIso();
    const completion = await db.run(`
    UPDATE internal_link_analysis_jobs
    SET status = 'completed',
        progressCompleted = ?,
        progressTotal = ?,
        actualEmbeddingTokens = ?,
        actualReviewTokens = ?,
        actualCost = ?,
        completedAt = ?,
        updatedAt = ?,
        lastError = ?,
        lockedAt = NULL
    WHERE id = ? AND status = 'running' AND lockedAt = ?
  `, [
        completed,
        Math.max(completed, toFiniteNumber(job.progressTotal)),
        semantic?.actualEmbeddingTokens || 0,
        review.reviewTokens,
        estimatedHostedCostForUsage(job, semantic?.actualEmbeddingTokens || 0, review.reviewTokens),
        completedAt,
        completedAt,
        semantic?.warning || null,
        job.id,
        job.lockedAt,
    ]);
    if (!completion.changes)
        throw new AnalysisLeaseLostError();
}
export async function runInternalLinkAnalysisJobNow(db, jobId) {
    const job = await db.get('SELECT * FROM internal_link_analysis_jobs WHERE id = ?', [jobId]);
    if (!job)
        throw new Error('Internal link analysis job not found.');
    const lease = nowIso();
    await db.run('UPDATE internal_link_analysis_jobs SET status = ?, startedAt = COALESCE(startedAt, ?), updatedAt = ?, lockedAt = ?, lastError = NULL WHERE id = ?', ['running', lease, lease, lease, jobId]);
    const refreshed = (await db.get('SELECT * FROM internal_link_analysis_jobs WHERE id = ?', [jobId]));
    await runInternalLinkAnalysis(db, refreshed);
}
export function startInternalLinkAnalysisWorker(db) {
    let stopped = false;
    const workerCount = clampWorkerCount(process.env.INTERNAL_LINK_JOB_CONCURRENCY ?? process.env.INTERNAL_LINK_ANALYSIS_WORKERS, 1);
    const workerLoop = async () => {
        while (!stopped) {
            let claimedJob = false;
            try {
                const job = await claimNextAnalysisJob(db);
                if (job) {
                    claimedJob = true;
                    try {
                        await runInternalLinkAnalysis(db, job);
                    }
                    catch (error) {
                        if (error instanceof AnalysisLeaseLostError)
                            continue;
                        const failedAt = nowIso();
                        await db.run(`
              UPDATE internal_link_analysis_jobs
              SET status = 'error', completedAt = ?, updatedAt = ?, lockedAt = NULL, lastError = ?
              WHERE id = ? AND status = 'running' AND lockedAt = ?
            `, [failedAt, failedAt, error?.message || 'Internal link analysis failed', job.id, job.lockedAt]);
                    }
                }
            }
            catch (error) {
                console.error('[internal-links] Analysis worker failed:', error);
            }
            if (!claimedJob && !stopped) {
                await sleep(ANALYSIS_POLL_MS);
            }
        }
    };
    for (let index = 0; index < workerCount; index += 1) {
        void workerLoop();
    }
    return () => {
        stopped = true;
    };
}
export const __internalLinkWorkerTestUtils = {
    claimNextAnalysisJob,
    createAnalysisHeartbeat,
    recoverStaleAnalysisJobs,
};
function hydrateOpportunity(row) {
    return {
        id: row.id,
        annotationId: row.annotationId || null,
        anchorEnd: toFiniteNumber(row.anchorEnd),
        anchorStart: toFiniteNumber(row.anchorStart),
        anchorText: row.anchorText || '',
        confidence: row.confidence || 'low',
        createdAt: row.createdAt || null,
        implementedAt: row.implementedAt || null,
        modelVersion: row.modelVersion || null,
        opportunityType: row.opportunityType || 'link-gap',
        priorityScore: toFiniteNumber(row.priorityScore),
        scoreBreakdown: parseScoreBreakdown(row.scoreBreakdown, toFiniteNumber(row.priorityScore)),
        provider: row.provider || LOCAL_PROVIDER,
        readerBenefit: row.readerBenefit || '',
        stale: Boolean(toFiniteNumber(row.stale)),
        status: row.status || 'new',
        userNote: row.userNote || null,
        source: {
            pageKey: row.sourcePageKey || '',
            sentence: row.sourceSentence || '',
            title: row.sourceTitle || null,
            url: row.sourceUrl || '',
        },
        target: {
            folder: getFolderKey(row.targetPageKey || ''),
            pageKey: row.targetPageKey || '',
            title: row.targetTitle || null,
            url: row.targetUrl || '',
        },
    };
}
export async function getInternalLinkOpportunities(db, ownerId, siteUrl, _startDate, _endDate, filters) {
    const latestJob = filters.jobId
        ? await db.get('SELECT * FROM internal_link_analysis_jobs WHERE id = ? AND ownerId = ? AND siteUrl = ?', [filters.jobId, ownerId, siteUrl])
        : await db.get(`
      SELECT *
      FROM internal_link_analysis_jobs
      WHERE ownerId = ? AND siteUrl = ?
      ORDER BY updatedAt DESC
      LIMIT 1
    `, [ownerId, siteUrl]);
    if (!latestJob) {
        return {
            job: null,
            meta: { folders: [], message: 'Run an internal link analysis to generate editorial recommendations.', totals: { highPriority: 0, implemented: 0, opportunities: 0, ready: 0, stale: 0 } },
            page: { filteredTotal: 0, limit: filters.limit, offset: filters.offset, total: 0 },
            rows: [],
        };
    }
    const latestCrawl = filters.jobId ? null : await getLatestCompletedCrawlJob(db, ownerId, siteUrl);
    const staleMessage = latestCrawl?.id && latestCrawl.id !== latestJob.crawlJobId
        ? 'A newer crawl is available. Existing recommendations were marked stale; rerun analysis for fresh source sentences and link gaps.'
        : null;
    if (staleMessage) {
        await db.run(`
      UPDATE internal_link_opportunities
      SET stale = 1, status = CASE WHEN status = 'implemented' THEN status ELSE 'stale' END, updatedAt = ?
      WHERE ownerId = ? AND siteUrl = ? AND jobId = ? AND stale = 0
    `, [nowIso(), ownerId, siteUrl, latestJob.id]);
    }
    const params = [ownerId, siteUrl, latestJob.id];
    const where = ['ownerId = ?', 'siteUrl = ?', 'jobId = ?'];
    if (filters.confidence && filters.confidence !== 'all') {
        where.push('confidence = ?');
        params.push(filters.confidence);
    }
    if (filters.status && filters.status !== 'all') {
        where.push('status = ?');
        params.push(filters.status);
    }
    if (filters.opportunityType && filters.opportunityType !== 'all') {
        where.push('opportunityType = ?');
        params.push(filters.opportunityType);
    }
    if (filters.targetFolder && filters.targetFolder !== 'all') {
        where.push('targetPageKey LIKE ?');
        params.push(`${filters.targetFolder}%`);
    }
    const query = normalizeText(filters.query).toLowerCase();
    if (query) {
        where.push('(LOWER(sourceUrl) LIKE ? OR LOWER(sourceTitle) LIKE ? OR LOWER(sourceSentence) LIKE ? OR LOWER(targetUrl) LIKE ? OR LOWER(targetTitle) LIKE ? OR LOWER(anchorText) LIKE ?)');
        const term = `%${query}%`;
        params.push(term, term, term, term, term, term);
    }
    const totals = await db.get(`
    SELECT
      COUNT(*) AS opportunities,
      SUM(CASE WHEN status = 'implemented' THEN 1 ELSE 0 END) AS implemented,
      SUM(CASE WHEN priorityScore >= 84 THEN 1 ELSE 0 END) AS highPriority,
      SUM(CASE WHEN confidence != 'low' AND stale = 0 AND status != 'implemented' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN stale = 1 THEN 1 ELSE 0 END) AS stale
    FROM internal_link_opportunities
    WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
  `, [ownerId, siteUrl, latestJob.id]);
    const total = await db.get(`SELECT COUNT(*) AS total FROM internal_link_opportunities WHERE ${where.join(' AND ')}`, params);
    const rows = await db.all(`
    SELECT *
    FROM internal_link_opportunities
    WHERE ${where.join(' AND ')}
    ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 WHEN 'implemented' THEN 3 ELSE 4 END,
      stale ASC, priorityScore DESC, sourceTitle ASC, targetTitle ASC
    LIMIT ? OFFSET ?
  `, [...params, filters.limit, filters.offset]);
    const folderRows = await db.all(`
    SELECT DISTINCT targetPageKey
    FROM internal_link_opportunities
    WHERE ownerId = ? AND siteUrl = ? AND jobId = ?
  `, [ownerId, siteUrl, latestJob.id]);
    const folders = Array.from(new Set(folderRows.map((row) => getFolderKey(row.targetPageKey || '')))).filter(Boolean).sort();
    return {
        job: latestJob,
        meta: {
            folders,
            message: staleMessage || (latestJob.status === 'error' ? latestJob.lastError : latestJob.status === 'queued' || latestJob.status === 'running' ? 'Internal link analysis is running. Recommendations will appear as soon as the job completes.' : null),
            totals: {
                highPriority: toFiniteNumber(totals?.highPriority),
                implemented: toFiniteNumber(totals?.implemented),
                opportunities: toFiniteNumber(totals?.opportunities),
                ready: toFiniteNumber(totals?.ready),
                stale: toFiniteNumber(totals?.stale),
            },
        },
        page: { filteredTotal: toFiniteNumber(total?.total), limit: filters.limit, offset: filters.offset, total: toFiniteNumber(totals?.opportunities) },
        rows: rows.map(hydrateOpportunity),
    };
}
export async function updateInternalLinkOpportunityStatus(db, ownerId, opportunityId, input) {
    const allowed = new Set(['new', 'approved', 'rejected', 'implemented', 'stale']);
    const current = await db.get('SELECT * FROM internal_link_opportunities WHERE id = ? AND ownerId = ?', [opportunityId, ownerId]);
    if (!current)
        throw new Error('Internal link opportunity not found.');
    if (input.status && !allowed.has(input.status)) {
        throw new Error('Invalid internal link opportunity status.');
    }
    const status = input.status || current.status || 'new';
    if ((current.status === 'implemented' || current.annotationId) && status !== 'implemented') {
        throw new Error('Implemented internal link recommendations cannot be moved back to another status.');
    }
    let annotationId = current.annotationId || null;
    let implementedAt = current.implementedAt || null;
    if (status === 'implemented' && !annotationId) {
        annotationId = crypto.randomUUID();
        implementedAt = nowIso();
        await db.run(`
      INSERT INTO annotations (id, userId, siteUrl, date, title, description, type, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            annotationId,
            ownerId,
            current.siteUrl,
            implementedAt.slice(0, 10),
            'Internal link implemented',
            `Added internal link from ${current.sourceUrl} to ${current.targetUrl} using anchor "${current.anchorText}". Reader benefit: ${current.readerBenefit}`,
            'user',
            implementedAt,
        ]);
    }
    await db.run(`
    UPDATE internal_link_opportunities
    SET status = ?, userNote = ?, annotationId = ?, implementedAt = ?, updatedAt = ?
    WHERE id = ? AND ownerId = ?
  `, [status, input.note ?? current.userNote ?? null, annotationId, implementedAt, nowIso(), opportunityId, ownerId]);
    return hydrateOpportunity(await db.get('SELECT * FROM internal_link_opportunities WHERE id = ? AND ownerId = ?', [opportunityId, ownerId]));
}
