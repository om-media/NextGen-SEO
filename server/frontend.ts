import express from 'express';
import { createServer as createViteServer, loadEnv } from 'vite';
import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export async function attachFrontend(app: express.Express) {
  if (process.env.NODE_ENV !== 'production') {
    const env = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '');
    const vite = await createViteServer({
      configFile: false,
      server: { middlewareMode: true },
      appType: 'spa',
      plugins: [react(), tailwindcss()],
      define: {
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      },
      resolve: {
        alias: {
          '@': path.resolve(process.cwd(), '.'),
        },
      },
    });

    app.use(vite.middlewares);
    return;
  }

  const distPath = path.join(process.cwd(), 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}
