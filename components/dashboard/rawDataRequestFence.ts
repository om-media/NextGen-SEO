export type RawDataRequestScope = "crawl-jobs" | "rows";

export type RawDataRequestTicket = {
  requestId: number;
  selectionKey: string;
};

type RawDataSelectionSnapshot = {
  requestId: number;
  selectionKey: string;
};

type RawDataRowsSelectionKeyInput = {
  crawlIssueFilter: string;
  crawlKind: string;
  endDate: string;
  ga4Kind: string;
  ga4PropertyId?: string | null;
  gscKind: string;
  offset: number;
  search: string;
  selectedCrawlJobId: string;
  siteUrl: string;
  source: string;
  startDate: string;
};

export function createRawDataRequestFence() {
  const currentRequests = new Map<RawDataRequestScope, RawDataSelectionSnapshot>();

  return {
    begin(scope: RawDataRequestScope, selectionKey: string): RawDataRequestTicket {
      const requestId = (currentRequests.get(scope)?.requestId || 0) + 1;
      const ticket = { requestId, selectionKey };
      currentRequests.set(scope, ticket);
      return ticket;
    },
    cancel(scope: RawDataRequestScope) {
      const current = currentRequests.get(scope);
      currentRequests.set(scope, {
        requestId: (current?.requestId || 0) + 1,
        selectionKey: current?.selectionKey || "",
      });
    },
    isCurrent(scope: RawDataRequestScope, ticket: RawDataRequestTicket, selectionKey = ticket.selectionKey) {
      const current = currentRequests.get(scope);
      return current?.requestId === ticket.requestId && current.selectionKey === selectionKey;
    },
  };
}

export function getCrawlJobsSelectionKey(siteUrl: string) {
  return JSON.stringify({ siteUrl });
}

export function getRawDataRowsSelectionKey(input: RawDataRowsSelectionKeyInput) {
  return JSON.stringify([
    input.source,
    input.siteUrl,
    input.ga4PropertyId || "",
    input.gscKind,
    input.ga4Kind,
    input.crawlKind,
    input.selectedCrawlJobId,
    input.crawlIssueFilter,
    input.search,
    input.startDate,
    input.endDate,
    input.offset,
  ]);
}
