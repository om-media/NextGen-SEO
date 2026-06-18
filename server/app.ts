import express from 'express';
import multer from 'multer';
import type { AppDatabase } from './database.js';
import { registerAccountDataRoutes } from './routes/accountData.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerLocalAuthRoutes } from './routes/auth.js';
import { registerCrawlRoutes } from './routes/crawl.js';
import { registerBlendedRoutes } from './routes/blended.js';
import { registerIndexingRoutes } from './routes/indexing.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerGoogleRoutes } from './routes/google.js';
import { registerRankTrackingRoutes } from './routes/rankTracking.js';
import { registerReconciliationRoutes } from './routes/reconciliation.js';
import { registerWarehouseRoutes } from './routes/warehouse.js';
import { registerWorkspaceCrudRoutes } from './routes/workspaceCrud.js';
import { authRateLimit, securityHeaders } from './middleware/security.js';
import { startBingDailyScheduler } from './services/bingWarehouse.js';
import { startCrawlQueueWorker } from './services/crawl.js';
import { startGscMonthlySummaryBackfillWorker } from './services/gscMonthlySummaries.js';
import { startRankTrackingScheduler } from './services/rankTracking.js';
import { startWarehouseDailyScheduler, startWarehouseJobWorker } from './services/warehouseJobs.js';

export type SyncJobState = {
  current: number;
  total: number;
  status: 'running' | 'completed' | 'error';
  message?: string;
};

type BuildAppOptions = {
  db: AppDatabase;
  upload: multer.Multer;
  syncJobs: Map<string, SyncJobState>;
  getSyncJobKey: (ownerId: string, siteUrl: string) => string;
  startWorkers?: boolean;
};

export function buildApp({ db, upload, syncJobs, getSyncJobKey, startWorkers = true }: BuildAppOptions) {
  const app = express();

  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  app.use(securityHeaders);
  app.use(express.json({ limit: '50mb' }));
  app.disable('x-powered-by');

  app.use('/api/auth/login', authRateLimit);
  app.use('/api/auth/register', authRateLimit);
  app.use('/api/auth/google/start', authRateLimit);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      database: {
        dialect: db.dialect,
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/ready', async (_req, res) => {
    try {
      await db.get('SELECT 1 AS ok');
      res.json({
        ok: true,
        database: {
          dialect: db.dialect,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: 'Database unavailable',
        timestamp: new Date().toISOString(),
      });
    }
  });

  registerLocalAuthRoutes(app, db);
  registerAccountDataRoutes(app, db);
  registerAiRoutes(app, db);
  registerCrawlRoutes(app, db);
  registerGoogleRoutes(app, db);
  registerWorkspaceCrudRoutes(app, db);
  registerLogRoutes(app, db, upload);
  registerWarehouseRoutes(app, db);
  registerBlendedRoutes(app, db);
  registerReconciliationRoutes(app, db);
  registerRankTrackingRoutes(app, db);
  registerIndexingRoutes(app, db, syncJobs, getSyncJobKey);

  if (startWorkers) {
    const stopWorkers = [
      startCrawlQueueWorker(db),
      startBingDailyScheduler(db),
      startWarehouseJobWorker(db),
      startWarehouseDailyScheduler(db),
      startGscMonthlySummaryBackfillWorker(db),
      startRankTrackingScheduler(db),
    ];
    app.locals.stopBackgroundWorkers = () => {
      for (const stop of stopWorkers) {
        stop?.();
      }
    };
  }

  return app;
}
