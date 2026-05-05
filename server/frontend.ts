import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export async function attachFrontend(app: express.Express) {
  const distPath = path.join(process.cwd(), 'dist');
  const hasBuiltClient = fs.existsSync(path.join(distPath, 'index.html'));
  const useViteMiddleware =
    process.env.USE_VITE_MIDDLEWARE === 'true' ||
    (process.env.NODE_ENV !== 'production' && !hasBuiltClient);

  if (useViteMiddleware) {
    const vite = await createViteServer({
      configFile: false,
      server: {
        middlewareMode: true,
        watch: {
          ignored: [
            '**/sqlite.db',
            '**/sqlite.db-*',
            '**/sqlite.db.*',
            '**/.server-dist/**',
            '**/uploads/**',
          ],
        },
      },
      appType: 'spa',
      plugins: [react(), tailwindcss()],
      resolve: {
        alias: {
          '@': path.resolve(process.cwd(), '.'),
        },
      },
    });

    app.use(vite.middlewares);
    return;
  }

  app.use(express.static(distPath));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}
