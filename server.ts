import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import path from 'path';
import * as cheerio from 'cheerio';
import multer from 'multer';
import fs from 'fs';
import readline from 'readline';
import zlib from 'zlib';

const upload = multer({ dest: 'uploads/' });

// In-memory background job tracking
export const syncJobs = new Map<string, { current: number, total: number, status: 'running' | 'completed' | 'error', message?: string }>();

function getBotType(userAgent: string): string {
  if (!userAgent) return 'Unknown';
  const ua = userAgent.toLowerCase();
  
  if (ua.includes('googlebot')) return 'Googlebot';
  if (ua.includes('bingbot')) return 'Bingbot';
  if (ua.includes('applebot')) return 'Applebot';
  if (ua.includes('ahrefsbot')) return 'AhrefsBot';
  if (ua.includes('semrushbot')) return 'SemrushBot';
  if (ua.includes('yandexbot')) return 'YandexBot';
  if (ua.includes('baiduspider')) return 'Baiduspider';
  if (ua.includes('facebookexternalhit')) return 'FacebookBot';
  if (ua.includes('linkedinbot')) return 'LinkedInBot';
  if (ua.includes('twitterbot')) return 'TwitterBot';
  
  // LLM Bots
  if (ua.includes('chatgpt-user') || ua.includes('gptbot') || ua.includes('openai')) return 'ChatGPT / OpenAI';
  if (ua.includes('anthropic-ai') || ua.includes('claudebot')) return 'Claude / Anthropic';
  if (ua.includes('perplexitybot')) return 'Perplexity';
  if (ua.includes('cohere-ai')) return 'Cohere';
  if (ua.includes('omgili') || ua.includes('ccbot')) return 'Generic LLM / Scraper';

  if (ua.includes('bot') || ua.includes('crawler') || ua.includes('spider')) return 'Generic Bot';
  
  return 'Human';
}

