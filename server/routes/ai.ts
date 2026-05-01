import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import { generateGscInsights } from '../services/ai.js';
import { isNonEmptyString } from '../validation.js';

type InsightRow = Record<string, unknown>;

function isInsightRow(value: unknown): value is InsightRow {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function registerAiRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);

  app.post('/api/ai/gsc-insights', authRequired, async (req, res) => {
    const { data, dimension, searchTerm, intentFilter } = req.body ?? {};

    if (!Array.isArray(data) || data.some((row) => !isInsightRow(row))) {
      return res.status(400).json({ error: 'Invalid data payload' });
    }
    if (!isNonEmptyString(dimension) || !isNonEmptyString(intentFilter)) {
      return res.status(400).json({ error: 'Invalid insight context' });
    }
    if (searchTerm !== undefined && searchTerm !== null && typeof searchTerm !== 'string') {
      return res.status(400).json({ error: 'Invalid searchTerm' });
    }

    try {
      const insights = await generateGscInsights(
        data,
        dimension,
        searchTerm || '',
        intentFilter,
      );
      res.json({ insights });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate AI insights' });
    }
  });
}
