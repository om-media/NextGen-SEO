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

  async getQueryStats(siteUrl: string): Promise<BingQueryStat[]> {
    const response = await authFetch(`/api/bing/stats?siteUrl=${encodeURIComponent(siteUrl)}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch Bing query stats');
    }
    const data = await response.json();
    return data.d || [];
  }
}
