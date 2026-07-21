import crypto from 'node:crypto';

export type PageAuthorityPageType =
  | 'article'
  | 'guide'
  | 'hub'
  | 'category'
  | 'service'
  | 'product'
  | 'comparison'
  | 'tool'
  | 'faq'
  | 'location'
  | 'legal'
  | 'utility'
  | 'transactional';

export type PageAuthorityTask =
  | 'learn'
  | 'compare'
  | 'calculate'
  | 'buy_or_hire'
  | 'find'
  | 'navigate'
  | 'troubleshoot'
  | 'review'
  | 'reference';

export type PageAuthorityConfidenceLabel = 'low' | 'medium' | 'high';

export type PageAuthorityHeadingInput = {
  level: number;
  text: string;
};

export type PageAuthorityDomNodeInput = {
  tag: string;
  role?: string | null;
  classes?: string[];
  depth?: number | null;
  childCount?: number | null;
  textLength?: number | null;
  attributes?: Record<string, string | number | boolean | null | undefined>;
};

export type PageAuthorityRegionInput = {
  kind: string;
  label?: string | null;
  heading?: string | null;
  itemCount?: number | null;
  linkCount?: number | null;
  textSample?: string | null;
  classes?: string[];
  attributes?: Record<string, string | number | boolean | null | undefined>;
};

export type PageAuthorityBlockInput = {
  kind: string;
  label?: string | null;
  text?: string | null;
  itemCount?: number | null;
  linkCount?: number | null;
  action?: string | null;
  depth?: number | null;
  classes?: string[];
  repeatedHint?: string | null;
};

export type PageAuthorityPageInput = {
  id: string;
  url: string;
  canonicalUrl?: string | null;
  title?: string | null;
  metaDescription?: string | null;
  lang?: string | null;
  wordCount?: number | null;
  headings?: PageAuthorityHeadingInput[];
  domNodes?: PageAuthorityDomNodeInput[];
  regions?: PageAuthorityRegionInput[];
  blocks?: PageAuthorityBlockInput[];
  breadcrumbs?: string[];
  structuredDataTypes?: string[];
  ctaTexts?: string[];
  price?: string | null;
  ratingValue?: number | null;
  reviewCount?: number | null;
};

export type PageAuthorityFeatureReason = {
  key: string;
  label: string;
  points: number;
  evidence: string;
};

export type PageAuthorityCandidate<TLabel extends string> = {
  label: TLabel;
  score: number;
  normalizedScore: number;
  confidence: number;
  confidenceLabel: PageAuthorityConfidenceLabel;
  reasons: PageAuthorityFeatureReason[];
};

export type PageAuthorityClassification<TLabel extends string> = {
  label: TLabel;
  score: number;
  normalizedScore: number;
  confidence: number;
  confidenceLabel: PageAuthorityConfidenceLabel;
  reasons: PageAuthorityFeatureReason[];
  candidates: Array<PageAuthorityCandidate<TLabel>>;
};

export type PageAuthorityUrlSkeletonSegment = {
  original: string;
  normalized: string;
  kind: 'locale' | 'year' | 'month' | 'day' | 'numeric' | 'slug' | 'compound' | 'token';
  skeleton: string;
};

export type PageAuthorityUrlSkeleton = {
  originalUrl: string;
  normalizedUrl: string;
  hostname: string;
  pathSegments: PageAuthorityUrlSkeletonSegment[];
  queryKeys: string[];
  skeletonPath: string;
  familyKey: string;
  hash: string;
};

export type PageAuthorityDomSignature = {
  nodeCount: number;
  tagHistogram: Record<string, number>;
  roleHistogram: Record<string, number>;
  classHints: string[];
  structureTokens: string[];
  structureFingerprint: string;
  hash: string;
};

export type PageAuthorityRegionSignature = {
  regionCount: number;
  regionKinds: string[];
  labelTokens: string[];
  structureTokens: string[];
  structureFingerprint: string;
  hash: string;
};

export type PageAuthorityRepeatedBlockEntry = {
  blockKey: string;
  shape: string;
  kind: string;
  occurrenceCount: number;
  pageCount: number;
  shareOfPages: number;
  samplePageIds: string[];
};

export type PageAuthorityRepeatedBlocks = {
  totalPages: number;
  repeatedBlocks: PageAuthorityRepeatedBlockEntry[];
  pageBreakdown: Record<string, {
    repeatedBlockCount: number;
    totalBlockCount: number;
    repeatedShare: number;
    repeatedBlockKeys: string[];
  }>;
};

