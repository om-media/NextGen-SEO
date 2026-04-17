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
  
  -- Data Warehouse Tables
  CREATE TABLE IF NOT EXISTS gsc_site_metrics (
    siteUrl TEXT,
    date TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (siteUrl, date)
  );
  
  CREATE TABLE IF NOT EXISTS gsc_query_metrics (
    siteUrl TEXT,
    date TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (siteUrl, date, query)
  );
  
  CREATE TABLE IF NOT EXISTS warehouse_sync_status (
    siteUrl TEXT PRIMARY KEY,
    lastSyncDate TEXT,
    earliestSyncDate TEXT,
    status TEXT,
    lastUpdated TEXT
  );
`);

// Add bingApiKey column if it doesn't exist
try {
  db.exec(`ALTER TABLE users ADD COLUMN bingApiKey TEXT`);
} catch (e) {
  // Column likely already exists
}

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
        
        // Ensure tier limit is respected
        const limit = user.tier === 'free' ? 1 : user.tier === 'pro' ? 3 : Infinity;
        if (user.unlockedSites.length > limit) {
          user.unlockedSites = user.unlockedSites.slice(0, limit);
          db.prepare('UPDATE users SET unlockedSites = ? WHERE id = ?').run(JSON.stringify(user.unlockedSites), req.params.id);
        }

        res.json(user);
      } else {
        res.status(404).json({ error: 'User not found' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/users', (req, res) => {
    const { id, email, tier, unlockedSites, createdAt, bingApiKey } = req.body;
    try {
      db.prepare('INSERT OR IGNORE INTO users (id, email, tier, unlockedSites, createdAt, bingApiKey) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, email, tier, JSON.stringify(unlockedSites || []), createdAt, bingApiKey || null);
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
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
      if (!user) return res.status(404).json({ error: 'User not found' });

      let unlockedSites = JSON.parse(user.unlockedSites || '[]');
      const limit = tier === 'free' ? 1 : tier === 'pro' ? 3 : Infinity;
      
      let trimmedSites = unlockedSites;
      if (unlockedSites.length > limit) {
        trimmedSites = unlockedSites.slice(0, limit);
        db.prepare('UPDATE users SET tier = ?, unlockedSites = ? WHERE id = ?').run(tier, JSON.stringify(trimmedSites), req.params.id);
      } else {
        db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, req.params.id);
      }
      res.json({ success: true, tier, unlockedSites: trimmedSites });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/users/:id/bing-key', (req, res) => {
    const { bingApiKey } = req.body;
    try {
      db.prepare('UPDATE users SET bingApiKey = ? WHERE id = ?').run(bingApiKey, req.params.id);
      res.json({ success: true, bingApiKey });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bing Webmaster API Proxy Routes
  app.get('/api/bing/sites', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    
    try {
      const user = db.prepare('SELECT bingApiKey FROM users WHERE id = ?').get(userId) as any;
      if (!user || !user.bingApiKey) {
        return res.status(400).json({ error: 'Bing API key not configured' });
      }

      const response = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${user.bingApiKey}`);
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/bing/stats', async (req, res) => {
    const { userId, siteUrl } = req.query;
    if (!userId || !siteUrl) return res.status(400).json({ error: 'Missing userId or siteUrl' });
    
    try {
      const user = db.prepare('SELECT bingApiKey FROM users WHERE id = ?').get(userId) as any;
      if (!user || !user.bingApiKey) {
        return res.status(400).json({ error: 'Bing API key not configured' });
      }

      const response = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=${encodeURIComponent(siteUrl as string)}&apikey=${user.bingApiKey}`);
      const data = await response.json();
      res.json(data);
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

  // Data Warehouse APIs
  app.post('/api/warehouse/ingest/site', (req, res) => {
    const { siteUrl, rows } = req.body;
    if (!siteUrl || !rows || !Array.isArray(rows)) return res.status(400).json({ error: 'Invalid payload' });
    try {
      const stmt = db.prepare(`
        INSERT INTO gsc_site_metrics (siteUrl, date, clicks, impressions, ctr, position)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(siteUrl, date) DO UPDATE SET
          clicks=excluded.clicks,
          impressions=excluded.impressions,
          ctr=excluded.ctr,
          position=excluded.position
      `);
      const insertMany = db.transaction((metrics) => {
        for (const row of metrics) {
          const date = row.keys[0]; // '2025-01-01'
          stmt.run(siteUrl, date, row.clicks, row.impressions, row.ctr, row.position);
        }
      });
      insertMany(rows);
      res.json({ success: true, count: rows.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/ingest/query', (req, res) => {
    const { siteUrl, rows } = req.body;
    if (!siteUrl || !rows || !Array.isArray(rows)) return res.status(400).json({ error: 'Invalid payload' });
    try {
      const stmt = db.prepare(`
        INSERT INTO gsc_query_metrics (siteUrl, date, query, clicks, impressions, ctr, position)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(siteUrl, date, query) DO UPDATE SET
          clicks=excluded.clicks,
          impressions=excluded.impressions,
          ctr=excluded.ctr,
          position=excluded.position
      `);
      const insertMany = db.transaction((metrics) => {
        for (const row of metrics) {
          const date = row.keys[0]; // '2025-01-01'
          const query = row.keys[1] || ''; // 'search term'
          stmt.run(siteUrl, date, query, row.clicks, row.impressions, row.ctr, row.position);
        }
      });
      insertMany(rows);
      res.json({ success: true, count: rows.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/warehouse/status', (req, res) => {
    const { siteUrl } = req.query;
    try {
      if (siteUrl) {
        const status = db.prepare('SELECT * FROM warehouse_sync_status WHERE siteUrl = ?').get(siteUrl);
        res.json(status || { siteUrl, status: 'uninitialized' });
      } else {
        const statuses = db.prepare('SELECT * FROM warehouse_sync_status').all();
        res.json(statuses);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/status', (req, res) => {
    const { siteUrl, lastSyncDate, earliestSyncDate, status } = req.body;
    try {
      db.prepare(`
        INSERT INTO warehouse_sync_status (siteUrl, lastSyncDate, earliestSyncDate, status, lastUpdated)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(siteUrl) DO UPDATE SET
          lastSyncDate=IFNULL(excluded.lastSyncDate, lastSyncDate),
          earliestSyncDate=IFNULL(excluded.earliestSyncDate, earliestSyncDate),
          status=IFNULL(excluded.status, status),
          lastUpdated=excluded.lastUpdated
      `).run(siteUrl, lastSyncDate, earliestSyncDate, status, new Date().toISOString());
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/query', (req, res) => {
    const { siteUrl, startDate, endDate, dimensions, dimensionFilterGroups } = req.body;
    if (!siteUrl || !startDate || !endDate) return res.status(400).json({ error: 'Missing parameters' });
    
    try {
      const dims = (dimensions as string[]) || [];
      const hasDate = dims.includes('date');
      const hasQuery = dims.includes('query');
      
      let selectClauseElements = [];
      let groupByClauseElements = [];
      let orderClause = "ORDER BY impressions DESC";
      
      if (hasDate) {
        selectClauseElements.push("date");
        groupByClauseElements.push("date");
        orderClause = "ORDER BY date ASC";
      }
      if (hasQuery) {
        selectClauseElements.push("query");
        groupByClauseElements.push("query");
        if (!hasDate) orderClause = "ORDER BY clicks DESC, impressions DESC";
      }

      const selectCols = selectClauseElements.length > 0 ? selectClauseElements.join(", ") + ", " : "";
      const groupByClause = groupByClauseElements.length > 0 ? "GROUP BY " + groupByClauseElements.join(", ") : "";

      let whereClause = "WHERE siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate";
      const params: any = { siteUrl, startDate, endDate };

      if (dimensionFilterGroups && dimensionFilterGroups.length > 0) {
        // Implement basic query filtering
        for (const group of dimensionFilterGroups) {
          if (group.filters) {
            for (const filter of group.filters) {
              if (filter.dimension === 'query' && filter.expression) {
                const paramIdx = Object.keys(params).length;
                if (filter.operator === 'contains') {
                  whereClause += ` AND query LIKE @queryFilter${paramIdx}`;
                  params[`queryFilter${paramIdx}`] = `%${filter.expression}%`;
                } else if (filter.operator === 'notContains') {
                  whereClause += ` AND query NOT LIKE @queryFilter${paramIdx}`;
                  params[`queryFilter${paramIdx}`] = `%${filter.expression}%`;
                }
              }
            }
          }
        }
      }

      let rows = [];
      if (hasQuery) {
         rows = db.prepare(`
            SELECT ${selectCols} 
                   SUM(clicks) as clicks, 
                   SUM(impressions) as impressions, 
                   SUM(clicks)*1.0/MAX(SUM(impressions), 1) as ctr, 
                   SUM(position * impressions)*1.0/MAX(SUM(impressions), 1) as position
            FROM gsc_query_metrics
            ${whereClause}
            ${groupByClause}
            ${orderClause}
            LIMIT 50000
         `).all(params);
      } else {
         rows = db.prepare(`
            SELECT ${selectCols} 
                   SUM(clicks) as clicks, 
                   SUM(impressions) as impressions, 
                   SUM(clicks)*1.0/MAX(SUM(impressions), 1) as ctr, 
                   SUM(position * impressions)*1.0/MAX(SUM(impressions), 1) as position
            FROM gsc_site_metrics
            ${whereClause}
            ${groupByClause}
            ${orderClause}
            LIMIT 50000
         `).all(params);
      }
      
      // format to match Google Search Console API [key1, key2]
      rows = rows.map((r: any) => {
         const keys = [];
         if (hasDate) keys.push(r.date);
         if (hasQuery) keys.push(r.query);
         return {
            keys: keys.length > 0 ? keys : undefined,
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: r.ctr,
            position: r.position
         }
      });

      res.json(rows);
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