// Basic regex for Nginx combined log format
const NGINX_LOG_REGEX = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([^"]*)"\s+(\d{3})\s+(\d+|-)(?:\s+"([^"]*)")?(?:\s+"([^"]*)")?/;

function parseLogDate(dateStr: string): string {
  // Try to parse "14/Aug/2023:10:00:00 +0000" to ISO "2023-08-14T10:00:00.000Z"
  try {
    const parts = dateStr.split(/[/\s:]/);
    if (parts.length >= 6) {
      const [day, monthStr, year, hour, minute, second] = parts;
      const monthMap: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
      const month = monthMap[monthStr] || '01';
      return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
    }
  } catch (e) {
    // fallback
  }
  return new Date().toISOString(); 
}

const db = new Database('sqlite.db');

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

  CREATE TABLE IF NOT EXISTS server_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    siteUrl TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    ipAddress TEXT,
    httpMethod TEXT,
    urlPath TEXT NOT NULL,
    statusCode INTEGER,
    userAgent TEXT,
    botType TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_server_logs_site_time ON server_logs(siteUrl, timestamp);
  CREATE INDEX IF NOT EXISTS idx_server_logs_botType ON server_logs(siteUrl, botType);

  CREATE TABLE IF NOT EXISTS url_inspection_cache (
    siteUrl TEXT NOT NULL,
    url TEXT NOT NULL,
    inspectionResult TEXT,
    coverageState TEXT,
    lastInspectionTime TEXT NOT NULL,
    PRIMARY KEY (siteUrl, url)
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

  // Server Logs APIs
  app.post('/api/logs/upload', upload.single('logfile'), async (req, res) => {
    try {
      const siteUrl = req.body.siteUrl;
      const file = req.file;
      
      if (!siteUrl || !file) {
        return res.status(400).json({ error: 'Missing siteUrl or file' });
      }

      let readStream: NodeJS.ReadableStream = fs.createReadStream(file.path);
      
      // Support extracting .gz archives on the fly
      if (file.originalname.toLowerCase().endsWith('.gz') || file.mimetype === 'application/gzip') {
        readStream = readStream.pipe(zlib.createGunzip());
      }

      const rl = readline.createInterface({
        input: readStream,
        crlfDelay: Infinity
      });

      const stmt = db.prepare(`
        INSERT INTO server_logs (siteUrl, timestamp, ipAddress, httpMethod, urlPath, statusCode, userAgent, botType)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let count = 0;
      
      const insertMany = db.transaction((lines: string[]) => {
        for (const line of lines) {
          const match = line.match(NGINX_LOG_REGEX);
          if (match) {
            const ipAddress = match[1];
            const dateStr = match[2];
            const request = match[3] || '';
            const statusCode = match[4];
            const userAgent = match[7];
            
            const httpMethod = request.split(' ')[0] || '-';
            const urlPath = request.split(' ')[1] || '-';

            const timestamp = parseLogDate(dateStr);
            const botType = getBotType(userAgent);
            stmt.run(siteUrl, timestamp, ipAddress, httpMethod, urlPath, parseInt(statusCode, 10), userAgent || '', botType);
            count++;
          }
        }
      });

      let currentBatch: string[] = [];
      for await (const line of rl) {
        currentBatch.push(line);
        if (currentBatch.length >= 1000) {
          insertMany(currentBatch);
          currentBatch = [];
        }
      }
      if (currentBatch.length > 0) {
        insertMany(currentBatch);
      }

      // Cleanup temp file
      fs.unlinkSync(file.path);

      res.json({ success: true, count });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/logs/webhook', (req, res) => {
    const { siteUrl, logs } = req.body;
    if (!siteUrl || !logs || !Array.isArray(logs)) return res.status(400).json({ error: 'Invalid payload' });
    
    try {
      const stmt = db.prepare(`
        INSERT INTO server_logs (siteUrl, timestamp, ipAddress, httpMethod, urlPath, statusCode, userAgent, botType)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      let count = 0;
      const insertManyWebhook = db.transaction((lines: string[]) => {
        for (const line of lines) {
          const match = line.match(NGINX_LOG_REGEX);
          if (match) {
            const ipAddress = match[1];
            const dateStr = match[2];
            const request = match[3] || '';
            const statusCode = match[4];
            const userAgent = match[7];
            
            const httpMethod = request.split(' ')[0] || '-';
            const urlPath = request.split(' ')[1] || '-';

            const timestamp = parseLogDate(dateStr);
            const botType = getBotType(userAgent);
            stmt.run(siteUrl, timestamp, ipAddress, httpMethod, urlPath, parseInt(statusCode, 10), userAgent || '', botType);
            count++;
          }
        }
      });
      
      insertManyWebhook(logs);
      
      res.json({ success: true, count });
    } catch(err: any) {
        res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/logs/stats', (req, res) => {
    const { siteUrl, startDate, endDate } = req.query;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    
    try {
      const stats = db.prepare(`
        SELECT 
          substr(timestamp, 1, 10) as date,
          botType,
          COUNT(*) as hits
        FROM server_logs
        WHERE siteUrl = ? AND timestamp >= ? AND timestamp <= ?
        GROUP BY substr(timestamp, 1, 10), botType
        ORDER BY date ASC
      `).all(siteUrl, startDate ? String(startDate) + 'T00:00:00' : '2000-01-01', endDate ? String(endDate) + 'T23:59:59' : '2099-12-31');
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/logs/errors', (req, res) => {
    const { siteUrl, startDate, endDate } = req.query;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    
    try {
      const errors = db.prepare(`
        SELECT urlPath, statusCode, botType, COUNT(*) as count
        FROM server_logs
        WHERE siteUrl = ? AND timestamp >= ? AND timestamp <= ? AND statusCode >= 400
        GROUP BY urlPath, statusCode, botType
        ORDER BY count DESC
        LIMIT 100
      `).all(siteUrl, startDate ? String(startDate) + 'T00:00:00' : '2000-01-01', endDate ? String(endDate) + 'T23:59:59' : '2099-12-31');
      res.json(errors);
    } catch(err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/logs/insights', (req, res) => {
    const { siteUrl, startDate, endDate } = req.query;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    
    const start = startDate ? String(startDate) + 'T00:00:00' : '2000-01-01';
    const end = endDate ? String(endDate) + 'T23:59:59' : '2099-12-31';

    try {
      // 1. Most crawled pages by Googlebot / Bingbot (excluding assets if possible, or just raw)
      const mostCrawled = db.prepare(`
        SELECT urlPath, count(*) as count, botType
        FROM server_logs
        WHERE siteUrl = ? AND timestamp >= ? AND timestamp <= ? 
          AND botType IN ('Googlebot', 'Bingbot')
        GROUP BY urlPath, botType
        ORDER BY count DESC
        LIMIT 50
      `).all(siteUrl, start, end);

      // 2. LLM / AI Bot Traffic
      const llmTraffic = db.prepare(`
        SELECT botType, urlPath, count(*) as count
        FROM server_logs
        WHERE siteUrl = ? AND timestamp >= ? AND timestamp <= ? 
          AND botType IN ('ChatGPT / OpenAI', 'Claude / Anthropic', 'Perplexity', 'Cohere', 'Generic LLM / Scraper')
        GROUP BY botType, urlPath
        ORDER BY count DESC
        LIMIT 50
      `).all(siteUrl, start, end);

      // 3. Efficiency (Status codes for Googlebot)
      const efficiency = db.prepare(`
        SELECT statusCode, count(*) as count
        FROM server_logs
        WHERE siteUrl = ? AND timestamp >= ? AND timestamp <= ? 
          AND botType = 'Googlebot'
        GROUP BY statusCode
      `).all(siteUrl, start, end);

      res.json({ mostCrawled, llmTraffic, efficiency });
    } catch(err: any) {
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
    const { siteUrl, keywords, location, device, tags, targetDomain, initialPositions } = req.body;
    if (!siteUrl || !keywords || !Array.isArray(keywords)) return res.status(400).json({ error: 'Invalid payload' });
    
    try {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO tracked_keywords (id, siteUrl, keyword, location, device, tags, targetDomain, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      const rankStmt = db.prepare(`
        INSERT OR REPLACE INTO keyword_rankings (keywordId, date, position, rankingUrl)
        VALUES (?, ?, ?, ?)
      `);
      
      const today = new Date().toISOString().split('T')[0];
      
      const insertMany = db.transaction((kws) => {
        for (const kw of kws) {
          const id = Math.random().toString(36).substring(2, 15);
          const kStr = kw.trim();
          stmt.run(id, siteUrl, kStr, location || 'US', device || 'desktop', tags || '', targetDomain || '', new Date().toISOString());
          
          if (initialPositions !== undefined && initialPositions[kStr] !== undefined) {
             console.log("Setting initial position for", kStr, initialPositions[kStr]);
             rankStmt.run(id, today, Math.round(initialPositions[kStr]), null);
          } else {
             console.log("No initial position for", kStr, initialPositions);
          }
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

  // --- NEW: Indexing Endpoints ---
  app.get('/api/indexing/grid', async (req, res) => {
    const { siteUrl, startDate, endDate, isLive } = req.query;
    const authHeader = req.headers.authorization;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    try {
      let gscPages: any[] = [];
      const start = startDate ? String(startDate) : '2000-01-01';
      const end = endDate ? String(endDate) : '2099-12-31';

      if (isLive === 'true' && authHeader) {
        const token = authHeader.split(' ')[1];
        try {
          const gscRes = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl as string)}/searchAnalytics/query`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              startDate: start,
              endDate: end,
              dimensions: ['page'],
              rowLimit: 5000
            })
          });
          const json = await gscRes.json();
          if (json.rows) {
             gscPages = json.rows.map((r: any) => ({
                 url: r.keys[0],
                 clicks: r.clicks,
                 impressions: r.impressions
             }));
          }
        } catch (e) {
          console.error("GSC Live Fetch Error in Indexing:", e);
        }
      } else {
         gscPages = db.prepare('SELECT page as url, SUM(clicks) as clicks, SUM(impressions) as impressions FROM gsc_page_query_metrics WHERE siteUrl = ? AND date >= ? AND date <= ? GROUP BY page').all(siteUrl, start, end) as any[];
      }

      const logs = db.prepare(`
        SELECT urlPath, MAX(timestamp) as lastCrawl 
        FROM server_logs 
        WHERE siteUrl = ? 
          AND botType = 'Googlebot'
          AND urlPath NOT LIKE '%/.%'
          AND urlPath NOT LIKE '%.php'
          AND urlPath NOT LIKE '%.env%'
          AND urlPath NOT LIKE '%.bak'
        GROUP BY urlPath
      `).all(siteUrl) as any[];
      const inspections = db.prepare('SELECT url, inspectionResult, coverageState, lastInspectionTime FROM url_inspection_cache WHERE siteUrl = ?').all(siteUrl) as any[];

      const urlMap = new Map<string, any>();
      
      // Clean siteUrl for absolute URL reconstruction if needed
      const baseHost = (siteUrl as string).replace(/\/$/, '');
      const isHttp = baseHost.startsWith('http');

      for (const p of gscPages) {
        if (p.url.includes('#')) continue;
        if (p.url.match(/\.(jpg|jpeg|png|gif|svg|webp|pdf|css|js|txt)$/i)) continue;
        
        let cleanedUrl = p.url;
        try {
           const parsed = new URL(p.url);
           // Strip parameters to prevent treating www.domain.com/ and www.domain.com/?ref=x as two different indexed pages
           cleanedUrl = parsed.origin + parsed.pathname;
        } catch(e) {}
        
        // Ensure trailing slash standardization so /blog and /blog/ don't duplicate
        if (!cleanedUrl.endsWith('/')) {
           cleanedUrl += '/';
        }
        
        // If we already have the cleaned URL, sum the clicks/impressions rather than making a new entry
        if (urlMap.has(cleanedUrl)) {
            const existing = urlMap.get(cleanedUrl);
            existing.clicks += p.clicks;
            existing.impressions += p.impressions;
            urlMap.set(cleanedUrl, existing);
        } else {
            urlMap.set(cleanedUrl, { url: cleanedUrl, clicks: p.clicks, impressions: p.impressions, lastCrawl: null, inspectionResult: null, coverageState: null, lastInspectionTime: null });
        }
      }

      for (const l of logs) {
        // Reconstruct full URL if possible so it matches GSC
        let fullUrl = l.urlPath;
        if (fullUrl.includes('#') || fullUrl.match(/\.(jpg|jpeg|png|gif|svg|webp|pdf|css|js|txt)$/i)) continue;

        if (isHttp && fullUrl.startsWith('/')) {
           fullUrl = `${baseHost}${fullUrl}`;
        } else if (!isHttp && !fullUrl.startsWith('http')) {
           fullUrl = `https://${baseHost.replace('sc-domain:', '')}${fullUrl.startsWith('/') ? '' : '/'}${fullUrl}`;
        }
        
        try {
            const parsedLogUrl = new URL(fullUrl);
            fullUrl = parsedLogUrl.origin + parsedLogUrl.pathname;
        } catch(e) {}
        
        if (!fullUrl.endsWith('/')) {
           fullUrl += '/';
        }
        
        let cleanDate = l.lastCrawl;
        if (typeof cleanDate === 'string' && cleanDate.includes('/')) {
           cleanDate = cleanDate.replace(':', ' ').replace(/\//g, ' ');
           cleanDate = new Date(cleanDate).toISOString();
        }
        
        if (urlMap.has(fullUrl)) {
           urlMap.get(fullUrl)!.lastCrawl = cleanDate;
        } else {
           urlMap.set(fullUrl, { url: fullUrl, clicks: 0, impressions: 0, lastCrawl: cleanDate, inspectionResult: null, coverageState: null, lastInspectionTime: null });
        }
      }

      for (const i of inspections) {
        let cleanUrl = i.url;
        try {
            const parsedInsp = new URL(i.url);
            cleanUrl = parsedInsp.origin + parsedInsp.pathname;
        } catch(e) {}
        
        if (!cleanUrl.endsWith('/')) {
           cleanUrl += '/';
        }
        
        if (urlMap.has(cleanUrl)) {
           const existing = urlMap.get(cleanUrl)!;
           existing.inspectionResult = i.inspectionResult ? JSON.parse(i.inspectionResult) : null;
           existing.coverageState = i.coverageState;
           existing.lastInspectionTime = i.lastInspectionTime;
        } else {
           urlMap.set(cleanUrl, { url: cleanUrl, clicks: 0, impressions: 0, lastCrawl: null, inspectionResult: i.inspectionResult ? JSON.parse(i.inspectionResult) : null, coverageState: i.coverageState, lastInspectionTime: i.lastInspectionTime });
        }
      }

      res.json(Array.from(urlMap.values()));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/indexing/seed-urls', (req, res) => {
    const { siteUrl, urls } = req.body;
    if (!siteUrl || !urls || !Array.isArray(urls)) return res.status(400).json({ error: 'Invalid payload' });

    try {
      let added = 0;
      const insert = db.prepare('INSERT OR IGNORE INTO url_inspection_cache (siteUrl, url) VALUES (?, ?)');
      
      db.transaction(() => {
        for (let u of urls) {
           if (typeof u !== 'string' || !u.startsWith('http')) continue;
           
           try {
              const parsed = new URL(u);
              u = parsed.origin + parsed.pathname;
           } catch(e) {}
           
           if (!u.endsWith('/')) u += '/';
           
           const result = insert.run(siteUrl, u);
           if (result.changes > 0) added++;
        }
      })();
      
      res.json({ success: true, added });
    } catch(err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/indexing/inspect', async (req, res) => {
    const { siteUrl, inspectionUrl, accessToken } = req.body;
    if (!siteUrl || !inspectionUrl || !accessToken) return res.status(400).json({ error: 'Missing required fields' });
    
    try {
      const response = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
         method: 'POST',
         headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
         },
         body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: 'en-US' })
      });
      
      const data = await response.json();
      if (!response.ok) {
         return res.status(response.status).json(data);
      }
      
      // Save to cache
      const coverageState = data?.inspectionResult?.indexStatusResult?.coverageState || 'Unknown';
      const resultStr = JSON.stringify(data.inspectionResult || {});
      const now = new Date().toISOString();
      
      db.prepare(`
        INSERT OR REPLACE INTO url_inspection_cache (siteUrl, url, inspectionResult, coverageState, lastInspectionTime)
        VALUES (?, ?, ?, ?, ?)
      `).run(siteUrl, inspectionUrl, resultStr, coverageState, now);
      
      res.json({ success: true, coverageState, inspectionResult: data.inspectionResult, lastInspectionTime: now });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/indexing/auto-sync/start', async (req, res) => {
    const { siteUrl, accessToken, uninspectedUrls } = req.body;
    if (!siteUrl || !accessToken || !uninspectedUrls || !Array.isArray(uninspectedUrls)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existingJob = syncJobs.get(siteUrl);
    if (existingJob && existingJob.status === 'running') {
      return res.json({ success: true, message: 'Job already running', alreadyRunning: true });
    }

    // Start background job
    syncJobs.set(siteUrl, { current: 0, total: uninspectedUrls.length, status: 'running' });
    
    res.json({ success: true, message: 'Sync started in background', alreadyRunning: false });

    // Execute background async task safely
    (async () => {
      let current = 0;
      for (const url of uninspectedUrls) {
        try {
          const response = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
             method: 'POST',
             headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
             },
             body: JSON.stringify({ inspectionUrl: url, siteUrl, languageCode: 'en-US' })
          });
          
          if (!response.ok) {
             const errorData = await response.json();
             // If Quota Exceeded (429), we stop gracefully
             if (response.status === 429) {
                console.warn(`GSC Quota exceeded during auth-sync for ${siteUrl}`);
                syncJobs.set(siteUrl, { current, total: uninspectedUrls.length, status: 'error', message: "Google's 2,000 URL daily limit reached. Remaining URLs paused until tomorrow." });
                return;
             }
             if (response.status === 401 || response.status === 403) {
                console.warn(`GSC Session Expired or unauthorized during auth-sync for ${siteUrl}`);
                syncJobs.set(siteUrl, { current, total: uninspectedUrls.length, status: 'error', message: 'Session expired or unauthorized' });
                return;
             }
             console.error(`Inspection failed for ${url}:`, errorData);
          } else {
             const data = await response.json();
             const coverageState = data?.inspectionResult?.indexStatusResult?.coverageState || 'Unknown';
             const resultStr = JSON.stringify(data.inspectionResult || {});
             const now = new Date().toISOString();
             
             db.prepare(`
               INSERT OR REPLACE INTO url_inspection_cache (siteUrl, url, inspectionResult, coverageState, lastInspectionTime)
               VALUES (?, ?, ?, ?, ?)
             `).run(siteUrl, url, resultStr, coverageState, now);
          }
        } catch (e: any) {
          console.error(`Auto-sync error for ${url}:`, e.message);
        }

        current++;
        syncJobs.set(siteUrl, { current, total: uninspectedUrls.length, status: 'running' });
        
        // Wait 150ms gracefully so we can process up to 2000 URLs within the 1-hour OAuth token lifetime
        // (Quota is 600 per minute per property -> 10QPS -> 100ms interval is safe)
        await new Promise(r => setTimeout(r, 150));
      }

      // Finish job
      syncJobs.set(siteUrl, { current, total: uninspectedUrls.length, status: 'completed' });
    })();
  });

  app.get('/api/indexing/auto-sync/status', (req, res) => {
    const { siteUrl } = req.query;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    
    const job = syncJobs.get(siteUrl as string);
    if (!job) {
      return res.json({ status: 'none' });
    }
    
    res.json(job);
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
