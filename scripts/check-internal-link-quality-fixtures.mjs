#!/usr/bin/env node

const STOP_WORDS = new Set([
  'a', 'about', 'also', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'has', 'have', 'how', 'in', 'into', 'is', 'it', 'its', 'more', 'of', 'on', 'or', 'our', 'page', 'post', 'the', 'this', 'to', 'with', 'your', 'you', 'we', 'what', 'when', 'where', 'why', 'vs', 'best', 'guide', 'home', 'learn',
]);
const GENERIC_SINGLE_ANCHOR_TOKENS = new Set([
  'activities', 'activity', 'aktivitaet', 'adventure', 'article', 'avanterra', 'blog', 'click', 'course', 'guide', 'home', 'learn', 'link', 'lopar', 'page', 'parcours', 'park', 'post', 'read', 'route', 'site', 'staza', 'trail', 'visit',
]);
const ASSET_URL_PATTERN = /\.(?:avif|css|gif|ico|jpe?g|js|json|mov|mp3|mp4|pdf|png|svg|webm|webp|woff2?|xml|zip)(?:[?#].*)?$/i;
const ASSET_PATH_PATTERN = /\/(?:wp-content\/uploads|uploads|assets|static|media)\//i;
const UTILITY_PAGE_PATTERN = /\/(?:privacy-policy|privacy|politika-privatnosti|datenschutz|terms|uvjeti|legal|impressum|cookie|cookies|login|account|cart|checkout|thank-you|search)(?:\/|$)/i;
const HOME_PAGE_KEY_PATTERN = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:home|homepage|startseite)?\/?$/i;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function tokenize(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function uniqueTokens(values, limit = 42) {
  return Array.from(new Set(values.flatMap((value) => tokenize(value)))).slice(0, limit);
}

function pageIdentityText(page) {
  return `${page.url || ''} ${page.normalizedUrl || ''} ${page.pageKey || ''}`;
}

function isHtmlContentType(value) {
  const contentType = normalizeText(value).toLowerCase();
  if (!contentType) return true;
  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
}

function isIndexableContentPage(page) {
  const identity = pageIdentityText(page);
  if (ASSET_URL_PATTERN.test(identity)) return false;
  if (ASSET_PATH_PATTERN.test(identity)) return false;
  if (!isHtmlContentType(page.contentType)) return false;
  if (toFiniteNumber(page.statusCode) < 200 || toFiniteNumber(page.statusCode) >= 300) return false;
  if (toFiniteNumber(page.noindex)) return false;
  if (toFiniteNumber(page.wordCount) < 20 && !normalizeText(page.title) && !normalizeText(page.h1Text)) return false;
  return true;
}

function isUtilityPage(page) {
  return UTILITY_PAGE_PATTERN.test(pageIdentityText(page));
}

function isEligibleTargetPage(page) {
  return isIndexableContentPage(page) && !HOME_PAGE_KEY_PATTERN.test(page.pageKey || '/') && !isUtilityPage(page);
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
  if (!tokens.length) return false;
  if (tokens.length === 1 && (tokens[0].length < 8 || GENERIC_SINGLE_ANCHOR_TOKENS.has(tokens[0]))) return false;
  if (tokens.every((token) => GENERIC_SINGLE_ANCHOR_TOKENS.has(token))) return false;
  return true;
}

function chooseAnchorSpan(sentence, target) {
  const candidatePhrases = [
    ...(target.topQueries || []),
    target.h1Text,
    target.title,
    target.pageKey.split('/').filter(Boolean).slice(-1)[0]?.replace(/[-_]/g, ' '),
  ]
    .map((value) => normalizeText(value).replace(/[|:-].*$/, '').trim())
    .filter((value) => value.length >= 4 && value.length <= 90)
    .sort((a, b) => b.length - a.length);

  for (const phrase of candidatePhrases) {
    const span = findCaseInsensitiveSpan(sentence, phrase);
    if (span && isUsefulAnchorText(span.anchorText)) return span;
  }

  const targetTokens = new Set(uniqueTokens([target.title, target.h1Text, target.pageKey, ...(target.topQueries || [])]));
  const sentenceTokens = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || [];
  for (let i = 0; i < sentenceTokens.length; i += 1) {
    for (let size = 4; size >= 1; size -= 1) {
      const phrase = sentenceTokens.slice(i, i + size).join(' ');
      const tokens = tokenize(phrase);
      if (tokens.length >= 2 && tokens.every((token) => targetTokens.has(token))) {
        const span = findCaseInsensitiveSpan(sentence, phrase);
        if (span && span.anchorText.length >= 4 && isUsefulAnchorText(span.anchorText)) return span;
      }
    }
  }
  return null;
}

function readerBenefitFor(sourceSentence, target) {
  const targetLabel = target.title || target.h1Text || target.pageKey;
  const query = target.topQueries?.[0];
  if (query) {
    return `A reader at this exact sentence can continue to ${targetLabel}, which expands on ${query} with a dedicated follow-up instead of leaving the concept implicit.`;
  }
  return `A reader at this exact sentence gets a useful next step because ${targetLabel} deepens the same topic without breaking context.`;
}

function targetNeed(target) {
  return Math.min(100, Math.max(0,
    Math.max(0, 10 - toFiniteNumber(target.inboundLinkCount)) * 4
    + Math.min(26, toFiniteNumber(target.impressions) / 80)
    + (target.position >= 4 && target.position <= 20 ? 16 : 0)
    + Math.min(12, toFiniteNumber(target.sessions) / 25),
  ));
}

function generateFixtureRecommendations({ existingLinks = [], sources, targets }) {
  const existing = new Set(existingLinks.map((link) => `${link.fromPageKey}=>${link.toPageKey}`));
  const eligibleTargets = targets.filter(isEligibleTargetPage).sort((a, b) => targetNeed(b) - targetNeed(a));
  const rows = [];
  const sentenceRows = sources.flatMap((source) => source.sentences.map((sentence) => ({ sentence, source })));
  const sentenceTokenSets = new Map();
  const sentencesByToken = new Map();
  let scoredPairs = 0;

  for (const row of sentenceRows) {
    const key = `${row.source.pageKey}\u001f${row.sentence}`;
    const tokens = new Set(tokenize(row.sentence));
    sentenceTokenSets.set(key, tokens);
    for (const token of tokens) {
      const bucket = sentencesByToken.get(token) || [];
      bucket.push(row);
      sentencesByToken.set(token, bucket);
    }
  }

  for (const target of eligibleTargets) {
    const targetTokens = new Set(uniqueTokens([target.title, target.h1Text, target.pageKey, ...(target.topQueries || [])]));
    const candidates = new Map();
    for (const token of targetTokens) {
      for (const row of sentencesByToken.get(token) || []) {
        if (existing.has(`${row.source.pageKey}=>${target.pageKey}`) || row.source.pageKey === target.pageKey) continue;
        candidates.set(`${row.source.pageKey}\u001f${row.sentence}`, row);
      }
    }

    for (const { source, sentence } of candidates.values()) {
      scoredPairs += 1;
      const sentenceTokens = sentenceTokenSets.get(`${source.pageKey}\u001f${sentence}`) || new Set();
      const overlap = Array.from(sentenceTokens).filter((token) => targetTokens.has(token)).length;
      if (overlap < 1) continue;
        const anchor = chooseAnchorSpan(sentence, target);
        if (!anchor) continue;
        rows.push({
          anchorText: anchor.anchorText,
          anchorStart: anchor.anchorStart,
          anchorEnd: anchor.anchorEnd,
          priorityScore: Math.round(Math.min(100, targetNeed(target) + overlap * 8)),
          readerBenefit: readerBenefitFor(sentence, target),
          sourcePageKey: source.pageKey,
          sourceSentence: sentence,
          targetPageKey: target.pageKey,
          targetTitle: target.title,
          targetUrl: target.url,
        });
    }
  }

  rows.sort((a, b) => b.priorityScore - a.priorityScore);
  const usedSourceAnchor = new Set();
  const usedSourceTarget = new Set();
  const deduped = rows.filter((row) => {
    const sourceAnchorKey = `${row.sourcePageKey}:${normalizeText(row.anchorText).toLowerCase()}`;
    const sourceTargetKey = `${row.sourcePageKey}=>${row.targetPageKey}`;
    if (usedSourceAnchor.has(sourceAnchorKey) || usedSourceTarget.has(sourceTargetKey)) return false;
    usedSourceAnchor.add(sourceAnchorKey);
    usedSourceTarget.add(sourceTargetKey);
    return true;
  });
  deduped.scoredPairs = scoredPairs;
  deduped.bruteForcePairs = sentenceRows.length * eligibleTargets.length;
  return deduped;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
}

const sources = [
  {
    pageKey: '/bigquery-mcp-server-seo-tools',
    title: 'BigQuery MCP Server: 32 SEO Tools for Your GSC + GA4 Data Warehouse',
    sentences: [
      'How much of my traffic is hidden behind anonymous queries? Shows you which pages rely most on queries Google will not reveal at the query level.',
      'Ask forecast my traffic for the next 90 days and you get a table with daily predicted clicks, lower bound, upper bound, and uncertainty range.',
    ],
  },
  {
    pageKey: '/not-provided-keywords-google-analytics',
    title: 'How to Unlock Not Provided Keywords in Google Analytics',
    sentences: [
      'For content planning, title optimisation, and identifying striking distance keywords, the data is good enough.',
      'Click here to learn more about our article and guide for SEO.',
    ],
  },
];

const targets = [
  {
    contentType: 'text/html; charset=utf-8',
    h1Text: 'How to Unlock Not Provided Keywords in Google Analytics',
    inboundLinkCount: 2,
    impressions: 1300,
    noindex: 0,
    normalizedUrl: 'https://example.com/not-provided-keywords-google-analytics/',
    pageKey: '/not-provided-keywords-google-analytics',
    position: 8,
    sessions: 45,
    statusCode: 200,
    title: 'How to Unlock Not Provided Keywords in Google Analytics',
    topQueries: ['queries Google will not reveal', 'not provided keywords'],
    url: 'https://example.com/not-provided-keywords-google-analytics/',
    wordCount: 1500,
  },
  {
    contentType: 'text/html; charset=utf-8',
    h1Text: 'I Tested 3 Ways to Forecast SEO Traffic',
    inboundLinkCount: 1,
    impressions: 900,
    noindex: 0,
    normalizedUrl: 'https://example.com/forecast-seo-traffic/',
    pageKey: '/forecast-seo-traffic',
    position: 10,
    sessions: 60,
    statusCode: 200,
    title: 'I Tested 3 Ways to Forecast SEO Traffic. Here Is What Actually Works.',
    topQueries: ['forecast my traffic', 'forecast SEO traffic'],
    url: 'https://example.com/forecast-seo-traffic/',
    wordCount: 1800,
  },
  {
    contentType: 'text/html; charset=utf-8',
    h1Text: 'Google Search Console MCP: Step by Step Setup Guide',
    inboundLinkCount: 3,
    impressions: 720,
    noindex: 0,
    normalizedUrl: 'https://example.com/google-search-console-mcp/',
    pageKey: '/google-search-console-mcp',
    position: 12,
    sessions: 35,
    statusCode: 200,
    title: 'Google Search Console MCP: Step by Step Setup Guide',
    topQueries: ['identifying striking distance keywords', 'search console mcp'],
    url: 'https://example.com/google-search-console-mcp/',
    wordCount: 2100,
  },
  {
    contentType: 'image/jpeg',
    h1Text: null,
    inboundLinkCount: 0,
    impressions: 9999,
    noindex: 0,
    normalizedUrl: 'https://example.com/wp-content/uploads/forecast-chart.jpg',
    pageKey: '/wp-content/uploads/forecast-chart.jpg',
    position: 5,
    sessions: 100,
    statusCode: 200,
    title: 'Forecast chart image',
    topQueries: ['forecast my traffic'],
    url: 'https://example.com/wp-content/uploads/forecast-chart.jpg',
    wordCount: 0,
  },
];

const recommendations = generateFixtureRecommendations({
  existingLinks: [{ fromPageKey: '/not-provided-keywords-google-analytics', toPageKey: '/google-search-console-mcp' }],
  sources,
  targets,
});

const byAnchor = new Map(recommendations.map((row) => [normalizeText(row.anchorText).toLowerCase(), row]));

assertEqual(recommendations.length, 2, 'Golden fixture emits only the two valid editorial links after existing-link and asset suppression');
assert(recommendations.scoredPairs < recommendations.bruteForcePairs, 'Golden fixture scores a narrowed candidate set instead of every eligible source-target sentence pair');
assert(byAnchor.has('queries google will not reveal'), 'Golden fixture finds the query-hiding contextual anchor');
assert(byAnchor.has('forecast my traffic'), 'Golden fixture finds the forecasting contextual anchor');
assert(!byAnchor.has('identifying striking distance keywords'), 'Existing source-target links suppress otherwise valid repeated recommendations');
assert(!recommendations.some((row) => /\.(?:jpg|jpeg|png|gif|webp|svg|pdf)(?:[?#].*)?$/i.test(row.targetUrl)), 'Golden fixture never links to assets');
assert(!recommendations.some((row) => normalizeText(row.anchorText).toLowerCase() === 'click here'), 'Golden fixture rejects generic anchors');

for (const row of recommendations) {
  assertEqual(row.sourceSentence.slice(row.anchorStart, row.anchorEnd), row.anchorText, `Anchor offsets slice back exactly for ${row.anchorText}`);
  assert(row.readerBenefit.includes(row.targetTitle), `Reader benefit names the target page for ${row.anchorText}`);
  assert(row.readerBenefit.length >= 90, `Reader benefit is specific enough for ${row.anchorText}`);
  assert(row.priorityScore >= 50, `Priority score clears the recommendation floor for ${row.anchorText}`);
}

console.log(`${recommendations.length} golden internal-link quality fixtures passed.`);




