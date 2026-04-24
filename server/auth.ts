import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';
import type { AuthedRequest } from './types.js';

export const SESSION_COOKIE_NAME = 'nextgen_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function parseCookieHeader(cookieHeader: string | undefined) {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const entry of cookieHeader.split(';')) {
    const [rawName, ...rawValueParts] = entry.trim().split('=');
    if (!rawName) {
      continue;
    }

    cookies.set(rawName, decodeURIComponent(rawValueParts.join('=')));
  }

  return cookies;
}

function getSessionToken(req: Request) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return parseCookieHeader(req.headers.cookie).get(SESSION_COOKIE_NAME) || null;
}

function hashSessionToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSessionCookie(token: string, maxAgeSeconds = SESSION_MAX_AGE_SECONDS) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', createSessionCookie('', 0));
}

export function setSessionCookie(res: Response, token: string) {
  res.setHeader('Set-Cookie', createSessionCookie(token));
}

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

export function verifyPassword(password: string, storedHash: string | null | undefined) {
  if (!storedHash) {
    return false;
  }

  const [algorithm, salt, derivedKey] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !salt || !derivedKey) {
    return false;
  }

  const candidateKey = crypto.scryptSync(password, salt, 64);
  const storedKeyBuffer = Buffer.from(derivedKey, 'hex');
  if (candidateKey.length !== storedKeyBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateKey, storedKeyBuffer);
}

export function createUserSession(db: Database.Database, userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();

  db.prepare('INSERT INTO sessions (tokenHash, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)')
    .run(hashSessionToken(token), userId, expiresAt, now.toISOString());

  return token;
}

export function destroySession(db: Database.Database, token: string | null) {
  if (!token) {
    return;
  }

  db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(hashSessionToken(token));
}

export function readAuthedUser(req: Request, db: Database.Database) {
  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    return null;
  }

  const session = db.prepare(
    `SELECT sessions.userId
     FROM sessions
     WHERE sessions.tokenHash = ?
       AND sessions.expiresAt > ?`,
  ).get(hashSessionToken(sessionToken), new Date().toISOString()) as { userId?: string } | undefined;

  if (!session?.userId) {
    return null;
  }

  return {
    token: sessionToken,
    uid: session.userId,
  };
}

export function requireAuth(db: Database.Database) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const authedUser = readAuthedUser(req, db);
      if (!authedUser) {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }

      req.authUser = { uid: authedUser.uid };
      next();
    } catch (error: any) {
      res.status(401).json({ error: error.message || 'Authentication failed', code: 'AUTH_FAILED' });
    }
  };
}

export function requireMatchingParam(paramName: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }

    if (req.params[paramName] !== req.authUser.uid) {
      return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    }

    next();
  };
}
