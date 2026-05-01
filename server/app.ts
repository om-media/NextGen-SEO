import express from 'express';
import multer from 'multer';
import type { AppDatabase } from './database.js';
import { registerAccountDataRoutes } from './routes/accountData.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerLocalAuthRoutes } from './routes/auth.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerBlendedRoutes } from './routes/blended.js';
import { registerIndexingRoutes } from './routes/indexing.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerGoogleRoutes } from './routes/google.js';
import { registerRankTrackingRoutes } from './routes/rankTracking.js';
import { registerWarehouseRoutes } from './routes/warehouse.js';
import { registerWorkspaceCrudRoutes } from './routes/workspaceCrud.js';
import { startRankTrackingScheduler } from './services/rankTracking.js';

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
};

export function buildApp({ db, upload, syncJobs, getSyncJobKey }: BuildAppOptions) {
  const app = express();

  app.use(express.json({ limit: '50mb' }));

  registerLocalAuthRoutes(app, db);
  registerAccountDataRoutes(app, db);
  registerAiRoutes(app, db);
  registerBillingRoutes(app, db);
  registerGoogleRoutes(app, db);
  registerWorkspaceCrudRoutes(app, db);
  registerLogRoutes(app, db, upload);
  registerWarehouseRoutes(app, db);
  registerBlendedRoutes(app, db);
  registerRankTrackingRoutes(app, db);
  registerIndexingRoutes(app, db, syncJobs, getSyncJobKey);

  startRankTrackingScheduler(db);

  return app;
}
