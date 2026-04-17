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

export class Ga4ApiService {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async fetchApi(url: string, options: RequestInit = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to fetch GA4 data');
    }

    return response.json();
  }

  async getProperties(): Promise<{ siteUrl: string, displayName: string }[]> {
    const data = await this.fetchApi('https://analyticsadmin.googleapis.com/v1beta/accountSummaries');
    const summaries: Ga4AccountSummary[] = data.accountSummaries || [];
    
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
    dimensionFilter?: { filterDimension: string, filterValue: string }
  ) {
    const body: any = {
      dateRanges: [{ startDate, endDate }],
      dimensions: dimensions.map(name => ({ name })),
      metrics: metrics.map(name => ({ name }))
    };

    if (dimensionFilter) {
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

    const data = await this.fetchApi(`https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    return data;
  }
}
