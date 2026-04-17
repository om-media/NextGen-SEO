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
  private accessToken: string | null;
  private tier: 'free' | 'pro' | 'enterprise';

  constructor(accessToken: string | null = null, tier: 'free' | 'pro' | 'enterprise' = 'free') {
    this.accessToken = accessToken;
    this.tier = tier;
  }

  private async fetchApi(path: string, options: RequestInit = {}) {
    if (!this.accessToken) {
      throw new Error("invalid authentication credentials - OAuth 2 access token has expired or is missing");
    }
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
    dimensionFilterGroups?: any[],
    forceLive: boolean = false
  ): Promise<GscSearchAnalyticsRow[]> {
    
    // Check if we can fulfill this from our local data warehouse
    const canUseWarehouse = !forceLive && dimensions.every(d => d === 'query' || d === 'date');
    if (canUseWarehouse) {
      try {
        const response = await fetch('/api/warehouse/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            siteUrl,
            startDate,
            endDate,
            dimensions,
            dimensionFilterGroups
          })
        });

        if (response.ok) {
          const rows = await response.json();
          // If the warehouse returns data, use it! It's much faster and has no 16-month limit.
          if (rows && rows.length > 0) {
            return rows;
          }
        }
      } catch (err) {
        console.error("Warehouse query failed, falling back to Google API", err);
      }
    }

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
