import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env.local' });
dotenv.config();

const baseUrl = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!databaseUrl) throw new Error('DATABASE_URL or POSTGRES_URL is required.');

async function ready() {
  const startedAt = performance.now();
  try {
    const response = await fetch(baseUrl + '/api/ready', { signal: AbortSignal.timeout(5_000) });
    return { durationMs: Math.round(performance.now() - startedAt), ok: response.ok, status: response.status };
  } catch {
    return { durationMs: Math.round(performance.now() - startedAt), ok: false, status: 0 };
  }
}

const before = await ready();
if (!before.ok) throw new Error(`Server was not ready before connection reset: ${JSON.stringify(before)}`);

const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  application_name: 'gscplus-recovery-test',
});
await client.connect();
const result = await client.query(`
  SELECT pg_terminate_backend(pid) AS terminated
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()
    AND application_name = 'gscplus'
`);
await client.end();

const startedAt = Date.now();
const probes = [];
let recovered = null;
while (Date.now() - startedAt < 30_000) {
  const probe = await ready();
  probes.push(probe);
  if (probe.ok) {
    recovered = probe;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!recovered) throw new Error(`Server did not recover its PostgreSQL pool: ${JSON.stringify(probes)}`);

console.log(JSON.stringify({
  before,
  recoveryMs: Date.now() - startedAt,
  terminatedConnections: result.rows.filter((row) => row.terminated).length,
  probes,
  recovered,
}, null, 2));
