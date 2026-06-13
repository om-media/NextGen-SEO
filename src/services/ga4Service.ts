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

export type Ga4RunReportOptions = {
  allowLive?: boolean;
  signal?: AbortSignal;
  siteUrl?: string | null;
};

export class Ga4ApiService {
  constructor(_accessToken?: string | null) {
  }

  private async fetchApi(url: string, options: RequestInit = {}) {
    const response = await authFetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      const error = await response.json();
      const errorMessage =
        typeof error?.error === 'string'
          ? error.error
          : error?.error?.message || error?.message || 'Failed to fetch GA4 data';
      throw new Error(errorMessage);
    }

    return response.json();
  }

  async getProperties(): Promise<{ siteUrl: string, displayName: string }[]> {
    const data = await this.fetchApi('/api/google/ga4/properties');
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
  ) {
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

    const data = await this.fetchApi('/api/warehouse/ga4/report', {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({
        propertyId,
        startDate,
        endDate,
        dimensions,
        metrics,
        dimensionFilter: body.dimensionFilter,
        allowLive: Boolean(options.allowLive),
        siteUrl: options.siteUrl || undefined,
      })
    });

    return data;
  }
}
import { authFetch } from "../lib/authFetch";
