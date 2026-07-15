export type CrawlLifecycleJob = {
  id: string;
  status: string;
};

export function pendingAnalysisStorageKey(siteUrl: string) {
  return 'nextgen-seo:internal-links:analyze-after-crawl:' + siteUrl;
}

export function shouldStartAnalysisAfterCrawl(
  pendingCrawlJobId: string | null,
  crawlJob: CrawlLifecycleJob | null,
  analysisRunning: boolean,
) {
  return Boolean(
    pendingCrawlJobId
      && crawlJob?.id === pendingCrawlJobId
      && crawlJob.status === 'completed'
      && !analysisRunning,
  );
}

export function shouldBootstrapInternalLinkAnalysis(options: {
  analysisRunning: boolean;
  crawlJob: CrawlLifecycleJob | null;
  jobsLoaded: boolean;
  jobCount: number;
  usableSentenceCount: number;
}) {
  return options.jobsLoaded
    && options.jobCount === 0
    && !options.analysisRunning
    && options.crawlJob?.status === 'completed'
    && options.usableSentenceCount > 0;
}
