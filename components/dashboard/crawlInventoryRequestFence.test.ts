import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { createCrawlInventoryRequestFence } from "./crawlInventoryRequestFence";

export function runCrawlInventoryRequestFenceTests() {
  const fence = createCrawlInventoryRequestFence();

  const jobsRequestId = fence.begin("jobs");
  const statusRequestId = fence.begin("status");
  const pagesRequestId = fence.begin("pages");
  const compareRequestId = fence.begin("compare");

  fence.invalidateJobSelection();

  assert.equal(fence.isCurrent("jobs", jobsRequestId), false);
  assert.equal(fence.isCurrent("status", statusRequestId), false);
  assert.equal(fence.isCurrent("pages", pagesRequestId), false);
  assert.equal(fence.isCurrent("compare", compareRequestId), false);

  const freshPagesRequestId = fence.begin("pages");
  assert.equal(fence.isCurrent("pages", freshPagesRequestId), true);

  const siteScopedJobsRequestId = fence.begin("jobs");
  const siteScopedCompareRequestId = fence.begin("compare");

  fence.invalidateSiteSelection();

  assert.equal(fence.isCurrent("jobs", siteScopedJobsRequestId), false);
  assert.equal(fence.isCurrent("compare", siteScopedCompareRequestId), false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCrawlInventoryRequestFenceTests();
  console.log("Crawl inventory request fence tests passed");
}