export type PageAuthorityProfile = {
  pageType: PageAuthorityClassification<PageAuthorityPageType>;
  task: PageAuthorityClassification<PageAuthorityTask>;
  featureSnapshot: {
    titleTokens: string[];
    headingTokens: string[];
    ctaTokens: string[];
    blockKinds: string[];
    regionKinds: string[];
    structuredDataTypes: string[];
    wordCount: number;
    hasPrice: boolean;
    hasRatings: boolean;
  };
};

export type PageAuthorityPageAnalysis = {
  pageId: string;
  urlSkeleton: PageAuthorityUrlSkeleton;
  domSignature: PageAuthorityDomSignature;
  regionSignature: PageAuthorityRegionSignature;
  profile: PageAuthorityProfile;
};

export type PageAuthorityTemplateCluster = {
  clusterId: string;
  templateFingerprint: string;
  confidence: number;
  confidenceLabel: PageAuthorityConfidenceLabel;
  reasons: PageAuthorityFeatureReason[];
  memberPageIds: string[];
  sharedUrlFamilies: string[];
  sharedRegionKinds: string[];
  sharedDomTags: string[];
};

export type PageAuthorityTemplateClusterResult = {
  clusters: PageAuthorityTemplateCluster[];
  pageToClusterId: Record<string, string>;
};

export type PageAuthorityDatasetAnalysis = {
  pages: PageAuthorityPageAnalysis[];
  repeatedBlocks: PageAuthorityRepeatedBlocks;
  clusters: PageAuthorityTemplateClusterResult;
};

const STOP_WORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'best', 'by', 'for', 'from', 'get', 'how',
  'in', 'into', 'is', 'it', 'learn', 'of', 'on', 'or', 'our', 'the', 'this', 'to', 'vs', 'what',
  'with', 'your',
]);

const CONTENT_CLASS_HINTS = new Set([
  'accordion', 'address', 'author', 'benefits', 'breadcrumbs', 'cards', 'carousel', 'cart', 'category',
  'checkout', 'comparison', 'contact', 'cta', 'faq', 'features', 'filters', 'footer', 'form', 'gallery',
  'hero', 'hours', 'listing', 'map', 'nav', 'pagination', 'pricing', 'product', 'quote', 'resource',
  'results', 'reviews', 'search', 'section', 'service', 'sidebar', 'specs', 'steps', 'table', 'tabs',
  'team', 'testimonials', 'toc',
]);

const PAGE_TYPES: PageAuthorityPageType[] = [
  'article',
  'guide',
  'hub',
  'category',
  'service',
  'product',
  'comparison',
  'tool',
  'faq',
  'location',
  'legal',
  'utility',
  'transactional',
];

const TASKS: PageAuthorityTask[] = [
  'learn',
  'compare',
  'calculate',
  'buy_or_hire',
  'find',
  'navigate',
  'troubleshoot',
  'review',
  'reference',
];

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeToken(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function tokenize(value: unknown): string[] {
  return normalizeToken(value)
    .replace(/[^\p{L}\p{N}\s/-]/gu, ' ')
    .split(/[\s/:-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function maybeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function bucketCount(value: number | null | undefined): string {
  const count = Number.isFinite(value) ? Number(value) : 0;
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 8) return '4-8';
  if (count <= 16) return '9-16';
  return '17+';
}

function confidenceLabel(confidence: number): PageAuthorityConfidenceLabel {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.58) return 'medium';
  return 'low';
}

function scoreConfidence(topScore: number, runnerUpScore: number): number {
  const base = clamp(topScore / 100, 0, 1);
  const gap = clamp((topScore - runnerUpScore) / 40, 0, 1);
  return round(clamp(base * 0.55 + gap * 0.45, 0.05, 0.99));
}

function toHistogram(values: string[]): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const value of values) {
    histogram[value] = (histogram[value] || 0) + 1;
  }
  return histogram;
}

function topKeys(histogram: Record<string, number>, limit: number): string[] {
  return Object.entries(histogram)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key]) => key);
}

function regionLabel(region: PageAuthorityRegionInput): string {
  return normalizeText(region.label || region.heading || region.textSample || '');
}

function blockLabel(block: PageAuthorityBlockInput): string {
  return normalizeText(block.label || block.action || block.text || '');
}

