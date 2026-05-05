import { authFetch } from "../lib/authFetch";

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
  queryCount?: number;
}

export interface GscSearchAnalyticsResponse {
  rows?: GscSearchAnalyticsRow[];
}

export class GscApiService {
  private tier: 'free' | 'pro' | 'enterprise';

  constructor(accessToken: string | null = null, tier: 'free' | 'pro' | 'enterprise' = 'free') {
    this.tier = tier;
  }

  private async fetchApi(path: string, options: RequestInit = {}) {
    const response = await authFetch(`/api/google/gsc${path}`, {
      ...options,
      headers: {
        ...options.headers,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      const errorMessage =
        typeof error?.error === 'string'
          ? error.error
          : error?.error?.message || error?.message || 'Failed to fetch GSC data';
      throw new Error(errorMessage);
    }

    return response.json();
  }

  async getSites(): Promise<GscSite[]> {
    return this.fetchApi('/sites');
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
    const hasUnsupportedFilter = dimensionFilterGroups?.some((group: any) => 
      group.filters?.some((filter: any) => filter.dimension !== 'query' && filter.dimension !== 'date' && filter.dimension !== 'page')
    );
    const canUseWarehouse = !forceLive && !hasUnsupportedFilter && dimensions.every(d => d === 'query' || d === 'date' || d === 'page');
    if (canUseWarehouse) {
      try {
        const maxRowsPerRequest = 25000;
        const warehouseRows: GscSearchAnalyticsRow[] = [];
        let startRow = 0;
        let hasMore = true;

        while (hasMore) {
          const fetchLimit = maxRowsPerRequest;
          const response = await authFetch('/api/warehouse/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              siteUrl,
              startDate,
              endDate,
              dimensions,
              dimensionFilterGroups,
              rowLimit: fetchLimit,
              startRow,
            })
          });

          if (!response.ok) {
            break;
          }

          const rows = await response.json();
          const pageRows = Array.isArray(rows) ? rows : [];
          warehouseRows.push(...pageRows);
          hasMore = pageRows.length === fetchLimit;
          startRow += fetchLimit;
        }

        // If the warehouse returns data, use it. It is faster and avoids live API export ceilings.
        if (warehouseRows.length > 0) {
          return warehouseRows;
        }
      } catch (err) {
        console.error("Warehouse query failed, falling back to Google API", err);
      }
    }

    const maxRowsPerRequest = 25000;
    let allRows: GscSearchAnalyticsRow[] = [];
    let startRow = 0;
    let hasMore = true;

    while (hasMore) {
      const fetchLimit = maxRowsPerRequest;
      
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

      const data = await this.fetchApi('/search-analytics', {
        method: 'POST',
        body: JSON.stringify({
          siteUrl,
          ...body,
        }),
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
