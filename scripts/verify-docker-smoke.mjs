import { spawn } from 'node:child_process';

const composeFile = 'docker-compose.prod-smoke.yml';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const isWindowsDocker = process.platform === 'win32' && command === 'docker';
    const executable = isWindowsDocker ? process.env.ComSpec || 'cmd.exe' : command;
    const executableArgs = isWindowsDocker ? ['/d', '/s', '/c', command, ...args] : args;
    const child = spawn(executable, executableArgs, { stdio: 'inherit' });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

let failure;

try {
  await run('docker', ['compose', '-f', composeFile, 'up', '--build', '--wait', '--wait-timeout', '180']);
  process.env.PRODUCTION_VERIFY_ALLOW_HTTP = 'true';
  await run('node', ['scripts/verify-production-url.mjs', 'http://127.0.0.1:3010']);
} catch (error) {
  failure = error;
} finally {
  try {
    await run('docker', ['compose', '-f', composeFile, 'down', '-v']);
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