function pageText(page: PageAuthorityPageInput): string {
  return [
    page.url,
    page.canonicalUrl,
    page.title,
    page.metaDescription,
    ...(page.headings || []).map((heading) => heading.text),
    ...(page.breadcrumbs || []),
    ...(page.ctaTexts || []),
  ].join(' ');
}

function keywordSet(page: PageAuthorityPageInput): Set<string> {
  return new Set(tokenize(pageText(page)));
}

function hasKeyword(tokens: Set<string>, ...candidates: string[]): boolean {
  return candidates.some((candidate) => tokens.has(normalizeToken(candidate)));
}

function countKinds(values: string[]): Set<string> {
  return new Set(values.map((value) => normalizeToken(value)));
}

function createReason(key: string, label: string, points: number, evidence: string): PageAuthorityFeatureReason {
  return {
    key,
    label,
    points,
    evidence,
  };
}

function pushReason<TLabel extends string>(
  scorecard: Map<TLabel, PageAuthorityFeatureReason[]>,
  label: TLabel,
  key: string,
  summary: string,
  points: number,
  evidence: string,
) {
  const reasons = scorecard.get(label) || [];
  reasons.push(createReason(key, summary, points, evidence));
  scorecard.set(label, reasons);
}

function finalizeClassification<TLabel extends string>(
  labels: TLabel[],
  scorecard: Map<TLabel, PageAuthorityFeatureReason[]>,
  fallback: TLabel,
): PageAuthorityClassification<TLabel> {
  const candidates = labels.map((label) => {
    const reasons = (scorecard.get(label) || []).sort((left, right) => right.points - left.points || left.key.localeCompare(right.key));
    const score = reasons.reduce((total, reason) => total + reason.points, 0);
    return {
      label,
      score,
      reasons,
    };
  }).sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));

  const best = candidates[0];
  const runnerUp = candidates[1] || { score: 0 };
  const winner = best && best.score > 0 ? best : { label: fallback, score: 1, reasons: [createReason('fallback', 'Fallback', 1, `Defaulted to ${fallback} because no stronger rules matched.`)] };
  const totalScore = candidates.reduce((sum, candidate) => sum + candidate.score, 0) || winner.score;

  const normalizedCandidates: Array<PageAuthorityCandidate<TLabel>> = candidates.map((candidate) => {
    const confidence = scoreConfidence(candidate.score, candidate === best ? runnerUp.score : best?.score || 0);
    return {
      label: candidate.label,
      score: candidate.score,
      normalizedScore: round(candidate.score / totalScore),
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      reasons: candidate.reasons,
    };
  });

  const winnerConfidence = scoreConfidence(winner.score, runnerUp.score);
  return {
    label: winner.label,
    score: winner.score,
    normalizedScore: round(winner.score / totalScore),
    confidence: winnerConfidence,
    confidenceLabel: confidenceLabel(winnerConfidence),
    reasons: winner.reasons,
    candidates: normalizedCandidates,
  };
}

export function buildUrlSkeleton(url: string): PageAuthorityUrlSkeleton {
  const parsed = maybeUrl(url);
  const normalizedUrl = parsed ? parsed.toString() : normalizeText(url);
  const hostname = normalizeToken(parsed?.hostname || '');
  const pathSegments = (parsed?.pathname || '/')
    .split('/')
    .filter(Boolean)
    .map<PageAuthorityUrlSkeletonSegment>((segment, index, allSegments) => {
      const normalized = normalizeToken(segment);
      if (/^[a-z]{2}(?:-[a-z]{2})?$/.test(normalized)) {
        return { original: segment, normalized, kind: 'locale', skeleton: '{locale}' };
      }
      if (/^(19|20)\d{2}$/.test(normalized)) {
        return { original: segment, normalized, kind: 'year', skeleton: '{year}' };
      }
      if (/^(0?[1-9]|1[0-2])$/.test(normalized) && index > 0 && allSegments[index - 1] && /^(19|20)\d{2}$/.test(allSegments[index - 1])) {
        return { original: segment, normalized, kind: 'month', skeleton: '{month}' };
      }
      if (/^(0?[1-9]|[12]\d|3[01])$/.test(normalized) && index > 1 && allSegments[index - 2] && /^(19|20)\d{2}$/.test(allSegments[index - 2])) {
        return { original: segment, normalized, kind: 'day', skeleton: '{day}' };
      }
      if (/^\d+$/.test(normalized)) {
        return { original: segment, normalized, kind: 'numeric', skeleton: '{n}' };
      }
      const slugParts = normalized.split('-').filter(Boolean);
      if (slugParts.length >= 3) {
        return { original: segment, normalized, kind: 'slug', skeleton: '{slug}' };
      }
      if (normalized.includes('-')) {
        return { original: segment, normalized, kind: 'compound', skeleton: '{compound}' };
      }
      return { original: segment, normalized, kind: 'token', skeleton: normalized };
    });

  const queryKeys = parsed ? unique(Array.from(parsed.searchParams.keys()).map((key) => normalizeToken(key)).filter(Boolean)).sort() : [];
  const skeletonPath = `/${pathSegments.map((segment) => segment.skeleton).join('/')}`;
  const familyKey = `${hostname}${skeletonPath}${queryKeys.length ? `?${queryKeys.join('&')}` : ''}`;
  return {
    originalUrl: url,
    normalizedUrl,
    hostname,
    pathSegments,
    queryKeys,
    skeletonPath,
    familyKey,
    hash: hashValue(familyKey).slice(0, 16),
  };
}

