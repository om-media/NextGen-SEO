import { authFetch } from "../lib/authFetch";
import { fetchCachedWarehouseQuery } from "./warehouseQueryClient";

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
    
    // Check if we can fulfill this from our local data warehouse.
    // Dashboard reads should not silently fall back to Google APIs; explicit
    // sync actions are responsible for refreshing the warehouse.
    const hasUnsupportedFilter = dimensionFilterGroups?.some((group: any) => 
      group.filters?.some((filter: any) => filter.dimension !== 'query' && filter.dimension !== 'date' && filter.dimension !== 'page' && filter.dimension !== 'country')
    );
    const canUseWarehouse = !forceLive && !hasUnsupportedFilter && dimensions.every(d => d === 'query' || d === 'date' || d === 'page' || d === 'country');
    if (!forceLive) {
      if (!canUseWarehouse) {
        return [];
      }

      try {
        const maxRowsPerRequest = 25000;
        const warehouseRows: GscSearchAnalyticsRow[] = [];
        let startRow = 0;
        let hasMore = true;

        while (hasMore) {
          const fetchLimit = maxRowsPerRequest;
          const rows = await fetchCachedWarehouseQuery<GscSearchAnalyticsRow[]>(
            {
              siteUrl,
              startDate,
              endDate,
              dimensions,
              dimensionFilterGroups,
              rowLimit: fetchLimit,
              startRow,
            },
            "gsc-service",
          );
          const pageRows = Array.isArray(rows) ? rows : [];
          warehouseRows.push(...pageRows);
          hasMore = pageRows.length === fetchLimit;
          startRow += fetchLimit;
        }

        return warehouseRows;
      } catch (err) {
        console.error("Warehouse query failed", err);
        throw err instanceof Error ? err : new Error("Warehouse query failed");
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
