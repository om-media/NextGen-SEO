import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { createRawDataRequestFence, getCrawlJobsSelectionKey, getRawDataRowsSelectionKey } from "./rawDataRequestFence";

export async function runRawDataRequestFenceTests() {
  const rowsFence = createRawDataRequestFence();
  const appliedRowSelections: string[] = [];

  const staleSiteSelection = getRawDataRowsSelectionKey({
    crawlIssueFilter: "all",
    crawlKind: "pages",
    endDate: "2026-07-14",
    ga4Kind: "page",
    ga4PropertyId: null,
    gscKind: "page",
    offset: 0,
    search: "",
    selectedCrawlJobId: "",
    siteUrl: "https://alpha.example/",
    source: "gsc",
    startDate: "2026-07-01",
  });
  const freshSiteSelection = getRawDataRowsSelectionKey({
    crawlIssueFilter: "all",
    crawlKind: "pages",
    endDate: "2026-07-14",
    ga4Kind: "page",
    ga4PropertyId: null,
    gscKind: "page",
    offset: 0,
    search: "",
    selectedCrawlJobId: "",
    siteUrl: "https://beta.example/",
    source: "gsc",
    startDate: "2026-07-01",
  });

  const staleSiteRequest = rowsFence.begin("rows", staleSiteSelection);
  const freshSiteRequest = rowsFence.begin("rows", freshSiteSelection);

  await Promise.all([
    Promise.resolve().then(() => {
      if (rowsFence.isCurrent("rows", staleSiteRequest, staleSiteSelection)) {
        appliedRowSelections.push("stale-site");
      }
    }),
    Promise.resolve().then(() => {
      if (rowsFence.isCurrent("rows", freshSiteRequest, freshSiteSelection)) {
        appliedRowSelections.push("fresh-site");
      }
    }),
  ]);

  assert.deepEqual(appliedRowSelections, ["fresh-site"]);

  const stalePropertyAndDimensionSelection = getRawDataRowsSelectionKey({
    crawlIssueFilter: "all",
    crawlKind: "pages",
    endDate: "2026-07-14",
    ga4Kind: "page",
    ga4PropertyId: "properties/1001",
    gscKind: "page",
    offset: 0,
    search: "",
    selectedCrawlJobId: "",
    siteUrl: "https://beta.example/",
    source: "ga4",
    startDate: "2026-07-01",
  });
  const freshPropertyAndDimensionSelection = getRawDataRowsSelectionKey({
    crawlIssueFilter: "all",
    crawlKind: "pages",
    endDate: "2026-07-14",
    ga4Kind: "event",
    ga4PropertyId: "properties/2002",
    gscKind: "page",
    offset: 0,
    search: "",
    selectedCrawlJobId: "",
    siteUrl: "https://beta.example/",
    source: "ga4",
    startDate: "2026-07-01",
  });

  const stalePropertyAndDimensionRequest = rowsFence.begin("rows", stalePropertyAndDimensionSelection);
  const freshPropertyAndDimensionRequest = rowsFence.begin("rows", freshPropertyAndDimensionSelection);
  const appliedGa4Selections: string[] = [];

  await Promise.all([
    Promise.resolve().then(() => {
      if (rowsFence.isCurrent("rows", stalePropertyAndDimensionRequest, stalePropertyAndDimensionSelection)) {
        appliedGa4Selections.push("stale-ga4");
      }
    }),
    Promise.resolve().then(() => {
      if (rowsFence.isCurrent("rows", freshPropertyAndDimensionRequest, freshPropertyAndDimensionSelection)) {
        appliedGa4Selections.push("fresh-ga4");
      }
    }),
  ]);

  assert.deepEqual(appliedGa4Selections, ["fresh-ga4"]);

  const crawlJobsFence = createRawDataRequestFence();
  const crawlJobsSelection = getCrawlJobsSelectionKey("https://alpha.example/");
  const crawlJobsRequest = crawlJobsFence.begin("crawl-jobs", crawlJobsSelection);
  crawlJobsFence.cancel("crawl-jobs");
  assert.equal(crawlJobsFence.isCurrent("crawl-jobs", crawlJobsRequest, crawlJobsSelection), false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRawDataRequestFenceTests();
  console.log("Raw data request fence tests passed");
}