export function buildDomSignature(page: Pick<PageAuthorityPageInput, 'domNodes' | 'blocks'>): PageAuthorityDomSignature {
  const nodes = page.domNodes || [];
  const tagTokens: string[] = [];
  const roleTokens: string[] = [];
  const structureTokens: string[] = [];
  const classHints: string[] = [];

  for (const node of nodes) {
    const tag = normalizeToken(node.tag);
    if (!tag) continue;
    const role = normalizeToken(node.role || '');
    const depth = bucketCount(node.depth);
    const children = bucketCount(node.childCount);
    const textLength = bucketCount(node.textLength);
    tagTokens.push(tag);
    if (role) roleTokens.push(role);
    const classTokens = unique((node.classes || []).flatMap((className) => tokenize(className))).filter((token) => CONTENT_CLASS_HINTS.has(token)).sort();
    classHints.push(...classTokens);
    structureTokens.push(`${tag}:${role || '-'}:d${depth}:c${children}:t${textLength}:${classTokens.slice(0, 2).join('+') || '-'}`);
  }

  for (const block of page.blocks || []) {
    const kind = normalizeToken(block.kind);
    if (!kind) continue;
    structureTokens.push(`block:${kind}:depth${bucketCount(block.depth)}`);
  }

  const structureFingerprint = structureTokens.slice(0, 120).join('|');
  return {
    nodeCount: nodes.length,
    tagHistogram: toHistogram(tagTokens),
    roleHistogram: toHistogram(roleTokens),
    classHints: unique(classHints).sort(),
    structureTokens,
    structureFingerprint,
    hash: hashValue(structureFingerprint).slice(0, 16),
  };
}

export function buildRegionSignature(page: Pick<PageAuthorityPageInput, 'regions'>): PageAuthorityRegionSignature {
  const regions = page.regions || [];
  const regionKinds = regions.map((region) => normalizeToken(region.kind)).filter(Boolean);
  const labelTokens = unique(regions.flatMap((region) => tokenize(regionLabel(region)))).sort();
  const structureTokens = regions.map((region) => {
    const kind = normalizeToken(region.kind) || 'unknown';
    return `${kind}:links${bucketCount(region.linkCount)}`;
  });
  const structureFingerprint = structureTokens.join('|');
  return {
    regionCount: regions.length,
    regionKinds,
    labelTokens,
    structureTokens,
    structureFingerprint,
    hash: hashValue(structureFingerprint).slice(0, 16),
  };
}

function buildBlockShape(block: PageAuthorityBlockInput): string {
  const textTokens = tokenize(blockLabel(block)).slice(0, 4);
  return [
    normalizeToken(block.kind) || 'unknown',
    `items:${bucketCount(block.itemCount)}`,
    `links:${bucketCount(block.linkCount)}`,
    `depth:${bucketCount(block.depth)}`,
    `action:${normalizeToken(block.action || '') || '-'}`,
    `hint:${normalizeToken(block.repeatedHint || '') || '-'}`,
    `tokens:${textTokens.join('+') || '-'}`,
  ].join('|');
}

