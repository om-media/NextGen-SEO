import type { AppDatabase } from '../database.js';

export async function getInitialRegistrationTier(_db: AppDatabase) {
  return 'enterprise';
}
