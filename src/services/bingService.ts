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
  };
  fromCache: boolean;
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

  async getQueryStats(siteUrl: string): Promise<BingQueryStatsResult> {
    const response = await authFetch(`/api/bing/stats?siteUrl=${encodeURIComponent(siteUrl)}`);
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

  async syncQueryStats(siteUrl: string): Promise<BingQueryStatsResult> {
    const response = await authFetch('/api/bing/stats/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteUrl }),
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
