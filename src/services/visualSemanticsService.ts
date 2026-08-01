import { authFetch } from '@/src/lib/authFetch';

export type AuthorityConfidence = {
  label: 'high' | 'medium' | 'low' | 'unknown';
  value: number | null;
};

export type ContentAuthorityMeta = {
  confidence: AuthorityConfidence;
  counts: {
    pageCount: number;
    profileCount: number;
    regionCount: number;
    regionPageCount: number;
    templateCount: number;
    templateMemberCount: number;
    templateMemberPageCount: number;
  };
  coverage: {
    profileCoverage: number;
    regionCoverage: number;
    templateCoverage: number;
  };
  crawlJobId: string | null;
  freshness: {
    ageHours: number | null;
    analyzedAt: string | null;
    state: 'fresh' | 'stale' | 'pending' | 'failed' | 'unknown';
    updatedAt: string | null;
  };
  job: {
    lastError: string | null;
    progressCompleted: number | null;
    progressTotal: number | null;
    status: string | null;
  } | null;
  message: string;
  status: 'no_crawl' | 'pending' | 'ready' | 'partial' | 'failed';
};

export type ContentAuthorityPage = {
  confidence: AuthorityConfidence;
  depth: number | null;
  pageKey: string;
  pageType: string | null;
  primaryTask: string | null;
  regions: {
    count: number;
    roles: Array<{ count: number; role: string }>;
  };
  template: {
    isExemplar: boolean;
    memberCount: number;
    templateKey: string;
    urlSkeleton: string | null;
  } | null;
  title: string | null;
  topEvidence: {
    confidence: number | null;
    role: string | null;
    text: string | null;
  } | null;
  url: string | null;
  wordCount: number | null;
};

export type ContentAuthorityTemplate = {
  confidence: AuthorityConfidence;
  evidence: {
    exemplarRegions: number;
    members: number;
    pageTypes: Array<{ count: number; value: string }>;
    primaryTasks: Array<{ count: number; value: string }>;
  };
  exemplarPageKey: string | null;
  memberCount: number;
  templateKey: string;
  topEvidence: {
    confidence: number | null;
    role: string | null;
    text: string | null;
  } | null;
  urlSkeleton: string | null;
};

export type ContentAuthorityRegion = {
  confidence: number | null;
  headingChain: string[];
  regionIndex: number | null;
  regionRole: string | null;
  selector: string | null;
  text: string | null;
  visible: boolean;
};

export type ContentAuthorityPageEvidence = {
  found: boolean;
  meta: ContentAuthorityMeta;
  page: {
    confidence: AuthorityConfidence;
    crawl: {
      canonicalUrl: string | null;
      depth: number | null;
      metaDescription: string | null;
      statusCode: number | null;
      title: string | null;
      url: string | null;
      wordCount: number | null;
    };
    pageKey: string;
    pageType: string | null;
    primaryTask: string | null;
    regions: ContentAuthorityRegion[];
    secondaryTasks: string[];
    template: ContentAuthorityPage['template'];
  } | null;
};

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || fallback);
  }
  return payload as T;
}

function query(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && String(value).trim()) search.set(key, String(value));
  });
  return search.toString();
}

export const ContentAuthorityService = {
  async getReadiness(siteUrl: string) {
    return readJson<ContentAuthorityMeta>(
      await authFetch(`/api/content-authority/readiness?${query({ siteUrl })}`),
      'Failed to load content authority readiness.',
    );
  },

  async getPages(siteUrl: string, options: { limit?: number; offset?: number; search?: string } = {}) {
    return readJson<{ meta: ContentAuthorityMeta; page: { limit: number; offset: number; total: number }; rows: ContentAuthorityPage[] }>(
      await authFetch(`/api/content-authority/pages?${query({ siteUrl, ...options })}`),
      'Failed to load analyzed pages.',
    );
  },

  async getTemplates(siteUrl: string) {
    return readJson<{ meta: ContentAuthorityMeta; rows: ContentAuthorityTemplate[] }>(
      await authFetch(`/api/content-authority/templates?${query({ siteUrl })}`),
      'Failed to load page templates.',
    );
  },

  async getPageEvidence(siteUrl: string, pageKey: string) {
    return readJson<ContentAuthorityPageEvidence>(
      await authFetch(`/api/content-authority/pages/${encodeURIComponent(pageKey)}/evidence?${query({ siteUrl })}`),
      'Failed to load page evidence.',
    );
  },
};
