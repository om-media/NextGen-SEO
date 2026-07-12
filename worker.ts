import dotenv from 'dotenv';
import http from 'node:http';
import { validateRuntimeConfig } from './server/config.js';
import { initializeDatabase } from './server/database.js';
import { parseRuntimeRole, startRuntimeServices, type RuntimeRole } from './server/runtimeRoles.js';

dotenv.config({ path: '.env.local' });
dotenv.config();
validateRuntimeConfig();

const allowedWorkerRoles = new Set<RuntimeRole>(['crawl', 'internal-links', 'warehouse', 'scheduler']);

async function startWorker() {
  const role = parseRuntimeRole(process.argv[2] || process.env.WORKER_ROLE || process.env.APP_PROCESS_ROLE, 'crawl');
  if (!allowedWorkerRoles.has(role)) {
    throw new Error('WORKER_ROLE must be crawl, internal-links, warehouse, or scheduler.');
  }

  const db = await initializeDatabase();
  const dryRun = process.env.WORKER_DRY_RUN === 'true';
  const stopServices = dryRun ? () => {} : startRuntimeServices(db, role);
  const defaultPorts: Record<Exclude<RuntimeRole, 'all' | 'web'>, number> = {
    crawl: 3101,
    'internal-links': 3102,
    warehouse: 3103,
    scheduler: 3104,
  };
  const healthPort = Number(process.env.WORKER_HEALTH_PORT || defaultPorts[role as keyof typeof defaultPorts]);

  const healthServer = http.createServer(async (request, response) => {
    if (request.url !== '/health' && request.url !== '/ready') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, role }));
      return;
    }

    try {
      await db.get('SELECT 1 AS ok');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const diagnostics = db.getDiagnostics?.();
      response.end(JSON.stringify({
        database: db.dialect,
        ok: true,
        pool: diagnostics?.pool ? {
          idle: diagnostics.pool.idleCount,
          max: diagnostics.pool.max,
          total: diagnostics.pool.totalCount,
          waiting: diagnostics.pool.waitingCount,
        } : undefined,
        role,
      }));
    } catch {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Database unavailable', ok: false, role }));
    }
  });

  await new Promise<void>((resolve) => healthServer.listen(healthPort, '0.0.0.0', resolve));
  console.log('[worker] ' + role + ' ready on health port ' + healthPort + (dryRun ? ' (dry run)' : ''));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[worker] ' + role + ' received ' + signal + ', shutting down...');
    stopServices();
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await db.close?.();
    process.exit();
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (error) => {
    console.error('[worker] Unhandled rejection:', error);
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    console.error('[worker] Uncaught exception:', error);
    void shutdown('uncaughtException');
  });
}

startWorker().catch((error) => {
  console.error('[worker] Startup failed:', error);
  process.exit(1);
});