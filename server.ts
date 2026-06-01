import dotenv from 'dotenv';
import fs from 'fs';
import multer from 'multer';
import { buildApp, type SyncJobState } from './server/app.js';
import { validateRuntimeConfig } from './server/config.js';
import { initializeDatabase } from './server/database.js';
import { attachFrontend } from './server/frontend.js';

dotenv.config({ path: '.env.local' });
dotenv.config();
validateRuntimeConfig();
fs.mkdirSync('uploads', { recursive: true });

const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});
const syncJobs = new Map<string, SyncJobState>();
const getSyncJobKey = (ownerId: string, siteUrl: string) => `${ownerId}:${siteUrl}`;

async function startServer() {
  const PORT = Number(process.env.PORT || 3000);
  const db = await initializeDatabase();
  const app = buildApp({ db, upload, syncJobs, getSyncJobKey });
  await attachFrontend(app);

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.log(`[server] ${signal} received, shutting down...`);
    const forceExit = setTimeout(() => {
      console.error('[server] Graceful shutdown timed out.');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    app.locals.stopBackgroundWorkers?.();
    server.close((error) => {
      if (error) {
        console.error('[server] Error while closing HTTP server:', error);
      }
      db.close?.()
        .catch((closeError) => {
          console.error('[server] Error while closing database:', closeError);
          process.exitCode = 1;
        })
        .finally(() => {
          clearTimeout(forceExit);
          process.exit();
        });
    });
    server.closeIdleConnections?.();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled promise rejection:', reason);
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    console.error('[server] Uncaught exception:', error);
    shutdown('uncaughtException');
  });
}

startServer().catch((error) => {
  console.error('[server] Startup failed:', error);
  process.exit(1);
});
