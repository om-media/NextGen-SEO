/**
 * Query-intent classification used by warehouse jobs and exports.
 *
 * Google Search Console does not return intent.  This module deliberately
 * keeps the fast, deterministic path independent of network/LLM providers and
 * lets callers opt into a best-effort semantic provider for only ambiguous
 * queries.  Providers never block the dashboard: failures and malformed
 * responses fall back to the deterministic result.
 */

export const QUERY_INTENT_RULES_VERSION = 'intent-rules-v3';
export const QUERY_INTENT_EMBEDDING_VERSION = 'intent-embedding-v1';
export const QUERY_INTENT_LLM_VERSION = 'intent-llm-v1';

export type QueryIntent = 'Navigational' | 'Commercial' | 'Informational' | 'Unclassified';
export type QueryIntentSource = 'deterministic' | 'embedding' | 'llm';

export type QueryIntentClassification = {
  intent: QueryIntent;
  confidence: number;
  reason: string;
  modelVersion: string;
  source: QueryIntentSource;
};

export type QueryIntentProviderInput = {
  query: string;
  siteUrl: string;
  deterministic: QueryIntentClassification;
};

/** A provider may return an object or JSON text from a structured-output API. */
export type QueryIntentProvider = (input: QueryIntentProviderInput) => Promise<unknown>;

export type QueryIntentClassifierOptions = {
  providers?: {
    embedding?: QueryIntentProvider;
    llm?: QueryIntentProvider;
  };
  /** Providers below this confidence are ignored. Defaults to 0.75. */
  minProviderConfidence?: number;
  /** Provider calls are best effort and bounded. Defaults to 1500ms. */
  providerTimeoutMs?: number;
};

const COMMERCIAL_SIGNALS = [
  'buy', 'price', 'cheap', 'review', 'reviews', 'compare', 'best', 'top', 'discount', 'coupon', 'order',
  'purchase', 'hire', 'service', 'services', 'cost', 'pricing', 'deal', 'app', 'platform',
  'booking', 'book', 'reserve', 'reservation', 'ticket', 'tickets', 'free', 'cijena',
  'ulaznica', 'ulaznice', 'karte', 'karta', 'biglietti', 'biglietto', 'entradas', 'entrada',
  'billet', 'billets', 'precio', 'prezzo', 'rezervacija', 'rezervacije', 'karten', 'eintritt',
];

const LOCAL_DISCOVERY_SIGNALS = [
  'visit', 'open', 'opening hours', 'hours', 'location', 'directions', 'near', 'nearby',
  'accommodation', 'hotel', 'rental', 'rent', 'tour', 'tours', 'attractions', 'activities',
  'camping', 'adventure park', 'adrenalinski park', 'things to do', 'water park', 'theme park',
];

const INFORMATIONAL_SIGNALS = [
  'how', 'what', 'why', 'when', 'where', 'who', 'guide', 'tutorial', 'tips', 'ideas', 'examples',
  'learn', 'meaning', 'definition', 'can', 'is', 'are', 'does', 'ways', 'benefits', 'history',
  'news', 'kako', 'zasto', 'zašto', 'kada', 'gdje', 'gde', 'radno vrijeme', 'radno vreme',
  'vrijeme', 'vreme', 'weather', 'come arrivare', 'come arrivare a', 'como llegar',
];

const NAVIGATIONAL_SIGNALS = ['login', 'signin', 'sign in', 'sign up', 'contact', 'support', 'dashboard', 'portal'];
const PUBLIC_TLDS = new Set([
  'com', 'net', 'org', 'io', 'co', 'uk', 'de', 'fr', 'es', 'it', 'nl', 'au', 'ca', 'us',
  'shop', 'store', 'online', 'site', 'hr', 'si', 'at', 'ch', 'be', 'eu',
]);

function normalizeText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function getHostname(siteUrl: string) {
  const raw = String(siteUrl || '').trim().replace(/^sc-domain:/i, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return raw.split(/[/?#]/, 1)[0].replace(/^www\./i, '').toLowerCase();
  }
}

function matchesSignal(query: string, signal: string) {
  const normalized = normalizeText(signal);
  if (!normalized) return false;
  return ` ${query} `.includes(` ${normalized} `);
}

function matchedSignals(query: string, signals: string[]) {
  return signals.filter((signal) => matchesSignal(query, signal));
}

function matchesSiteIdentity(query: string, siteUrl: string) {
  const hostname = getHostname(siteUrl);
  const labels = hostname
    .split('.')
    .filter((label) => label && !PUBLIC_TLDS.has(label));
  if (!labels.length) return false;

  const compactQuery = query.replace(/\s+/g, '');
  return labels.some((label) => {
    const candidate = normalizeText(label).replace(/\s+/g, '');
    // Short/generic host names must not turn every query into navigational.
    if (candidate.length < 5) return false;
    return compactQuery.includes(candidate)
      || (candidate.includes(compactQuery) && compactQuery.length >= Math.max(5, Math.ceil(candidate.length * 0.55)));
  });
}

function makeClassification(
  intent: QueryIntent,
  confidence: number,
  reason: string,
  modelVersion = QUERY_INTENT_RULES_VERSION,
  source: QueryIntentSource = 'deterministic',
): QueryIntentClassification {
  return {
    intent,
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(3)))),
    reason: reason.trim().slice(0, 500),
    modelVersion,
    source,
  };
}