export function computeRepeatedBlockFrequency(pages: PageAuthorityPageInput[]): PageAuthorityRepeatedBlocks {
  const blockMap = new Map<string, {
    blockKey: string;
    shape: string;
    kind: string;
    occurrenceCount: number;
    pageIds: Set<string>;
  }>();
  const pageBreakdown: PageAuthorityRepeatedBlocks['pageBreakdown'] = {};

  for (const page of pages) {
    const blocks = page.blocks || [];
    const blockKeys: string[] = [];
    for (const block of blocks) {
      const shape = buildBlockShape(block);
      const blockKey = hashValue(shape).slice(0, 16);
      blockKeys.push(blockKey);
      const entry = blockMap.get(blockKey) || {
        blockKey,
        shape,
        kind: normalizeToken(block.kind) || 'unknown',
        occurrenceCount: 0,
        pageIds: new Set<string>(),
      };
      entry.occurrenceCount += 1;
      entry.pageIds.add(page.id);
      blockMap.set(blockKey, entry);
    }

    pageBreakdown[page.id] = {
      repeatedBlockCount: 0,
      totalBlockCount: blocks.length,
      repeatedShare: 0,
      repeatedBlockKeys: blockKeys,
    };
  }

  const repeatedBlocks = Array.from(blockMap.values())
    .filter((entry) => entry.pageIds.size >= 2)
    .map<PageAuthorityRepeatedBlockEntry>((entry) => ({
      blockKey: entry.blockKey,
      shape: entry.shape,
      kind: entry.kind,
      occurrenceCount: entry.occurrenceCount,
      pageCount: entry.pageIds.size,
      shareOfPages: round(entry.pageIds.size / Math.max(1, pages.length)),
      samplePageIds: Array.from(entry.pageIds).sort().slice(0, 5),
    }))
    .sort((left, right) => right.pageCount - left.pageCount || right.occurrenceCount - left.occurrenceCount || left.blockKey.localeCompare(right.blockKey));

  const repeatedBlockKeySet = new Set(repeatedBlocks.map((entry) => entry.blockKey));
  for (const [pageId, breakdown] of Object.entries(pageBreakdown)) {
    const repeatedKeys = breakdown.repeatedBlockKeys.filter((blockKey) => repeatedBlockKeySet.has(blockKey));
    breakdown.repeatedBlockCount = repeatedKeys.length;
    breakdown.repeatedShare = breakdown.totalBlockCount ? round(repeatedKeys.length / breakdown.totalBlockCount) : 0;
    breakdown.repeatedBlockKeys = repeatedKeys;
    pageBreakdown[pageId] = breakdown;
  }

  return {
    totalPages: pages.length,
    repeatedBlocks,
    pageBreakdown,
  };
}

function buildFeatureSnapshot(page: PageAuthorityPageInput) {
  return {
    titleTokens: unique(tokenize(page.title)).slice(0, 24),
    headingTokens: unique((page.headings || []).flatMap((heading) => tokenize(heading.text))).slice(0, 32),
    ctaTokens: unique((page.ctaTexts || []).flatMap((cta) => tokenize(cta))).slice(0, 20),
    blockKinds: unique((page.blocks || []).map((block) => normalizeToken(block.kind)).filter(Boolean)).sort(),
    regionKinds: unique((page.regions || []).map((region) => normalizeToken(region.kind)).filter(Boolean)).sort(),
    structuredDataTypes: unique((page.structuredDataTypes || []).map((value) => normalizeToken(value)).filter(Boolean)).sort(),
    wordCount: Math.max(0, Number(page.wordCount) || 0),
    hasPrice: !!normalizeText(page.price),
    hasRatings: Number(page.ratingValue) > 0 || Number(page.reviewCount) > 0,
  };
}

