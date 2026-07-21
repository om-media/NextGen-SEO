import assert from 'node:assert/strict';
import {
  analyzePageAuthorityDataset,
  type PageAuthorityBlockInput,
  type PageAuthorityDomNodeInput,
  type PageAuthorityPageInput,
  type PageAuthorityPageAnalysis,
  type PageAuthorityPageType,
  type PageAuthorityRegionInput,
  type PageAuthorityTask,
} from '../server/services/pageAuthority.js';

type ExpectedProfile = {
  pageType: PageAuthorityPageType;
  task: PageAuthorityTask;
};

const COMMON_HEADER_BLOCK: PageAuthorityBlockInput = {
  kind: 'nav',
  label: 'Primary navigation',
  itemCount: 6,
  linkCount: 6,
  depth: 1,
  repeatedHint: 'site-header',
};

const COMMON_BREADCRUMB_BLOCK: PageAuthorityBlockInput = {
  kind: 'breadcrumbs',
  label: 'Breadcrumb trail',
  itemCount: 3,
  linkCount: 3,
  depth: 2,
  repeatedHint: 'breadcrumbs',
};

const COMMON_FOOTER_BLOCK: PageAuthorityBlockInput = {
  kind: 'footer',
  label: 'Footer links',
  itemCount: 10,
  linkCount: 10,
  depth: 1,
  repeatedHint: 'site-footer',
};

const NEWSLETTER_BLOCK: PageAuthorityBlockInput = {
  kind: 'cta',
  label: 'Get SEO updates',
  action: 'subscribe',
  itemCount: 1,
  linkCount: 1,
  depth: 2,
  repeatedHint: 'newsletter-cta',
};

function articleDom(): PageAuthorityDomNodeInput[] {
  return [
    { tag: 'header', role: 'banner', depth: 1, childCount: 3, textLength: 40, classes: ['site-header'] },
    { tag: 'nav', role: 'navigation', depth: 2, childCount: 6, textLength: 24, classes: ['primary-nav'] },
    { tag: 'main', role: 'main', depth: 1, childCount: 5, textLength: 220, classes: ['article-shell'] },
    { tag: 'article', depth: 2, childCount: 8, textLength: 180, classes: ['prose', 'article-body'] },
    { tag: 'aside', role: 'complementary', depth: 2, childCount: 2, textLength: 60, classes: ['author-box'] },
    { tag: 'footer', role: 'contentinfo', depth: 1, childCount: 4, textLength: 30, classes: ['site-footer'] },
  ];
}

function serviceDom(): PageAuthorityDomNodeInput[] {
  return [
    { tag: 'header', role: 'banner', depth: 1, childCount: 3, textLength: 36, classes: ['site-header'] },
    { tag: 'nav', role: 'navigation', depth: 2, childCount: 6, textLength: 22, classes: ['primary-nav'] },
    { tag: 'main', role: 'main', depth: 1, childCount: 6, textLength: 180, classes: ['service-shell'] },
    { tag: 'section', depth: 2, childCount: 3, textLength: 80, classes: ['hero', 'service-hero'] },
    { tag: 'section', depth: 2, childCount: 6, textLength: 120, classes: ['benefits-grid'] },
    { tag: 'section', depth: 2, childCount: 5, textLength: 90, classes: ['pricing-strip'] },
    { tag: 'footer', role: 'contentinfo', depth: 1, childCount: 4, textLength: 30, classes: ['site-footer'] },
  ];
}

function productDom(): PageAuthorityDomNodeInput[] {
  return [
    { tag: 'header', role: 'banner', depth: 1, childCount: 3, textLength: 36, classes: ['site-header'] },
    { tag: 'nav', role: 'navigation', depth: 2, childCount: 6, textLength: 22, classes: ['primary-nav'] },
    { tag: 'main', role: 'main', depth: 1, childCount: 6, textLength: 190, classes: ['product-shell'] },
    { tag: 'section', depth: 2, childCount: 3, textLength: 70, classes: ['gallery'] },
    { tag: 'section', depth: 2, childCount: 5, textLength: 85, classes: ['specs-table'] },
    { tag: 'section', depth: 2, childCount: 4, textLength: 55, classes: ['reviews-panel'] },
    { tag: 'footer', role: 'contentinfo', depth: 1, childCount: 4, textLength: 30, classes: ['site-footer'] },
  ];
}

function faqDom(): PageAuthorityDomNodeInput[] {
  return [
    { tag: 'header', role: 'banner', depth: 1, childCount: 3, textLength: 36, classes: ['site-header'] },
    { tag: 'nav', role: 'navigation', depth: 2, childCount: 6, textLength: 22, classes: ['primary-nav'] },
    { tag: 'main', role: 'main', depth: 1, childCount: 5, textLength: 150, classes: ['faq-shell'] },
    { tag: 'section', depth: 2, childCount: 10, textLength: 120, classes: ['faq-accordion'] },
    { tag: 'section', depth: 2, childCount: 3, textLength: 50, classes: ['contact-cta'] },
    { tag: 'footer', role: 'contentinfo', depth: 1, childCount: 4, textLength: 30, classes: ['site-footer'] },
  ];
}

