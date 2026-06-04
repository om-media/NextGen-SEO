import type { AppDatabase } from '../database.js';
import { canAccessGa4Property, canAccessSite } from '../accessControl.js';

export type WorkspaceGa4Mapping = {
  displayName?: string | null;
  ownerId: string;
  propertyId: string;
  siteUrl: string;
};

const nowIso = () => new Date().toISOString();

export async function upsertWorkspaceGa4Mapping(db: AppDatabase, mapping: WorkspaceGa4Mapping) {
  const siteUrl = mapping.siteUrl.trim();
  const propertyId = mapping.propertyId.trim();
  if (!siteUrl || !propertyId) return;

  const [siteAllowed, propertyAllowed] = await Promise.all([
    canAccessSite(db, mapping.ownerId, siteUrl),
    canAccessGa4Property(db, mapping.ownerId, propertyId),
  ]);
  if (!siteAllowed || !propertyAllowed) return;

  await db.run(`
    INSERT INTO workspace_ga4_mappings (ownerId, siteUrl, propertyId, displayName, updatedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ownerId, siteUrl) DO UPDATE SET
      propertyId = excluded.propertyId,
      displayName = COALESCE(excluded.displayName, workspace_ga4_mappings.displayName),
      updatedAt = excluded.updatedAt
  `, [mapping.ownerId, siteUrl, propertyId, mapping.displayName || null, nowIso()]);
}

export async function resolveWorkspaceGa4Property(db: AppDatabase, ownerId: string, siteUrl: string) {
  const mapping = await db.get<{ propertyId?: string | null }>(`
    SELECT propertyId
    FROM workspace_ga4_mappings
    WHERE ownerId = ? AND siteUrl = ?
    LIMIT 1
  `, [ownerId, siteUrl]);
  const mappedPropertyId = typeof mapping?.propertyId === 'string' ? mapping.propertyId.trim() : '';
  if (mappedPropertyId && await canAccessGa4Property(db, ownerId, mappedPropertyId)) {
    return mappedPropertyId;
  }

  const user = await db.get<{ activatedGa4PropertyId?: string | null; activatedSiteUrl?: string | null }>(
    'SELECT activatedGa4PropertyId, activatedSiteUrl FROM users WHERE id = ?',
    [ownerId],
  );
  const activeSiteUrl = typeof user?.activatedSiteUrl === 'string' ? user.activatedSiteUrl.trim() : '';
  const activePropertyId = typeof user?.activatedGa4PropertyId === 'string' ? user.activatedGa4PropertyId.trim() : '';
  if (siteUrl === activeSiteUrl && activePropertyId && await canAccessGa4Property(db, ownerId, activePropertyId)) {
    return activePropertyId;
  }

  return null;
}
