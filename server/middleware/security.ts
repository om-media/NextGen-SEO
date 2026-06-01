import type { NextFunction, Request, Response } from 'express';

type RateLimitRecord = {
  count: number;
  resetAt: number;
};

const authAttempts = new Map<string, RateLimitRecord>();
const AUTH_RATE_LIMIT_MAX = 20;
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const HSTS_MAX_AGE_SECONDS = 15552000;

function getClientKey(req: Request) {
  return req.ip || req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`);
  }
  next();
}

function pruneExpiredAttempts(now: number) {
  for (const [key, record] of authAttempts) {
    if (record.resetAt <= now) {
      authAttempts.delete(key);
    }
  }
}

export function authRateLimit(req: Request, res: Response, next: NextFunction) {
  const key = getClientKey(req);
  const now = Date.now();
  if (authAttempts.size > 1000) {
    pruneExpiredAttempts(now);
  }

  const current = authAttempts.get(key);

  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS });
    return next();
  }

  current.count += 1;
  if (current.count > AUTH_RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.ceil((current.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many authentication attempts. Try again later.', code: 'RATE_LIMITED' });
  }

  next();
}
