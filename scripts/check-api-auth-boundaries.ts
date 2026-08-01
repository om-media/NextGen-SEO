import multer from 'multer';
import type { AddressInfo } from 'node:net';
import type { AppDatabase, QueryParams, RunResult } from '../server/database.js';
import { buildApp } from '../server/app.js';

class AuthProbeDatabase implements AppDatabase {
  dialect = 'sqlite' as const;

  prepare() {
    throw new Error('prepare is not used by the auth-boundary probe');
  }

  async exec() {}

  async get<T = unknown>(sql: string, _params?: QueryParams) {
    if (/SELECT 1 AS ok/i.test(sql)) return { ok: 1 } as T;
    return undefined;
  }

  async all<T = unknown>() {
    return [] as T[];
  }

  async run(_sql: string, _params?: QueryParams): Promise<RunResult> {
    return { changes: 0 };
  }

  transaction<Args extends unknown[], T>(callback: (...args: Args) => T | Promise<T>) {
    return async (...args: Args) => callback(...args);
  }
}

type RouteLayer = {
  route?: {
    methods: Record<string, boolean>;
    path: string;
  };
};

const publicRoutes = new Set([
  'GET:/api/auth/google/start',
  'GET:/api/auth/session',
  'GET:/api/google/oauth/callback',
  'GET:/api/health',
  'GET:/api/ready',
  'POST:/api/auth/login',
  'POST:/api/auth/register',
]);

const app = buildApp({
  db: new AuthProbeDatabase(),
  getSyncJobKey: (ownerId, siteUrl) => `${ownerId}:${siteUrl}`,
  startWorkers: false,
  syncJobs: new Map(),
  upload: multer({ storage: multer.memoryStorage() }),
});

const routerStack = ((app as any)._router?.stack || []) as RouteLayer[];
const routes = routerStack.flatMap((layer) => {
  if (!layer.route) return [];
  return Object.entries(layer.route.methods)
    .filter(([, enabled]) => enabled)
    .map(([method]) => ({ method: method.toUpperCase(), path: layer.route!.path }));
});

const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});

try {
  const port = (server.address() as AddressInfo).port;
  const results = [];
  for (const route of routes) {
    const routeKey = `${route.method}:${route.path}`;
    const concretePath = route.path.replace(/:[^/]+/g, 'probe');
    const response = await fetch(`http://127.0.0.1:${port}${concretePath}`, {
      body: ['GET', 'HEAD'].includes(route.method) ? undefined : '{}',
      headers: ['GET', 'HEAD'].includes(route.method) ? undefined : { 'content-type': 'application/json' },
      method: route.method,
      redirect: 'manual',
    });
    results.push({ route: routeKey, status: response.status });

    if (!publicRoutes.has(routeKey) && response.status !== 401) {
      throw new Error(`${routeKey} allowed an unauthenticated request with status ${response.status}`);
    }
  }

  const protectedResults = results.filter((entry) => !publicRoutes.has(entry.route));
  console.log(JSON.stringify({
    protectedCount: protectedResults.length,
    protectedStatusCounts: protectedResults.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.status] = (counts[entry.status] || 0) + 1;
      return counts;
    }, {}),
    public: results.filter((entry) => publicRoutes.has(entry.route)),
    routeCount: results.length,
  }, null, 2));
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
