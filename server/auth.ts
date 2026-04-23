import type { NextFunction, Response } from 'express';
import fs from 'fs';
import path from 'path';
import type { AuthedRequest } from './types.js';

const firebaseConfig = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'firebase-applet-config.json'), 'utf8'),
) as { apiKey: string };

const verifiedTokenCache = new Map<string, { uid: string; expiresAt: number }>();

async function verifyFirebaseIdToken(idToken: string) {
  const cached = verifiedTokenCache.get(idToken);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseConfig.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    },
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as { users?: Array<{ localId: string }> };
  const user = data.users?.[0];
  if (!user?.localId) {
    return null;
  }

  const verified = {
    uid: user.localId,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  verifiedTokenCache.set(idToken, verified);
  return verified;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

    if (!idToken) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }

    const verified = await verifyFirebaseIdToken(idToken);
    if (!verified) {
      return res.status(401).json({ error: 'Invalid authorization token' });
    }

    req.authUser = { uid: verified.uid };
    next();
  } catch (error: any) {
    res.status(401).json({ error: error.message || 'Authentication failed' });
  }
}

export function requireMatchingParam(paramName: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.params[paramName] !== req.authUser.uid) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    next();
  };
}
