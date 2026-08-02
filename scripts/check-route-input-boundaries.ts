import type { AddressInfo } from 'node:net';
import multer from 'multer';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { buildApp } from '../server/app.js';

class BoundaryDatabase implements AppDatabase {
  dialect = 'sqlite' as const;

  prepare() { throw new Error('prepare is not used by route boundary checks'); }
  async exec() {}

  async get<T = unknown>(sql: string, _params?: QueryParams) {
    if (/SELECT 1 AS ok/i.test(sql)) return { ok: 1 } as T;
    if (/FROM sessions/i.test(sql)) return { userId: 'boundary-owner' } as T;
    if (/FROM users/i.test(sql)) {
      return {
        activatedGa4PropertyId: 'properties/boundary',
        activatedSiteUrl: 'https://boundary.example/',
        gscRefreshToken: null,
        knownSites: JSON.stringify(['https://boundary.example/']),
        tier: 'enterprise',
        unlockedSites: JSON.stringify(['https://boundary.example/']),
      } as T;
    }
    if (/FROM workspace_ga4_mappings/i.test(sql)) return { propertyId: 'properties/boundary' } as T;
    if (/SUM\(rowCount\)/i.test(sql)) return { count: 1 } as T;
    if (/COUNT\(\*\)/i.test(sql)) return { count: 0 } as T;
    return undefined;
  }

  async all<T = unknown>() { return [] as T[]; }
  async run(_sql: string, _params?: QueryParams): Promise<RunResult> { return { changes: 1 }; }
  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => callback(...args);
  }
}

type MatrixCase = {
  body?: unknown;
  expectedStatus?: number;
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
  name: string;
  path: string;
};

