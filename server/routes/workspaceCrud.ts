import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { isNonEmptyString } from '../validation.js';

export function registerWorkspaceCrudRoutes(app: Express, db: Database.Database) {
  app.get('/api/projects', requireAuth, (req: AuthedRequest, res) => {
    try {
      const rows = db.prepare('SELECT * FROM projects WHERE ownerId = ?').all(req.authUser!.uid);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects', requireAuth, (req: AuthedRequest, res) => {
    const { id, name, domain, createdAt } = req.body;
    if (!isNonEmptyString(id)) return res.status(400).json({ error: 'Invalid id' });
    if (!isNonEmptyString(name)) return res.status(400).json({ error: 'Invalid name' });
    if (!isNonEmptyString(domain)) return res.status(400).json({ error: 'Invalid domain' });
    if (createdAt !== undefined && createdAt !== null && !isNonEmptyString(createdAt)) return res.status(400).json({ error: 'Invalid createdAt' });
    try {
      db.prepare('INSERT INTO projects (id, name, domain, ownerId, createdAt) VALUES (?, ?, ?, ?, ?)').run(id, name, domain, req.authUser!.uid, createdAt);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:id', requireAuth, (req: AuthedRequest, res) => {
    try {
      const result = db.prepare('DELETE FROM projects WHERE id = ? AND ownerId = ?').run(req.params.id, req.authUser!.uid);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Project not found' });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/filters', requireAuth, (req: AuthedRequest, res) => {
    const projectId = req.query.projectId;
    if (projectId !== undefined && !isNonEmptyString(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
    try {
      const rows = projectId
        ? db.prepare('SELECT * FROM filters WHERE ownerId = ? AND projectId = ?').all(req.authUser!.uid, projectId)
        : db.prepare('SELECT * FROM filters WHERE ownerId = ?').all(req.authUser!.uid);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/filters', requireAuth, (req: AuthedRequest, res) => {
    const { id, name, projectId, configuration, createdAt } = req.body;
    if (!isNonEmptyString(id)) return res.status(400).json({ error: 'Invalid id' });
    if (!isNonEmptyString(name)) return res.status(400).json({ error: 'Invalid name' });
    if (!isNonEmptyString(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
    if (!isNonEmptyString(configuration)) return res.status(400).json({ error: 'Invalid configuration' });
    if (createdAt !== undefined && createdAt !== null && !isNonEmptyString(createdAt)) return res.status(400).json({ error: 'Invalid createdAt' });
    try {
      db.prepare('INSERT INTO filters (id, name, projectId, ownerId, configuration, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, projectId, req.authUser!.uid, configuration, createdAt);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/filters/:id', requireAuth, (req: AuthedRequest, res) => {
    try {
      const result = db.prepare('DELETE FROM filters WHERE id = ? AND ownerId = ?').run(req.params.id, req.authUser!.uid);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Filter not found' });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
