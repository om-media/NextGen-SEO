import { authFetch } from '@/src/lib/authFetch';
import type { QueueMetadata } from '@/src/services/queueMetadata';

export type InternalLinkScoreBreakdown = {
  anchorQuality: number;
  diversityPenalty: number;
  notes: string[];
  safety: number;
  semanticBoost: number;
  sourceAuthority: number;
  targetNeed: number;
  topicMatch: number;
  total: number;
};
export type InternalLinkAnalysisJob = {
  actualCost: number | null;
  actualEmbeddingTokens: number | null;
  actualReviewTokens: number | null;
  completedAt: string | null;
  crawlJobId: string;
  embeddingModel: string | null;
  embeddingProvider: string | null;
  endDate: string;
  estimatedEmbeddingTokens: number | null;
  estimatedHostedEmbeddingCost: number | null;
  estimatedHostedReviewCost: number | null;
  estimatedLocalUnits: number | null;
  estimatedReviewTokens: number | null;
  id: string;
  lastError: string | null;
  maxPages: number | null;
  maxRecommendations: number | null;
  maxSentencesPerPage: number | null;
  progressCompleted: number | null;
  progressTotal: number | null;
  provider: string | null;
  reviewModel: string | null;
  reviewProvider: string | null;
  siteUrl: string;
  startedAt: string | null;
  startDate: string;
  status: string;
  updatedAt: string | null;
};

export type InternalLinkOpportunity = {
  annotationId: string | null;
  anchorEnd: number;
  anchorStart: number;
  anchorText: string;
  confidence: 'high' | 'medium' | 'low';
  createdAt: string | null;
  id: string;
  implementedAt: string | null;
  modelVersion: string | null;
  opportunityType: 'link-gap' | 'orphan-risk' | 'striking-distance' | 'visibility-gap';
  priorityScore: number;
  scoreBreakdown: InternalLinkScoreBreakdown;
  provider: string | null;
  readerBenefit: string;
  stale: boolean;
  status: 'new' | 'approved' | 'rejected' | 'implemented' | 'stale';
  userNote: string | null;
  source: {
    pageKey: string;
    sentence: string;
    title: string | null;
    url: string;
  };
  target: {
    folder: string;
    pageKey: string;
    title: string | null;
    url: string;
  };
};

export type InternalLinkWorkspaceQueueResponse = {
  failures: Array<{ error: string; siteUrl: string }>;
  queued: InternalLinkAnalysisJob[];
  skipped: Array<{ id: string; siteUrl: string; status: string }>;
  success: true;
  totals: {
    failures: number;
    queued: number;
    skipped: number;
    sites: number;
  };
};
export type InternalLinkVectorStoreStatus = {
  available: boolean;
  dimensions: number | null;
  indexed: boolean;
  provider: 'pgvector' | 'json-cache' | string;
  reason: string;
};

export type InternalLinkAnalysisEstimate = {
  crawlJobId: string;
  embeddingModel: string;
  embeddingProvider: string;
  estimatedEmbeddingTokens: number;
  estimatedHostedEmbeddingCost: number;
  estimatedHostedReviewCost: number;
  estimatedLocalUnits: number;
  estimatedReviewTokens: number;
  maxPages: number;
  maxRecommendations: number;
  maxSentencesPerPage: number;
  reviewModel: string;
  reviewProvider: string;
  totalHostedCost: number;
  vectorStore: InternalLinkVectorStoreStatus;
};
export type InternalLinkProviderSetting = {
  apiKeyPreview: string | null;
  baseUrl: string | null;
  createdAt: string | null;
  embeddingModel: string | null;
  enabled: boolean;
  hasApiKey: boolean;
  provider: string;
  reviewModel: string | null;
  updatedAt: string | null;
};
export type InternalLinkProviderStatus = {
  available: boolean;
  baseUrl: string;
  dimensions: number | null;
  message: string;
  model: string;
  modelAvailable: boolean;
};
export type InternalLinkOpportunitiesResponse = {
  queue: QueueMetadata;
  job: InternalLinkAnalysisJob | null;
  meta: {
    folders?: string[];
    message: string | null;
    totals: {
      highPriority: number;
      implemented: number;
      opportunities: number;
      ready: number;
      stale: number;
    };
  };
  page: {
    filteredTotal: number;
    limit: number;
    offset: number;
    total: number;
  };
  rows: InternalLinkOpportunity[];
};


type InternalLinkApiErrorPayload = {
  error?: string;
  job?: Partial<InternalLinkAnalysisJob> | null;
};

function internalLinkError(data: InternalLinkApiErrorPayload | null, fallback: string) {
  const message = data?.error || fallback;
  return new Error(data?.job?.status ? `${message} Current status: ${data.job.status}.` : message);
}

export async function fetchInternalLinkProviderStatus(provider: string, model?: string | null) {
  const searchParams = new URLSearchParams({ provider });
  if (model?.trim()) searchParams.set('model', model.trim());
  const response = await authFetch('/api/internal-links/provider-status?' + searchParams.toString());
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to check internal link provider');
  return data as { status: InternalLinkProviderStatus; success: true };
}

export async function fetchInternalLinkProviderSettings() {
  const response = await authFetch('/api/internal-links/provider-settings');
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to load internal link provider settings');
  return { settings: Array.isArray(data?.settings) ? data.settings : [] as InternalLinkProviderSetting[] };
}

