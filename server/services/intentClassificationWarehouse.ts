import type { AppDatabase } from '../database.js';
import { classifyQueryIntentDeterministic } from './queryIntentClassifier.js';

export const INTENT_CLASSIFICATION_JOB_TYPE = 'intent-classification-sync';
export const DEFAULT_INTENT_CLASSIFIER_MODEL_VERSION =
  process.env.INTENT_CLASSIFIER_MODEL_VERSION || 'hybrid-v1';

export type WarehouseIntent = 'Navigational' | 'Commercial' | 'Informational' | 'Unclassified';

export type IntentClassificationResult = {
  confidence: number;
  intent: WarehouseIntent;
  query: string;
  reason?: string | null;
};

export type WarehouseIntentClassifier = (input: {
  modelVersion: string;
  ownerId: string;
  queries: string[];
  siteUrl: string;
}) => Promise<IntentClassificationResult[]>;

// Deterministic classification is always available locally. Optional semantic
// providers can replace this adapter, but never need to run in the dashboard.
let configuredClassifier: WarehouseIntentClassifier | null = async ({ queries, siteUrl }) => queries.map((query) => {
  const result = classifyQueryIntentDeterministic(query, siteUrl);
  return { confidence: result.confidence, intent: result.intent, query, reason: result.reason };
});

/**
 * The provider is deliberately injected. The warehouse worker owns lifecycle,
 * batching, and persistence; model selection belongs to the classifier layer.
 */
export function setWarehouseIntentClassifier(provider: WarehouseIntentClassifier | null) {
  configuredClassifier = provider;
}

export function getWarehouseIntentClassifier() {
  return configuredClassifier;
}

export function intentClassifierModelVersion() {
  return DEFAULT_INTENT_CLASSIFIER_MODEL_VERSION;
}

const positiveIntegerEnv = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
};

export const INTENT_CLASSIFICATION_BATCH_SIZE = positiveIntegerEnv(
  process.env.INTENT_CLASSIFICATION_BATCH_SIZE,
  64,
  1,
  256,
);
export const INTENT_CLASSIFICATION_MAX_QUERIES_PER_JOB = positiveIntegerEnv(
  process.env.INTENT_CLASSIFICATION_MAX_QUERIES_PER_JOB,
  5_000,
  1,
  50_000,
);
const RETRY_COUNT = positiveIntegerEnv(process.env.INTENT_CLASSIFICATION_PROVIDER_RETRIES, 2, 0, 4);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeResult(query: string, result?: IntentClassificationResult) {
  const intent: WarehouseIntent = result?.intent && ['Navigational', 'Commercial', 'Informational', 'Unclassified'].includes(result.intent)
    ? result.intent
    : 'Unclassified';
  const confidence = Number.isFinite(Number(result?.confidence))
    ? Math.min(1, Math.max(0, Number(result?.confidence)))
    : 0;
  return {
    confidence,
    intent,
    query,
    reason: result?.reason || null,
  } satisfies IntentClassificationResult;
}

