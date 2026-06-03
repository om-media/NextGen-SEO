import { spawn } from 'node:child_process';

const composeFile = 'docker-compose.prod-smoke.yml';
const composeUpArgs = ['compose', '-f', composeFile, 'up', '--build', '--wait', '--wait-timeout', '180'];
const composeDownArgs = ['compose', '-f', composeFile, 'down', '-v'];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const isWindowsDocker = process.platform === 'win32' && command === 'docker';
    const executable = isWindowsDocker ? process.env.ComSpec || 'cmd.exe' : command;
    const executableArgs = isWindowsDocker ? ['/d', '/s', '/c', command, ...args] : args;
    const child = spawn(executable, executableArgs, { stdio: ['inherit', 'pipe', 'pipe'] });
    const output = [];

    const capture = (chunk, stream) => {
      const text = chunk.toString();
      output.push(text);
      stream.write(chunk);
    };

    child.stdout.on('data', (chunk) => capture(chunk, process.stdout));
    child.stderr.on('data', (chunk) => capture(chunk, process.stderr));

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const capturedOutput = output.join('').trim();
      const suffix = capturedOutput ? `\n${capturedOutput.slice(-2000)}` : '';
      reject(new Error(`${command} ${args.join(' ')} exited with ${code}${suffix}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDockerError(error) {
  const message = error?.message || '';
  return /context deadline exceeded|Client\.Timeout|TLS handshake timeout|toomanyrequests|network is unreachable|connection reset|temporary failure|i\/o timeout/i.test(message);
}

async function cleanupCompose() {
  await run('docker', composeDownArgs);
}

async function runComposeUpWithRetry(maxAttempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await run('docker', composeUpArgs);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableDockerError(error) || attempt === maxAttempts) {
        throw error;
      }

      console.warn(`Docker compose smoke attempt ${attempt} failed with a retryable error: ${error.message}`);
      console.warn(`Retrying Docker compose smoke in ${attempt * 10}s...`);
      try {
        await cleanupCompose();
      } catch (cleanupError) {
        console.warn(`Docker compose cleanup before retry failed: ${cleanupError.message}`);
      }
      await delay(attempt * 10_000);
    }
  }

  throw lastError;
}

let failure;

try {
  await runComposeUpWithRetry();
  process.env.PRODUCTION_VERIFY_ALLOW_HTTP = 'true';
  await run('node', ['scripts/verify-production-url.mjs', 'http://127.0.0.1:3010']);
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanupCompose();
  } catch (cleanupError) {
    if (!failure) {
      failure = cleanupError;
    } else {
      console.error(`Docker smoke cleanup failed: ${cleanupError.message}`);
    }
  }
}

if (failure) {
  console.error(`Docker smoke verification failed: ${failure.message}`);
  process.exit(1);
}
