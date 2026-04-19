import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import path from 'path';
import * as cheerio from 'cheerio';

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
  
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    userId TEXT,
    siteUrl TEXT,
    date TEXT,
    title TEXT,
    description TEXT,
    type TEXT,
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

  CREATE TABLE IF NOT EXISTS gsc_page_query_metrics (
    siteUrl TEXT,
    date TEXT,
    page TEXT,
    query TEXT,
    clicks INTEGER,
    impressions INTEGER,
    ctr REAL,
    position REAL,
    PRIMARY KEY (siteUrl, date, page, query)
  );
  
  CREATE TABLE IF NOT EXISTS warehouse_sync_status (
    siteUrl TEXT PRIMARY KEY,
    lastSyncDate TEXT,
    earliestSyncDate TEXT,
    status TEXT,
    lastUpdated TEXT
  );

  CREATE TABLE IF NOT EXISTS tracked_keywords (
    id TEXT PRIMARY KEY,
    siteUrl TEXT,
    keyword TEXT,
    location TEXT,
    device TEXT,
    tags TEXT,
    targetDomain TEXT,
    createdAt TEXT,
    UNIQUE(siteUrl, keyword)
  );

  CREATE TABLE IF NOT EXISTS keyword_rankings (
    keywordId TEXT,
    date TEXT,
    position INTEGER,
    rankingUrl TEXT,
    PRIMARY KEY (keywordId, date)
  );
