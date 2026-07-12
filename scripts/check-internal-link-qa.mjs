#!/usr/bin/env node

const CHECKS = [];
const CANCELABLE_JOB_STATUSES = new Set(['queued', 'running']);
const TERMINAL_JOB_STATUSES = new Set(['completed', 'error', 'canceled']);
const LOCAL_PROVIDER = 'local';
const LOCAL_RULES_PROVIDER = 'local-rules';
const FREE_EMBEDDING_PROVIDERS = new Set([LOCAL_PROVIDER, LOCAL_RULES_PROVIDER, 'ollama']);
const FREE_REVIEW_PROVIDERS = new Set([LOCAL_PROVIDER, LOCAL_RULES_PROVIDER, 'ollama']);

function check(name, fn) {
  CHECKS.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
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
function tokenizeAnchor(value) {
  return normalizeText(value).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/[\s-]+/).map((token) => token.trim()).filter((token) => token.length >= 3);
}
function isUsefulAnchorText(anchorText) {
  const tokens = tokenizeAnchor(anchorText);
  if (!tokens.length) return false;
  if (tokens.length === 1 && (tokens[0].length < 8 || GENERIC_SINGLE_ANCHOR_TOKENS.has(tokens[0]))) return false;
  if (tokens.every((token) => GENERIC_SINGLE_ANCHOR_TOKENS.has(token))) return false;
  if (tokens.length <= 2 && tokens.some((token) => WEAK_ANCHOR_HEAD_TERMS.has(token))) return false;
  return true;
}
function isHtmlContentType(value) {
  const contentType = normalizeText(value).toLowerCase();
  if (!contentType) return true;
  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
}
function pageIdentityText(page) {
  return `${page.url || ''} ${page.normalizedUrl || ''} ${page.pageKey || ''}`;
}
function isUtilityPage(page) {
  return UTILITY_PAGE_PATTERN.test(pageIdentityText(page));
}
function isEligibleTargetPage(page) {
  if (toFiniteNumber(page.wordCount) < 120) return false;
  return !HOME_PAGE_KEY_PATTERN.test(page.pageKey || '/') && !isUtilityPage(page);
}
function isEligibleSourcePage(page) {
  return !isUtilityPage(page);
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
  const url = `${page.url || ''} ${page.normalizedUrl || ''} ${page.pageKey || ''}`;
  if (ASSET_URL_PATTERN.test(url)) return false;
  if (ASSET_PATH_PATTERN.test(url)) return false;
  if (!isHtmlContentType(page.contentType)) return false;
  if (toFiniteNumber(page.statusCode) < 200 || toFiniteNumber(page.statusCode) >= 300) return false;
  if (toFiniteNumber(page.noindex)) return false;
  if (isCanonicalizedAway(page)) return false;
  if (toFiniteNumber(page.wordCount) < 20 && !normalizeText(page.title) && !normalizeText(page.h1Text)) return false;
  return true;
}
function scoreBreakdown({ ga4, overlap, semanticSimilarity, source, sourceGsc, target, targetGsc }) {
  const semanticBoost = semanticSimilarity > 0 ? clamp((semanticSimilarity - 0.42) * 58, 0, 24) : 0;
  const targetNeed = clamp((10 - toFiniteNumber(target.inboundLinkCount)) * 4, 0, 36)
    + clamp(toFiniteNumber(targetGsc?.impressions) / 80, 0, 26)
    + (targetGsc?.position && targetGsc.position >= 4 && targetGsc.position <= 20 ? 16 : 0)
    + clamp(toFiniteNumber(ga4?.sessions) / 25, 0, 12);
  const sourceAuthority = clamp(24 - toFiniteNumber(source.depth) * 3, 6, 24)
    + clamp(toFiniteNumber(sourceGsc?.clicks) / 15, 0, 12)
    + clamp(toFiniteNumber(source.inboundLinkCount), 0, 10);
  const tokenOverlap = toFiniteNumber(overlap) * 8;
  const rawTotal = targetNeed + sourceAuthority + tokenOverlap + semanticBoost;

  return {
    components: {
      semanticBoost,
      sourceAuthority,
      targetNeed,
      tokenOverlap,
    },
    rawTotal,
    total: Math.round(clamp(rawTotal, 0, 100)),
  };
}

function resolveEmbeddingRuntime(provider, model) {
  const normalizedProvider = normalizeText(provider || LOCAL_PROVIDER).toLowerCase();
  const normalizedModel = normalizeText(model || 'bge-m3-local');
  if (normalizedProvider === LOCAL_RULES_PROVIDER || normalizedModel === LOCAL_RULES_PROVIDER || normalizedModel.includes('rules')) {
    return { model: 'local-rules', provider: LOCAL_RULES_PROVIDER, semantic: false };
  }
  if (normalizedProvider === LOCAL_PROVIDER) {
    return { model: 'BAAI/bge-m3', provider: normalizedProvider, semantic: true };
  }
  if (normalizedProvider === 'ollama') {
    return { model: normalizedModel === 'bge-m3-local' ? 'bge-m3' : normalizedModel, provider: normalizedProvider, semantic: true };
  }
  return { model: normalizedModel, provider: normalizedProvider, semantic: false };
}

