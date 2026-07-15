import assert from 'node:assert/strict';
import {
  pendingAnalysisStorageKey,
  shouldBootstrapInternalLinkAnalysis,
  shouldStartAnalysisAfterCrawl,
} from './internalLinkLifecycle.js';

const completedCrawl = { id: 'crawl-complete', status: 'completed' };

assert.equal(
  shouldStartAnalysisAfterCrawl('crawl-complete', completedCrawl, false),
  true,
  'a completed requested crawl starts analysis',
);
assert.equal(
  shouldStartAnalysisAfterCrawl('another-crawl', completedCrawl, false),
  false,
  'an unrelated completed crawl does not consume the pending intent',
);
assert.equal(
  shouldStartAnalysisAfterCrawl('crawl-complete', completedCrawl, true),
  false,
  'an active analysis prevents a duplicate job',
);
assert.equal(
  shouldStartAnalysisAfterCrawl('crawl-complete', { id: 'crawl-complete', status: 'running' }, false),
  false,
  'analysis waits for sentence extraction to finish',
);

assert.equal(
  shouldBootstrapInternalLinkAnalysis({
    analysisRunning: false,
    crawlJob: completedCrawl,
    jobCount: 0,
    jobsLoaded: true,
    usableSentenceCount: 14_897,
  }),
  true,
  'a site with sentence context and no prior analysis starts its first analysis automatically',
);
assert.equal(
  shouldBootstrapInternalLinkAnalysis({
    analysisRunning: false,
    crawlJob: completedCrawl,
    jobCount: 1,
    jobsLoaded: true,
    usableSentenceCount: 14_897,
  }),
  false,
  'existing analysis history prevents an unexpected bootstrap rerun',
);
assert.equal(
  pendingAnalysisStorageKey('sc-domain:example.com'),
  'nextgen-seo:internal-links:analyze-after-crawl:sc-domain:example.com',
  'pending crawl intent is isolated by workspace site',
);

console.log('Internal link crawl lifecycle checks passed.');
