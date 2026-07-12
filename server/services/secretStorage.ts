import crypto from 'crypto';

function getSecretMaterial() {
  return process.env.APP_SECRET_ENCRYPTION_KEY
    || process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
    || process.env.GOOGLE_OAUTH_CLIENT_SECRET
    || 'nextgen-seo-dev-secret';
}

function getEncryptionKey() {
  return crypto.createHash('sha256').update(getSecretMaterial()).digest();
}

export function encryptSecret(secret: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value: string | null | undefined) {
  if (!value) return null;
  if (!value.startsWith('enc:')) return value;

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

export function maskSecret(secret: string | null | undefined) {
  const value = String(secret || '').trim();
  if (!value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
