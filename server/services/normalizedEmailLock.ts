import type { AppDatabase } from '../database.js';

const sqliteLocks = new Map<string, Promise<void>>();

async function withSqliteEmailLock<T>(normalizedEmail: string, callback: () => Promise<T>) {
  const previous = sqliteLocks.get(normalizedEmail) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  sqliteLocks.set(normalizedEmail, queued);

  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (sqliteLocks.get(normalizedEmail) === queued) {
      sqliteLocks.delete(normalizedEmail);
    }
  }
}

export async function withNormalizedEmailLock<T>(
  db: AppDatabase,
  normalizedEmail: string,
  callback: () => Promise<T>,
) {
  if (db.dialect === 'postgres') {
    return db.transaction(async () => {
      await db.get('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [normalizedEmail]);
      return callback();
    })();
  }

  return withSqliteEmailLock(normalizedEmail, callback);
}
