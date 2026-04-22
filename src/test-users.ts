import Database from 'better-sqlite3';

try {
  const db = new Database('sqlite.db');
  console.log("Users:", db.prepare('SELECT * FROM users').all());
} catch (e) {
  console.error(e);
}
