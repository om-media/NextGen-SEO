import { authFetch } from '@/src/lib/authFetch';

export type TopicalAuthorityStatus = 'leading' | 'established' | 'emerging' | 'gap';

export type TopicalAuthorityCluster = {
  clicks: number;
  ctr: number;
  evidence: {
    demandCapture: number;
    depth: number;
    internalSupport: number;
    total: number;
    visibility: number;
  };
  impressions: number;
  issues: string[];
  key: string;
  label: string;
  pageCount: number;
  pages: Array<{
    clicks: number;
    impressions: number;
    inboundLinks: number;
    pageKey: string;
    position: number;
    queryCount: number;
    title: string;
    url: string;
    wordCount: number;
  }>;
  position: number;
  queryCount: number;
  queries: Array<{ clicks: number; impressions: number; position: number; query: string }>;
  status: TopicalAuthorityStatus;
  support: { inboundLinks: number };
};

export type TopicalAuthorityReport = {
  meta: {
    crawlJobId: string | null;
    dateRange: { endDate: string | null; startDate: string | null };
    methodology: string;
    source: 'warehouse';
    sourceSites: string[];
  };
  page: { limit: number; offset: number; total: number };
  rows: TopicalAuthorityCluster[];
  summary: {
    clicks: number;
    clusters: number;
    impressions: number;
    pages: number;
    statusCounts: Record<TopicalAuthorityStatus, number>;
  };
};

function query(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && String(value).trim()) search.set(key, String(value));
  });
  return search.toString();
}

export const TopicalAuthorityService = {
  async getClusters(siteUrl: string, options: { limit?: number; offset?: number; search?: string; status?: string } = {}) {
    const response = await authFetch(`/api/topical-authority/clusters?${query({ siteUrl, ...options })}`);
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || 'Failed to load topical authority evidence.');
    return payload as TopicalAuthorityReport;
  },
};
