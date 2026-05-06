import type { AppDatabase } from './database.js';

type WorkspaceAccessUser = {
  activatedGa4PropertyId?: string | null;
  activatedSiteUrl?: string | null;
  tier?: string | null;
  unlockedSites?: string | null;
};

function parseStringArray(value: unknown) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export async function canAccessSite(db: AppDatabase, ownerId: string, siteUrl: string) {
  const user = await db.get<WorkspaceAccessUser>(
    'SELECT tier, unlockedSites, activatedSiteUrl FROM users WHERE id = ?',
    [ownerId],
  );

  if (!user) return false;
  if (user.tier === 'enterprise') return true;

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