export async function saveInternalLinkProviderSettings(provider: string, params: {
  apiKey?: string | null;
  baseUrl?: string | null;
  clearApiKey?: boolean;
  embeddingModel?: string | null;
  enabled?: boolean;
  reviewModel?: string | null;
}) {
  const response = await authFetch(`/api/internal-links/provider-settings/${encodeURIComponent(provider)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to save internal link provider settings');
  return data as { setting: InternalLinkProviderSetting; success: true };
}

export async function deleteInternalLinkProviderSettings(provider: string) {
  const response = await authFetch(`/api/internal-links/provider-settings/${encodeURIComponent(provider)}`, { method: 'DELETE' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to delete internal link provider settings');
  return data as { deleted: boolean; provider: string; success: true };
}
export async function startWorkspaceInternalLinkAnalysis(params: {
  endDate: string;
  embeddingModel?: string;
  embeddingProvider?: string;
  maxHostedSpend?: number;
  maxPages?: number;
  maxRecommendations?: number;
  maxSentencesPerPage?: number;
  reviewModel?: string;
  reviewProvider?: string;
  siteUrl?: string;
  siteUrls?: string[];
  startDate: string;
}) {
  const response = await authFetch('/api/internal-links/analyze-workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to queue workspace internal link analysis');
  return data as InternalLinkWorkspaceQueueResponse;
}
export async function estimateInternalLinkAnalysis(params: {
  endDate: string;
  embeddingModel?: string;
  embeddingProvider?: string;
  maxHostedSpend?: number;
  maxPages?: number;
  maxRecommendations?: number;
  maxSentencesPerPage?: number;
  reviewModel?: string;
  reviewProvider?: string;
  siteUrl: string;
  startDate: string;
}) {
  const response = await authFetch('/api/internal-links/estimate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to estimate internal link analysis');
  return data as { estimate: InternalLinkAnalysisEstimate; success: true };
}
export async function startInternalLinkAnalysis(params: {
  endDate: string;
  embeddingModel?: string;
  embeddingProvider?: string;
  maxHostedSpend?: number;
  maxPages?: number;
  maxRecommendations?: number;
  maxSentencesPerPage?: number;
  reviewModel?: string;
  reviewProvider?: string;
  siteUrl: string;
  startDate: string;
}) {
  const response = await authFetch('/api/internal-links/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to start internal link analysis');
  return data as { job: InternalLinkAnalysisJob; queue: QueueMetadata; success: true };
}

export async function fetchInternalLinkJobs(siteUrl: string, limit = 20) {
  const searchParams = new URLSearchParams({ limit: String(limit), siteUrl });
  const response = await authFetch(`/api/internal-links/jobs?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to load internal link analysis jobs');
  return { jobs: Array.isArray(data?.jobs) ? data.jobs : [] as InternalLinkAnalysisJob[], queue: data?.queue as QueueMetadata };
}

export async function fetchInternalLinkOpportunities(params: {
  confidence?: string;
  endDate: string;
  jobId?: string | null;
  limit?: number;
  offset?: number;
  opportunityType?: string;
  query?: string;
  siteUrl: string;
  startDate: string;
  status?: string;
  targetFolder?: string;
}) {
  const searchParams = new URLSearchParams({
    endDate: params.endDate,
    limit: String(params.limit ?? 50),
    offset: String(params.offset ?? 0),
    siteUrl: params.siteUrl,
    startDate: params.startDate,
  });

  if (params.confidence && params.confidence !== 'all') searchParams.set('confidence', params.confidence);
  if (params.jobId) searchParams.set('jobId', params.jobId);
  if (params.opportunityType && params.opportunityType !== 'all') searchParams.set('opportunityType', params.opportunityType);
  if (params.status && params.status !== 'all') searchParams.set('status', params.status);
  if (params.targetFolder && params.targetFolder !== 'all') searchParams.set('targetFolder', params.targetFolder);
  if (params.query?.trim()) searchParams.set('query', params.query.trim());

  const response = await authFetch(`/api/internal-links/opportunities?${searchParams.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to load internal link opportunities');

  return {
    job: data?.job ?? null,
    meta: data?.meta ?? { message: null, totals: { highPriority: 0, implemented: 0, opportunities: 0, ready: 0, stale: 0 } },
    page: data?.page ?? { filteredTotal: 0, limit: params.limit ?? 50, offset: params.offset ?? 0, total: 0 },
    queue: data?.queue,
    rows: Array.isArray(data?.rows) ? data.rows : [],
  } satisfies InternalLinkOpportunitiesResponse;
}

export async function updateInternalLinkOpportunity(params: { id: string; note?: string | null; status: string }) {
  const response = await authFetch(`/api/internal-links/opportunities/${encodeURIComponent(params.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: params.note ?? null, status: params.status }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to update internal link opportunity');
  return data as { opportunity: InternalLinkOpportunity; success: true };
}

export async function cancelInternalLinkJob(jobId: string) {
  const response = await authFetch(`/api/internal-links/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to cancel internal link analysis job');
  return data as { job: InternalLinkAnalysisJob; queue: QueueMetadata; success: true };
}

export async function rerunInternalLinkJob(jobId: string) {
  const response = await authFetch(`/api/internal-links/jobs/${encodeURIComponent(jobId)}/rerun`, { method: 'POST' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw internalLinkError(data, 'Failed to rerun internal link analysis job');
  return data as { job: InternalLinkAnalysisJob; queue: QueueMetadata; success: true };
}
