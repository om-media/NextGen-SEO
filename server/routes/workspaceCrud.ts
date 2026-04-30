import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import type { AuthedRequest } from '../types.js';
import { isNonEmptyString } from '../validation.js';

export function registerWorkspaceCrudRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

  app.get('/api/projects', authRequired, async (req: AuthedRequest, res) => {
    try {
      const rows = await db.all('SELECT * FROM projects WHERE ownerId = ?', [req.authUser!.uid]);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects', authRequired, async (req: AuthedRequest, res) => {
    const { id, name, domain, createdAt } = req.body;
    if (!isNonEmptyString(id)) return res.status(400).json({ error: 'Invalid id' });
    if (!isNonEmptyString(name)) return res.status(400).json({ error: 'Invalid name' });
    if (!isNonEmptyString(domain)) return res.status(400).json({ error: 'Invalid domain' });
    if (createdAt !== undefined && createdAt !== null && !isNonEmptyString(createdAt)) return res.status(400).json({ error: 'Invalid createdAt' });
    try {
      await db.run('INSERT INTO projects (id, name, domain, ownerId, createdAt) VALUES (?, ?, ?, ?, ?)', [id, name, domain, req.authUser!.uid, createdAt]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:id', authRequired, async (req: AuthedRequest, res) => {
    try {
      const result = await db.run('DELETE FROM projects WHERE id = ? AND ownerId = ?', [req.params.id, req.authUser!.uid]);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Project not found' });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/filters', authRequired, async (req: AuthedRequest, res) => {
    const projectId = req.query.projectId;
    if (projectId !== undefined && !isNonEmptyString(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
    try {
      const rows = projectId
        ? await db.all('SELECT * FROM filters WHERE ownerId = ? AND projectId = ?', [req.authUser!.uid, projectId])
        : await db.all('SELECT * FROM filters WHERE ownerId = ?', [req.authUser!.uid]);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/filters', authRequired, async (req: AuthedRequest, res) => {
    const { id, name, projectId, configuration, createdAt } = req.body;
    if (!isNonEmptyString(id)) return res.status(400).json({ error: 'Invalid id' });
    if (!isNonEmptyString(name)) return res.status(400).json({ error: 'Invalid name' });
    if (!isNonEmptyString(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
    if (!isNonEmptyString(configuration)) return res.status(400).json({ error: 'Invalid configuration' });
    if (createdAt !== undefined && createdAt !== null && !isNonEmptyString(createdAt)) return res.status(400).json({ error: 'Invalid createdAt' });
    try {
      await db.run('INSERT INTO filters (id, name, projectId, ownerId, configuration, createdAt) VALUES (?, ?, ?, ?, ?, ?)', [id, name, projectId, req.authUser!.uid, configuration, createdAt]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/filters/:id', authRequired, async (req: AuthedRequest, res) => {
    try {
      const result = await db.run('DELETE FROM filters WHERE id = ? AND ownerId = ?', [req.params.id, req.authUser!.uid]);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Filter not found' });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
