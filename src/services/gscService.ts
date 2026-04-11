export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface GscSearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscSearchAnalyticsResponse {
  rows?: GscSearchAnalyticsRow[];
}

export class GscApiService {
  private accessToken: string;
  private tier: 'free' | 'pro' | 'enterprise';

  constructor(accessToken: string, tier: 'free' | 'pro' | 'enterprise' = 'free') {
    this.accessToken = accessToken;
    this.tier = tier;
  }

  private async fetchApi(path: string, options: RequestInit = {}) {
    const url = `https://www.googleapis.com/webmasters/v3${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to fetch GSC data');
    }

    return response.json();
  }

  async getSites(): Promise<GscSite[]> {
    const data = await this.fetchApi('/sites');
    return data.siteEntry || [];
  }

  async querySearchAnalytics(
    siteUrl: string,
    startDate: string,
    endDate: string,
    dimensions: string[] = ['query'],
    dimensionFilterGroups?: any[]
  ): Promise<GscSearchAnalyticsRow[]> {
    
    const maxRowsPerRequest = 25000;
    let targetRowLimit = 2500; // Free tier
    
    if (this.tier === 'pro') {
      targetRowLimit = 25000;
    } else if (this.tier === 'enterprise') {
      targetRowLimit = Infinity;
    }

    let allRows: GscSearchAnalyticsRow[] = [];
    let startRow = 0;
    let hasMore = true;

    while (hasMore && allRows.length < targetRowLimit) {
      const fetchLimit = Math.min(maxRowsPerRequest, targetRowLimit - allRows.length);
      
      const body: any = {
        startDate,
        endDate,
        dimensions,
        rowLimit: fetchLimit,
        startRow: startRow
      };

      if (dimensionFilterGroups) {
        body.dimensionFilterGroups = dimensionFilterGroups;
      }

      const data = await this.fetchApi(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const rows = data.rows || [];
      allRows = allRows.concat(rows);
      
      if (rows.length < fetchLimit) {
        hasMore = false; // We've reached the end of the available data
      } else {
        startRow += fetchLimit;
      }
    }

    return allRows;
  }
}
