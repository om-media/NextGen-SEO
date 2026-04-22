import Database from 'better-sqlite3';

try {
  const db = new Database('sqlite.db');
  db.exec('ALTER TABLE users ADD COLUMN gscRefreshToken TEXT;');
  console.log("Migration successful");
} catch (e) {
  console.error("Migration error:", e.message);
}
