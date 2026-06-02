import type { AppDatabase } from './database.js';

type WorkspaceAccessUser = {
  activatedGa4PropertyId?: string | null;
  activatedSiteUrl?: string | null;
  knownSites?: string | null;
  tier?: string | null;
  unlockedSites?: string | null;
};

function parseStringArray(value: unknown) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function hasWorkspaceSite(user: WorkspaceAccessUser, siteUrl: string) {
  const allowedSites = new Set([
    ...parseStringArray(user.unlockedSites),
    ...parseStringArray(user.knownSites),
    ...(typeof user.activatedSiteUrl === 'string' && user.activatedSiteUrl.trim() ? [user.activatedSiteUrl.trim()] : []),
  ]);

  return allowedSites.has(siteUrl);
}

export async function canAccessSite(db: AppDatabase, ownerId: string, siteUrl: string) {
  const user = await db.get<WorkspaceAccessUser>(
    'SELECT tier, unlockedSites, knownSites, activatedSiteUrl FROM users WHERE id = ?',
    [ownerId],
  );

  if (!user) return false;
  if (user.tier === 'enterprise') return hasWorkspaceSite(user, siteUrl);

  const unlockedSites = parseStringArray(user.unlockedSites);
  return unlockedSites.includes(siteUrl) || user.activatedSiteUrl === siteUrl;
}

export async function canAccessGa4Property(db: AppDatabase, ownerId: string, propertyId: string) {
  const user = await db.get<WorkspaceAccessUser>(
    'SELECT tier, activatedGa4PropertyId FROM users WHERE id = ?',
    [ownerId],
  );

  if (!user) return false;
  if (user.tier === 'enterprise') return true;

  return Boolean(user.activatedGa4PropertyId && user.activatedGa4PropertyId === propertyId);
}