export function profilePage(
  page: PageAuthorityPageInput,
  repeatedBlocks?: PageAuthorityRepeatedBlocks,
): PageAuthorityProfile {
  const typeScores = new Map<PageAuthorityPageType, PageAuthorityFeatureReason[]>();
  const taskScores = new Map<PageAuthorityTask, PageAuthorityFeatureReason[]>();
  const features = buildFeatureSnapshot(page);
  const tokens = keywordSet(page);
  const blockKinds = countKinds(features.blockKinds);
  const regionKinds = countKinds(features.regionKinds);
  const structuredTypes = countKinds(features.structuredDataTypes);
  const repeatedShare = repeatedBlocks?.pageBreakdown[page.id]?.repeatedShare || 0;
  const url = maybeUrl(page.url);
  const path = normalizeToken(url?.pathname || page.url);
  const pageWordCount = features.wordCount;
  const headingLevels = (page.headings || []).map((heading) => heading.level).sort((left, right) => left - right);
  const h1Count = headingLevels.filter((level) => level === 1).length;
  const hasFaqBlocks = blockKinds.has('faq') || blockKinds.has('accordion') || regionKinds.has('faq');
  const hasTable = blockKinds.has('table') || regionKinds.has('comparison');
  const hasForm = blockKinds.has('form') || regionKinds.has('form');
  const hasListings = blockKinds.has('listing') || blockKinds.has('cards') || regionKinds.has('listing');
  const listingRegionCount = (page.regions || []).filter((region) => normalizeToken(region.kind) === 'listing').length;
  const hasMap = blockKinds.has('map') || regionKinds.has('map');
  const hasReviews = blockKinds.has('reviews') || blockKinds.has('testimonials') || regionKinds.has('reviews') || features.hasRatings;
  const hasPricing = features.hasPrice || blockKinds.has('pricing') || regionKinds.has('pricing');
  const hasToolResults = blockKinds.has('results') || regionKinds.has('results') || blockKinds.has('tool');
  const isLegalPath = /\/(privacy(?:-policy)?|terms(?:-of-service)?|cookie|cookies|gdpr|legal|impressum|disclaimer)(?:\/|$)/.test(path);
  const isUtilityPath = /\/(login|account|search|cart|checkout|thank-you|reset-password|signup|register)(\/|$)/.test(path);
  const ctaSet = new Set(features.ctaTokens);
  const titlePathTokens = new Set([...features.titleTokens, ...tokenize(path)]);

  if (isLegalPath) {
    pushReason(typeScores, 'legal', 'legal-path', 'Legal route', 42, `Path "${path}" matches a legal or policy route.`);
    pushReason(taskScores, 'reference', 'legal-reference', 'Reference intent', 28, 'Legal and policy pages usually serve lookup and compliance reference tasks.');
  }

  if (isUtilityPath) {
    pushReason(typeScores, 'utility', 'utility-path', 'Utility route', 42, `Path "${path}" matches an account, search, or checkout utility route.`);
    pushReason(taskScores, 'navigate', 'utility-navigation', 'Navigation utility', 18, 'Utility pages often help users continue an existing workflow.');
  }

  if (hasFaqBlocks || hasKeyword(tokens, 'faq', 'questions', 'answers')) {
    pushReason(typeScores, 'faq', 'faq-structure', 'FAQ structure', 44, 'FAQ blocks or accordion-style question sections are present.');
    pushReason(taskScores, 'troubleshoot', 'faq-troubleshoot', 'Troubleshooting fit', 28, 'Question-and-answer sections often resolve objections or problems.');
    pushReason(taskScores, 'learn', 'faq-learn', 'Explainer fit', 14, 'FAQ pages are also used for explanatory learning tasks.');
    pushReason(taskScores, 'reference', 'faq-reference', 'Lookup fit', 14, 'Question-and-answer pages support fast fact lookup.');
  }

  if (hasKeyword(tokens, 'guide', 'tutorial', 'how', 'checklist') || blockKinds.has('steps') || regionKinds.has('steps')) {
    pushReason(typeScores, 'guide', 'guide-signals', 'Guide framing', 34, 'Guide/tutorial keywords or stepwise instructional sections are present.');
    pushReason(taskScores, 'learn', 'guide-learn', 'Learning fit', 28, 'Guide pages primarily support learning workflows.');
  }

  if (hasKeyword(tokens, 'blog', 'article', 'news', 'story', 'insights') || structuredTypes.has('article') || structuredTypes.has('blogposting')) {
    pushReason(typeScores, 'article', 'article-signals', 'Article framing', 28, 'Article/blog keywords or article structured data are present.');
    pushReason(taskScores, 'learn', 'article-learn', 'Learning fit', 20, 'Articles primarily support reading and understanding.');
  }

  if (hasKeyword(tokens, 'hub', 'resources', 'library', 'overview') || regionKinds.has('toc') || (listingRegionCount >= 2 && pageWordCount < 900 && !hasPricing)) {
    pushReason(typeScores, 'hub', 'hub-structure', 'Hub structure', 34, 'Resource-hub keywords or section-heavy navigation layout are present.');
    pushReason(taskScores, 'navigate', 'hub-navigate', 'Navigation fit', 28, 'Hub pages usually route users toward deeper destination pages.');
  }

  if (hasKeyword(tokens, 'category', 'collection', 'catalog', 'shop') || hasListings) {
    pushReason(typeScores, 'category', 'category-signals', 'Listing structure', 24, 'Listing/card sections suggest a collection or category page.');
    pushReason(taskScores, 'find', 'category-find', 'Findability fit', 20, 'Listing pages mainly help users find matching items.');
  }

  if (hasKeyword(tokens, 'service', 'consulting', 'agency', 'book', 'quote', 'demo') || ctaSet.has('quote') || ctaSet.has('consultation') || ctaSet.has('demo')) {
    pushReason(typeScores, 'service', 'service-signals', 'Service framing', 34, 'Service keywords or consultation/demo calls to action are present.');
    pushReason(taskScores, 'buy_or_hire', 'service-buy', 'Commercial action', 26, 'Service pages aim to convert interest into contact or hiring.');
  }

  if (hasKeyword(tokens, 'sku', 'buy') || structuredTypes.has('product') || (hasPricing && ctaSet.has('buy')) || blockKinds.has('specs')) {
    pushReason(typeScores, 'product', 'product-signals', 'Product framing', 38, 'Product schema, specifications, or buy-oriented commerce signals are present.');
    pushReason(taskScores, 'buy_or_hire', 'product-buy', 'Commercial action', 30, 'Product pages are built for purchase decisions.');
  }

  if (hasKeyword(titlePathTokens, 'compare', 'comparison', 'versus', 'vs', 'alternatives', 'best') || hasTable) {
    pushReason(typeScores, 'comparison', 'comparison-signals', 'Comparison framing', 42, 'Comparison keywords or table-heavy comparison structure are present.');
    pushReason(taskScores, 'compare', 'comparison-task', 'Compare intent', 34, 'Comparison pages exist to evaluate options side by side.');
    if (hasReviews) {
      pushReason(taskScores, 'review', 'comparison-reviews', 'Review fit', 14, 'Reviews/testimonials strengthen evaluative intent.');
    }
  }

  if (hasKeyword(tokens, 'calculator', 'estimator', 'generator', 'checker', 'tool') || (hasForm && hasToolResults)) {
    pushReason(typeScores, 'tool', 'tool-signals', 'Tool framing', 40, 'Tool or calculator keywords plus interactive inputs/forms are present.');
    pushReason(taskScores, 'calculate', 'tool-calculate', 'Calculation fit', 36, 'Interactive tools typically help users compute or generate outputs.');
  }

  if (hasKeyword(tokens, 'location', 'office', 'directions', 'hours', 'near') || hasMap || structuredTypes.has('localbusiness')) {
    pushReason(typeScores, 'location', 'location-signals', 'Location framing', 40, 'Map, office-hours, or local business signals are present.');
    pushReason(taskScores, 'find', 'location-find', 'Findability fit', 28, 'Location pages mainly help users find a place or coverage area.');
    pushReason(taskScores, 'navigate', 'location-navigate', 'Wayfinding fit', 14, 'Directions and hours support physical navigation.');
  }

  if (hasKeyword(tokens, 'pricing', 'plan', 'checkout', 'start', 'trial') || path.includes('/pricing') || ctaSet.has('start') || ctaSet.has('trial')) {
    pushReason(typeScores, 'transactional', 'transactional-signals', 'Transactional framing', 34, 'Pricing, signup, or checkout cues indicate a conversion page.');
    pushReason(taskScores, 'buy_or_hire', 'transactional-buy', 'Commercial action', 32, 'Pricing and signup pages push toward commitment.');
  }

  if (pageWordCount >= 1200 && h1Count <= 1) {
    pushReason(typeScores, 'article', 'longform-article', 'Long-form narrative', 12, `Word count is ${pageWordCount}, which fits long-form editorial content.`);
    pushReason(typeScores, 'guide', 'longform-guide', 'Long-form instructional', 12, `Word count is ${pageWordCount}, which also fits guide-style content.`);
  }

  if ((page.blocks || []).length >= 6 && repeatedShare >= 0.45) {
    pushReason(typeScores, 'hub', 'template-heavy-hub', 'Template-heavy shell', 10, `Repeated block share is ${round(repeatedShare * 100, 1)}%, suggesting a navigational shell around content.`);
    pushReason(typeScores, 'category', 'template-heavy-category', 'Template-heavy listing', 10, `Repeated block share is ${round(repeatedShare * 100, 1)}%, consistent with a reusable listing template.`);
  }

  if (hasReviews) {
    pushReason(taskScores, 'review', 'review-signals', 'Evaluative content', 18, 'Ratings, reviews, or testimonials are present.');
  }

  if (hasKeyword(tokens, 'support', 'fix', 'error', 'troubleshoot', 'repair')) {
    pushReason(taskScores, 'troubleshoot', 'support-signals', 'Troubleshooting cues', 26, 'Support and fix-oriented language is present.');
  }

  if (structuredTypes.has('faqpage') || structuredTypes.has('howto') || structuredTypes.has('techarticle') || structuredTypes.has('article')) {
    pushReason(taskScores, 'reference', 'structured-reference', 'Reference-oriented schema', 10, `Structured data types include ${Array.from(structuredTypes).sort().join(', ')}.`);
  }

  if (hasKeyword(tokens, 'docs', 'documentation', 'reference', 'spec', 'api')) {
    pushReason(taskScores, 'reference', 'reference-keywords', 'Reference keywords', 22, 'Documentation/specification language is present.');
  }

  const pageType = finalizeClassification(PAGE_TYPES, typeScores, 'article');
  const task = finalizeClassification(TASKS, taskScores, 'learn');

  return {
    pageType,
    task,
    featureSnapshot: features,
  };
}

