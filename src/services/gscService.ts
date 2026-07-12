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
  country?: string;
  date?: string;
  page?: string;
  query?: string;
  queryCount?: number;
}

export interface GscSearchAnalyticsResponse {
  rows?: GscSearchAnalyticsRow[];
}

const SUPPORTED_WAREHOUSE_DIMENSIONS = new Set(["query", "date", "page", "country"]);
const SUPPORTED_WAREHOUSE_FILTER_OPERATORS = new Set(["equals", "contains", "notContains"]);

function hasUnsupportedWarehouseFilter(dimensionFilterGroups?: any[]) {
  return dimensionFilterGroups?.some((group: any) =>
    group.filters?.some((filter: any) =>
      !SUPPORTED_WAREHOUSE_DIMENSIONS.has(filter.dimension)
      || (filter.operator !== undefined && !SUPPORTED_WAREHOUSE_FILTER_OPERATORS.has(filter.operator))
    )
  );
}

function readPrimaryDimensionValue(row: GscSearchAnalyticsRow) {
  if (typeof row.query === "string" && row.query.length > 0) return row.query;
  if (typeof row.page === "string" && row.page.length > 0) return row.page;
  if (typeof row.country === "string" && row.country.length > 0) return row.country;
  return typeof row.keys?.[0] === "string" ? row.keys[0] : "";
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
    const hasUnsupportedFilter = hasUnsupportedWarehouseFilter(dimensionFilterGroups);
    const canUseWarehouse = !forceLive && !hasUnsupportedFilter && dimensions.every((dimension) => SUPPORTED_WAREHOUSE_DIMENSIONS.has(dimension));
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

  async getStoredQueryPositions(
    siteUrl: string,
    startDate: string,
    endDate: string,
    keywords: string[],
  ): Promise<Record<string, number>> {
    const uniqueKeywords = Array.from(new Set(
      keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0),
    ));
    const results = await Promise.allSettled(uniqueKeywords.map(async (keyword) => {
      const rows = await this.querySearchAnalytics(
        siteUrl,
        startDate,
        endDate,
        ['query'],
        [{ filters: [{ dimension: 'query', operator: 'equals', expression: keyword }] }],
      );
      const normalizedKeyword = keyword.toLowerCase();
      const match = rows.find((row) => readPrimaryDimensionValue(row).toLowerCase() === normalizedKeyword);
      const position = match ? Math.round(match.position) : NaN;
      return Number.isFinite(position) && position > 0 ? [keyword, position] as const : null;
    }));

    return results.reduce<Record<string, number>>((positions, result) => {
      if (result.status === 'fulfilled' && result.value) {
        const [keyword, position] = result.value;
        positions[keyword] = position;
      }
      return positions;
    }, {});
  }
}
