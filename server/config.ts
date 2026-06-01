const PLACEHOLDER_VALUES = new Set([
  '',
  'CHANGE_ME',
  'CHANGE_ME_TOO',
  'MY_APP_URL',
  'MY_GOOGLE_OAUTH_CLIENT_ID',
  'MY_GOOGLE_OAUTH_CLIENT_SECRET',
  'nextgen-seo-dev-secret',
]);

function isPlaceholder(value: string | undefined) {
  const normalized = value?.trim() || '';
  return (
    !normalized ||
    PLACEHOLDER_VALUES.has(normalized) ||
    normalized.toUpperCase().includes('CHANGE_ME') ||
    normalized.toUpperCase().includes('REPLACE_ME')
  );
}

function isHttpsUrl(value: string | undefined) {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateRuntimeConfig() {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const errors: string[] = [];

  if (isPlaceholder(process.env.DATABASE_URL)) {
    errors.push('DATABASE_URL must be set in production so the app does not fall back to local SQLite.');
  }

  if (!isHttpsUrl(process.env.APP_BASE_URL)) {
    errors.push('APP_BASE_URL must be a valid https:// URL in production.');
  }

  if (isPlaceholder(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY) || (process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || '').length < 32) {
    errors.push('GOOGLE_TOKEN_ENCRYPTION_KEY must be set to a non-placeholder value of at least 32 characters in production.');
  }

  if (isPlaceholder(process.env.GOOGLE_OAUTH_STATE_SECRET) || (process.env.GOOGLE_OAUTH_STATE_SECRET || '').length < 32) {
    errors.push('GOOGLE_OAUTH_STATE_SECRET must be set to a non-placeholder value of at least 32 characters in production.');
  }

  if (isPlaceholder(process.env.GOOGLE_OAUTH_CLIENT_ID)) {
    errors.push('GOOGLE_OAUTH_CLIENT_ID must be set in production for Google integrations.');
  }
  if (isPlaceholder(process.env.GOOGLE_OAUTH_CLIENT_SECRET)) {
    errors.push('GOOGLE_OAUTH_CLIENT_SECRET must be set in production for Google integrations.');
  }
  if (!isHttpsUrl(process.env.GOOGLE_OAUTH_REDIRECT_URI)) {
    errors.push('GOOGLE_OAUTH_REDIRECT_URI must be an https:// URL in production.');
  }

  if (errors.length > 0) {
    throw new Error(`Production configuration is invalid:\n- ${errors.join('\n- ')}`);
  }
}