/** Fast, network-free classification. Use this on every request/render path. */
export function classifyQueryIntentDeterministic(query: string, siteUrl: string): QueryIntentClassification {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return makeClassification('Unclassified', 0, 'The query is empty.');

  const commercial = matchedSignals(normalizedQuery, [...COMMERCIAL_SIGNALS, ...LOCAL_DISCOVERY_SIGNALS]);
  const informational = matchedSignals(normalizedQuery, INFORMATIONAL_SIGNALS);
  const hasQuestionPunctuation = String(query).includes('?');

  // Explicit action terms are the strongest evidence, even when a brand is present.
  if (commercial.length) {
    return makeClassification(
      'Commercial',
      commercial.some((signal) => COMMERCIAL_SIGNALS.includes(signal)) ? 0.93 : 0.86,
      `Matched ${commercial.slice(0, 2).join(' and ')} ${commercial.length === 1 ? 'signal' : 'signals'}.`,
    );
  }

  if (hasQuestionPunctuation || informational.length) {
    return makeClassification(
      'Informational',
      hasQuestionPunctuation ? 0.9 : 0.86,
      hasQuestionPunctuation ? 'The query is phrased as a question.' : `Matched ${informational.slice(0, 2).join(' and ')} informational signal${informational.length === 1 ? '' : 's'}.`,
    );
  }

  const navigational = matchedSignals(normalizedQuery, NAVIGATIONAL_SIGNALS);
  if (navigational.length) {
    return makeClassification('Navigational', 0.94, `Matched ${navigational[0]} account/navigation signal.`);
  }

  if (matchesSiteIdentity(normalizedQuery, siteUrl)) {
    return makeClassification('Navigational', 0.92, 'The query contains the selected site identity.');
  }

  return makeClassification('Unclassified', 0.35, 'No high-confidence intent signal was found.');
}

/** Label-only compatibility helper for callers that do not need provenance. */
export function classifyIntent(query: string, siteUrl: string): QueryIntent {
  return classifyQueryIntentDeterministic(query, siteUrl).intent;
}

function parseProviderValue(value: unknown, source: QueryIntentSource): QueryIntentClassification | null {
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  const allowedKeys = new Set(['intent', 'confidence', 'reason', 'modelVersion']);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return null;
  if (!['Navigational', 'Commercial', 'Informational', 'Unclassified'].includes(String(record.intent))) return null;
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) return null;
  if (typeof record.reason !== 'string' || !record.reason.trim() || record.reason.length > 500) return null;
  if (record.modelVersion !== undefined && (typeof record.modelVersion !== 'string' || !record.modelVersion.trim() || record.modelVersion.length > 100)) return null;

  return makeClassification(
    record.intent as QueryIntent,
    record.confidence,
    record.reason,
    typeof record.modelVersion === 'string' ? record.modelVersion : source === 'embedding' ? QUERY_INTENT_EMBEDDING_VERSION : QUERY_INTENT_LLM_VERSION,
    source,
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Intent provider timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Best-effort hybrid classification. Providers are consulted only for an
 * ambiguous deterministic result and are always bounded/fail-open.
 */
export async function classifyQueryIntent(
  query: string,
  siteUrl: string,
  options: QueryIntentClassifierOptions = {},
): Promise<QueryIntentClassification> {
  const deterministic = classifyQueryIntentDeterministic(query, siteUrl);
  const providers = options.providers;
  if (!providers || (deterministic.intent !== 'Unclassified' && deterministic.confidence >= 0.86)) return deterministic;

  const minimumConfidence = Math.max(0.5, Math.min(1, options.minProviderConfidence ?? 0.75));
  const timeoutMs = Math.max(100, Math.min(10_000, options.providerTimeoutMs ?? 1_500));
  for (const [source, provider] of [
    ['embedding', providers.embedding],
    ['llm', providers.llm],
  ] as const) {
    if (!provider) continue;
    try {
      const value = await withTimeout(provider({ query, siteUrl, deterministic }), timeoutMs);
      const validated = parseProviderValue(value, source);
      if (validated && validated.confidence >= minimumConfidence && validated.intent !== 'Unclassified') return validated;
    } catch {
      // Provider outages must never make a dashboard request fail.
    }
  }
  return deterministic;
}

/** Structured-output validation is exported for provider adapters and tests. */
export function validateQueryIntentProviderResult(value: unknown, source: QueryIntentSource) {
  return parseProviderValue(value, source);
}
