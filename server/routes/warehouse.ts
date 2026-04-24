import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import {
  hasValidMetricRows,
  isIsoDateString,
  isNonEmptyString,
  isValidWarehouseDimensions,
  validateDimensionFilterGroups,
} from '../validation.js';

export function registerWarehouseRoutes(app: Express, db: Database.Database) {
  const authRequired = requireAuth(db);

  app.post('/api/warehouse/ingest/site', authRequired, (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, rows } = req.body;
    if (!isNonEmptyString(siteUrl) || !hasValidMetricRows(rows, 1)) return res.status(400).json({ error: 'Invalid payload' });
    try {
      const stmt = db.prepare(`
        INSERT INTO gsc_site_metrics (ownerId, siteUrl, date, clicks, impressions, ctr, position)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ownerId, siteUrl, date) DO UPDATE SET
          clicks=excluded.clicks,
          impressions=excluded.impressions,
          ctr=excluded.ctr,
          position=excluded.position
      `);
      const insertMany = db.transaction((metrics: any[]) => {
        for (const row of metrics) {
          const date = row.keys[0];
          stmt.run(ownerId, siteUrl, date, row.clicks, row.impressions, row.ctr, row.position);
        }
      });
      insertMany(rows);
      res.json({ success: true, count: rows.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/ingest/query', authRequired, (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, rows } = req.body;
    if (!isNonEmptyString(siteUrl) || !hasValidMetricRows(rows, 2)) return res.status(400).json({ error: 'Invalid payload' });
    try {
      const stmt = db.prepare(`
        INSERT INTO gsc_query_metrics (ownerId, siteUrl, date, query, clicks, impressions, ctr, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ownerId, siteUrl, date, query) DO UPDATE SET
          clicks=excluded.clicks,
          impressions=excluded.impressions,
          ctr=excluded.ctr,
          position=excluded.position
      `);
      const insertMany = db.transaction((metrics: any[]) => {
        for (const row of metrics) {
          const date = row.keys[0];
          const query = row.keys[1] || '';
          stmt.run(ownerId, siteUrl, date, query, row.clicks, row.impressions, row.ctr, row.position);
        }
      });
      insertMany(rows);
      res.json({ success: true, count: rows.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/ingest/page_query', authRequired, (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, rows } = req.body;
    if (!isNonEmptyString(siteUrl) || !hasValidMetricRows(rows, 3)) return res.status(400).json({ error: 'Invalid payload' });
    try {
      const stmt = db.prepare(`
        INSERT INTO gsc_page_query_metrics (ownerId, siteUrl, date, page, query, clicks, impressions, ctr, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ownerId, siteUrl, date, page, query) DO UPDATE SET
          clicks=excluded.clicks,
          impressions=excluded.impressions,
          ctr=excluded.ctr,
          position=excluded.position
      `);
      const insertMany = db.transaction((metrics: any[]) => {
        for (const row of metrics) {
          const date = row.keys[0];
          const page = row.keys[1] || '';
          const query = row.keys[2] || '';
          stmt.run(ownerId, siteUrl, date, page, query, row.clicks, row.impressions, row.ctr, row.position);
        }
      });
      insertMany(rows);
      res.json({ success: true, count: rows.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/warehouse/status', authRequired, (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const siteUrl = req.query.siteUrl;
    if (siteUrl !== undefined && !isNonEmptyString(siteUrl)) return res.status(400).json({ error: 'Invalid siteUrl' });
    try {
      if (siteUrl) {
        const status = db.prepare('SELECT * FROM warehouse_sync_status WHERE ownerId = ? AND siteUrl = ?').get(ownerId, siteUrl);
        res.json(status || { siteUrl, status: 'uninitialized' });
      } else {
        const allSites = new Set<string>();

        const statuses = db.prepare('SELECT siteUrl FROM warehouse_sync_status WHERE ownerId = ?').all(ownerId) as any[];
        statuses.forEach((s) => allSites.add(s.siteUrl));

        const queries = db.prepare('SELECT DISTINCT siteUrl FROM gsc_site_metrics WHERE ownerId = ?').all(ownerId) as any[];
        queries.forEach((s) => allSites.add(s.siteUrl));

        const logs = db.prepare('SELECT DISTINCT siteUrl FROM server_logs WHERE ownerId = ?').all(ownerId) as any[];
        logs.forEach((s) => allSites.add(s.siteUrl));

        const caches = db.prepare('SELECT DISTINCT siteUrl FROM url_inspection_cache WHERE ownerId = ?').all(ownerId) as any[];
        caches.forEach((s) => allSites.add(s.siteUrl));

        const keywords = db.prepare('SELECT DISTINCT siteUrl FROM tracked_keywords WHERE ownerId = ?').all(ownerId) as any[];
        keywords.forEach((s) => allSites.add(s.siteUrl));

        const result = Array.from(allSites).map((url) => ({ siteUrl: url }));
        res.json(result);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/status', authRequired, (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, lastSyncDate, earliestSyncDate, status } = req.body;
    if (!isNonEmptyString(siteUrl)) return res.status(400).json({ error: 'Invalid siteUrl' });
    if (lastSyncDate !== undefined && lastSyncDate !== null && !isIsoDateString(lastSyncDate)) return res.status(400).json({ error: 'Invalid lastSyncDate' });
    if (earliestSyncDate !== undefined && earliestSyncDate !== null && !isIsoDateString(earliestSyncDate)) return res.status(400).json({ error: 'Invalid earliestSyncDate' });
    if (status !== undefined && status !== null && !isNonEmptyString(status)) return res.status(400).json({ error: 'Invalid status' });
    try {
      db.prepare(`
        INSERT INTO warehouse_sync_status (ownerId, siteUrl, lastSyncDate, earliestSyncDate, status, lastUpdated)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(ownerId, siteUrl) DO UPDATE SET
          lastSyncDate=IFNULL(excluded.lastSyncDate, lastSyncDate),
          earliestSyncDate=IFNULL(excluded.earliestSyncDate, earliestSyncDate),
          status=IFNULL(excluded.status, status),
          lastUpdated=excluded.lastUpdated
      `).run(ownerId, siteUrl, lastSyncDate, earliestSyncDate, status, new Date().toISOString());
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/warehouse/query', authRequired, (req: AuthedRequest, res) => {
    const ownerId = req.authUser!.uid;
    const { siteUrl, startDate, endDate, dimensions, dimensionFilterGroups } = req.body;
    if (!isNonEmptyString(siteUrl) || !isIsoDateString(startDate) || !isIsoDateString(endDate)) {
      return res.status(400).json({ error: 'Missing or invalid parameters' });
    }
    if (dimensions !== undefined && !isValidWarehouseDimensions(dimensions)) {
      return res.status(400).json({ error: 'Invalid dimensions' });
    }
    if (!validateDimensionFilterGroups(dimensionFilterGroups)) {
      return res.status(400).json({ error: 'Invalid dimensionFilterGroups' });
    }

    try {
      const dims = (dimensions as string[]) || [];
      const hasDate = dims.includes('date');
      const hasQuery = dims.includes('query');
      const hasPage = dims.includes('page');

      const selectClauseElements: string[] = [];
      const groupByClauseElements: string[] = [];
      let orderClause = 'ORDER BY impressions DESC';

      if (hasDate) {
        selectClauseElements.push('date');
        groupByClauseElements.push('date');
        orderClause = 'ORDER BY date ASC';
      }
      if (hasPage) {
        selectClauseElements.push('page');
        groupByClauseElements.push('page');
        if (!hasDate) orderClause = 'ORDER BY clicks DESC, impressions DESC';
      }
      if (hasQuery) {
        selectClauseElements.push('query');
        groupByClauseElements.push('query');
        if (!hasDate) orderClause = 'ORDER BY clicks DESC, impressions DESC';
      }

      const selectCols = selectClauseElements.length > 0 ? `${selectClauseElements.join(', ')}, ` : '';
      const groupByClause = groupByClauseElements.length > 0 ? `GROUP BY ${groupByClauseElements.join(', ')}` : '';

      let whereClause = 'WHERE ownerId = @ownerId AND siteUrl = @siteUrl AND date >= @startDate AND date <= @endDate';
      const params: Record<string, unknown> = { ownerId, siteUrl, startDate, endDate };

      if (dimensionFilterGroups && dimensionFilterGroups.length > 0) {
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

      let rows: any[] = [];
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

      rows = rows.map((r: any) => {
        const keys = [];
        if (hasDate) keys.push(r.date);
        if (hasQuery) keys.push(r.query);
        return {
          keys: keys.length > 0 ? keys : undefined,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
        };
      });

      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