`);

// Add bingApiKey column if it doesn't exist
try {
  db.exec(`ALTER TABLE users ADD COLUMN bingApiKey TEXT`);
} catch (e) {
  // Column likely already exists
}

// Add targetDomain to existing tracked_keywords
try {
  db.exec(`ALTER TABLE tracked_keywords ADD COLUMN targetDomain TEXT`);
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

  // Annotations Routes
  app.get('/api/annotations/:userId', (req, res) => {
    try {
      const { siteUrl } = req.query;
      let annotations;
      if (siteUrl && siteUrl !== 'null') {
         annotations = db.prepare('SELECT * FROM annotations WHERE userId = ? AND (siteUrl = ? OR siteUrl IS NULL) ORDER BY date DESC')
           .all(req.params.userId, siteUrl as string);
      } else {
         annotations = db.prepare('SELECT * FROM annotations WHERE userId = ? ORDER BY date DESC')
           .all(req.params.userId);
      }
      res.json(annotations);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/annotations/:userId', (req, res) => {
    const { id, siteUrl, date, title, description, type } = req.body;
    try {
      db.prepare(`
        INSERT INTO annotations (id, userId, siteUrl, date, title, description, type, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id || Math.random().toString(36).substring(2, 15),
        req.params.userId,
        siteUrl || null,
        date, // Expected format: YYYY-MM-DD
        title,
        description || '',
        type || 'user',
        new Date().toISOString()
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/annotations/:userId/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM annotations WHERE id = ? AND userId = ?').run(req.params.id, req.params.userId);
      res.json({ success: true });
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

  app.post('/api/warehouse/ingest/page_query', (req, res) => {
    const { siteUrl, rows } = req.body;
    if (!siteUrl || !rows || !Array.isArray(rows)) return res.status(400).json({ error: 'Invalid payload' });
    try {
      const stmt = db.prepare(`
        INSERT INTO gsc_page_query_metrics (siteUrl, date, page, query, clicks, impressions, ctr, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(siteUrl, date, page, query) DO UPDATE SET
          clicks=excluded.clicks,
          impressions=excluded.impressions,
          ctr=excluded.ctr,
          position=excluded.position
      `);
      const insertMany = db.transaction((metrics) => {
        for (const row of metrics) {
          const date = row.keys[0];
          const page = row.keys[1] || '';
          const query = row.keys[2] || '';
          stmt.run(siteUrl, date, page, query, row.clicks, row.impressions, row.ctr, row.position);
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
      const hasPage = dims.includes('page');
      
      let selectClauseElements = [];
      let groupByClauseElements = [];
      let orderClause = "ORDER BY impressions DESC";
      
      if (hasDate) {
        selectClauseElements.push("date");
        groupByClauseElements.push("date");
        orderClause = "ORDER BY date ASC";
      }
      if (hasPage) {
        selectClauseElements.push("page");
        groupByClauseElements.push("page");
        if (!hasDate) orderClause = "ORDER BY clicks DESC, impressions DESC";
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
              if (filter.dimension === 'page' && filter.expression) {
                const paramIdx = Object.keys(params).length;
                if (filter.operator === 'equals') {
                  whereClause += ` AND page = @pageFilter${paramIdx}`;
                  params[`pageFilter${paramIdx}`] = filter.expression;
                } else if (filter.operator === 'contains') {
                  whereClause += ` AND page LIKE @pageFilter${paramIdx}`;
                  params[`pageFilter${paramIdx}`] = `%${filter.expression}%`;
                } else if (filter.operator === 'notContains') {
                  whereClause += ` AND page NOT LIKE @pageFilter${paramIdx}`;
                  params[`pageFilter${paramIdx}`] = `%${filter.expression}%`;
                }
              }
            }
          }
        }
      }

      let rows = [];
      if (hasPage && hasQuery) {
         rows = db.prepare(`
            SELECT ${selectCols} 
                   SUM(clicks) as clicks, 
                   SUM(impressions) as impressions, 
                   SUM(clicks)*1.0/MAX(SUM(impressions), 1) as ctr, 
                   SUM(position * impressions)*1.0/MAX(SUM(impressions), 1) as position
            FROM gsc_page_query_metrics
            ${whereClause}
            ${groupByClause}
            ${orderClause}
            LIMIT 50000
         `).all(params);
      } else if (hasQuery) {
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

  // --- NEW: Rank Tracking Endpoints (Hybrid Engine) ---
  
  app.get('/api/rank-tracking/keywords', (req, res) => {
    const { siteUrl } = req.query;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    try {
      const keywords = db.prepare('SELECT * FROM tracked_keywords WHERE siteUrl = ? ORDER BY createdAt DESC').all(siteUrl);
      
      // Also attach the latest rank for each
      const enriched = keywords.map((kw: any) => {
        const latestRank = db.prepare('SELECT position, rankingUrl, date FROM keyword_rankings WHERE keywordId = ? ORDER BY date DESC LIMIT 1').get(kw.id) as any;
        return {
          ...kw,
          currentPosition: latestRank ? latestRank.position : null,
          rankingUrl: latestRank ? latestRank.rankingUrl : null,
          lastUpdated: latestRank ? latestRank.date : null
        };
      });
      res.json(enriched);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/rank-tracking/keywords', (req, res) => {
    const { siteUrl, keywords, location, device, tags, targetDomain } = req.body;
    if (!siteUrl || !keywords || !Array.isArray(keywords)) return res.status(400).json({ error: 'Invalid payload' });
    
    try {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO tracked_keywords (id, siteUrl, keyword, location, device, tags, targetDomain, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      const insertMany = db.transaction((kws) => {
        for (const kw of kws) {
          const id = Math.random().toString(36).substring(2, 15);
          stmt.run(id, siteUrl, kw.trim(), location || 'US', device || 'desktop', tags || '', targetDomain || '', new Date().toISOString());
        }
      });
      
      insertMany(keywords);
      
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/rank-tracking/keywords/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM tracked_keywords WHERE id = ?').run(req.params.id);
      db.prepare('DELETE FROM keyword_rankings WHERE keywordId = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/rank-tracking/history', (req, res) => {
    const { keywordId } = req.query;
    if (!keywordId) return res.status(400).json({ error: 'Missing keywordId' });
    try {
      const history = db.prepare('SELECT * FROM keyword_rankings WHERE keywordId = ? ORDER BY date ASC').all(keywordId);
      res.json(history);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/rank-tracking/sync', async (req, res) => {
    const { siteUrl, force, gscHints } = req.body;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    
    try {
      const keywords = db.prepare('SELECT * FROM tracked_keywords WHERE siteUrl = ?').all(siteUrl) as any[];
      const today = new Date().toISOString().split('T')[0];
      let syncCount = 0;
      
      const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
      
      // Clean up siteUrl for matching
      const defaultTargetDomain = siteUrl.replace(/^https?:\/\//, '').replace(/^sc-domain:/, '').replace(/^www\./, '').split('/')[0];

      for (const kw of keywords) {
        // Use kw.targetDomain if it exists, otherwise fallback to the extracted defaultTargetDomain
        let currentTargetDomain = kw.targetDomain && kw.targetDomain.trim() !== '' ? kw.targetDomain : defaultTargetDomain;
        
        // Aggressively clean the currentTargetDomain to just the bare domain
        currentTargetDomain = currentTargetDomain.replace(/^https?:\/\//, '').replace(/^sc-domain:/, '').replace(/^www\./, '').split('/')[0];
        
        // Skip if we already synced today AND we aren't forcing an update
        if (!force) {
          const existing = db.prepare('SELECT 1 FROM keyword_rankings WHERE keywordId = ? AND date = ?').get(kw.id, today);
          if (existing) continue;
        }

        let positionToRecord = 101; // Default to 101+ (unranked)
        let matchedUrl = null;
        let foundInGsc = false;

        // Map location manually
        const mapLocToGsc = (loc: string) => {
            if (loc === 'UK') return 'gbr';
            if (loc === 'US') return 'usa';
            if (loc === 'CA') return 'can';
            if (loc === 'AU') return 'aus';
            return loc ? loc.toLowerCase() : 'gbr';
        };

        const compositeKey = `${kw.keyword.toLowerCase().trim()}|${(kw.device || 'desktop').toLowerCase()}|${mapLocToGsc(kw.location || 'UK')}`;

        console.log(`Checking GSC Hints for compositeKey: ${compositeKey}`);
        
        let hint = undefined;

        // Tier 1a: Check Frontend Live GSC Hints using the composite key exactly
        if (gscHints && gscHints[compositeKey] !== undefined) {
           hint = gscHints[compositeKey];
           console.log(`Found GSC Hint (Exact)!`, hint);
        } else if (gscHints && gscHints[kw.keyword.toLowerCase().trim()] !== undefined) {
           // Tier 1b: Fallback to global query average if exact localization is missing
           hint = gscHints[kw.keyword.toLowerCase().trim()];
           console.log(`Found GSC Hint (Global Fallback)!`, hint);
        } else {
           console.log(`No GSC hint found. available keys:`, gscHints ? Object.keys(gscHints) : 'none');
        }

        if (hint !== undefined) {
           positionToRecord = typeof hint === 'object' ? hint.position : hint;
           matchedUrl = typeof hint === 'object' && hint.url ? hint.url : 'gsc_live_auth';
           foundInGsc = true;
        }

        // Tier 1b: Check GSC Data Warehouse (fast & free!)
        if (!foundInGsc) {
          const gscData = db.prepare(`
            SELECT position, date FROM gsc_query_metrics 
            WHERE siteUrl = ? AND query = ? 
            ORDER BY date DESC LIMIT 1
          `).get(siteUrl, kw.keyword) as any;

          if (gscData && gscData.position > 0) {
            positionToRecord = Math.round(gscData.position);
            matchedUrl = 'gsc_aggregated';
            foundInGsc = true;
          }
        }

        // Tier 2: Custom Free Google Scraper
        if (!foundInGsc) {
          try {
            await delay(1000 + Math.random() * 2000);

            const glLocation = (kw.location || 'US').toLowerCase();
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(kw.keyword)}&num=100&hl=en&gl=${glLocation}`;
            const response = await fetch(googleUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml',
                'Accept-Language': 'en-GB,en;q=0.9',
              }
            });

            if (response.ok) {
              const html = await response.text();
              const $ = cheerio.load(html);
              let currentPosition = 1;
              let foundUrl = false;
              
              $('.g').each((i: number, el: any) => {
                const link = $(el).find('a[href^="http"]').first();
                if (link.length > 0) {
                  const href = link.attr('href') || '';
                  if (!href.includes('google.com') && !href.includes('googleusercontent')) {
                    if (href.includes(currentTargetDomain)) {
                      positionToRecord = currentPosition;
                      matchedUrl = href;
                      foundUrl = true;
                      return false; // Break loop
                    }
                    currentPosition++;
                  }
                }
              });

              // --- ZERO RESULTS OR BLOCKED ---
              // If we didn't find a url, leave it as 101 to indicate "not ranking".
              let resultsCount = $('.g').length;
              if (!foundUrl && (html.includes('sorry/index') || html.includes('enablejs') || html.includes('CONSENT') || resultsCount === 0)) {
                 positionToRecord = 101;
                 matchedUrl = null;
              }

            } else {
              console.error(`Failed to fetch SERP for '${kw.keyword}': ${response.status}`);
              positionToRecord = 101;
              matchedUrl = null;
            }
          } catch (e) {
            console.error(`Scrape error for '${kw.keyword}':`, e);
          }
        }

        // Save position
        db.prepare(`
          INSERT OR REPLACE INTO keyword_rankings (keywordId, date, position, rankingUrl)
          VALUES (?, ?, ?, ?)
        `).run(kw.id, today, positionToRecord, matchedUrl);
        
        syncCount++;
      }

      res.json({ success: true, count: syncCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Background Daily Automated Sync logic
  setInterval(() => {
    try {
      const sites = db.prepare('SELECT DISTINCT siteUrl FROM tracked_keywords').all() as any[];
      for (const site of sites) {
         fetch(`http://localhost:3000/api/rank-tracking/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteUrl: site.siteUrl, force: false })
         }).catch(e => console.error("Daily cron sync error:", e));
      }
    } catch (e) {
      console.error("Daily cron error:", e);
    }
  }, 24 * 60 * 60 * 1000); // Run once every 24 hours

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
