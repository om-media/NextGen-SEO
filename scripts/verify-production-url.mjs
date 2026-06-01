const inputUrl = process.argv[2] || process.env.PRODUCTION_BASE_URL;

if (!inputUrl) {
  console.error('Usage: npm run verify:production-url -- https://your-app.example.com');
  console.error('Or set PRODUCTION_BASE_URL=https://your-app.example.com');
  process.exit(2);
}

const baseUrl = new URL(inputUrl);
baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
baseUrl.search = '';
baseUrl.hash = '';

if (baseUrl.protocol !== 'https:' && process.env.PRODUCTION_VERIFY_ALLOW_HTTP !== 'true') {
  console.error(`Production URL must use https://. Received: ${baseUrl.href}`);
  console.error('Set PRODUCTION_VERIFY_ALLOW_HTTP=true only for local container smoke tests.');
  process.exit(2);
}

function resolveUrl(path) {
  return new URL(path, baseUrl.href).href;
}

async function fetchWithTimeout(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(resolveUrl(path), {
      redirect: 'manual',
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function requireStatus(name, response, expectedStatus) {
  if (response.status !== expectedStatus) {
    throw new Error(`${name} returned ${response.status}; expected ${expectedStatus}`);
  }
}

function requireHeader(name, response, headerName, expectedPattern) {
  const value = response.headers.get(headerName);
  if (!value || !expectedPattern.test(value)) {
    throw new Error(`${name} missing or invalid ${headerName}: ${value || '(missing)'}`);
  }
}

const checks = [];

async function runCheck(name, fn) {
  await fn();
  checks.push(name);
  console.log(`ok - ${name}`);
}

try {
  let indexHtml = '';

  await runCheck('health endpoint', async () => {
    const response = await fetchWithTimeout('/api/health');
    requireStatus('health endpoint', response, 200);
    requireHeader('health endpoint', response, 'strict-transport-security', /max-age=\d+/i);
    requireHeader('health endpoint', response, 'x-content-type-options', /^nosniff$/i);
    requireHeader('health endpoint', response, 'x-frame-options', /^DENY$/i);
  });

  await runCheck('readiness endpoint', async () => {
    const response = await fetchWithTimeout('/api/ready');
    requireStatus('readiness endpoint', response, 200);
    const payload = await response.json();
    if (payload?.ok !== true) {
      throw new Error(`readiness endpoint returned ok=${payload?.ok}`);
    }
  });

  await runCheck('SPA document', async () => {
    const response = await fetchWithTimeout('/');
    requireStatus('SPA document', response, 200);
    requireHeader('SPA document', response, 'content-type', /text\/html/i);
    indexHtml = await response.text();
    if (!indexHtml.includes('<div id="root">')) {
      throw new Error('SPA document does not contain the React root element.');
    }
  });

  await runCheck('built asset cache headers', async () => {
    const assetMatch = indexHtml.match(/src="([^"]+\.js)"/);
    if (!assetMatch) {
      throw new Error('Could not find a built JavaScript asset in the SPA document.');
    }

    const response = await fetchWithTimeout(assetMatch[1], { method: 'HEAD' });
    requireStatus('built asset', response, 200);
    requireHeader('built asset', response, 'cache-control', /max-age=31536000/i);
    requireHeader('built asset', response, 'cache-control', /immutable/i);
  });

  await runCheck('Google OAuth callback route', async () => {
    const response = await fetchWithTimeout('/api/google/oauth/callback');
    requireStatus('Google OAuth callback route', response, 400);
    requireHeader('Google OAuth callback route', response, 'content-type', /text\/html/i);
  });

  console.log(`verified ${checks.length} production URL checks for ${baseUrl.href}`);
} catch (error) {
  console.error(`production URL verification failed: ${error.message}`);
  process.exit(1);
}
