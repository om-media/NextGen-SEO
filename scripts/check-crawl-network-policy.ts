import assert from 'node:assert/strict';
import {
  isBlockedCrawlAddress,
  resolveSafeCrawlTarget,
  UnsafeCrawlTargetError,
  type CrawlAddressResolver,
} from '../server/services/crawlNetworkPolicy.js';

const publicResolver: CrawlAddressResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const privateResolver: CrawlAddressResolver = async () => [{ address: '10.20.30.40', family: 4 }];
const mixedResolver: CrawlAddressResolver = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '169.254.169.254', family: 4 },
];

async function rejectsUnsafe(run: () => Promise<unknown>, message: string) {
  await assert.rejects(run, (error) => error instanceof UnsafeCrawlTargetError, message);
}

assert.equal(isBlockedCrawlAddress('127.0.0.1'), true);
assert.equal(isBlockedCrawlAddress('169.254.169.254'), true);
assert.equal(isBlockedCrawlAddress('10.0.0.1'), true);
assert.equal(isBlockedCrawlAddress('::1'), true);
assert.equal(isBlockedCrawlAddress('fc00::1'), true);
assert.equal(isBlockedCrawlAddress('::ffff:7f00:1'), true);
assert.equal(isBlockedCrawlAddress('93.184.216.34'), false);

await rejectsUnsafe(
  () => resolveSafeCrawlTarget('http://127.0.0.1/admin', 'example.com', publicResolver),
  'Loopback literals must be rejected.',
);
await rejectsUnsafe(
  () => resolveSafeCrawlTarget('http://2130706433/admin', '127.0.0.1', publicResolver),
  'Alternate IPv4 loopback notation must be rejected.',
);
await rejectsUnsafe(
  () => resolveSafeCrawlTarget('https://example.com/sitemap.xml', 'example.com', privateResolver),
  'Hostnames resolving to private addresses must be rejected.',
);
await rejectsUnsafe(
  () => resolveSafeCrawlTarget('https://example.com/sitemap.xml', 'example.com', mixedResolver),
  'Mixed public/private DNS answers must be rejected.',
);
await rejectsUnsafe(
  () => resolveSafeCrawlTarget('https://other.example/sitemap.xml', 'example.com', publicResolver),
  'Cross-host crawl targets must be rejected.',
);
await rejectsUnsafe(
  () => resolveSafeCrawlTarget('https://user:pass@example.com/', 'example.com', publicResolver),
  'Credential-bearing crawl URLs must be rejected.',
);

const accepted = await resolveSafeCrawlTarget('https://www.example.com/sitemap.xml', 'example.com', publicResolver);
assert.equal(accepted.url.hostname, 'www.example.com');

console.log('crawl network policy checks passed');
