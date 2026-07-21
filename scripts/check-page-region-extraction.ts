import assert from 'node:assert/strict';
import { __crawlExtractionTestUtils } from '../server/services/crawl.js';

const START_URL = 'https://example.com/guides/acoustic-treatment';

const html = `
<!doctype html>
<html lang="en">
  <head>
    <title>Acoustic Treatment Guide | Example</title>
    <meta name="description" content="Learn how to compare panels, use the room calculator, and place internal links with confidence." />
  </head>
  <body>
    <header class="site-header hero">
      <nav class="primary-navigation">
        <a href="/products">Products</a>
        <a href="/guides">Guides</a>
        <a href="/contact">Contact</a>
      </nav>
      <div class="breadcrumb-trail">
        <a href="/">Home</a>
        <a href="/guides">Guides</a>
        <span>Acoustic Treatment Guide</span>
      </div>
      <section class="hero-banner">
        <h1>Acoustic Treatment Guide</h1>
        <p>Plan quieter rooms with practical placement advice, product comparisons, and contextual recommendations that help readers move naturally to the next useful page.</p>
        <div class="cta-panel">
          <p>Book a demo to review your treatment plan with our team.</p>
          <a href="/book-demo">Book demo</a>
        </div>
      </section>
    </header>

    <main>
      <aside class="sidebar toc-sidebar">
        <div class="table-of-contents">
          <h2>Table of Contents</h2>
          <ul>
            <li><a href="#basics">Basics</a></li>
            <li><a href="#compare">Compare panels</a></li>
            <li><a href="#faq">FAQ</a></li>
          </ul>
        </div>
        <div class="related-links">
          <h2>Related resources</h2>
          <p>Read more about room planning and installation before choosing treatment depth.</p>
          <a href="/guides/room-planning">Room planning</a>
        </div>
      </aside>

      <article>
        <section id="basics">
          <h2>Basics</h2>
          <p>Start by measuring the room, identifying reflective surfaces, and reviewing which landing page should receive the strongest editorial internal links from this guide.</p>
          <h3>Placement checklist</h3>
          <p>Step-by-step installation advice should sit beside a contextual link to the product family page so readers can move from education to evaluation without losing the narrative thread.</p>
        </section>

        <section id="compare" class="comparison-grid">
          <h2>Compare panels</h2>
          <p>Compare foam and fabric systems by depth, absorption range, installation effort, and the commercial use cases each option supports.</p>
          <div class="product-grid">
            <article>
              <h3>Fabric panel</h3>
              <p>Fabric wrapped panels suit offices and showrooms where finish quality matters alongside broadband control.</p>
              <a href="/products/fabric-panels">Fabric panels</a>
            </article>
            <article>
              <h3>Foam panel</h3>
              <p>Foam panels are lighter and faster to install when budget and coverage speed matter most.</p>
              <a href="/products/foam-panels">Foam panels</a>
            </article>
          </div>
        </section>

        <section class="tool calculator-tool">
          <h2>Room calculator</h2>
          <p>Use the calculator to estimate panel counts, then link readers toward the quote request page once the result gives them a realistic scope.</p>
        </section>

        <form class="quote-form">
          <h2>Request a quote</h2>
          <p>Share room dimensions and budget so we can recommend the right panel mix for the project.</p>
          <label>Name <input type="text" name="name" /></label>
          <button type="submit">Send</button>
        </form>

        <section id="faq" class="faq-block">
          <h2>FAQ</h2>
          <h3>Can treatment improve speech clarity?</h3>
          <p>Yes. Reducing early reflections often improves intelligibility, especially when the article also links to the installation walkthrough for the next step.</p>
          <h3>Should I treat the ceiling?</h3>
          <p>Treat the ceiling when flutter echo or strong vertical reflections remain after wall coverage is installed.</p>
        </section>
      </article>
    </main>

    <footer class="site-footer">
      <p>Privacy policy and newsletter updates for architects and installers.</p>
      <p>Privacy policy and newsletter updates for architects and installers.</p>
      <a href="/privacy">Privacy policy</a>
    </footer>
  </body>
</html>
`;

const whitespaceVariant = html
  .replace(/>\s+</g, '>\n    <')
  .replace(/Plan quieter rooms/g, 'Plan    quieter   rooms')
  .replace(/Read more about room planning/g, 'Read   more about room planning');

