import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { initializeDatabase } from '../../.server-dist/server/database.js';
import { createUserSession, SESSION_COOKIE_NAME } from '../../.server-dist/server/auth.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const count = Math.max(1, Math.min(1000, Number(argument('--count', '200'))));
const namespace = String(argument('--namespace', 'load-acceptance')).replace(/[^a-z0-9_-]/gi, '-');
const output = path.resolve(argument('--output', '.tmp/load-users.json'));
const cleanup = process.argv.includes('--cleanup');
const siteUrl = String(argument('--site-url', 'https://load-acceptance.example/'));

const db = await initializeDatabase();
try {
  const prefix = `${namespace}-%`;
  if (cleanup) {
    await db.run('DELETE FROM sessions WHERE userId LIKE ?', [prefix]);
    await db.run('DELETE FROM users WHERE id LIKE ?', [prefix]);
    console.log(JSON.stringify({ cleaned: true, namespace }));
    process.exit(0);
  }

  const users = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index + 1).padStart(3, '0');
    const id = `${namespace}-${suffix}`;
    const email = `${id}@example.test`;
    const now = new Date().toISOString();
    await db.run('DELETE FROM sessions WHERE userId = ?', [id]);
    await db.run('DELETE FROM users WHERE id = ?', [id]);
    await db.run(`
      INSERT INTO users (
        id, email, passwordHash, name, tier, activatedSiteUrl, knownSites, unlockedSites,
        onboardingCompleted, createdAt
      ) VALUES (?, ?, 'load-only', ?, 'pro', ?, ?, ?, 1, ?)
    `, [id, email, `Load user ${suffix}`, siteUrl, JSON.stringify([siteUrl]), JSON.stringify([siteUrl]), now]);
    const token = await createUserSession(db, id);
    users.push({
      id,
      sessionCookie: `${SESSION_COOKIE_NAME}=${token}`,
      siteUrl,
    });
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(users, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ count: users.length, namespace, output, siteUrl }, null, 2));
} finally {
  await db.close?.();
}
