import type { AppDatabase } from './database.js';

type WorkspaceAccessUser = {
  activatedGa4PropertyId?: string | null;
  activatedSiteUrl?: string | null;
  gscRefreshToken?: string | null;
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
  return hasWorkspaceSite(user, siteUrl);
}

export async function canAccessGa4Property(db: AppDatabase, ownerId: string, propertyId: string) {
  const user = await db.get<WorkspaceAccessUser>(
    'SELECT tier, activatedGa4PropertyId FROM users WHERE id = ?',
    [ownerId],
  );

  if (!user) return false;
  if (user.activatedGa4PropertyId && user.activatedGa4PropertyId === propertyId) return true;
  const mapping = await db.get<{ propertyId: string }>(
    'SELECT propertyId FROM workspace_ga4_mappings WHERE ownerId = ? AND propertyId = ?',
    [ownerId, propertyId],
  );
  if (mapping) return true;

  const storedRows = await db.get<{ count: number }>(
    `
      SELECT SUM(rowCount) AS count
      FROM (
        SELECT COUNT(*) AS rowCount FROM ga4_page_metrics WHERE ownerId = ? AND propertyId = ?
        UNION ALL
        SELECT COUNT(*) AS rowCount FROM ga4_dimension_metrics WHERE ownerId = ? AND propertyId = ?
        UNION ALL
        SELECT COUNT(*) AS rowCount FROM ga4_llm_referral_metrics WHERE ownerId = ? AND propertyId = ?
      ) rows
    `,
    [ownerId, propertyId, ownerId, propertyId, ownerId, propertyId],
  );
  return Number(storedRows?.count || 0) > 0;
}
