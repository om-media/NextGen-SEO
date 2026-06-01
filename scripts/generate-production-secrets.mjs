import crypto from 'node:crypto';

function secret() {
  return crypto.randomBytes(32).toString('base64url');
}

console.log(`GOOGLE_OAUTH_STATE_SECRET=${secret()}`);
console.log(`GOOGLE_TOKEN_ENCRYPTION_KEY=${secret()}`);