const siteUrl = 'https://boundary.example/';
const propertyId = 'properties/boundary';
const cases: MatrixCase[] = [
  { name: 'google gsc reversed dates', method: 'POST', path: '/api/google/gsc/search-analytics', body: { siteUrl, startDate: '2026-08-02', endDate: '2026-08-01', dimensions: [] } },
  { name: 'google gsc impossible date', method: 'POST', path: '/api/google/gsc/search-analytics', body: { siteUrl, startDate: '2026-02-29', endDate: '2026-08-01', dimensions: [] } },
  { name: 'google gsc negative row limit', method: 'POST', path: '/api/google/gsc/search-analytics', body: { siteUrl, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], rowLimit: -1 } },
  { name: 'google gsc oversized row limit', method: 'POST', path: '/api/google/gsc/search-analytics', body: { siteUrl, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], rowLimit: 25001 } },
  { name: 'google gsc negative start row', method: 'POST', path: '/api/google/gsc/search-analytics', body: { siteUrl, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], startRow: -1 } },
  { name: 'google gsc malformed filters', method: 'POST', path: '/api/google/gsc/search-analytics', body: { siteUrl, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], dimensionFilterGroups: 'bad' } },
  { name: 'google ga4 reversed dates', method: 'POST', path: '/api/google/ga4/run-report', body: { propertyId, startDate: '2026-08-02', endDate: '2026-08-01', dimensions: [], metrics: [] } },
  { name: 'google ga4 negative limit', method: 'POST', path: '/api/google/ga4/run-report', body: { propertyId, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], metrics: [], limit: -1 } },
  { name: 'google ga4 negative offset', method: 'POST', path: '/api/google/ga4/run-report', body: { propertyId, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], metrics: [], offset: -1 } },
  { name: 'google ga4 oversized offset', method: 'POST', path: '/api/google/ga4/run-report', body: { propertyId, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], metrics: [], offset: 1_000_001 } },
  { name: 'google ga4 malformed dimension filter', method: 'POST', path: '/api/google/ga4/run-report', body: { propertyId, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], metrics: [], dimensionFilter: [] } },
  { name: 'warehouse report reversed dates', method: 'POST', path: '/api/warehouse/ga4/report', body: { propertyId, siteUrl, startDate: '2026-08-02', endDate: '2026-08-01', dimensions: [], metrics: [] } },
  { name: 'warehouse coverage reversed dates', method: 'GET', path: `/api/warehouse/coverage?siteUrl=${encodeURIComponent(siteUrl)}&propertyId=${encodeURIComponent(propertyId)}&startDate=2026-08-02&endDate=2026-08-01` },
  { name: 'warehouse missing jobs reversed dates', method: 'POST', path: '/api/warehouse/jobs/missing', body: { siteUrl, propertyId, startDate: '2026-08-02', endDate: '2026-08-01' } },
  { name: 'warehouse query reversed dates', method: 'POST', path: '/api/warehouse/query', body: { siteUrl, startDate: '2026-08-02', endDate: '2026-08-01', dimensions: [] } },
  { name: 'warehouse query negative row limit', method: 'POST', path: '/api/warehouse/query', body: { siteUrl, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], rowLimit: -1 } },
  { name: 'warehouse query negative start row', method: 'POST', path: '/api/warehouse/query', body: { siteUrl, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], startRow: -1 } },
  { name: 'warehouse query malformed filters', method: 'POST', path: '/api/warehouse/query', body: { siteUrl, startDate: '2026-08-01', endDate: '2026-08-02', dimensions: [], dimensionFilterGroups: 'bad' } },
  { name: 'warehouse raw gsc negative limit', method: 'GET', path: `/api/warehouse/raw/gsc?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-08-01&endDate=2026-08-02&limit=-1` },
  { name: 'warehouse raw gsc negative offset', method: 'GET', path: `/api/warehouse/raw/gsc?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-08-01&endDate=2026-08-02&offset=-1` },
  { name: 'warehouse raw gsc oversized offset', method: 'GET', path: `/api/warehouse/raw/gsc?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-08-01&endDate=2026-08-02&offset=1000001` },
  { name: 'logs reversed dates', method: 'GET', path: `/api/logs/stats?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-08-02&endDate=2026-08-01` },
  { name: 'logs impossible date', method: 'GET', path: `/api/logs/errors?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-99-99&endDate=2026-08-01` },
  { name: 'logs malformed array', method: 'POST', path: '/api/logs/webhook', body: { siteUrl, logs: {} } },
  { name: 'indexing reversed dates', method: 'GET', path: `/api/indexing/grid?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-08-02&endDate=2026-08-01` },
  { name: 'indexing malformed urls', method: 'POST', path: '/api/indexing/seed-urls', body: { siteUrl, urls: [1] } },
  { name: 'indexing empty urls', method: 'POST', path: '/api/indexing/seed-urls', body: { siteUrl, urls: [] } },
  { name: 'indexing missing inspection id', method: 'POST', path: '/api/indexing/inspect', body: { siteUrl } },
  { name: 'blended reversed dates', method: 'POST', path: '/api/blended/page-performance', body: { siteUrl, startDate: '2026-08-02', endDate: '2026-08-01' } },
  { name: 'blended negative limit', method: 'POST', path: '/api/blended/page-performance', body: { siteUrl, startDate: '2026-08-01', endDate: '2026-08-02', limit: -1 } },
  { name: 'blended negative offset', method: 'POST', path: '/api/blended/page-performance', body: { siteUrl, startDate: '2026-08-01', endDate: '2026-08-02', offset: -1 } },
  { name: 'reconciliation reversed dates', method: 'GET', path: `/api/reconciliation/pages?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-08-02&endDate=2026-08-01` },
  { name: 'reconciliation negative limit', method: 'GET', path: `/api/reconciliation/pages?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-08-01&endDate=2026-08-02&limit=-1` },
  { name: 'reconciliation negative offset', method: 'GET', path: `/api/reconciliation/pages?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-08-01&endDate=2026-08-02&offset=-1` },
  { name: 'internal links reversed analysis dates', method: 'POST', path: '/api/internal-links/analyze', body: { siteUrl, startDate: '2026-08-02', endDate: '2026-08-01' } },
  { name: 'internal links negative max pages', method: 'POST', path: '/api/internal-links/analyze', body: { siteUrl, startDate: '2026-08-01', endDate: '2026-08-02', maxPages: -1 } },
  { name: 'internal links negative jobs limit', method: 'GET', path: `/api/internal-links/jobs?siteUrl=${encodeURIComponent(siteUrl)}&limit=-1` },
  { name: 'internal links negative opportunity offset', method: 'GET', path: `/api/internal-links/opportunities?siteUrl=${encodeURIComponent(siteUrl)}&startDate=2026-08-01&endDate=2026-08-02&offset=-1` },
  { name: 'internal links missing job id', method: 'POST', path: '/api/internal-links/jobs/%20/cancel', body: {} },
  { name: 'crawl negative max pages', method: 'POST', path: '/api/crawl/start', body: { siteUrl, maxPages: -1 } },
  { name: 'crawl private sitemap target', method: 'POST', path: '/api/crawl/start', body: { siteUrl, sitemapUrl: 'http://127.0.0.1/private-sitemap.xml' } },
  { name: 'crawl negative jobs limit', method: 'GET', path: `/api/crawl/jobs?siteUrl=${encodeURIComponent(siteUrl)}&limit=-1` },
  { name: 'crawl oversized jobs limit', method: 'GET', path: `/api/crawl/jobs?siteUrl=${encodeURIComponent(siteUrl)}&limit=51` },
  { name: 'crawl negative pages offset', method: 'GET', path: `/api/crawl/pages?siteUrl=${encodeURIComponent(siteUrl)}&offset=-1` },
  { name: 'crawl missing cancel id', method: 'POST', path: '/api/crawl/cancel', body: { siteUrl } },
  { name: 'rank tracking malformed keywords', method: 'POST', path: '/api/rank-tracking/keywords', body: { siteUrl, keywords: [1] } },
  { name: 'rank tracking empty keywords', method: 'POST', path: '/api/rank-tracking/keywords', body: { siteUrl, keywords: [] } },
  { name: 'rank tracking missing history id', method: 'GET', path: '/api/rank-tracking/history' },
  { name: 'rank tracking malformed hints', method: 'POST', path: '/api/rank-tracking/sync', body: { siteUrl, gscHints: [] } },
  { name: 'topical authority negative limit', method: 'GET', path: `/api/topical-authority/clusters?siteUrl=${encodeURIComponent(siteUrl)}&limit=-1` },
  { name: 'topical authority negative offset', method: 'GET', path: `/api/topical-authority/clusters?siteUrl=${encodeURIComponent(siteUrl)}&offset=-1` },
  { name: 'content authority negative limit', method: 'GET', path: `/api/content-authority/pages?siteUrl=${encodeURIComponent(siteUrl)}&limit=-1` },
  { name: 'content authority oversized limit', method: 'GET', path: `/api/content-authority/pages?siteUrl=${encodeURIComponent(siteUrl)}&limit=501` },
  { name: 'content authority negative offset', method: 'GET', path: `/api/content-authority/pages?siteUrl=${encodeURIComponent(siteUrl)}&offset=-1` },
  { name: 'content authority missing page id', method: 'GET', path: `/api/content-authority/pages/%20/evidence?siteUrl=${encodeURIComponent(siteUrl)}` },
];