const snapshot = __crawlExtractionTestUtils.extractPageSnapshot(
  html,
  new Headers({ 'content-type': 'text/html' }),
  START_URL,
  START_URL,
  { includeQueryStrings: false },
);

const snapshotVariant = __crawlExtractionTestUtils.extractPageSnapshot(
  whitespaceVariant,
  new Headers({ 'content-type': 'text/html' }),
  START_URL,
  START_URL,
  { includeQueryStrings: false },
);

const roles = new Set(snapshot.regions.map((region) => region.regionRole));
for (const requiredRole of [
  'header',
  'navigation',
  'breadcrumb',
  'hero',
  'table_of_contents',
  'main',
  'section',
  'sidebar',
  'faq',
  'comparison',
  'product_grid',
  'tool',
  'form',
  'related_content',
  'cta',
  'footer',
] as const) {
  assert(roles.has(requiredRole), `missing semantic role: ${requiredRole}`);
}

const placementBlock = snapshot.textBlocks.find((block) => block.text.includes('Step-by-step installation advice'));
assert(placementBlock, 'expected placement checklist block');
assert.equal(placementBlock.extractionVersion, 3, 'expected extraction version 3');
assert.deepEqual(JSON.parse(placementBlock.headingChainJson), ['Acoustic Treatment Guide', 'Basics', 'Placement checklist']);
assert.match(placementBlock.domPath, /article/i, 'expected article in DOM path');
assert.match(placementBlock.selector, /^p/, 'expected paragraph selector');
assert(placementBlock.blockKey.startsWith('blk_'), 'expected stable block key prefix');

const footerBlocks = snapshot.textBlocks.filter((block) => block.regionRole === 'footer');
assert(footerBlocks.length >= 1, 'expected footer blocks');
assert(footerBlocks.some((block) => block.boilerplateScore >= 0.7), 'expected high boilerplate footer score');

const relatedBlock = snapshot.textBlocks.find((block) => block.regionRole === 'related_content');
assert(relatedBlock && relatedBlock.boilerplateScore >= 0.45, 'expected related content boilerplate score');

const blockByKey = new Map(snapshot.textBlocks.map((block) => [block.blockKey, block]));

const faqSentence = snapshot.sentences.find((sentence) => sentence.regionRole === 'faq' && sentence.sentenceText.includes('Reducing early reflections'));
assert(faqSentence, 'expected FAQ sentence extraction');
assert.equal(faqSentence.pageType, 'faq', 'expected FAQ page type');
assert(faqSentence.visualProminence > 0.55, 'expected FAQ sentence prominence');
assert(snapshot.sentences.every((sentence) => sentence.extractionVersion === 3), 'expected sentence extraction version 3');
const parentBlock = blockByKey.get(faqSentence.blockKey);
assert(parentBlock, 'expected sentence parent block lookup');
assert.equal(faqSentence.blockKey, parentBlock.blockKey, 'expected structural sentence-to-block linkage');

const compareLink = snapshot.internalLinks.find((link) => link.url.endsWith('/products/fabric-panels'));
assert(compareLink, 'expected comparison link metadata');
assert.equal(compareLink.regionRole, 'product_grid');
assert.equal(compareLink.blockType, 'a');
assert(compareLink.visualProminence > 0.35, 'expected link prominence');

const quoteLink = snapshot.internalLinks.find((link) => link.url.endsWith('/book-demo'));
assert(quoteLink, 'expected CTA link metadata');
assert.equal(quoteLink.regionRole, 'cta');

for (const variantBlock of snapshotVariant.textBlocks) {
  const baseline = blockByKey.get(variantBlock.blockKey);
  if (!baseline) {
    continue;
  }
  assert.equal(variantBlock.textHash, baseline.textHash, `stable text hash mismatch for ${variantBlock.blockKey}`);
  assert.equal(variantBlock.headingChainJson, baseline.headingChainJson, `stable heading chain mismatch for ${variantBlock.blockKey}`);
}

console.log(`Semantic region extraction fixture passed with ${snapshot.textBlocks.length} blocks, ${snapshot.sentences.length} sentences, and ${snapshot.internalLinks.length} links.`);