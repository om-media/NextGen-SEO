import crypto from 'crypto';
import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { clearSessionCookie, createUserSession, destroySession, hashPassword, readAuthedUser, requireAuth, setSessionCookie, verifyPassword } from '../auth.js';
import { getInitialRegistrationTier } from '../services/registrationTier.js';

export type UserRow = {
  id: string;
  email: string;
  passwordHash?: string | null;
  authProvider?: string | null;
  name?: string | null;
  company?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  tier?: string | null;
  unlockedSites?: string | null;
  knownSites?: string | null;
  bingApiKey?: string | null;
  onboardingCompleted?: number | null;
  activatedSiteUrl?: string | null;
  activatedGa4PropertyId?: string | null;
  activatedGa4DisplayName?: string | null;
  gscRefreshToken?: string | null;
};

export function normalizeUserProfile(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    name: user.name || null,
    company: user.company || null,
    avatarUrl: user.avatarUrl || null,
    bio: user.bio || null,
    tier: (user.tier as 'free' | 'pro' | 'enterprise') || 'free',
    unlockedSites: JSON.parse(user.unlockedSites || '[]'),
    knownSites: JSON.parse(user.knownSites || '[]'),
    bingConnected: Boolean(user.bingApiKey),
    onboardingCompleted: Boolean(user.onboardingCompleted),
    activatedSiteUrl: user.activatedSiteUrl || null,
    activatedGa4PropertyId: user.activatedGa4PropertyId || null,
    activatedGa4DisplayName: user.activatedGa4DisplayName || null,
    googleConnected: Boolean(user.gscRefreshToken),
  };
}

export function buildSessionPayload(user: UserRow) {
  const profile = normalizeUserProfile(user);
  return {
    user: {
      uid: user.id,
      email: user.email,
      displayName: profile.name,
      photoURL: profile.avatarUrl,
    },
    profile,
  };
}

function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 3 && value.includes('@');
}

function isPasswordLoginShape(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 6;
}

function isAcceptableRegistrationPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10;
}

export function registerLocalAuthRoutes(app: Express, db: AppDatabase) {
  app.get('/api/auth/session', async (req, res) => {
    try {
      const authedUser = await readAuthedUser(req, db);
      if (!authedUser) {
        clearSessionCookie(res);
        return res.status(401).json({ error: 'No active session', code: 'NO_SESSION' });
      }

      const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', [authedUser.uid]);
      if (!user) {
        await destroySession(db, authedUser.token);
        clearSessionCookie(res);
        return res.status(401).json({ error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
      }

      res.json(buildSessionPayload(user));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to load session', code: 'SESSION_ERROR' });
    }
  });

  app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.', code: 'INVALID_EMAIL' });
    }
    if (!isAcceptableRegistrationPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 10 characters.', code: 'WEAK_PASSWORD' });
    }

    try {
      const normalizedEmail = email.trim().toLowerCase();
      const existingUser = await db.get<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?)', [normalizedEmail]);
      let sessionUser: UserRow;

      if (existingUser) {
        if (existingUser.passwordHash) {
          return res.status(409).json({
            error: 'This email already belongs to an existing account.',
            code: 'EMAIL_ALREADY_IN_USE',
          });
        }

        const passwordHash = hashPassword(password);
        await db.run('UPDATE users SET email = ?, passwordHash = ?, authProvider = ? WHERE id = ?', [normalizedEmail, passwordHash, 'local', existingUser.id]);
        sessionUser = {
          ...existingUser,
          email: normalizedEmail,
          passwordHash,
          authProvider: 'local',
        };
      } else {
        const id = crypto.randomUUID();
        const passwordHash = hashPassword(password);
        const createdAt = new Date().toISOString();
        const initialTier = await getInitialRegistrationTier(db);

        await db.run(`
          INSERT INTO users (
            id, email, passwordHash, authProvider, name, company, avatarUrl, bio, tier, unlockedSites, createdAt, bingApiKey, onboardingCompleted, activatedSiteUrl
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          id,
          normalizedEmail,
          passwordHash,
          'local',
          null,
          null,
          null,
          null,
          initialTier,
          JSON.stringify([]),
          createdAt,
          null,
          0,
          null,
        ]);

        sessionUser = (await db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]))!;
      }

      const sessionToken = await createUserSession(db, sessionUser.id);
      setSessionCookie(res, sessionToken);
      res.status(201).json(buildSessionPayload(sessionUser));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to create account', code: 'REGISTER_FAILED' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.', code: 'INVALID_EMAIL' });
    }
    if (!isPasswordLoginShape(password)) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.', code: 'WEAK_PASSWORD' });
    }

    try {
      const normalizedEmail = email.trim().toLowerCase();
      const user = await db.get<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?)', [normalizedEmail]);

      if (!user) {
        return res.status(401).json({ error: 'We could not find an account for that email.', code: 'INVALID_LOGIN' });
      }

      if (!user.passwordHash) {
        return res.status(409).json({
          error: 'This email already belongs to an existing account that does not have a local password yet.',
          code: 'PASSWORD_NOT_SET',
        });
      }

      if (!verifyPassword(password, user.passwordHash)) {
        return res.status(401).json({ error: 'The email or password is incorrect.', code: 'INVALID_LOGIN' });
      }

      const sessionToken = await createUserSession(db, user.id);
      setSessionCookie(res, sessionToken);
      res.json(buildSessionPayload(user));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to sign in', code: 'LOGIN_FAILED' });
    }
  });

  app.post('/api/auth/logout', requireAuth(db), async (req, res) => {
    try {
      const authedUser = await readAuthedUser(req, db);
      await destroySession(db, authedUser?.token || null);
      clearSessionCookie(res);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to sign out', code: 'LOGOUT_FAILED' });
    }
  });
}