function planEmbeddingCacheMisses(entries, cachedKeys = new Set()) {
  const missing = new Map();
  for (const entry of entries) {
    const key = `${entry.inputType}\u001f${entry.textHash}`;
    if (cachedKeys.has(key)) continue;
    if (!missing.has(key)) missing.set(key, entry);
  }
  return {
    actualEmbeddingTokens: Array.from(missing.values()).reduce((sum, entry) => sum + entry.tokenCount, 0),
    missingCount: missing.size,
  };
}
function estimateAnalysisCost({ charCount, maxPages = 1000, maxRecommendations = 500, maxSentencesPerPage = 50, pageCount, provider, reviewProvider, sentenceCount }) {
  const boundedMaxPages = Math.min(Math.max(Number(maxPages || 1000), 1), 10000);
  const boundedMaxSentencesPerPage = Math.min(Math.max(Number(maxSentencesPerPage || 50), 1), 250);
  const boundedPageCount = Math.min(Number(pageCount || 0), boundedMaxPages);
  const boundedSentenceCount = Math.min(Number(sentenceCount || 0), boundedPageCount * boundedMaxSentencesPerPage);
  const avgChars = boundedSentenceCount > 0 ? Number(charCount || 0) / Math.max(1, Number(sentenceCount || 0)) : 120;
  const estimatedEmbeddingTokens = Math.round(boundedSentenceCount * Math.max(12, avgChars / 4));
  const estimatedReviewTokens = Math.min(Number(maxRecommendations || 500), 1000) * 450;
  const embeddingProvider = normalizeText(provider || LOCAL_PROVIDER).toLowerCase();
  const normalizedReviewProvider = normalizeText(reviewProvider || LOCAL_PROVIDER).toLowerCase();
  const hostedEmbeddings = embeddingProvider && !FREE_EMBEDDING_PROVIDERS.has(embeddingProvider);
  const hostedReview = normalizedReviewProvider && !FREE_REVIEW_PROVIDERS.has(normalizedReviewProvider);
  const estimatedHostedEmbeddingCost = hostedEmbeddings ? (estimatedEmbeddingTokens / 1_000_000) * 0.02 : 0;
  const estimatedHostedReviewCost = hostedReview ? (estimatedReviewTokens / 1_000_000) * 0.2 : 0;

  return {
    estimatedEmbeddingTokens,
    estimatedHostedEmbeddingCost,
    estimatedHostedReviewCost,
    estimatedLocalUnits: boundedSentenceCount,
    estimatedReviewTokens,
    totalHostedCost: estimatedHostedEmbeddingCost + estimatedHostedReviewCost,
  };
}

const REQUIRED_SENTENCE_EXTRACTION_VERSION = 2;

