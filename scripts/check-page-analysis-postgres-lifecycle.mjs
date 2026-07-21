import net from 'node:net';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const image = 'pgvector/pgvector:pg16';
const database = 'page_analysis_test';
const user = 'page_analysis_test';
const password = 'page_analysis_test_password';
const containerName = `gscplus-page-analysis-${crypto.randomBytes(8).toString('hex')}`;
const readinessTimeoutMs = 120_000;

function run(command, args, options = {}) {
  const { capture = false, env = process.env } = options;

  return new Promise((resolve, reject) => {
    const useWindowsCommandShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const executable = useWindowsCommandShell ? process.env.ComSpec || 'cmd.exe' : command;
    const executableArgs = useWindowsCommandShell ? ['/d', '/s', '/c', command, ...args] : args;
    const child = spawn(executable, executableArgs, {
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';

    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    }

    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function docker(args, options = {}) {
  return run(process.platform === 'win32' ? 'docker.exe' : 'docker', args, options);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not determine the allocated localhost port.');
  }
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForPostgres() {
  const startedAt = Date.now();
  let lastError = 'container has not reported readiness';

  while (Date.now() - startedAt < readinessTimeoutMs) {
    const result = await docker(
      ['exec', containerName, 'pg_isready', '-U', user, '-d', database],
      { capture: true },
    );
    if (result.code === 0) return;

    lastError = (result.stderr || result.stdout || `exit code ${result.code}`).trim();
    await sleep(500);
  }

  throw new Error(`PostgreSQL container did not become ready: ${lastError}`);
}

async function removeContainer() {
  const result = await docker(['rm', '--force', '--volumes', containerName], { capture: true });
  if (result.code !== 0 && !/No such container/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Could not remove PostgreSQL test container: ${(result.stderr || result.stdout).trim()}`);
  }
}

const port = await findFreePort();
const databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
let failure;

try {
  const start = await docker([
    'run',
    '--detach',
    '--name', containerName,
    '--publish', `127.0.0.1:${port}:5432`,
    '--env', `POSTGRES_DB=${database}`,
    '--env', `POSTGRES_USER=${user}`,
    '--env', `POSTGRES_PASSWORD=${password}`,
    image,
  ], { capture: true });
  if (start.code !== 0) {
    throw new Error(`Could not start isolated PostgreSQL container: ${(start.stderr || start.stdout).trim()}`);
  }

  await waitForPostgres();

  const tsx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const lifecycle = await run(
    tsx,
    ['--no-install', 'tsx', '--tsconfig', 'tsconfig.server.json', 'scripts/check-page-analysis-lifecycle.ts'],
    { env: { ...process.env, PAGE_ANALYSIS_TEST_DATABASE_URL: databaseUrl } },
  );
  if (lifecycle.code !== 0) {
    throw new Error(`PostgreSQL page analysis lifecycle check exited with ${lifecycle.code ?? lifecycle.signal}.`);
  }
} catch (error) {
  failure = error;
} finally {
  try {
    await removeContainer();
  } catch (cleanupError) {
    if (!failure) failure = cleanupError;
    else console.error(`PostgreSQL test container cleanup failed: ${cleanupError.message}`);
  }
}

if (failure) {
  console.error(failure instanceof Error ? failure.stack || failure.message : failure);
  process.exit(1);
}

console.log('PostgreSQL page analysis lifecycle regression passed.');