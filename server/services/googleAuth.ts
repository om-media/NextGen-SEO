import crypto from 'crypto';
import type { Request } from 'express';
import type { AppDatabase } from '../database.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DATA_SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];
const GOOGLE_APP_AUTH_SCOPES = [
  'openid',
  'email',
  'profile',
];

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type GoogleOauthStatePayload = {
  issuedAt: number;
  mode: 'connect' | 'app-auth';
  userId?: string;
};

export type GoogleUserInfo = {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  sub?: string;
};

type GoogleOauthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

function getSecretMaterial() {
  return process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
    || process.env.GOOGLE_OAUTH_CLIENT_SECRET
    || 'nextgen-seo-dev-secret';
}

function getEncryptionKey() {
  return crypto.createHash('sha256').update(getSecretMaterial()).digest();
}

function getStateSecret() {
  return process.env.GOOGLE_OAUTH_STATE_SECRET || getSecretMaterial();
}

function encodeBase64Url(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signStatePayload(payload: string) {
  return crypto.createHmac('sha256', getStateSecret()).update(payload).digest('base64url');
}

function encryptToken(token: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptToken(value: string) {
  if (!value) {
    return null;
  }

  if (!value.startsWith('enc:')) {
    return value;
  }

  const [, payload] = value.split('enc:');
  const [ivPart, tagPart, dataPart] = payload.split('.');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function resolveAppBaseUrl(req: Request) {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL.replace(/\/$/, '');
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto?.split(',')[0] || 'http';
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : forwardedHost || req.headers.host || 'localhost:3000';

  return `${proto}://${host}`.replace(/\/$/, '');
}

export function getGoogleOauthConfig(req: Request): GoogleOauthConfig {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || `${resolveAppBaseUrl(req)}/api/google/oauth/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.');
  }

  return { clientId, clientSecret, redirectUri };
}

function buildGoogleOauthStatePayload(payload: GoogleOauthStatePayload) {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${signStatePayload(encodedPayload)}`;
}

export function buildGoogleOauthState(userId: string) {
  return buildGoogleOauthStatePayload({
    issuedAt: Date.now(),
    mode: 'connect',
    userId,
  });
}

export function buildGoogleAppAuthState() {
  return buildGoogleOauthStatePayload({
    issuedAt: Date.now(),
    mode: 'app-auth',
  });
}

export function verifyGoogleOauthStatePayload(state: string) {
  const [payload, signature] = state.split('.');
  if (!payload || !signature || signStatePayload(payload) !== signature) {
    throw new Error('Invalid OAuth state');
  }

  const parsed = JSON.parse(decodeBase64Url(payload)) as GoogleOauthStatePayload;
  if (!parsed.mode || !parsed.issuedAt || Date.now() - parsed.issuedAt > 10 * 60 * 1000) {
    throw new Error('Expired OAuth state');
  }
  if (parsed.mode === 'connect' && !parsed.userId) {
    throw new Error('Invalid OAuth state');
  }

  return parsed;
}

function buildGoogleOauthUrlForState(req: Request, state: string, scopes: string[]) {
  const { clientId, redirectUri } = getGoogleOauthConfig(req);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes.join(' '),
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function buildGoogleAppAuthUrl(req: Request) {
  return buildGoogleOauthUrlForState(req, buildGoogleAppAuthState(), GOOGLE_APP_AUTH_SCOPES);
}

export function verifyGoogleOauthState(state: string) {
  const parsed = verifyGoogleOauthStatePayload(state);
  if (parsed.mode !== 'connect' || !parsed.userId) {
    throw new Error('Invalid OAuth state');
  }

  return parsed.userId;
}

export function buildGoogleOauthUrl(req: Request, userId: string) {
  return buildGoogleOauthUrlForState(req, buildGoogleOauthState(userId), GOOGLE_DATA_SCOPES);
}

export async function fetchGoogleUserInfo(accessToken: string) {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await response.json() as GoogleUserInfo;
  if (!response.ok || !data.email) {
    throw new Error('Failed to read Google account profile.');
  }

  return data;
}

export async function exchangeGoogleCodeForTokens(req: Request, code: string) {
  const { clientId, clientSecret, redirectUri } = getGoogleOauthConfig(req);
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json() as GoogleTokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Failed to exchange Google OAuth code');
  }

  return data;
}

export async function storeGoogleRefreshToken(db: AppDatabase, userId: string, refreshToken: string) {
  await db.run('UPDATE users SET gscRefreshToken = ? WHERE id = ?', [encryptToken(refreshToken), userId]);
}

export async function clearGoogleRefreshToken(db: AppDatabase, userId: string) {
  await db.run('UPDATE users SET gscRefreshToken = NULL WHERE id = ?', [userId]);
}

export async function getStoredGoogleRefreshToken(db: AppDatabase, userId: string) {
  const record = await db.get<{ gscRefreshToken?: string | null }>('SELECT gscRefreshToken FROM users WHERE id = ?', [userId]);
  if (!record?.gscRefreshToken) {
    return null;
  }

  return decryptToken(record.gscRefreshToken);
}

export async function getGoogleAccessTokenForUser(db: AppDatabase, userId: string) {
  const refreshToken = await getStoredGoogleRefreshToken(db, userId);
  if (!refreshToken) {
    throw new Error('GOOGLE_NOT_CONNECTED');
  }

  const { clientId, clientSecret } = getGoogleOauthConfig({
    headers: {},
  } as Request);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json() as GoogleTokenResponse;
  if (!response.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      await clearGoogleRefreshToken(db, userId);
    }

    throw new Error(data.error_description || data.error || 'GOOGLE_NOT_CONNECTED');
  }

  return data.access_token;
}

export async function googleApiFetchJson(
  db: AppDatabase,
  userId: string,
  url: string,
  options: RequestInit = {},
) {
  const accessToken = await getGoogleAccessTokenForUser(db, userId);
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || data?.error_description || 'Google API request failed';
    const error = new Error(message) as Error & { status?: number; payload?: unknown };
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}