function filterAnalysisSentences(rows, maxSentencesPerPage = 50) {
  const counts = new Map();
  return rows
    .filter((row) => toFiniteNumber(row.extractionVersion) >= REQUIRED_SENTENCE_EXTRACTION_VERSION)
    .filter((row) => {
      const key = row.pageKey || row.pageUrl;
      const count = counts.get(key) || 0;
      if (count >= maxSentencesPerPage) return false;
      counts.set(key, count + 1);
      return normalizeText(row.sentenceText).length >= 55
        && toFiniteNumber(row.linkDensity) <= 0.35
        && toFiniteNumber(row.boilerplateScore) < 0.65;
    });
}
function assertAnalysisCanQueue(estimate) {
  if (toFiniteNumber(estimate.estimatedLocalUnits) <= 0) {
    throw new Error('Recrawl the site to collect sentence-level context before running premium internal link analysis.');
  }
  return true;
}
function assertHostedSpendAllowed(estimate, cap) {
  const total = toFiniteNumber(estimate.estimatedHostedEmbeddingCost) + toFiniteNumber(estimate.estimatedHostedReviewCost);
  if (cap !== null && cap !== undefined && total > cap) {
    throw new Error(`Estimated hosted analysis cost ${total.toFixed(4)} exceeds the max hosted spend cap ${Number(cap).toFixed(4)}.`);
  }
  return true;
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
      return {
        anchorEnd: index + phrase.length,
        anchorStart: index,
        anchorText: text.slice(index, index + phrase.length),
      };
    }
    index = lowerText.indexOf(lowerPhrase, index + 1);
  }
  return null;
}
function integerOffset(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}
function normalizedJudgeConfidence(value, fallback) {
  const confidence = normalizeText(value).toLowerCase();
  return confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : fallback;
}
function applyStructuredJudgeResultModel(rec, result) {
  if (!result || result.accept !== true) return null;
  const sourceSentence = String(rec.sentence.sentenceText || '');
  const judgedSourceSentence = normalizeText(result.sourceSentence);
  if (!judgedSourceSentence || judgedSourceSentence !== normalizeText(sourceSentence)) return null;

  const targetUrl = normalizeText(rec.target.url || rec.target.normalizedUrl);
  if (!targetUrl || normalizeText(result.targetUrl) !== targetUrl) return null;

  const anchorStart = integerOffset(result.anchorStart);
  const anchorEnd = integerOffset(result.anchorEnd);
  if (anchorStart === null || anchorEnd === null || anchorStart < 0 || anchorEnd <= anchorStart || anchorEnd > sourceSentence.length) return null;

  const anchorText = String(result.anchorText || '');
  const exactAnchorText = sourceSentence.slice(anchorStart, anchorEnd);
  if (!anchorText || exactAnchorText !== anchorText) return null;

  const before = anchorStart > 0 ? sourceSentence[anchorStart - 1] : '';
  const after = anchorEnd < sourceSentence.length ? sourceSentence[anchorEnd] : '';
  if ((before && isWordCharacter(before)) || (after && isWordCharacter(after))) return null;

  const readerBenefit = normalizeText(result.readerBenefit || rec.readerBenefit);
  if (!readerBenefit || readerBenefit.length < 45 || !isUsefulAnchorText(exactAnchorText)) return null;

  return {
    ...rec,
    anchor: { anchorText: exactAnchorText, anchorStart, anchorEnd },
    confidence: normalizedJudgeConfidence(result.confidence, rec.confidence),
    readerBenefit,
  };
}
function exportRows(rows) {
  const headers = [
    'Status',
    'Source URL',
    'Source Title',
    'Source Sentence',
    'Anchor Text',
    'Target URL',
    'Target Title',
    'Reader Benefit',
    'User Note',
    'Confidence',
    'Priority Score',
  ];
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = rows.map((row) => [
    row.status,
    row.source.url,
    row.source.title || '',
    row.source.sentence,
    row.anchorText,
    row.target.url,
    row.target.title || '',
    row.readerBenefit,
    row.userNote || '',
    row.confidence,
    row.priorityScore,
  ]);
  return [headers, ...body].map((line) => line.map(escape).join(',')).join('\n');
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

function recommendationKey(row) {
  return [
    row.ownerId,
    row.siteUrl,
    row.crawlJobId,
    row.sourcePageKey,
    row.targetPageKey,
    row.anchorText,
  ].join('\u001f');
}

function buildRecommendations({ existingLinks, recommendations }) {
  const existing = new Set(existingLinks.map((link) => `${link.fromPageKey}=>${link.toPageKey}`));
  const table = new Map();

  for (const rec of recommendations) {
    if (rec.sourcePageKey === rec.targetPageKey) continue;
    if (existing.has(`${rec.sourcePageKey}=>${rec.targetPageKey}`)) continue;

    const key = recommendationKey(rec);
    const current = table.get(key);
    table.set(key, {
      ...current,
      ...rec,
      id: current?.id || rec.id,
      status: current?.status || 'new',
      updatedAt: rec.updatedAt,
    });
  }

  return Array.from(table.values());
}

function createOpportunityList(rows) {
  return rows.map((row) => ({ ...row }));
}

function markStaleForNewerCrawl({ latestCrawlId, latestJob, opportunities }) {
  if (!latestCrawlId || latestCrawlId === latestJob.crawlJobId) {
    return { message: null, rows: createOpportunityList(opportunities) };
  }

  return {
    message: 'A newer crawl is available. Existing recommendations were marked stale; rerun analysis for fresh source sentences and link gaps.',
    rows: opportunities.map((row) => row.jobId === latestJob.id && !row.stale
      ? {
          ...row,
          stale: true,
          status: row.status === 'implemented' ? row.status : 'stale',
        }
      : { ...row }),
  };
}

function markOlderCrawlOpportunitiesStale({ currentCrawlJobId, opportunities }) {
  return opportunities.map((row) => row.crawlJobId !== currentCrawlJobId && !row.stale
    ? {
        ...row,
        stale: true,
        status: row.status === 'implemented' ? row.status : 'stale',
      }
    : { ...row });
}

function opportunityTotals(rows) {
  return rows.reduce((totals, row) => {
    totals.opportunities += 1;
    if (row.status === 'implemented') totals.implemented += 1;
    if (row.priorityScore >= 84) totals.highPriority += 1;
    if (row.confidence !== 'low' && !row.stale && row.status !== 'implemented') totals.ready += 1;
    if (row.stale) totals.stale += 1;
    return totals;
  }, { highPriority: 0, implemented: 0, opportunities: 0, ready: 0, stale: 0 });
}

function canCancelJob(status) {
  return CANCELABLE_JOB_STATUSES.has(status);
}

function canRerunJob(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

function cancelJob(job) {
  if (!canCancelJob(job.status)) {
    return {
      error: `Cannot cancel an internal link analysis job with status "${job.status}".`,
      job,
    };
  }
  return {
    job: {
      ...job,
      completedAt: '2026-06-30T10:05:00.000Z',
      lastError: 'Canceled by user.',
      status: 'canceled',
      updatedAt: '2026-06-30T10:05:00.000Z',
    },
    success: true,
  };
}

function rerunJob({ activeJobs = [], job }) {
  if (!canRerunJob(job.status)) {
    return {
      error: `Cannot rerun an internal link analysis job with status "${job.status}".`,
      job,
    };
  }

  const activeJob = activeJobs.find((candidate) => candidate.siteUrl === job.siteUrl && canCancelJob(candidate.status));
  if (activeJob) {
    return {
      error: 'An internal link analysis is already queued or running for this site.',
      job: activeJob,
    };
  }

  return {
    job: {
      ...job,
      id: `${job.id}-rerun`,
      progressCompleted: 0,
      status: 'queued',
    },
    success: true,
  };
}
function createAnnotationModel() {
  let sequence = 0;
  const annotations = [];
  const opportunities = new Map();

  return {
    annotations,
    addOpportunity(row) {
      opportunities.set(row.id, { ...row });
    },
    updateStatus(opportunityId, input) {
      const current = opportunities.get(opportunityId);
      assert(current, 'Opportunity exists before status update');

      const allowed = new Set(['new', 'approved', 'rejected', 'implemented', 'stale']);
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
        sequence += 1;
        annotationId = `annotation-${sequence}`;
        implementedAt = `2026-06-30T10:00:0${sequence}.000Z`;
        annotations.push({
          id: annotationId,
          siteUrl: current.siteUrl,
          title: 'Internal link implemented',
          type: 'user',
        });
      }

      const next = {
        ...current,
        annotationId,
        implementedAt,
        status,
        userNote: input.note ?? current.userNote ?? null,
      };
      opportunities.set(opportunityId, next);
      return next;
    },
  };
}

check('score breakdown persistence semantics', () => {
  const fixture = {
    ga4: { sessions: 125 },
    overlap: 2,
    semanticSimilarity: 0.6,
    source: { depth: 2, inboundLinkCount: 4 },
    sourceGsc: { clicks: 45 },
    target: { inboundLinkCount: 3 },
    targetGsc: { impressions: 960, position: 8 },
  };

  const breakdown = scoreBreakdown(fixture);
  const componentTotal = breakdown.components.targetNeed
    + breakdown.components.sourceAuthority
    + breakdown.components.tokenOverlap
    + breakdown.components.semanticBoost;
  assertEqual(breakdown.components.targetNeed, 61, 'Target need combines link scarcity, demand, striking-distance, and GA4 demand');
  assertEqual(breakdown.components.sourceAuthority, 25, 'Source authority combines crawl depth, source clicks, and inbound links');
  assertEqual(breakdown.components.tokenOverlap, 16, 'Token overlap contributes 8 points per shared token');
  assertEqual(breakdown.components.semanticBoost, 10.44, 'Semantic boost is deterministic before total rounding');
  assertEqual(breakdown.rawTotal, componentTotal, 'Score components sum exactly to raw total');
  assertEqual(breakdown.total, 100, 'Priority score clamps the rounded component sum to 100');

  const upperClamp = scoreBreakdown({ ...fixture, overlap: 12, semanticSimilarity: 0.95 });
  assert(upperClamp.rawTotal > 100, 'Upper clamp fixture exceeds the score ceiling before clamping');
  assertEqual(upperClamp.total, 100, 'Priority score upper-clamps to 100');

  const lowerClamp = scoreBreakdown({
    ga4: { sessions: 0 },
    overlap: -3,
    semanticSimilarity: 0,
    source: { depth: 20, inboundLinkCount: 0 },
    sourceGsc: { clicks: 0 },
    target: { inboundLinkCount: 40 },
    targetGsc: { impressions: 0, position: 1 },
  });
  assert(lowerClamp.rawTotal < 0, 'Lower clamp fixture drops below the score floor before clamping');
  assertEqual(lowerClamp.total, 0, 'Priority score lower-clamps to 0');

  const persisted = {
    anchorEnd: 36,
    anchorStart: 18,
    confidence: 'high',
    paragraphIndex: 4,
    priorityScore: breakdown.total,
    scoreBreakdown: breakdown,
    sentenceIndex: 2,
    userNote: 'Use after launch, not before. Owner: SEO\nCMS ticket: IL-42',
  };
  const roundTrip = JSON.parse(JSON.stringify(persisted));
  assertEqual(roundTrip.priorityScore, 100, 'Persisted JSON round-trip preserves priorityScore as a number');
  assertEqual(roundTrip.anchorStart, 18, 'Persisted JSON round-trip preserves anchorStart as a number');
  assertEqual(roundTrip.anchorEnd, 36, 'Persisted JSON round-trip preserves anchorEnd as a number');
  assertEqual(roundTrip.paragraphIndex, 4, 'Persisted JSON round-trip preserves paragraphIndex as a number');
  assertEqual(roundTrip.sentenceIndex, 2, 'Persisted JSON round-trip preserves sentenceIndex as a number');
  assertEqual(roundTrip.scoreBreakdown.total, 100, 'Persisted JSON round-trip preserves score breakdown numeric total');
  assertEqual(typeof roundTrip.userNote, 'string', 'Persisted user note remains an export-safe string');
});
check('bge-m3 provider resolution semantics', () => {
  const local = resolveEmbeddingRuntime('local', 'bge-m3-local');
  assertEqual(local.semantic, true, 'Default local provider now runs semantic embeddings');
  assertEqual(local.model, 'BAAI/bge-m3', 'Default local provider maps to the built-in BAAI BGE-M3 worker');

  const rules = resolveEmbeddingRuntime('local-rules', 'local-rules');
  assertEqual(rules.semantic, false, 'Local rules remains the explicit lexical fallback');
  assertEqual(rules.provider, 'local-rules', 'Rules fallback has a distinct provider key');
});
check('embedding cache miss planning semantics', () => {
  const entries = [
    { inputType: 'target', textHash: 'target-a', tokenCount: 12 },
    { inputType: 'sentence', textHash: 'sentence-a', tokenCount: 18 },
    { inputType: 'sentence', textHash: 'sentence-a', tokenCount: 18 },
    { inputType: 'sentence', textHash: 'sentence-b', tokenCount: 9 },
  ];
  const cached = new Set(['target\u001ftarget-a']);
  const plan = planEmbeddingCacheMisses(entries, cached);
  assertEqual(plan.missingCount, 2, 'Cache misses dedupe duplicate sentence hashes and skip cached targets');
  assertEqual(plan.actualEmbeddingTokens, 27, 'Actual embedding token usage counts only uncached unique inputs');
});
check('analysis estimate provider cost semantics', () => {
  const fixture = {
    charCount: 120_000,
    maxRecommendations: 80,
    pageCount: 20,
    reviewProvider: 'local',
    sentenceCount: 600,
  };

  const local = estimateAnalysisCost({ ...fixture, provider: 'local' });
  assertEqual(local.estimatedEmbeddingTokens, 30000, 'Fixture produces a deterministic embedding token estimate');
  assertEqual(local.estimatedHostedEmbeddingCost, 0, 'Local embeddings have zero hosted embedding cost');
  assertEqual(local.estimatedHostedReviewCost, 0, 'Local review provider has zero hosted review cost');
  assertEqual(local.totalHostedCost, 0, 'All-local analysis has zero total hosted cost');

  const localRules = estimateAnalysisCost({ ...fixture, provider: 'local-rules' });
  assertEqual(localRules.estimatedHostedEmbeddingCost, 0, 'Explicit local-rules fallback has zero hosted embedding cost');

  const ollama = estimateAnalysisCost({ ...fixture, provider: 'ollama' });
  assertEqual(ollama.estimatedHostedEmbeddingCost, 0, 'Ollama embeddings have zero hosted embedding cost');
  assertEqual(ollama.estimatedHostedReviewCost, 0, 'Ollama embeddings with local review keep review cost at zero');

  const hosted = estimateAnalysisCost({ ...fixture, provider: 'openai' });
  assert(hosted.estimatedHostedEmbeddingCost > 0, 'Hosted embedding providers estimate a positive hosted embedding cost');
  assertEqual(hosted.estimatedHostedReviewCost, 0, 'Hosted embedding provider does not add review cost when review stays local');
  assertEqual(hosted.totalHostedCost, hosted.estimatedHostedEmbeddingCost, 'Hosted total reflects embedding-only cost when review is local');

  const ollamaReview = estimateAnalysisCost({ ...fixture, provider: 'local', reviewProvider: 'ollama' });
  assertEqual(ollamaReview.estimatedHostedReviewCost, 0, 'Ollama review judge has zero hosted review cost');

  const hostedReview = estimateAnalysisCost({ ...fixture, provider: 'local', reviewProvider: 'openai' });
  assertEqual(hostedReview.estimatedHostedEmbeddingCost, 0, 'Local embeddings remain free when review is hosted');
  assert(hostedReview.estimatedHostedReviewCost > 0, 'Hosted review providers estimate a positive hosted review cost');
});
check('no-crawl estimate fallback semantics', () => {
  const estimate = {
    crawlJobId: '',
    estimatedEmbeddingTokens: 0,
    estimatedHostedEmbeddingCost: 0,
    estimatedHostedReviewCost: 0,
    estimatedLocalUnits: 0,
    estimatedReviewTokens: 0,
    totalHostedCost: 0,
  };

  assertEqual(estimate.crawlJobId, '', 'No-crawl estimate returns an empty crawlJobId instead of throwing');
  assertEqual(estimate.estimatedLocalUnits, 0, 'No-crawl estimate reports zero local sentence workload');
  assertEqual(estimate.totalHostedCost, 0, 'No-crawl estimate reports zero hosted cost');
});check('asset target exclusion semantics', () => {
  const pages = [
    { contentType: 'image/jpeg', h1Text: null, noindex: 0, normalizedUrl: 'https://example.com/photo.jpg', pageKey: '/photo.jpg', statusCode: 200, title: null, url: 'https://example.com/photo.jpg', wordCount: 0 },
    { contentType: 'application/pdf', h1Text: null, noindex: 0, normalizedUrl: 'https://example.com/menu.pdf', pageKey: '/menu.pdf', statusCode: 200, title: null, url: 'https://example.com/menu.pdf', wordCount: 0 },
    { contentType: 'text/html; charset=utf-8', h1Text: 'Upload Attachment', noindex: 0, normalizedUrl: 'https://example.com/wp-content/uploads/photo', pageKey: '/wp-content/uploads/photo', statusCode: 200, title: 'Upload Attachment', url: 'https://example.com/wp-content/uploads/photo', wordCount: 200 },
    { contentType: 'text/html; charset=utf-8', h1Text: 'Internal Linking Guide', noindex: 0, normalizedUrl: 'https://example.com/internal-links/', pageKey: '/internal-links', statusCode: 200, title: 'Internal Linking Guide', url: 'https://example.com/internal-links/', wordCount: 850 },
    { canonicalUrl: 'https://example.com/canonical-target/', contentType: 'text/html', h1Text: 'Canonical Duplicate', noindex: 0, normalizedUrl: 'https://example.com/duplicate/', pageKey: '/duplicate', statusCode: 200, title: 'Canonical Duplicate', url: 'https://example.com/duplicate/', wordCount: 800 },
    { contentType: 'text/html', h1Text: 'Noindex Page', noindex: 1, normalizedUrl: 'https://example.com/noindex/', pageKey: '/noindex', statusCode: 200, title: 'Noindex Page', url: 'https://example.com/noindex/', wordCount: 500 },
  ];

  const eligible = pages.filter(isIndexableContentPage);
  assertEqual(eligible.length, 1, 'Only HTML indexable content pages are eligible as internal-link sources or targets');
  assertEqual(eligible[0].pageKey, '/internal-links', 'Asset files and noindex pages are excluded from internal-link analysis');
});
check('generic single-word anchor exclusion semantics', () => {
  assertEqual(isUsefulAnchorText('Avanterra'), false, 'Brand-only one-word anchors are rejected as too generic for contextual recommendations');
  assertEqual(isUsefulAnchorText('Parcours'), false, 'Generic one-word category anchors are rejected');
  assertEqual(isUsefulAnchorText('Avanterra Park'), false, 'Brand plus generic noun anchors are rejected');
  assertEqual(isUsefulAnchorText('adventure park'), false, 'Generic category phrase anchors are rejected');
  assertEqual(isUsefulAnchorText('SEO services'), false, 'Weak head-term phrases are rejected even when they contain a topical modifier');
  assertEqual(isUsefulAnchorText('pricing information'), false, 'Information-style anchors are rejected as weak editorial anchors');
  assertEqual(isUsefulAnchorText('team building course'), true, 'Specific multi-word anchors remain eligible');
  assertEqual(isUsefulAnchorText('zipline adventure'), true, 'Specific two-word anchors remain eligible');
});
check('editorial page eligibility semantics', () => {
  const homepage = { pageKey: '/', normalizedUrl: 'https://example.com/', url: 'https://example.com/' };
  const localizedHomepage = { pageKey: '/de/startseite', normalizedUrl: 'https://example.com/de/startseite', url: 'https://example.com/de/startseite' };
  const privacy = { pageKey: '/en/privacy-policy', normalizedUrl: 'https://example.com/en/privacy-policy', url: 'https://example.com/en/privacy-policy' };
  const guide = { pageKey: '/guides/internal-links', normalizedUrl: 'https://example.com/guides/internal-links', url: 'https://example.com/guides/internal-links', wordCount: 850 };

  assertEqual(isEligibleTargetPage(homepage), false, 'Homepage is excluded as a default contextual internal-link target');
  assertEqual(isEligibleTargetPage(localizedHomepage), false, 'Localized homepage aliases are excluded as contextual internal-link targets');
  assertEqual(isEligibleSourcePage(privacy), false, 'Legal/privacy pages are excluded as contextual source pages');
  assertEqual(isEligibleTargetPage(privacy), false, 'Legal/privacy pages are excluded as contextual target pages');
  assertEqual(isEligibleSourcePage(guide), true, 'Editorial guide pages remain eligible sources');
  assertEqual(isEligibleTargetPage(guide), true, 'Editorial guide pages remain eligible targets');
});
check('source anchor dedupe semantics', () => {
  const recommendations = [
    { sourcePageKey: '/source', targetPageKey: '/target-a', paragraphIndex: 1, sentenceIndex: 2, anchorText: 'Lila Parcours', priorityScore: 100 },
    { sourcePageKey: '/source', targetPageKey: '/target-b', paragraphIndex: 1, sentenceIndex: 9, anchorText: 'Lila Parcours', priorityScore: 95 },
    { sourcePageKey: '/source', targetPageKey: '/target-c', paragraphIndex: 1, sentenceIndex: 3, anchorText: 'Purple trail', priorityScore: 90 },
  ];
  const usedSourceAnchor = new Set();
  const accepted = recommendations.filter((rec) => {
    const key = `${rec.sourcePageKey}:${normalizeText(rec.anchorText).toLowerCase()}`;
    if (usedSourceAnchor.has(key)) return false;
    usedSourceAnchor.add(key);
    return true;
  });

  assertEqual(accepted.length, 2, 'Only one target can win for the same source page and anchor text');
  assertEqual(accepted[0].targetPageKey, '/target-a', 'The highest-ranked duplicate source anchor is retained');
});
check('sentence extraction quality gate semantics', () => {
  const rows = [
    { boilerplateScore: 0.1, extractionVersion: 2, linkDensity: 0.05, pageKey: '/good/', sentenceText: 'This article sentence has enough useful body copy to become a contextual internal link source.' },
    { boilerplateScore: 0.1, extractionVersion: 1, linkDensity: 0.05, pageKey: '/old/', sentenceText: 'Old extraction rows should prompt a recrawl before recommendations are generated.' },
    { boilerplateScore: 0.7, extractionVersion: 2, linkDensity: 0.05, pageKey: '/footer/', sentenceText: 'Footer and sidebar style text should not be used for contextual internal link recommendations.' },
    { boilerplateScore: 0.1, extractionVersion: 2, linkDensity: 0.55, pageKey: '/toc/', sentenceText: 'A link-heavy paragraph is usually navigation or a table of contents rather than editorial copy.' },
  ];
  const filtered = filterAnalysisSentences(rows);
  assertEqual(filtered.length, 1, 'Only current, body-like sentence rows survive extraction quality gates');
  assertEqual(filtered[0].pageKey, '/good/', 'The accepted sentence is the useful article-body row');
});
check('zero usable sentence analysis queue guard', () => {
  assertEqual(assertAnalysisCanQueue({ estimatedLocalUnits: 12 }), true, 'Analysis can queue when usable sentences exist');
  let message = '';
  try {
    assertAnalysisCanQueue({ estimatedLocalUnits: 0 });
  } catch (error) {
    message = error.message;
  }
  assert(message.includes('Recrawl the site'), 'Analysis queue rejects runs with zero usable sentences');
});
check('hosted spend cap semantics', () => {
  const estimate = {
    estimatedHostedEmbeddingCost: 0.02,
    estimatedHostedReviewCost: 0.03,
  };
  assertEqual(assertHostedSpendAllowed(estimate, 0.05), true, 'Spend cap allows estimates equal to the cap');

  let message = '';
  try {
    assertHostedSpendAllowed(estimate, 0.01);
  } catch (error) {
    message = error.message;
  }
  assert(message.includes('exceeds the max hosted spend cap'), 'Spend cap rejects estimates above the cap');
});
check('anchor offset exactness', () => {
  const sentence = 'Before launch, compare Enterprise SEO Platforms against analytics needs.';
  const span = findCaseInsensitiveSpan(sentence, 'enterprise seo platforms');

  assert(span, 'Case-insensitive anchor phrase is found');
  assertEqual(span.anchorStart, 23, 'Anchor start points at the exact sentence offset');
  assertEqual(span.anchorEnd, 47, 'Anchor end points just after the anchor');
  assertEqual(span.anchorText, 'Enterprise SEO Platforms', 'Anchor text preserves source casing');
  assertEqual(sentence.slice(span.anchorStart, span.anchorEnd), span.anchorText, 'Stored offsets slice back to stored anchor text');

  const repeated = 'Audit links before the audit template is shared.';
  const repeatedSpan = findCaseInsensitiveSpan(repeated, 'audit');
  assertEqual(repeatedSpan.anchorStart, 0, 'First matching anchor occurrence is selected deterministically');
  assertEqual(repeated.slice(repeatedSpan.anchorStart, repeatedSpan.anchorEnd), 'Audit', 'First occurrence offset remains exact');

  assertEqual(findCaseInsensitiveSpan(sentence, 'missing phrase'), null, 'Missing anchors return null');
  assertEqual(findCaseInsensitiveSpan('Ljubičasta staza is a separate trail.', 'asta staza'), null, 'Anchor matching rejects partial-word Unicode spans');
  const unicodeSpan = findCaseInsensitiveSpan('Ljubičasta staza is a separate trail.', 'Ljubičasta staza');
  assert(unicodeSpan, 'Unicode full-word anchor phrase is found');
});

check('structured judge output gate semantics', () => {
  const sentence = 'Readers comparing technical SEO audits for JavaScript websites need crawl evidence before choosing tooling.';
  const anchorText = 'technical SEO audits for JavaScript websites';
  const anchorStart = sentence.indexOf(anchorText);
  const anchorEnd = anchorStart + anchorText.length;
  const rec = {
    anchor: { anchorEnd, anchorStart, anchorText },
    confidence: 'medium',
    readerBenefit: 'A reader comparing audit options gets a focused guide that explains how JavaScript crawl evidence changes the tooling decision.',
    sentence: { sentenceText: sentence },
    target: { normalizedUrl: 'https://example.com/javascript-seo-audits/', url: 'https://example.com/javascript-seo-audits/' },
  };
  const accepted = applyStructuredJudgeResultModel(rec, {
    accept: true,
    anchorEnd,
    anchorStart,
    anchorText,
    confidence: 'high',
    readerBenefit: 'A reader comparing audit options gets a focused guide that explains how JavaScript crawl evidence changes the tooling decision.',
    sourceSentence: sentence,
    targetUrl: 'https://example.com/javascript-seo-audits/',
  });

  assert(accepted, 'Well-formed judge output is accepted');
  assertEqual(accepted.anchor.anchorText, anchorText, 'Accepted judge anchor uses the exact source-sentence slice');
  assertEqual(accepted.anchor.anchorStart, anchorStart, 'Accepted judge anchorStart is preserved');
  assertEqual(accepted.anchor.anchorEnd, anchorEnd, 'Accepted judge anchorEnd is preserved');
  assertEqual(accepted.confidence, 'high', 'Accepted judge confidence is normalized from structured output');

  assertEqual(applyStructuredJudgeResultModel(rec, { ...accepted, accept: true, anchorStart: anchorStart + 1, sourceSentence: sentence, targetUrl: rec.target.url }), null, 'Judge output with shifted offsets is rejected');
  assertEqual(applyStructuredJudgeResultModel(rec, { ...accepted, accept: true, anchorText: 'technical seo audits for javascript websites', sourceSentence: sentence, targetUrl: rec.target.url }), null, 'Judge output must return the exact source casing and text slice');
  assertEqual(applyStructuredJudgeResultModel(rec, { ...accepted, accept: true, sourceSentence: 'Different sentence', targetUrl: rec.target.url }), null, 'Judge output for a different source sentence is rejected');
  assertEqual(applyStructuredJudgeResultModel(rec, { ...accepted, accept: true, sourceSentence: sentence, targetUrl: 'https://example.com/wrong/' }), null, 'Judge output for a different target URL is rejected');
  assertEqual(applyStructuredJudgeResultModel(rec, { ...accepted, accept: true, anchorStart: 11, anchorEnd: 20, anchorText: sentence.slice(11, 20), sourceSentence: sentence, targetUrl: rec.target.url }), null, 'Judge output cannot select a partial-word anchor span');
});
check('export-safe row shape', () => {
  const row = {
    anchorEnd: 19,
    anchorStart: 5,
    anchorText: 'internal links',
    confidence: 'high',
    priorityScore: 91,
    readerBenefit: 'Shows the reader a focused next step, with context.',
    userNote: 'Reviewed by SEO, ready for CMS. Owner: Ana',
    source: {
      pageKey: '/guides/',
      sentence: 'Use "internal links", carefully, when expanding a topic.\nKeep context tight.',
      title: null,
      url: 'https://example.com/guides/',
    },
    status: 'approved',
    target: {
      folder: '/seo/',
      pageKey: '/seo/internal-links/',
      title: 'Internal Links "Checklist"',
      url: 'https://example.com/seo/internal-links/',
    },
  };

  assertEqual(row.source.sentence.slice(row.anchorStart, row.anchorEnd), row.anchorText, 'Export fixture offsets match the nested source sentence');

  const csv = exportRows([row]);
  const lines = csv.split('\n');
  assertEqual(lines.length, 3, 'Embedded newline is retained inside one escaped CSV cell');

  const headers = parseCsvLine(lines[0]);
  const values = parseCsvLine(`${lines[1]}\n${lines[2]}`);
  assertEqual(headers.length, 11, 'CSV has the expected header width');
  assertEqual(values.length, 11, 'CSV row has the expected value width');
  assertEqual(values[2], '', 'Null source title exports as an empty cell');
  assertEqual(values[3], row.source.sentence, 'Source sentence exports as text, including embedded newline');
  assertEqual(values[6], row.target.title, 'Quotes in target title round-trip through CSV escaping');
  assertEqual(values[8], row.userNote, 'User note exports as text with CSV escaping');
  assertEqual(values[10], '91', 'Priority score exports as a scalar value');
  assert(!csv.includes('[object Object]'), 'Nested source and target objects are never exported directly');
});

check('duplicate suppression semantics', () => {
  const recommendations = [
    {
      anchorText: 'technical seo',
      crawlJobId: 'crawl-1',
      id: 'new-row',
      ownerId: 'owner-1',
      priorityScore: 70,
      siteUrl: 'https://example.com',
      sourcePageKey: '/blog/a/',
      targetPageKey: '/seo/technical/',
      updatedAt: '2026-06-30T10:00:00.000Z',
    },
    {
      anchorText: 'technical seo',
      crawlJobId: 'crawl-1',
      id: 'duplicate-row',
      ownerId: 'owner-1',
      priorityScore: 88,
      siteUrl: 'https://example.com',
      sourcePageKey: '/blog/a/',
      targetPageKey: '/seo/technical/',
      updatedAt: '2026-06-30T10:01:00.000Z',
    },
    {
      anchorText: 'seo audit',
      crawlJobId: 'crawl-1',
      id: 'different-anchor',
      ownerId: 'owner-1',
      priorityScore: 81,
      siteUrl: 'https://example.com',
      sourcePageKey: '/blog/a/',
      targetPageKey: '/seo/technical/',
      updatedAt: '2026-06-30T10:02:00.000Z',
    },
    {
      anchorText: 'analytics',
      crawlJobId: 'crawl-1',
      id: 'existing-link',
      ownerId: 'owner-1',
      priorityScore: 95,
      siteUrl: 'https://example.com',
      sourcePageKey: '/blog/b/',
      targetPageKey: '/seo/analytics/',
      updatedAt: '2026-06-30T10:03:00.000Z',
    },
  ];

  const rows = buildRecommendations({
    existingLinks: [{ fromPageKey: '/blog/b/', toPageKey: '/seo/analytics/' }],
    recommendations,
  });

  assertEqual(rows.length, 2, 'Existing links are suppressed and conflict-key duplicates collapse');
  assert(rows.every((row) => row.id !== 'existing-link'), 'Recommendations for already-linked source-target pairs are suppressed');

  const merged = rows.find((row) => row.anchorText === 'technical seo');
  assert(merged, 'Duplicate recommendation leaves one row');
  assertEqual(merged.id, 'new-row', 'Conflict update keeps the original row identity');
  assertEqual(merged.priorityScore, 88, 'Conflict update refreshes mutable recommendation fields');

  assert(rows.some((row) => row.anchorText === 'seo audit'), 'Different anchor text for the same source-target pair remains distinct');
});

check('annotation idempotency semantics', () => {
  const model = createAnnotationModel();
  model.addOpportunity({
    annotationId: null,
    id: 'opp-1',
    implementedAt: null,
    siteUrl: 'https://example.com',
    status: 'approved',
    userNote: null,
  });

  let invalidRejected = false;
  try {
    model.updateStatus('opp-1', { status: 'not-real' });
  } catch {
    invalidRejected = true;
  }
  assertEqual(invalidRejected, true, 'Unknown opportunity statuses are rejected instead of silently ignored');

  const first = model.updateStatus('opp-1', { note: 'Published in CMS', status: 'implemented' });
  assertEqual(model.annotations.length, 1, 'First implemented transition creates one annotation');
  assertEqual(first.annotationId, 'annotation-1', 'Implemented opportunity stores the created annotation id');
  assert(first.implementedAt, 'Implemented opportunity stores implementedAt');
  assertEqual(first.userNote, 'Published in CMS', 'Status update stores the supplied note');

  const second = model.updateStatus('opp-1', { status: 'implemented' });
  assertEqual(model.annotations.length, 1, 'Repeated implemented updates do not create another annotation');
  assertEqual(second.annotationId, first.annotationId, 'Repeated implemented updates keep the same annotation id');
  assertEqual(second.implementedAt, first.implementedAt, 'Repeated implemented updates keep the original implementedAt');
  assertEqual(second.userNote, first.userNote, 'Omitted notes keep the existing note');

  let rollbackRejected = false;
  try {
    model.updateStatus('opp-1', { status: 'rejected' });
  } catch {
    rollbackRejected = true;
  }
  assertEqual(rollbackRejected, true, 'Implemented opportunities cannot move back to another status');
});
check('stale detection semantics', () => {
  const latestJob = { crawlJobId: 'crawl-1', id: 'job-1' };
  const opportunities = [
    {
      confidence: 'high',
      crawlJobId: 'crawl-1',
      id: 'new-row',
      jobId: 'job-1',
      priorityScore: 90,
      stale: false,
      status: 'new',
    },
    {
      confidence: 'medium',
      crawlJobId: 'crawl-1',
      id: 'implemented-row',
      jobId: 'job-1',
      priorityScore: 70,
      stale: false,
      status: 'implemented',
    },
    {
      confidence: 'medium',
      crawlJobId: 'crawl-1',
      id: 'rejected-row',
      jobId: 'job-1',
      priorityScore: 72,
      stale: true,
      status: 'stale',
    },
  ];

  const unchanged = markStaleForNewerCrawl({ latestCrawlId: 'crawl-1', latestJob, opportunities });
  assertEqual(unchanged.message, null, 'Matching latest crawl does not emit a stale warning');
  assertEqual(unchanged.rows.filter((row) => row.stale).length, 1, 'Matching latest crawl does not mark fresh rows stale');

  const changed = markStaleForNewerCrawl({ latestCrawlId: 'crawl-2', latestJob, opportunities });
  assert(changed.message?.includes('newer crawl'), 'Newer crawl emits a stale warning');

  const staleNew = changed.rows.find((row) => row.id === 'new-row');
  assertEqual(staleNew.stale, true, 'Fresh non-implemented recommendations become stale');
  assertEqual(staleNew.status, 'stale', 'Fresh non-implemented recommendations move to stale status');

  const staleImplemented = changed.rows.find((row) => row.id === 'implemented-row');
  assertEqual(staleImplemented.stale, true, 'Implemented recommendations are still flagged stale');
  assertEqual(staleImplemented.status, 'implemented', 'Implemented status is preserved when stale');

  const totals = opportunityTotals(changed.rows);
  assertDeepEqual(totals, { highPriority: 1, implemented: 1, opportunities: 3, ready: 0, stale: 3 }, 'Stale totals count all stale rows and exclude them from ready');
});

check('stale marking across crawl generations', () => {
  const rows = markOlderCrawlOpportunitiesStale({
    currentCrawlJobId: 'crawl-2',
    opportunities: [
      { crawlJobId: 'crawl-1', id: 'old-approved', stale: false, status: 'approved' },
      { crawlJobId: 'crawl-1', id: 'old-implemented', stale: false, status: 'implemented' },
      { crawlJobId: 'crawl-2', id: 'current-new', stale: false, status: 'new' },
      { crawlJobId: 'crawl-0', id: 'already-stale', stale: true, status: 'stale' },
    ],
  });

  assertEqual(rows.find((row) => row.id === 'old-approved').status, 'stale', 'Older non-implemented opportunities move to stale');
  assertEqual(rows.find((row) => row.id === 'old-approved').stale, true, 'Older non-implemented opportunities are flagged stale');
  assertEqual(rows.find((row) => row.id === 'old-implemented').status, 'implemented', 'Older implemented opportunities keep implemented status');
  assertEqual(rows.find((row) => row.id === 'old-implemented').stale, true, 'Older implemented opportunities are flagged stale');
  assertEqual(rows.find((row) => row.id === 'current-new').status, 'new', 'Current crawl opportunities stay fresh');
  assertEqual(rows.find((row) => row.id === 'current-new').stale, false, 'Current crawl opportunities are not flagged stale');
  assertEqual(rows.find((row) => row.id === 'already-stale').status, 'stale', 'Already-stale rows remain unchanged');
});

check('job lifecycle status rules', () => {
  const statuses = ['queued', 'running', 'completed', 'error', 'canceled'];
  assertDeepEqual(statuses.filter(canCancelJob), ['queued', 'running'], 'Only queued and running jobs are cancelable');
  assertDeepEqual(statuses.filter(canRerunJob), ['completed', 'error', 'canceled'], 'Only terminal jobs are rerunnable');

  const runningCancel = cancelJob({ id: 'job-running', siteUrl: 'https://example.com', status: 'running' });
  assertEqual(runningCancel.success, true, 'Running jobs can be canceled');
  assertEqual(runningCancel.job.status, 'canceled', 'Cancel moves running jobs to canceled');
  assertEqual(runningCancel.job.lastError, 'Canceled by user.', 'Cancel records the user cancellation reason');

  const completedCancel = cancelJob({ id: 'job-completed', siteUrl: 'https://example.com', status: 'completed' });
  assert(!completedCancel.success, 'Completed jobs cannot be canceled');
  assert(completedCancel.error.includes('completed'), 'Rejected cancel response names the disallowed status');

  const completedRerun = rerunJob({
    job: { id: 'job-completed', progressCompleted: 42, siteUrl: 'https://example.com', status: 'completed' },
  });
  assertEqual(completedRerun.success, true, 'Completed jobs can be rerun');
  assertEqual(completedRerun.job.status, 'queued', 'Rerun queues a new analysis job');
  assertEqual(completedRerun.job.progressCompleted, 0, 'Rerun starts with empty progress');

  const runningRerun = rerunJob({
    job: { id: 'job-running', siteUrl: 'https://example.com', status: 'running' },
  });
  assert(!runningRerun.success, 'Running jobs cannot be rerun');
  assert(runningRerun.error.includes('running'), 'Rejected rerun response names the disallowed status');

  const blockedRerun = rerunJob({
    activeJobs: [{ id: 'active-job', siteUrl: 'https://example.com', status: 'queued' }],
    job: { id: 'old-error', siteUrl: 'https://example.com', status: 'error' },
  });
  assert(!blockedRerun.success, 'Terminal jobs cannot be rerun while the same site has an active job');
  assertEqual(blockedRerun.job.id, 'active-job', 'Blocked rerun returns the active conflicting job');
});
let failures = 0;

for (const { name, fn } of CHECKS) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

if (failures) {
  console.error(`\n${failures} internal-link QA check(s) failed.`);
  process.exit(1);
}

console.log(`\n${CHECKS.length} internal-link QA checks passed.`);























