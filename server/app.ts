import express from 'express';
import multer from 'multer';
import type Database from 'better-sqlite3';
import { registerAccountDataRoutes } from './routes/accountData.js';
import { registerIndexingRoutes } from './routes/indexing.js';
import { registerLogRoutes } from './routes/logs.js';
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
  db: Database.Database;
  upload: multer.Multer;
  syncJobs: Map<string, SyncJobState>;
  getSyncJobKey: (ownerId: string, siteUrl: string) => string;
};

export function buildApp({ db, upload, syncJobs, getSyncJobKey }: BuildAppOptions) {
  const app = express();

  app.use(express.json({ limit: '50mb' }));

  registerAccountDataRoutes(app, db);
  registerWorkspaceCrudRoutes(app, db);
  registerLogRoutes(app, db, upload);
  registerWarehouseRoutes(app, db);
  registerRankTrackingRoutes(app, db);
  registerIndexingRoutes(app, db, syncJobs, getSyncJobKey);

  startRankTrackingScheduler(db);

  return app;
}
