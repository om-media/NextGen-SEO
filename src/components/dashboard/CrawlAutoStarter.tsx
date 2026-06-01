import { useEffect, useRef } from "react";
import { fetchCrawlJobs, startCrawl } from "@/src/services/crawlService";

function resolveStartUrl(siteUrl: string) {
  const trimmed = siteUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const hostname = trimmed.replace(/^sc-domain:/i, "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return hostname ? `https://${hostname}/` : "";
}

export function CrawlAutoStarter({ siteUrl }: { siteUrl: string | null }) {
  const attemptedSites = useRef(new Set<string>());

  useEffect(() => {
    if (!siteUrl || attemptedSites.current.has(siteUrl)) {
      return;
    }

    attemptedSites.current.add(siteUrl);
    let cancelled = false;

    const ensureCrawl = async () => {
      try {
        const jobs = await fetchCrawlJobs(siteUrl, 1);
        if (cancelled || jobs.jobs.length > 0) {
          return;
        }

        const startUrl = resolveStartUrl(siteUrl);
        if (!startUrl) {
          return;
        }

        await startCrawl({
          includeQueryStrings: false,
          renderMode: "html",
          respectRobots: true,
          siteUrl,
          startUrl,
          userAgent: "NextGenSEO-Crawler/1.0",
        });
      } catch (err) {
        attemptedSites.current.delete(siteUrl);
        console.warn("Automatic crawl startup skipped:", err);
      }
    };

    void ensureCrawl();

    return () => {
      cancelled = true;
    };
  }, [siteUrl]);

  return null;
}
