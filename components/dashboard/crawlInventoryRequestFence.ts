import { useRef } from "react";

import { createSelectorRequestGate } from "@/src/lib/useSelectorRequestGate";

export type CrawlInventoryRequestScope = "jobs" | "status" | "pages" | "compare";

export function createCrawlInventoryRequestFence() {
  const gate = createSelectorRequestGate<CrawlInventoryRequestScope>();

  return {
    begin(scope: CrawlInventoryRequestScope) {
      return gate.begin(scope);
    },
    invalidateJobSelection() {
      gate.cancel("jobs");
      gate.cancel("status");
      gate.cancel("pages");
      gate.cancel("compare");
    },
    invalidateSiteSelection() {
      gate.cancel("jobs");
      gate.cancel("status");
      gate.cancel("pages");
      gate.cancel("compare");
    },
    isCurrent(scope: CrawlInventoryRequestScope, requestId: number) {
      return gate.isCurrent(scope, requestId);
    },
  };
}

export function useCrawlInventoryRequestFence() {
  const fenceRef = useRef(createCrawlInventoryRequestFence());
  return fenceRef.current;
}