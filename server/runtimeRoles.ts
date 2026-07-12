import type { AppDatabase } from './database.js';
import { startBingDailyScheduler } from './services/bingWarehouse.js';
import { startCrawlQueueWorker } from './services/crawl.js';
import { startGscMonthlySummaryBackfillWorker } from './services/gscMonthlySummaries.js';
import { startInternalLinkAnalysisWorker } from './services/internalLinks.js';
import { startRankTrackingScheduler } from './services/rankTracking.js';
import { startWarehouseDailyScheduler, startWarehouseJobWorker } from './services/warehouseJobs.js';

export const RUNTIME_ROLES = ['all', 'web', 'crawl', 'internal-links', 'warehouse', 'scheduler'] as const;
export type RuntimeRole = typeof RUNTIME_ROLES[number];

const runtimeRoleSet = new Set<string>(RUNTIME_ROLES);

export function parseRuntimeRole(value: unknown, fallback: RuntimeRole): RuntimeRole {
  const normalized = String(value || '').trim().toLowerCase();
  return runtimeRoleSet.has(normalized) ? normalized as RuntimeRole : fallback;
}

export function configuredRuntimeRole() {
  const fallback: RuntimeRole = process.env.NODE_ENV === 'production' ? 'web' : 'all';
  return parseRuntimeRole(process.env.APP_PROCESS_ROLE || process.env.WORKER_ROLE, fallback);
}

export function startRuntimeServices(db: AppDatabase, role: RuntimeRole) {
  const stops: Array<(() => void) | undefined> = [];

  if (role === 'all' || role === 'crawl') {
    stops.push(startCrawlQueueWorker(db));
  }
  if (role === 'all' || role === 'internal-links') {
    stops.push(startInternalLinkAnalysisWorker(db));
  }
  if (role === 'all' || role === 'warehouse') {
    stops.push(startWarehouseJobWorker(db));
    stops.push(startGscMonthlySummaryBackfillWorker(db));
  }
  if (role === 'all' || role === 'scheduler') {
    stops.push(startBingDailyScheduler(db));
    stops.push(startWarehouseDailyScheduler(db));
    stops.push(startRankTrackingScheduler(db));
  }

  return () => {
    for (const stop of stops.reverse()) {
      try {
        stop?.();
      } catch (error) {
        console.error('[runtime] Failed to stop service for role', role, error);
      }
    }
  };
}