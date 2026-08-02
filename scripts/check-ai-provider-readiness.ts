import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import multer from 'multer';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AIContentAuditorView } from '../components/dashboard/AIContentAuditorView.js';
import { GscAiInsightsDialog } from '../components/dashboard/GscAiInsightsDialog.js';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { buildApp } from '../server/app.js';
import { AI_PROVIDER_READINESS } from '../src/services/aiService.js';

const AI_PROVIDER_UNAVAILABLE_CODE = 'AI_PROVIDER_UNAVAILABLE';

class AuthenticatedNoopDatabase implements AppDatabase {
  dialect = 'sqlite' as const;

  prepare() { throw new Error('prepare is not used'); }
  async exec() {}
  async get<T = unknown>() { return { userId: 'provider-readiness-user' } as T; }
  async all<T = unknown>() { return [] as T[]; }
  async run(_sql: string, _params?: QueryParams): Promise<RunResult> { return { changes: 0 }; }
  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => callback(...args);
  }
}

const app = buildApp({
  db: new AuthenticatedNoopDatabase(),
  getSyncJobKey: (ownerId, siteUrl) => `${ownerId}:${siteUrl}`,
  startWorkers: false,
  syncJobs: new Map(),
  upload: multer({ storage: multer.memoryStorage() }),
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});

try {
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/api/ai/gsc-insights`, {
    body: JSON.stringify({
      data: [],
      dimension: 'query',
      intentFilter: 'all',
      searchTerm: '',
    }),
    headers: {
      authorization: 'Bearer provider-readiness-session',
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  const payload = await response.json();

  assert.equal(response.status, 503, 'Unavailable AI insights must return 503');
  assert.equal(payload?.code, AI_PROVIDER_UNAVAILABLE_CODE, 'Unavailable AI insights must expose a stable machine-readable code');
  assert.match(payload?.error || '', /temporarily unavailable/i, 'Unavailable AI insights must explain the readiness state');

  const auditResponse = await fetch(`http://127.0.0.1:${port}/api/ai/content-audit`, {
    body: JSON.stringify({ data: [], siteUrl: 'https://example.com/' }),
    headers: {
      authorization: 'Bearer provider-readiness-session',
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  const auditPayload = await auditResponse.json();

  assert.equal(auditResponse.status, 503, 'Unavailable AI content audits must return 503');
  assert.equal(auditPayload?.code, AI_PROVIDER_UNAVAILABLE_CODE, 'Unavailable AI content audits must expose a stable machine-readable code');
  assert.match(auditPayload?.error || '', /temporarily unavailable/i, 'Unavailable AI content audits must explain the readiness state');

  assert.equal(AI_PROVIDER_READINESS.available, false, 'Client readiness must match the unavailable backend');
  const insightsControl = renderToStaticMarkup(createElement(GscAiInsightsDialog, {
    description: 'Current data analysis',
    error: null,
    insights: null,
    isGenerating: false,
    isProviderUnavailable: true,
    onGenerate: async () => undefined,
    onOpenChange: () => undefined,
    open: false,
    title: 'AI SEO Insights',
  }));

  assert.match(
    insightsControl,
    /<button[^>]*disabled[^>]*>.*AI unavailable.*<\/button>/,
    'Unavailable GSC AI insights must render as an explicitly disabled control',
  );

  const contentAuditor = renderToStaticMarkup(createElement(AIContentAuditorView, {
    dateRange: { from: new Date('2026-08-01T00:00:00.000Z'), to: new Date('2026-08-02T00:00:00.000Z') },
    siteUrl: 'https://example.com/',
    useLiveData: false,
  }));

  assert.match(
    contentAuditor,
    /<button[^>]*disabled[^>]*>.*AI brief unavailable.*<\/button>/,
    'Unavailable content-audit AI must render as an explicitly disabled control',
  );

  console.log('AI provider readiness check passed.');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
