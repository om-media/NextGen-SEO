import { authFetch } from "../lib/authFetch";

export interface BingSite {
  siteUrl: string;
}

export interface BingQueryStat {
  Query: string;
  Impressions: number;
  Clicks: number;
  Ctr: number;
  AvgClickPosition: number;
  AvgImpressionPosition: number;
}

export interface BingQueryStatsMeta {
  cache: {
    isFresh: boolean;
    latestFetchedAt: string | null;
    rowCount: number;
  } | null;
  fromCache: boolean;
  range?: {
    availableEndDate: string | null;
    availableStartDate: string | null;
    compatibilityBackfill: {
      dateCount: number;
      rowCount: number;
      semantics: string | null;
    };
    factRowCount: number;
    latestFetchedAt: string | null;
    matchedDateCount: number;
    mode: "date-range-aggregate" | "legacy-mirror";
    queryCount: number;
    requestedEndDate: string | null;
    requestedStartDate: string | null;
    semantics: string | null;
  };
  source?: "dated-facts" | "legacy-mirror";
}

export interface BingQueryStatsResult {
  meta: BingQueryStatsMeta;
  rows: BingQueryStat[];
}

export class BingApiService {
  constructor() {}

  async getSites(): Promise<BingSite[]> {
    const response = await authFetch(`/api/bing/sites`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch Bing sites');
    }
    const data = await response.json();
    return (data.d || []).map((site: any) => ({
      siteUrl: site.Url
    }));
  }

  async getQueryStats(siteUrl: string, startDate: string, endDate: string): Promise<BingQueryStatsResult> {
    const params = new URLSearchParams({ endDate, siteUrl, startDate });
    const response = await authFetch(`/api/bing/stats?${params.toString()}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch Bing query stats');
    }
    const data = await response.json();
    return {
      meta: data.meta,
      rows: data.d || [],
    };
  }

  async syncQueryStats(siteUrl: string, startDate: string, endDate: string): Promise<BingQueryStatsResult> {
    const response = await authFetch('/api/bing/stats/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endDate, siteUrl, startDate }),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to refresh Bing query stats');
    }
    const data = await response.json();
    return {
      meta: data.meta,
      rows: data.d || [],
    };
  }
}
