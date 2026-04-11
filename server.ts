import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import path from 'path';

const db = new Database('sqlite.db');
db.pragma('journal_mode = WAL');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    domain TEXT,
    ownerId TEXT,
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS filters (
    id TEXT PRIMARY KEY,
    name TEXT,
    projectId TEXT,
    ownerId TEXT,
    configuration TEXT,
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    tier TEXT,
    unlockedSites TEXT,
    createdAt TEXT
  );
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // API Routes
  
  // User Routes
  app.get('/api/users/:id', (req, res) => {
    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
      if (user) {
        user.unlockedSites = JSON.parse(user.unlockedSites || '[]');
        res.json(user);
      } else {
        res.status(404).json({ error: 'User not found' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/users', (req, res) => {
    const { id, email, tier, unlockedSites, createdAt } = req.body;
    try {
      db.prepare('INSERT OR IGNORE INTO users (id, email, tier, unlockedSites, createdAt) VALUES (?, ?, ?, ?, ?)')
        .run(id, email, tier, JSON.stringify(unlockedSites || []), createdAt);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/unlock', (req, res) => {
    const { siteUrl } = req.body;
    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      const unlockedSites = JSON.parse(user.unlockedSites || '[]');
      if (!unlockedSites.includes(siteUrl)) {
        unlockedSites.push(siteUrl);
        db.prepare('UPDATE users SET unlockedSites = ? WHERE id = ?')
          .run(JSON.stringify(unlockedSites), req.params.id);
      }
      res.json({ success: true, unlockedSites });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/tier', (req, res) => {
    const { tier } = req.body;
    try {
      db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, req.params.id);
      res.json({ success: true, tier });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects', (req, res) => {
    const { ownerId } = req.query;
    if (!ownerId) return res.json([]);
    try {
      const rows = db.prepare('SELECT * FROM projects WHERE ownerId = ?').all(ownerId);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects', (req, res) => {
    const { id, name, domain, ownerId, createdAt } = req.body;
    try {
      db.prepare('INSERT INTO projects (id, name, domain, ownerId, createdAt) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, domain, ownerId, createdAt);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/filters', (req, res) => {
    const { ownerId } = req.query;
    if (!ownerId) return res.json([]);
    try {
      const rows = db.prepare('SELECT * FROM filters WHERE ownerId = ?').all(ownerId);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/filters', (req, res) => {
    const { id, name, projectId, ownerId, configuration, createdAt } = req.body;
    try {
      db.prepare('INSERT INTO filters (id, name, projectId, ownerId, configuration, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, projectId, ownerId, configuration, createdAt);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/filters/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM filters WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