export async function classifyIntentBatch(input: {
  modelVersion: string;
  ownerId: string;
  queries: string[];
  siteUrl: string;
}) {
  const provider = configuredClassifier;
  if (!provider) {
    return input.queries.map((query) => normalizeResult(query, {
      confidence: 0,
      intent: 'Unclassified',
      query,
      reason: 'classifier_provider_unavailable',
    }));
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt += 1) {
    try {
      const results = await provider(input);
      const byQuery = new Map(results.map((result) => [result.query, result]));
      return input.queries.map((query) => normalizeResult(query, byQuery.get(query)));
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_COUNT) await sleep(Math.min(2_000, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Intent classifier provider failed');
}

export async function ensureIntentCacheRows(
  db: AppDatabase,
  input: { modelVersion: string; ownerId: string; queries: string[]; siteUrl: string },
) {
  const now = new Date().toISOString();
  for (const query of input.queries) {
    await db.run(
      `INSERT INTO gsc_query_intent_cache
        (ownerId, siteUrl, query, modelVersion, intent, confidence, reason, status, attemptCount, nextRunAt, lastError, createdAt, updatedAt, classifiedAt)
       VALUES (?, ?, ?, ?, 'Unclassified', 0, NULL, 'pending', 0, ?, NULL, ?, ?, NULL)
       ON CONFLICT(ownerId, siteUrl, query, modelVersion) DO NOTHING`,
      [input.ownerId, input.siteUrl, query, input.modelVersion, now, now, now],
    );
  }
}

export async function persistIntentBatch(
  db: AppDatabase,
  input: { modelVersion: string; ownerId: string; results: IntentClassificationResult[]; siteUrl: string },
) {
  const now = new Date().toISOString();
  for (const result of input.results) {
    await db.run(
      `UPDATE gsc_query_intent_cache
       SET intent = ?, confidence = ?, reason = ?, status = 'completed', attemptCount = attemptCount + 1,
           nextRunAt = NULL, lastError = NULL, updatedAt = ?, classifiedAt = ?
       WHERE ownerId = ? AND siteUrl = ? AND query = ? AND modelVersion = ?`,
      [result.intent, result.confidence, result.reason || null, now, now, input.ownerId, input.siteUrl, result.query, input.modelVersion],
    );
  }
}

export async function markIntentBatchFailure(
  db: AppDatabase,
  input: { error: unknown; modelVersion: string; ownerId: string; queries: string[]; siteUrl: string },
) {
  const now = new Date().toISOString();
  const message = input.error instanceof Error ? input.error.message : 'Intent classifier provider failed';
  for (const query of input.queries) {
    await db.run(
      `UPDATE gsc_query_intent_cache
       SET status = 'retrying', attemptCount = attemptCount + 1, nextRunAt = ?, lastError = ?, updatedAt = ?
       WHERE ownerId = ? AND siteUrl = ? AND query = ? AND modelVersion = ?`,
      [new Date(Date.now() + 60_000).toISOString(), message, now, input.ownerId, input.siteUrl, query, input.modelVersion],
    );
  }
}

export async function runIntentClassificationWarehouseJob(
  db: AppDatabase,
  input: { modelVersion?: string; ownerId: string; siteUrl: string },
) {
  const modelVersion = input.modelVersion || intentClassifierModelVersion();
  const queryRows = await db.all<{ query: string }>(
    `SELECT DISTINCT query
     FROM gsc_query_metrics
     WHERE ownerId = ? AND siteUrl = ? AND query IS NOT NULL AND TRIM(query) <> ''
     ORDER BY query
     LIMIT ?`,
    [input.ownerId, input.siteUrl, INTENT_CLASSIFICATION_MAX_QUERIES_PER_JOB],
  );
  const queries = queryRows.map((row) => row.query.trim()).filter(Boolean);
  if (queries.length === 0) return { modelVersion, processed: 0, skipped: 0 };

  // Do not write placeholder classifications when the model provider is not
  // configured. The next scheduled job will retry once a provider is enabled,
  // rather than permanently caching a misleading Unclassified label.
  if (!configuredClassifier) {
    return { modelVersion, processed: 0, skipped: queries.length, providerUnavailable: true };
  }

  await ensureIntentCacheRows(db, { modelVersion, ownerId: input.ownerId, queries, siteUrl: input.siteUrl });
  const pendingRows = await db.all<{ query: string }>(
    `SELECT query
     FROM gsc_query_intent_cache
     WHERE ownerId = ? AND siteUrl = ? AND modelVersion = ?
       AND status IN ('pending', 'retrying')
       AND (nextRunAt IS NULL OR nextRunAt <= ?)
     ORDER BY updatedAt ASC
     LIMIT ?`,
    [input.ownerId, input.siteUrl, modelVersion, new Date().toISOString(), INTENT_CLASSIFICATION_MAX_QUERIES_PER_JOB],
  );
  const pendingQueries = pendingRows.map((row) => row.query);
  let processed = 0;
  for (let index = 0; index < pendingQueries.length; index += INTENT_CLASSIFICATION_BATCH_SIZE) {
    const batch = pendingQueries.slice(index, index + INTENT_CLASSIFICATION_BATCH_SIZE);
    try {
      const results = await classifyIntentBatch({ modelVersion, ownerId: input.ownerId, queries: batch, siteUrl: input.siteUrl });
      await persistIntentBatch(db, { modelVersion, ownerId: input.ownerId, results, siteUrl: input.siteUrl });
      processed += batch.length;
    } catch (error) {
      await markIntentBatchFailure(db, { error, modelVersion, ownerId: input.ownerId, queries: batch, siteUrl: input.siteUrl });
      throw error;
    }
  }
  return { modelVersion, processed, skipped: Math.max(0, queries.length - pendingQueries.length) };
}
