import { authFetch } from "../lib/authFetch";

export interface Ga4Property {
  property: string; // e.g., "properties/1234567"
  displayName: string;
  propertyType: string;
}

export interface Ga4AccountSummary {
  name: string;
  account: string;
  displayName: string;
  propertySummaries: Ga4Property[];
}

export interface Ga4DataRow {
  dimensionValues: { value: string }[];
  metricValues: { value: string }[];
}

export type Ga4WarehouseCoverage = {
  activeDateCount?: number;
  activeJobCount?: number;
  coveredDateCount?: number;
  dimension?: string;
  errorJobCount?: number;
  expectedDateCount?: number;
  latestAvailableDate?: string;
  missingDateCount?: number;
  queued?: number;
  queuedDateCount?: number;
  skippedUnavailableDates?: number;
};

export type Ga4WarehouseReportResponse = {
  metadata?: {
    coverage?: Ga4WarehouseCoverage | null;
    source?: string;
  };
  rows: Ga4DataRow[];
};

export type Ga4LlmWarehouseSection = {
  rows: Ga4DataRow[];
};

export type Ga4LlmWarehouseTotals = {
  rows: Array<{
    metricValues: { value: string }[];
  }>;
};

export type Ga4LlmWarehouseReportResponse = {
  coverage?: Ga4WarehouseCoverage | null;
  daily?: Ga4LlmWarehouseSection;
  landingPage?: Ga4LlmWarehouseSection;
  metadata?: {
    source?: string;
  };
  source?: Ga4LlmWarehouseSection;
  totals?: Ga4LlmWarehouseTotals;
};

export type Ga4RunReportOptions = {
  autoQueue?: boolean;
  signal?: AbortSignal;
  siteUrl?: string | null;
};

export class Ga4ApiError extends Error {
  code?: string;
  metadata?: unknown;
  status?: number;

  constructor(message: string, options: { code?: string; metadata?: unknown; status?: number } = {}) {
    super(message);
    this.name = "Ga4ApiError";
    this.code = options.code;
    this.metadata = options.metadata;
    this.status = options.status;
  }
}

export class Ga4ApiService {
  constructor(_accessToken?: string | null) {
  }

  private async fetchApi<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await authFetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      if (response.status === 401) {
        throw new Ga4ApiError('UNAUTHORIZED', { status: response.status });
      }
      const errorMessage =
        typeof errorPayload?.error === 'string'
          ? errorPayload.error
          : errorPayload?.error?.message || errorPayload?.message || 'Failed to fetch GA4 data';
      throw new Ga4ApiError(errorMessage, {
        code: typeof errorPayload?.code === 'string' ? errorPayload.code : undefined,
        metadata: errorPayload?.metadata,
        status: response.status,
      });
    }

    return response.json() as Promise<T>;
  }

  async getProperties(): Promise<{ siteUrl: string, displayName: string }[]> {
    const data = await this.fetchApi<any>('/api/google/ga4/properties');
    const summaries: Ga4AccountSummary[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.accountSummaries)
        ? data.accountSummaries
        : [];
    
    const properties: { siteUrl: string, displayName: string }[] = [];
    
    for (const account of summaries) {
      if (account.propertySummaries) {
        for (const prop of account.propertySummaries) {
          properties.push({
            siteUrl: prop.property, // "properties/1234567"
            displayName: `${prop.displayName} (${account.displayName})`
          });
        }
      }
    }
    
    return properties;
  }

  async runReport(
    propertyId: string, // e.g., "properties/1234567"
    startDate: string,
    endDate: string,
    dimensions: string[] = ['date'],
    metrics: string[] = ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate'],
    dimensionFilter?: any,
    options: Ga4RunReportOptions = {},
  ): Promise<Ga4WarehouseReportResponse> {
    const body: any = {
      dateRanges: [{ startDate, endDate }],
      dimensions: dimensions.map(name => ({ name })),
      metrics: metrics.map(name => ({ name }))
    };

    if (dimensionFilter) {
      if (dimensionFilter.filter || dimensionFilter.andGroup || dimensionFilter.orGroup) {
        body.dimensionFilter = dimensionFilter;
      } else {
        body.dimensionFilter = {
          filter: {
            fieldName: dimensionFilter.filterDimension,
            stringFilter: {
              value: dimensionFilter.filterValue,
              matchType: 'EXACT'
            }
          }
        };
      }
    }

    return this.fetchApi<Ga4WarehouseReportResponse>('/api/warehouse/ga4/report', {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({
        propertyId,
        startDate,
        endDate,
        dimensions,
        metrics,
        dimensionFilter: body.dimensionFilter,
        autoQueue: options.autoQueue === true,
        siteUrl: options.siteUrl || undefined,
      })
    });
  }

  async getLlmTrafficReport(
    propertyId: string,
    startDate: string,
    endDate: string,
    options: Ga4RunReportOptions = {},
  ): Promise<Ga4LlmWarehouseReportResponse> {
    return this.fetchApi<Ga4LlmWarehouseReportResponse>('/api/warehouse/ga4/llm/report', {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({
        autoQueue: options.autoQueue === true,
        endDate,
        propertyId,
        siteUrl: options.siteUrl || undefined,
        startDate,
      }),
    });
  }
}
