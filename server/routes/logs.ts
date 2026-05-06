import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import type multer from 'multer';
import fs from 'fs';
import readline from 'readline';
import zlib from 'zlib';
import { requireAuth } from '../auth.js';
import { getBotType, NGINX_LOG_REGEX, parseLogDate } from '../logs.js';
import type { AuthedRequest } from '../types.js';
import { asTrimmedString, isIsoDateString, isNonEmptyString, isStringArray } from '../validation.js';
import { canAccessSite } from '../accessControl.js';

export function registerLogRoutes(app: Express, db: AppDatabase, upload: multer.Multer) {
  const authRequired = requireAuth(db);

  app.post('/api/logs/upload', authRequired, upload.single('logfile'), async (req: AuthedRequest, res) => {
    const file = req.file;
    try {
      const ownerId = req.authUser!.uid;
      const siteUrl = asTrimmedString(req.body.siteUrl);

      if (!siteUrl || !file) {
        return res.status(400).json({ error: 'Missing siteUrl or file' });
      }
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
      let processedBytes = 0;
      let readStream: NodeJS.ReadableStream = fs.createReadStream(file.path);

      if (file.originalname.toLowerCase().endsWith('.gz') || file.mimetype === 'application/gzip') {
        readStream = readStream.pipe(zlib.createGunzip());
      }

      const limitedStream = readStream as NodeJS.ReadableStream & { destroy: (error?: Error) => void };
      limitedStream.on('data', (chunk: Buffer) => {
        processedBytes += chunk.length;
        if (processedBytes > MAX_UNCOMPRESSED_BYTES) {
          limitedStream.destroy(new Error('Uploaded log file is too large after decompression'));
        }
      });

      const rl = readline.createInterface({
        input: readStream,
        crlfDelay: Infinity,
      });

      let count = 0;

      const insertMany = db.transaction(async (lines: string[]) => {
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

            await db.run(`
              INSERT INTO server_logs (ownerId, siteUrl, timestamp, ipAddress, httpMethod, urlPath, statusCode, userAgent, botType)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [ownerId, siteUrl, timestamp, ipAddress, httpMethod, urlPath, parseInt(statusCode, 10), userAgent || '', botType]);
            count++;
          }
        }
      });

      let currentBatch: string[] = [];
      for await (const line of rl) {
        currentBatch.push(line);
        if (currentBatch.length >= 1000) {
          await insertMany(currentBatch);
          currentBatch = [];
        }
      }

      if (currentBatch.length > 0) {
        await insertMany(currentBatch);
      }

      res.json({ success: true, count });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    } finally {
      if (file?.path) {
        await fs.promises.unlink(file.path).catch(() => {});
      }
    }
  });

  app.post('/api/logs/webhook', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, logs } = req.body;
    if (!isNonEmptyString(siteUrl) || !isStringArray(logs)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      let count = 0;
      const insertManyWebhook = db.transaction(async (lines: string[]) => {
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

            await db.run(`
              INSERT INTO server_logs (ownerId, siteUrl, timestamp, ipAddress, httpMethod, urlPath, statusCode, userAgent, botType)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [ownerId, siteUrl, timestamp, ipAddress, httpMethod, urlPath, parseInt(statusCode, 10), userAgent || '', botType]);
            count++;
          }
        }
      });

      await insertManyWebhook(logs);
      res.json({ success: true, count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/logs/stats', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    if (startDate !== undefined && !isIsoDateString(startDate)) return res.status(400).json({ error: 'Invalid startDate' });
    if (endDate !== undefined && !isIsoDateString(endDate)) return res.status(400).json({ error: 'Invalid endDate' });

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const stats = await db.all(`
        SELECT 
          substr(timestamp, 1, 10) as date,
          botType,
          COUNT(*) as hits
        FROM server_logs
        WHERE ownerId = ? AND siteUrl = ? AND timestamp >= ? AND timestamp <= ?
        GROUP BY substr(timestamp, 1, 10), botType
        ORDER BY date ASC
      `, [ownerId, siteUrl, startDate ? String(startDate) + 'T00:00:00' : '2000-01-01', endDate ? String(endDate) + 'T23:59:59' : '2099-12-31']);
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/logs/errors', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    if (startDate !== undefined && !isIsoDateString(startDate)) return res.status(400).json({ error: 'Invalid startDate' });
    if (endDate !== undefined && !isIsoDateString(endDate)) return res.status(400).json({ error: 'Invalid endDate' });

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const errors = await db.all(`
        SELECT urlPath, statusCode, botType, COUNT(*) as count
        FROM server_logs
        WHERE ownerId = ? AND siteUrl = ? AND timestamp >= ? AND timestamp <= ? AND statusCode >= 400
        GROUP BY urlPath, statusCode, botType
        ORDER BY count DESC
        LIMIT 100
      `, [ownerId, siteUrl, startDate ? String(startDate) + 'T00:00:00' : '2000-01-01', endDate ? String(endDate) + 'T23:59:59' : '2099-12-31']);
      res.json(errors);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/logs/insights', authRequired, async (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = asTrimmedString(req.query.siteUrl);
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
    if (startDate !== undefined && !isIsoDateString(startDate)) return res.status(400).json({ error: 'Invalid startDate' });
    if (endDate !== undefined && !isIsoDateString(endDate)) return res.status(400).json({ error: 'Invalid endDate' });

    const start = startDate ? String(startDate) + 'T00:00:00' : '2000-01-01';
    const end = endDate ? String(endDate) + 'T23:59:59' : '2099-12-31';

    try {
      if (!(await canAccessSite(db, ownerId, siteUrl))) {
        return res.status(403).json({ error: 'This site is not activated for your workspace.' });
      }

      const mostCrawled = await db.all(`
        SELECT urlPath, count(*) as count, botType
        FROM server_logs
        WHERE ownerId = ? AND siteUrl = ? AND timestamp >= ? AND timestamp <= ? 
          AND botType IN ('Googlebot', 'Bingbot')
        GROUP BY urlPath, botType
        ORDER BY count DESC
        LIMIT 50
      `, [ownerId, siteUrl, start, end]);

      const llmTraffic = await db.all(`
        SELECT botType, urlPath, count(*) as count
        FROM server_logs
        WHERE ownerId = ? AND siteUrl = ? AND timestamp >= ? AND timestamp <= ? 
          AND botType IN ('ChatGPT / OpenAI', 'Claude / Anthropic', 'Perplexity', 'Cohere', 'Generic LLM / Scraper')
        GROUP BY botType, urlPath
        ORDER BY count DESC
        LIMIT 50
      `, [ownerId, siteUrl, start, end]);

      const efficiency = await db.all(`
        SELECT statusCode, count(*) as count
        FROM server_logs
        WHERE ownerId = ? AND siteUrl = ? AND timestamp >= ? AND timestamp <= ? 
          AND botType = 'Googlebot'
        GROUP BY statusCode
      `, [ownerId, siteUrl, start, end]);

      res.json({ mostCrawled, llmTraffic, efficiency });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