export function analyzePageAuthorityPage(
  page: PageAuthorityPageInput,
  repeatedBlocks?: PageAuthorityRepeatedBlocks,
): PageAuthorityPageAnalysis {
  return {
    pageId: page.id,
    urlSkeleton: buildUrlSkeleton(page.url),
    domSignature: buildDomSignature(page),
    regionSignature: buildRegionSignature(page),
    profile: profilePage(page, repeatedBlocks),
  };
}

export function clusterTemplates(pages: PageAuthorityPageAnalysis[]): PageAuthorityTemplateClusterResult {
  const buckets = new Map<string, PageAuthorityPageAnalysis[]>();
  for (const page of pages) {
    const templateFingerprint = `${page.regionSignature.hash}:${page.domSignature.hash}`;
    const members = buckets.get(templateFingerprint) || [];
    members.push(page);
    buckets.set(templateFingerprint, members);
  }

  const clusters: PageAuthorityTemplateCluster[] = [];
  const pageToClusterId: Record<string, string> = {};

  for (const [templateFingerprint, members] of Array.from(buckets.entries()).sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))) {
    const clusterId = `tpl_${hashValue(templateFingerprint).slice(0, 12)}`;
    const familyHistogram = toHistogram(members.map((member) => member.urlSkeleton.familyKey));
    const regionHistogram = toHistogram(members.flatMap((member) => member.regionSignature.regionKinds));
    const tagHistogram = toHistogram(members.flatMap((member) => Object.keys(member.domSignature.tagHistogram)));
    const sharedFamilies = topKeys(familyHistogram, 4);
    const sharedRegions = topKeys(regionHistogram, 6);
    const sharedTags = topKeys(tagHistogram, 6);
    const topFamilyShare = members.length ? (familyHistogram[sharedFamilies[0] || ''] || 0) / members.length : 0;
    const regionDensity = sharedRegions.length ? sharedRegions.length / Math.max(1, members[0]?.regionSignature.regionKinds.length || 1) : 0;
    const confidence = round(clamp(0.45 + Math.min(0.35, members.length * 0.08) + Math.min(0.12, topFamilyShare * 0.12) + Math.min(0.08, regionDensity * 0.08), 0.45, 0.98));
    const reasons: PageAuthorityFeatureReason[] = [
      createReason('region-signature', 'Region signature match', 38, `All ${members.length} pages share region signature ${members[0]?.regionSignature.hash}.`),
      createReason('dom-signature', 'DOM signature match', 34, `All ${members.length} pages share DOM signature ${members[0]?.domSignature.hash}.`),
      createReason('url-family', 'URL family overlap', Math.round(topFamilyShare * 20), `Top URL family covers ${Math.round(topFamilyShare * 100)}% of the cluster.`),
    ];

    for (const member of members) {
      pageToClusterId[member.pageId] = clusterId;
    }

    clusters.push({
      clusterId,
      templateFingerprint,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      reasons,
      memberPageIds: members.map((member) => member.pageId).sort(),
      sharedUrlFamilies: sharedFamilies,
      sharedRegionKinds: sharedRegions,
      sharedDomTags: sharedTags,
    });
  }

  return {
    clusters,
    pageToClusterId,
  };
}

export function analyzePageAuthorityDataset(pages: PageAuthorityPageInput[]): PageAuthorityDatasetAnalysis {
  const repeatedBlocks = computeRepeatedBlockFrequency(pages);
  const pageAnalyses = pages.map((page) => analyzePageAuthorityPage(page, repeatedBlocks));
  const clusters = clusterTemplates(pageAnalyses);
  return {
    pages: pageAnalyses,
    repeatedBlocks,
    clusters,
  };
}