const app = buildApp({
  db: new BoundaryDatabase(),
  getSyncJobKey: (ownerId, url) => `${ownerId}:${url}`,
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
  const results: Array<{ actual: number; expected: number; name: string; pass: boolean }> = [];
  for (const entry of cases) {
    const response = await fetch(`http://127.0.0.1:${port}${entry.path}`, {
      body: entry.body === undefined ? undefined : JSON.stringify(entry.body),
      headers: {
        authorization: 'Bearer boundary-token',
        ...(entry.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      method: entry.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    const expected = entry.expectedStatus ?? 400;
    results.push({ actual: response.status, expected, name: entry.name, pass: response.status === expected });
    await response.arrayBuffer();
  }

  const oversizedResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    body: JSON.stringify({ padding: 'x'.repeat(50 * 1024 * 1024) }),
    headers: {
      authorization: 'Bearer boundary-token',
      'content-type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
  });
  const oversizedContentType = oversizedResponse.headers.get('content-type') ?? '';
  const oversizedText = await oversizedResponse.text();
  let oversizedCode: string | null = null;
  try {
    oversizedCode = (JSON.parse(oversizedText) as { code?: string }).code ?? null;
  } catch {
    oversizedCode = null;
  }
  const oversized = {
    code: oversizedCode,
    contentType: oversizedContentType,
    status: oversizedResponse.status,
  };

  results.push({
    actual: oversized.status,
    expected: 413,
    name: 'oversized JSON status',
    pass: oversized.status === 413,
  });
  results.push({
    actual: oversized.code === 'PAYLOAD_TOO_LARGE' && oversized.contentType.includes('application/json') ? 1 : 0,
    expected: 1,
    name: 'oversized JSON error contract',
    pass: oversized.code === 'PAYLOAD_TOO_LARGE' && oversized.contentType.includes('application/json'),
  });

  const failures = results.filter((entry) => !entry.pass);
  console.log(JSON.stringify({
    failed: failures.length,
    failures,
    passed: results.length - failures.length,
    total: results.length,
  }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
