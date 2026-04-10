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

  constructor(accessToken: string) {
    this.accessToken = accessToken;
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
    dimensions: string[] = ['query']
  ): Promise<GscSearchAnalyticsRow[]> {
    const data = await this.fetchApi(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: 'POST',
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions,
        rowLimit: 1000, // Adjust as needed
      }),
    });

    return data.rows || [];
  }
}
