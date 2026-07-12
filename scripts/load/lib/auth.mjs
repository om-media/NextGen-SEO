import path from 'node:path';
import { readJsonFile, runWithConcurrency } from './util.mjs';

function extractSessionCookie(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const cookies = headers.getSetCookie();
    if (cookies.length) {
      return cookies[0].split(';', 1)[0];
    }
  }

  const cookie = headers.get('set-cookie');
  return cookie ? cookie.split(';', 1)[0] : null;
}

function normalizeUser(entry, index) {
  const id = String(entry?.id || `vu-${String(index + 1).padStart(3, '0')}`).trim();
  const normalized = {
    id,
    siteUrl: entry?.siteUrl ? String(entry.siteUrl).trim() : null,
    startUrl: entry?.startUrl ? String(entry.startUrl).trim() : null,
    propertyId: entry?.propertyId ? String(entry.propertyId).trim() : null,
    bearerToken: entry?.bearerToken ? String(entry.bearerToken).trim() : null,
    sessionCookie: entry?.sessionCookie ? String(entry.sessionCookie).trim() : null,
    email: entry?.email ? String(entry.email).trim() : null,
    password: entry?.password ? String(entry.password) : null,
    metadata: entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {},
  };

  if (!normalized.bearerToken && !normalized.sessionCookie && !(normalized.email && normalized.password)) {
    throw new Error(`User "${id}" must provide bearerToken, sessionCookie, or email/password.`);
  }

  return normalized;
}

async function loginUser(baseUrl, loginPath, timeoutMs, user) {
  const response = await fetch(`${baseUrl}${loginPath}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: user.email,
      password: user.password,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Failed to sign in ${user.id}: ${data?.error || `HTTP ${response.status}`}`);
  }

  const sessionCookie = extractSessionCookie(response.headers);
  if (!sessionCookie) {
    throw new Error(`Login for ${user.id} succeeded but did not return a session cookie.`);
  }

  return {
    ...user,
    sessionCookie,
  };
}

export async function loadUserFixtures(usersPath, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, usersPath);
  const payload = await readJsonFile(resolved);
  if (!Array.isArray(payload)) {
    throw new Error(`User fixture must be an array: ${resolved}`);
  }
  return payload.map((entry, index) => normalizeUser(entry, index));
}

export async function resolveAuthenticatedUsers(config, cwd = process.cwd()) {
  const users = await loadUserFixtures(config.auth.usersPath, cwd);
  const loggedInUsers = await runWithConcurrency(config.auth.bootstrapConcurrency, users, async (user) => {
    if (user.bearerToken || user.sessionCookie) {
      return user;
    }
    return loginUser(config.baseUrl, config.auth.loginPath, config.requestTimeoutMs, user);
  });

  if (loggedInUsers.length === config.vus) {
    return loggedInUsers;
  }

  if (loggedInUsers.length > config.vus) {
    return loggedInUsers.slice(0, config.vus);
  }

  if (!config.auth.allowAuthReuse) {
    throw new Error(`Requested ${config.vus} virtual users, but only ${loggedInUsers.length} auth fixtures are available. Set auth.allowAuthReuse=true to clone fixtures for rehearsal runs.`);
  }

  const expanded = [];
  for (let index = 0; index < config.vus; index += 1) {
    const source = loggedInUsers[index % loggedInUsers.length];
    expanded.push({
      ...source,
      id: index < loggedInUsers.length ? source.id : `${source.id}#${String(index + 1).padStart(3, '0')}`,
      metadata: {
        ...(source.metadata || {}),
        sourceUserId: source.id,
      },
    });
  }
  return expanded;
}

export function buildAuthHeaders(user) {
  if (user?.bearerToken) {
    return { Authorization: `Bearer ${user.bearerToken}` };
  }
  if (user?.sessionCookie) {
    return { Cookie: user.sessionCookie };
  }
  throw new Error(`User "${user?.id || 'unknown'}" does not have resolved auth headers.`);
}
