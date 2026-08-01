import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error('HTTP ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('Worker readiness timed out.');
}

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert(port > 0, 'Failed to reserve an available worker health port.');
  return port;
}

async function main() {
  assert(fs.existsSync('.server-dist/worker.js'), 'Build worker.ts before running the runtime-role smoke.');
  assert(fs.existsSync('.server-dist/server/runtimeRoles.js'), 'Build server runtime roles before running the runtime-role smoke.');
  const { parseRuntimeRole } = await import('../.server-dist/server/runtimeRoles.js');
  assert(parseRuntimeRole('crawl', 'web') === 'crawl', 'crawl role parses');
  assert(parseRuntimeRole('internal-links', 'web') === 'internal-links', 'internal-links role parses');
  assert(parseRuntimeRole('not-real', 'web') === 'web', 'invalid role uses fallback');

  const port = await getAvailablePort();
  const child = spawn(process.execPath, ['.server-dist/worker.js', 'crawl'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      START_BACKGROUND_WORKERS: 'false',
      WORKER_DRY_RUN: 'true',
      WORKER_HEALTH_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  try {
    const ready = await waitForReady('http://127.0.0.1:' + port + '/ready', 20_000);
    assert(ready.ok === true, 'worker readiness is healthy');
    assert(ready.role === 'crawl', 'worker readiness reports role');
    child.kill('SIGTERM');
    const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const cleanExit = exit.code === 0 || (process.platform === 'win32' && exit.code === null && exit.signal === 'SIGTERM');
    assert(cleanExit, 'worker exits cleanly after SIGTERM: ' + JSON.stringify(exit));
    console.log(JSON.stringify({ exit, ready, stderr, stdout }, null, 2));
  } catch (error) {
    const detail = [
      error?.stack || error?.message || String(error),
      stdout ? `Worker stdout:\n${stdout}` : '',
      stderr ? `Worker stderr:\n${stderr}` : '',
    ].filter(Boolean).join('\n');
    throw new Error(detail);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
