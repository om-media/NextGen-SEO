import type { AppDatabase } from '../database.js';

export async function getInitialRegistrationTier(db: AppDatabase) {
  const row = await db.get<{ userCount?: number | string | null }>('SELECT COUNT(*) AS userCount FROM users');
  return Number(row?.userCount || 0) === 0 ? 'enterprise' : 'free';
}