function buildBasePage(input: {
  id: string;
  url: string;
  title: string;
  metaDescription: string;
  wordCount: number;
  headings: Array<{ level: number; text: string }>;
  ctaTexts?: string[];
  structuredDataTypes?: string[];
  domNodes: PageAuthorityDomNodeInput[];
  regions: PageAuthorityRegionInput[];
  blocks: PageAuthorityBlockInput[];
  price?: string;
  ratingValue?: number;
  reviewCount?: number;
}): PageAuthorityPageInput {
  return {
    id: input.id,
    url: input.url,
    canonicalUrl: input.url,
    title: input.title,
    metaDescription: input.metaDescription,
    wordCount: input.wordCount,
    headings: input.headings,
    breadcrumbs: ['Home', 'SEO'],
    ctaTexts: input.ctaTexts || [],
    structuredDataTypes: input.structuredDataTypes || [],
    domNodes: input.domNodes,
    regions: input.regions,
    blocks: input.blocks,
    price: input.price,
    ratingValue: input.ratingValue,
    reviewCount: input.reviewCount,
  };
}

function articlePage(id: string, slug: string, title: string): PageAuthorityPageInput {
  return buildBasePage({
    id,
    url: `https://example.com/blog/${slug}`,
    title,
    metaDescription: 'Editorial analysis for search growth teams.',
    wordCount: 1850,
    headings: [
      { level: 1, text: title },
      { level: 2, text: 'Why this issue happens' },
      { level: 2, text: 'What the data means' },
      { level: 2, text: 'What to do next' },
    ],
    ctaTexts: ['Subscribe'],
    structuredDataTypes: ['Article'],
    domNodes: articleDom(),
    regions: [
      { kind: 'hero', heading: title, itemCount: 1, linkCount: 0 },
      { kind: 'main', heading: 'Article body', itemCount: 4, linkCount: 6 },
      { kind: 'sidebar', heading: 'Author', itemCount: 1, linkCount: 1 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      COMMON_BREADCRUMB_BLOCK,
      { kind: 'article', label: 'Article body', itemCount: 4, linkCount: 6, depth: 2 },
      { kind: 'author', label: 'Author panel', itemCount: 1, linkCount: 1, depth: 2 },
      NEWSLETTER_BLOCK,
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function guidePage(): PageAuthorityPageInput {
  return buildBasePage({
    id: 'guide-ga4-migration',
    url: 'https://example.com/guides/ga4-migration-checklist',
    title: 'GA4 migration checklist for SEO teams',
    metaDescription: 'A step-by-step guide to migrate analytics without losing reporting continuity.',
    wordCount: 2200,
    headings: [
      { level: 1, text: 'GA4 migration checklist for SEO teams' },
      { level: 2, text: 'Preparation steps' },
      { level: 2, text: 'Tracking validation' },
      { level: 2, text: 'Reporting handoff' },
    ],
    ctaTexts: ['Download checklist'],
    structuredDataTypes: ['HowTo'],
    domNodes: [
      ...articleDom(),
      { tag: 'section', depth: 2, childCount: 5, textLength: 90, classes: ['steps'] },
      { tag: 'nav', role: 'navigation', depth: 2, childCount: 5, textLength: 30, classes: ['toc'] },
    ],
    regions: [
      { kind: 'hero', heading: 'GA4 migration checklist for SEO teams', itemCount: 1, linkCount: 0 },
      { kind: 'toc', heading: 'Checklist sections', itemCount: 5, linkCount: 5 },
      { kind: 'steps', heading: 'Step-by-step checklist', itemCount: 8, linkCount: 4 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      COMMON_BREADCRUMB_BLOCK,
      { kind: 'toc', label: 'Checklist navigation', itemCount: 5, linkCount: 5, depth: 2 },
      { kind: 'steps', label: 'Migration steps', itemCount: 8, linkCount: 4, depth: 2 },
      NEWSLETTER_BLOCK,
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function hubPage(): PageAuthorityPageInput {
  return buildBasePage({
    id: 'hub-seo-resources',
    url: 'https://example.com/resources/',
    title: 'SEO resources hub',
    metaDescription: 'Browse guides, tools, templates, and benchmarks by workflow.',
    wordCount: 780,
    headings: [
      { level: 1, text: 'SEO resources hub' },
      { level: 2, text: 'Guides' },
      { level: 2, text: 'Templates' },
      { level: 2, text: 'Benchmarks' },
    ],
    ctaTexts: ['Browse resources'],
    domNodes: [
      { tag: 'header', role: 'banner', depth: 1, childCount: 3, textLength: 32, classes: ['site-header'] },
      { tag: 'nav', role: 'navigation', depth: 2, childCount: 6, textLength: 22, classes: ['primary-nav'] },
      { tag: 'main', role: 'main', depth: 1, childCount: 6, textLength: 120, classes: ['hub-shell'] },
      { tag: 'section', depth: 2, childCount: 6, textLength: 70, classes: ['resource-grid'] },
      { tag: 'section', depth: 2, childCount: 6, textLength: 70, classes: ['resource-grid'] },
      { tag: 'footer', role: 'contentinfo', depth: 1, childCount: 4, textLength: 30, classes: ['site-footer'] },
    ],
    regions: [
      { kind: 'hero', heading: 'SEO resources hub', itemCount: 1, linkCount: 0 },
      { kind: 'listing', heading: 'Guides', itemCount: 6, linkCount: 6 },
      { kind: 'listing', heading: 'Templates', itemCount: 5, linkCount: 5 },
      { kind: 'listing', heading: 'Benchmarks', itemCount: 4, linkCount: 4 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      { kind: 'hero', label: 'Resources overview', itemCount: 1, linkCount: 0, depth: 2 },
      { kind: 'listing', label: 'Guides', itemCount: 6, linkCount: 6, depth: 2 },
      { kind: 'listing', label: 'Templates', itemCount: 5, linkCount: 5, depth: 2 },
      { kind: 'listing', label: 'Benchmarks', itemCount: 4, linkCount: 4, depth: 2 },
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function categoryPage(id: string, slug: string, title: string): PageAuthorityPageInput {
  return buildBasePage({
    id,
    url: `https://example.com/software/${slug}`,
    title,
    metaDescription: 'Compare curated products inside a focused category.',
    wordCount: 620,
    headings: [
      { level: 1, text: title },
      { level: 2, text: 'Featured products' },
      { level: 2, text: 'Filtering options' },
    ],
    ctaTexts: ['View product'],
    domNodes: [
      { tag: 'header', role: 'banner', depth: 1, childCount: 3, textLength: 32, classes: ['site-header'] },
      { tag: 'nav', role: 'navigation', depth: 2, childCount: 6, textLength: 22, classes: ['primary-nav'] },
      { tag: 'main', role: 'main', depth: 1, childCount: 5, textLength: 140, classes: ['category-shell'] },
      { tag: 'section', depth: 2, childCount: 8, textLength: 70, classes: ['filters'] },
      { tag: 'section', depth: 2, childCount: 12, textLength: 90, classes: ['cards'] },
      { tag: 'footer', role: 'contentinfo', depth: 1, childCount: 4, textLength: 30, classes: ['site-footer'] },
    ],
    regions: [
      { kind: 'hero', heading: title, itemCount: 1, linkCount: 0 },
      { kind: 'filters', heading: 'Category filters', itemCount: 8, linkCount: 0 },
      { kind: 'listing', heading: 'Featured products', itemCount: 12, linkCount: 12 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      { kind: 'filters', label: 'Category filters', itemCount: 8, linkCount: 0, depth: 2 },
      { kind: 'cards', label: 'Product cards', itemCount: 12, linkCount: 12, depth: 2 },
      NEWSLETTER_BLOCK,
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function servicePage(id: string, slug: string, title: string): PageAuthorityPageInput {
  return buildBasePage({
    id,
    url: `https://example.com/services/${slug}`,
    title,
    metaDescription: 'Service page built to book a consultation and explain deliverables.',
    wordCount: 1150,
    headings: [
      { level: 1, text: title },
      { level: 2, text: 'What is included' },
      { level: 2, text: 'Who this is for' },
      { level: 2, text: 'Book a consultation' },
    ],
    ctaTexts: ['Request quote', 'Book consultation'],
    domNodes: serviceDom(),
    regions: [
      { kind: 'hero', heading: title, itemCount: 1, linkCount: 0 },
      { kind: 'benefits', heading: 'What is included', itemCount: 6, linkCount: 0 },
      { kind: 'pricing', heading: 'Book a consultation', itemCount: 3, linkCount: 1 },
      { kind: 'testimonials', heading: 'Client proof', itemCount: 3, linkCount: 0 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      COMMON_BREADCRUMB_BLOCK,
      { kind: 'hero', label: 'Service hero', itemCount: 1, linkCount: 0, depth: 2 },
      { kind: 'benefits', label: 'Service deliverables', itemCount: 6, linkCount: 0, depth: 2 },
      { kind: 'pricing', label: 'Consultation options', itemCount: 3, linkCount: 1, depth: 2 },
      { kind: 'testimonials', label: 'Client proof', itemCount: 3, linkCount: 0, depth: 2 },
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function productPage(id: string, slug: string, title: string): PageAuthorityPageInput {
  return buildBasePage({
    id,
    url: `https://example.com/products/${slug}`,
    title,
    metaDescription: 'Product page with specifications, pricing, and reviews.',
    wordCount: 980,
    headings: [
      { level: 1, text: title },
      { level: 2, text: 'Specifications' },
      { level: 2, text: 'Reviews' },
    ],
    ctaTexts: ['Buy now'],
    structuredDataTypes: ['Product'],
    domNodes: productDom(),
    regions: [
      { kind: 'hero', heading: title, itemCount: 1, linkCount: 0 },
      { kind: 'gallery', heading: 'Screenshots', itemCount: 5, linkCount: 0 },
      { kind: 'specs', heading: 'Specifications', itemCount: 8, linkCount: 0 },
      { kind: 'reviews', heading: 'Reviews', itemCount: 4, linkCount: 0 },
      { kind: 'pricing', heading: 'Buy now', itemCount: 2, linkCount: 1 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      COMMON_BREADCRUMB_BLOCK,
      { kind: 'gallery', label: 'Product gallery', itemCount: 5, linkCount: 0, depth: 2 },
      { kind: 'specs', label: 'Specifications table', itemCount: 8, linkCount: 0, depth: 2 },
      { kind: 'reviews', label: 'Customer reviews', itemCount: 4, linkCount: 0, depth: 2 },
      { kind: 'pricing', label: 'Buy now', action: 'buy', itemCount: 2, linkCount: 1, depth: 2 },
      COMMON_FOOTER_BLOCK,
    ],
    price: '$99/mo',
    ratingValue: 4.8,
    reviewCount: 128,
  });
}

function comparisonPage(): PageAuthorityPageInput {
  return buildBasePage({
    id: 'comparison-ga4-vs-gsc',
    url: 'https://example.com/compare/ga4-vs-search-console',
    title: 'GA4 vs Search Console comparison',
    metaDescription: 'A side-by-side comparison for traffic and SEO reporting.',
    wordCount: 1450,
    headings: [
      { level: 1, text: 'GA4 vs Search Console comparison' },
      { level: 2, text: 'Feature matrix' },
      { level: 2, text: 'Which one is better for SEO?' },
    ],
    ctaTexts: ['View product'],
    domNodes: [
      ...articleDom(),
      { tag: 'table', depth: 2, childCount: 12, textLength: 120, classes: ['comparison-table'] },
    ],
    regions: [
      { kind: 'hero', heading: 'GA4 vs Search Console comparison', itemCount: 1, linkCount: 0 },
      { kind: 'comparison', heading: 'Feature matrix', itemCount: 12, linkCount: 0 },
      { kind: 'reviews', heading: 'Analyst verdict', itemCount: 3, linkCount: 0 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      COMMON_BREADCRUMB_BLOCK,
      { kind: 'table', label: 'Feature comparison', itemCount: 12, linkCount: 0, depth: 2 },
      { kind: 'reviews', label: 'Verdict summary', itemCount: 3, linkCount: 0, depth: 2 },
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function toolPage(): PageAuthorityPageInput {
  return buildBasePage({
    id: 'tool-seo-roi-calculator',
    url: 'https://example.com/tools/seo-roi-calculator',
    title: 'SEO ROI calculator',
    metaDescription: 'Estimate revenue impact from SEO growth scenarios.',
    wordCount: 540,
    headings: [
      { level: 1, text: 'SEO ROI calculator' },
      { level: 2, text: 'Enter your inputs' },
      { level: 2, text: 'Projected return' },
    ],
    ctaTexts: ['Start calculation'],
    domNodes: [
      { tag: 'header', role: 'banner', depth: 1, childCount: 3, textLength: 32, classes: ['site-header'] },
      { tag: 'nav', role: 'navigation', depth: 2, childCount: 6, textLength: 22, classes: ['primary-nav'] },
      { tag: 'main', role: 'main', depth: 1, childCount: 4, textLength: 90, classes: ['tool-shell'] },
      { tag: 'form', depth: 2, childCount: 8, textLength: 65, classes: ['calculator-form'] },
      { tag: 'section', depth: 2, childCount: 3, textLength: 55, classes: ['results-panel'] },
      { tag: 'footer', role: 'contentinfo', depth: 1, childCount: 4, textLength: 30, classes: ['site-footer'] },
    ],
    regions: [
      { kind: 'hero', heading: 'SEO ROI calculator', itemCount: 1, linkCount: 0 },
      { kind: 'form', heading: 'Calculator inputs', itemCount: 8, linkCount: 0 },
      { kind: 'results', heading: 'Projected return', itemCount: 3, linkCount: 0 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      { kind: 'form', label: 'Calculator inputs', itemCount: 8, linkCount: 0, depth: 2 },
      { kind: 'results', label: 'Projected return', itemCount: 3, linkCount: 0, depth: 2 },
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function faqPage(id: string, slug: string, title: string): PageAuthorityPageInput {
  return buildBasePage({
    id,
    url: `https://example.com/faq/${slug}`,
    title,
    metaDescription: 'Answer common migration questions and objections.',
    wordCount: 890,
    headings: [
      { level: 1, text: title },
      { level: 2, text: 'Common questions' },
      { level: 2, text: 'Still need help?' },
    ],
    ctaTexts: ['Contact support'],
    structuredDataTypes: ['FAQPage'],
    domNodes: faqDom(),
    regions: [
      { kind: 'hero', heading: title, itemCount: 1, linkCount: 0 },
      { kind: 'faq', heading: 'Common questions', itemCount: 8, linkCount: 0 },
      { kind: 'form', heading: 'Still need help?', itemCount: 2, linkCount: 1 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      COMMON_BREADCRUMB_BLOCK,
      { kind: 'accordion', label: 'Common questions', itemCount: 8, linkCount: 0, depth: 2 },
      { kind: 'faq', label: 'Questions and answers', itemCount: 8, linkCount: 0, depth: 2 },
      { kind: 'form', label: 'Support handoff', itemCount: 2, linkCount: 1, depth: 2 },
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function locationPage(): PageAuthorityPageInput {
  return buildBasePage({
    id: 'location-zagreb-office',
    url: 'https://example.com/locations/zagreb-office',
    title: 'Zagreb SEO office',
    metaDescription: 'Office hours, directions, and local coverage details.',
    wordCount: 740,
    headings: [
      { level: 1, text: 'Zagreb SEO office' },
      { level: 2, text: 'Directions' },
      { level: 2, text: 'Office hours' },
    ],
    ctaTexts: ['Get directions'],
    structuredDataTypes: ['LocalBusiness'],
    domNodes: [
      { tag: 'header', role: 'banner', depth: 1, childCount: 3, textLength: 32, classes: ['site-header'] },
      { tag: 'nav', role: 'navigation', depth: 2, childCount: 6, textLength: 22, classes: ['primary-nav'] },
      { tag: 'main', role: 'main', depth: 1, childCount: 5, textLength: 100, classes: ['location-shell'] },
      { tag: 'section', depth: 2, childCount: 2, textLength: 50, classes: ['hours'] },
      { tag: 'section', depth: 2, childCount: 1, textLength: 40, classes: ['map'] },
      { tag: 'footer', role: 'contentinfo', depth: 1, childCount: 4, textLength: 30, classes: ['site-footer'] },
    ],
    regions: [
      { kind: 'hero', heading: 'Zagreb SEO office', itemCount: 1, linkCount: 0 },
      { kind: 'map', heading: 'Directions', itemCount: 1, linkCount: 0 },
      { kind: 'hours', heading: 'Office hours', itemCount: 2, linkCount: 0 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      COMMON_BREADCRUMB_BLOCK,
      { kind: 'map', label: 'Map directions', itemCount: 1, linkCount: 0, depth: 2 },
      { kind: 'hours', label: 'Office hours', itemCount: 2, linkCount: 0, depth: 2 },
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function legalPage(): PageAuthorityPageInput {
  return buildBasePage({
    id: 'legal-privacy-policy',
    url: 'https://example.com/privacy-policy',
    title: 'Privacy policy',
    metaDescription: 'Legal processing, storage, and privacy terms.',
    wordCount: 2100,
    headings: [
      { level: 1, text: 'Privacy policy' },
      { level: 2, text: 'Data we collect' },
      { level: 2, text: 'Your rights' },
    ],
    ctaTexts: [],
    domNodes: articleDom(),
    regions: [
      { kind: 'hero', heading: 'Privacy policy', itemCount: 1, linkCount: 0 },
      { kind: 'main', heading: 'Policy content', itemCount: 6, linkCount: 2 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      { kind: 'article', label: 'Policy content', itemCount: 6, linkCount: 2, depth: 2 },
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function utilityPage(): PageAuthorityPageInput {
  return buildBasePage({
    id: 'utility-login',
    url: 'https://example.com/account/login',
    title: 'Login',
    metaDescription: 'Access your account workspace.',
    wordCount: 180,
    headings: [
      { level: 1, text: 'Login' },
    ],
    ctaTexts: ['Sign in'],
    domNodes: [
      { tag: 'header', role: 'banner', depth: 1, childCount: 3, textLength: 20, classes: ['site-header'] },
      { tag: 'main', role: 'main', depth: 1, childCount: 2, textLength: 50, classes: ['login-shell'] },
      { tag: 'form', depth: 2, childCount: 5, textLength: 35, classes: ['login-form'] },
      { tag: 'footer', role: 'contentinfo', depth: 1, childCount: 4, textLength: 20, classes: ['site-footer'] },
    ],
    regions: [
      { kind: 'hero', heading: 'Login', itemCount: 1, linkCount: 0 },
      { kind: 'form', heading: 'Account login', itemCount: 5, linkCount: 0 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      { kind: 'form', label: 'Account login', itemCount: 5, linkCount: 0, depth: 2 },
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function transactionalPage(): PageAuthorityPageInput {
  return buildBasePage({
    id: 'transactional-pricing',
    url: 'https://example.com/pricing',
    title: 'Pricing plans',
    metaDescription: 'Choose a plan and start your trial.',
    wordCount: 430,
    headings: [
      { level: 1, text: 'Pricing plans' },
      { level: 2, text: 'Plan comparison' },
    ],
    ctaTexts: ['Start trial'],
    domNodes: [
      { tag: 'header', role: 'banner', depth: 1, childCount: 3, textLength: 20, classes: ['site-header'] },
      { tag: 'main', role: 'main', depth: 1, childCount: 3, textLength: 60, classes: ['pricing-shell'] },
      { tag: 'section', depth: 2, childCount: 4, textLength: 40, classes: ['pricing-cards'] },
      { tag: 'footer', role: 'contentinfo', depth: 1, childCount: 4, textLength: 20, classes: ['site-footer'] },
    ],
    regions: [
      { kind: 'hero', heading: 'Pricing plans', itemCount: 1, linkCount: 0 },
      { kind: 'pricing', heading: 'Plan comparison', itemCount: 4, linkCount: 4 },
      { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
    ],
    blocks: [
      COMMON_HEADER_BLOCK,
      { kind: 'pricing', label: 'Plan comparison', itemCount: 4, linkCount: 4, depth: 2 },
      COMMON_FOOTER_BLOCK,
    ],
  });
}

function createStandardFixtures(): PageAuthorityPageInput[] {
  return [
    articlePage('article-crawl-depth', 'crawl-depth-audit-patterns', 'Crawl depth audit patterns'),
    articlePage('article-log-sampling', 'log-sampling-for-seo', 'Log sampling for SEO teams'),
    guidePage(),
    hubPage(),
    categoryPage('category-observability', 'seo-observability-tools', 'SEO observability software category'),
    categoryPage('category-crawlers', 'technical-seo-crawlers', 'Technical SEO crawler category'),
    servicePage('service-audit', 'technical-seo-audit', 'Technical SEO audit service'),
    servicePage('service-migration', 'site-migration-support', 'Site migration support service'),
    productPage('product-crawler', 'crawl-monitor-pro', 'Crawl Monitor Pro'),
    productPage('product-alerts', 'anomaly-alerts-cloud', 'Anomaly Alerts Cloud'),
    comparisonPage(),
    toolPage(),
    faqPage('faq-ga4', 'ga4-migration', 'GA4 migration FAQ'),
    faqPage('faq-crawl', 'crawl-budget', 'Crawl budget FAQ'),
    locationPage(),
    legalPage(),
    utilityPage(),
    transactionalPage(),
  ];
}

function createRecrawlFixtures(): Array<{ baseline: PageAuthorityPageInput; recrawl: PageAuthorityPageInput }> {
  return [
    {
      baseline: articlePage('article-baseline', 'crawl-depth-audit-patterns', 'Crawl depth audit patterns'),
      recrawl: buildBasePage({
        id: 'article-recrawl',
        url: 'https://example.com/blog/crawl-depth-audit-patterns',
        title: 'Crawl depth audit patterns for larger sites',
        metaDescription: 'Updated editorial analysis for search growth teams.',
        wordCount: 1960,
        headings: [
          { level: 1, text: 'Crawl depth audit patterns for larger sites' },
          { level: 2, text: 'Why this issue happens' },
          { level: 2, text: 'What the data means in 2026' },
          { level: 2, text: 'What to do next' },
        ],
        ctaTexts: ['Subscribe'],
        structuredDataTypes: ['Article'],
        domNodes: articleDom(),
        regions: [
          { kind: 'hero', heading: 'Crawl depth audit patterns for larger sites', itemCount: 1, linkCount: 0 },
          { kind: 'main', heading: 'Article body', itemCount: 4, linkCount: 7 },
          { kind: 'sidebar', heading: 'Author', itemCount: 1, linkCount: 1 },
          { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
        ],
        blocks: [
          COMMON_HEADER_BLOCK,
          COMMON_BREADCRUMB_BLOCK,
          { kind: 'article', label: 'Article body', itemCount: 4, linkCount: 7, depth: 2 },
          { kind: 'author', label: 'Author panel', itemCount: 1, linkCount: 1, depth: 2 },
          NEWSLETTER_BLOCK,
          COMMON_FOOTER_BLOCK,
        ],
      }),
    },
    {
      baseline: servicePage('service-baseline', 'technical-seo-audit', 'Technical SEO audit service'),
      recrawl: buildBasePage({
        id: 'service-recrawl',
        url: 'https://example.com/services/technical-seo-audit',
        title: 'Technical SEO audit service for enterprise teams',
        metaDescription: 'Updated deliverables and consultation details.',
        wordCount: 1240,
        headings: [
          { level: 1, text: 'Technical SEO audit service for enterprise teams' },
          { level: 2, text: 'What is included' },
          { level: 2, text: 'Who this is for' },
          { level: 2, text: 'Book a consultation' },
        ],
        ctaTexts: ['Request quote', 'Book consultation'],
        domNodes: serviceDom(),
        regions: [
          { kind: 'hero', heading: 'Technical SEO audit service for enterprise teams', itemCount: 1, linkCount: 0 },
          { kind: 'benefits', heading: 'What is included', itemCount: 6, linkCount: 0 },
          { kind: 'pricing', heading: 'Book a consultation', itemCount: 3, linkCount: 1 },
          { kind: 'testimonials', heading: 'Client proof', itemCount: 4, linkCount: 0 },
          { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
        ],
        blocks: [
          COMMON_HEADER_BLOCK,
          COMMON_BREADCRUMB_BLOCK,
          { kind: 'hero', label: 'Service hero', itemCount: 1, linkCount: 0, depth: 2 },
          { kind: 'benefits', label: 'Service deliverables', itemCount: 6, linkCount: 0, depth: 2 },
          { kind: 'pricing', label: 'Consultation options', itemCount: 3, linkCount: 1, depth: 2 },
          { kind: 'testimonials', label: 'Client proof', itemCount: 4, linkCount: 0, depth: 2 },
          COMMON_FOOTER_BLOCK,
        ],
      }),
    },
    {
      baseline: productPage('product-baseline', 'crawl-monitor-pro', 'Crawl Monitor Pro'),
      recrawl: buildBasePage({
        id: 'product-recrawl',
        url: 'https://example.com/products/crawl-monitor-pro',
        title: 'Crawl Monitor Pro platform',
        metaDescription: 'Updated product page with refreshed specs and reviews.',
        wordCount: 1040,
        headings: [
          { level: 1, text: 'Crawl Monitor Pro platform' },
          { level: 2, text: 'Specifications' },
          { level: 2, text: 'Reviews' },
        ],
        ctaTexts: ['Buy now'],
        structuredDataTypes: ['Product'],
        domNodes: productDom(),
        regions: [
          { kind: 'hero', heading: 'Crawl Monitor Pro platform', itemCount: 1, linkCount: 0 },
          { kind: 'gallery', heading: 'Screenshots', itemCount: 5, linkCount: 0 },
          { kind: 'specs', heading: 'Specifications', itemCount: 8, linkCount: 0 },
          { kind: 'reviews', heading: 'Reviews', itemCount: 5, linkCount: 0 },
          { kind: 'pricing', heading: 'Buy now', itemCount: 2, linkCount: 1 },
          { kind: 'footer', heading: 'Footer links', itemCount: 10, linkCount: 10 },
        ],
        blocks: [
          COMMON_HEADER_BLOCK,
          COMMON_BREADCRUMB_BLOCK,
          { kind: 'gallery', label: 'Product gallery', itemCount: 5, linkCount: 0, depth: 2 },
          { kind: 'specs', label: 'Specifications table', itemCount: 8, linkCount: 0, depth: 2 },
          { kind: 'reviews', label: 'Customer reviews', itemCount: 5, linkCount: 0, depth: 2 },
          { kind: 'pricing', label: 'Buy now', action: 'buy', itemCount: 2, linkCount: 1, depth: 2 },
          COMMON_FOOTER_BLOCK,
        ],
        price: '$99/mo',
        ratingValue: 4.9,
        reviewCount: 146,
      }),
    },
  ];
}

function byId(analyses: PageAuthorityPageAnalysis[]): Map<string, PageAuthorityPageAnalysis> {
  return new Map(analyses.map((analysis) => [analysis.pageId, analysis]));
}

function assertProfile(actual: PageAuthorityPageAnalysis | undefined, expected: ExpectedProfile) {
  assert(actual, 'Expected page analysis to exist.');
  assert.equal(actual.profile.pageType.label, expected.pageType, `Expected page type ${expected.pageType} for ${actual.pageId}.`);
  assert.equal(actual.profile.task.label, expected.task, `Expected task ${expected.task} for ${actual.pageId}.`);
  assert.ok(actual.profile.pageType.reasons.length > 0, `Expected page type reasons for ${actual.pageId}.`);
  assert.ok(actual.profile.task.reasons.length > 0, `Expected task reasons for ${actual.pageId}.`);
  assert.ok(actual.profile.pageType.confidence >= 0.2, `Expected non-trivial page type confidence for ${actual.pageId}.`);
}

function findClusterByMember(
  analysis: ReturnType<typeof analyzePageAuthorityDataset>,
  pageIds: string[],
) {
  return analysis.clusters.clusters.find((cluster) => pageIds.every((pageId) => cluster.memberPageIds.includes(pageId)));
}

function runStandardFixtureChecks() {
  const fixtures = createStandardFixtures();
  const analysis = analyzePageAuthorityDataset(fixtures);
  const pageMap = byId(analysis.pages);

  const expectations: Record<string, ExpectedProfile> = {
    'article-crawl-depth': { pageType: 'article', task: 'learn' },
    'article-log-sampling': { pageType: 'article', task: 'learn' },
    'guide-ga4-migration': { pageType: 'guide', task: 'learn' },
    'hub-seo-resources': { pageType: 'hub', task: 'navigate' },
    'category-observability': { pageType: 'category', task: 'find' },
    'category-crawlers': { pageType: 'category', task: 'find' },
    'service-audit': { pageType: 'service', task: 'buy_or_hire' },
    'service-migration': { pageType: 'service', task: 'buy_or_hire' },
    'product-crawler': { pageType: 'product', task: 'buy_or_hire' },
    'product-alerts': { pageType: 'product', task: 'buy_or_hire' },
    'comparison-ga4-vs-gsc': { pageType: 'comparison', task: 'compare' },
    'tool-seo-roi-calculator': { pageType: 'tool', task: 'calculate' },
    'faq-ga4': { pageType: 'faq', task: 'troubleshoot' },
    'faq-crawl': { pageType: 'faq', task: 'troubleshoot' },
    'location-zagreb-office': { pageType: 'location', task: 'find' },
    'legal-privacy-policy': { pageType: 'legal', task: 'reference' },
    'utility-login': { pageType: 'utility', task: 'navigate' },
    'transactional-pricing': { pageType: 'transactional', task: 'buy_or_hire' },
  };

  for (const [pageId, expected] of Object.entries(expectations)) {
    assertProfile(pageMap.get(pageId), expected);
  }

  const articleCluster = findClusterByMember(analysis, ['article-crawl-depth', 'article-log-sampling']);
  assert(articleCluster, 'Expected article pages to share a template cluster.');
  const serviceCluster = findClusterByMember(analysis, ['service-audit', 'service-migration']);
  assert(serviceCluster, 'Expected service pages to share a template cluster.');
  const productCluster = findClusterByMember(analysis, ['product-crawler', 'product-alerts']);
  assert(productCluster, 'Expected product pages to share a template cluster.');
  const faqCluster = findClusterByMember(analysis, ['faq-ga4', 'faq-crawl']);
  assert(faqCluster, 'Expected FAQ pages to share a template cluster.');
  const categoryCluster = findClusterByMember(analysis, ['category-observability', 'category-crawlers']);
  assert(categoryCluster, 'Expected category pages to share a template cluster.');

  const repeatedNav = analysis.repeatedBlocks.repeatedBlocks.find((entry) => entry.kind === 'nav');
  const repeatedFooter = analysis.repeatedBlocks.repeatedBlocks.find((entry) => entry.kind === 'footer');
  assert(repeatedNav, 'Expected shared navigation block to be detected as repeated.');
  assert(repeatedFooter, 'Expected shared footer block to be detected as repeated.');
  assert.ok((repeatedNav?.shareOfPages || 0) > 0.7, 'Expected navigation block to repeat across most fixtures.');
  assert.ok((repeatedFooter?.shareOfPages || 0) > 0.7, 'Expected footer block to repeat across most fixtures.');

  const articleRepeatedShare = analysis.repeatedBlocks.pageBreakdown['article-crawl-depth']?.repeatedShare || 0;
  assert.ok(articleRepeatedShare > 0.3, 'Expected article fixture to inherit repeated shell blocks.');

  console.log(`1 Standard fixture check passed for ${fixtures.length} pages and ${analysis.clusters.clusters.length} clusters.`);
}

function runRecrawlStabilityChecks() {
  const pairs = createRecrawlFixtures();

  for (const pair of pairs) {
    const analysis = analyzePageAuthorityDataset([pair.baseline, pair.recrawl]);
    const pageMap = byId(analysis.pages);
    const baseline = pageMap.get(pair.baseline.id);
    const recrawl = pageMap.get(pair.recrawl.id);
    assert(baseline && recrawl, 'Expected both baseline and recrawl analyses.');

    assert.equal(baseline.urlSkeleton.hash, recrawl.urlSkeleton.hash, `Expected stable URL skeleton for ${pair.baseline.id}.`);
    assert.equal(baseline.domSignature.hash, recrawl.domSignature.hash, `Expected stable DOM signature for ${pair.baseline.id}.`);
    assert.equal(baseline.regionSignature.hash, recrawl.regionSignature.hash, `Expected stable region signature for ${pair.baseline.id}.`);
    assert.equal(baseline.profile.pageType.label, recrawl.profile.pageType.label, `Expected stable page type for ${pair.baseline.id}.`);
    assert.equal(baseline.profile.task.label, recrawl.profile.task.label, `Expected stable task for ${pair.baseline.id}.`);

    const baselineClusterId = analysis.clusters.pageToClusterId[pair.baseline.id];
    const recrawlClusterId = analysis.clusters.pageToClusterId[pair.recrawl.id];
    assert.equal(baselineClusterId, recrawlClusterId, `Expected stable template cluster for ${pair.baseline.id}.`);
  }

  console.log(`2 Recrawl stability check passed for ${pairs.length} template pairs.`);
}

runStandardFixtureChecks();
runRecrawlStabilityChecks();
