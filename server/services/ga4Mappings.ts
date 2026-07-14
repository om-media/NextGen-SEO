import type { AppDatabase } from '../database.js';
import { canAccessGa4Property, canAccessSite } from '../accessControl.js';
import { googleApiFetchJson } from './googleAuth.js';

export type WorkspaceGa4Mapping = {
  displayName?: string | null;
  ownerId: string;
  propertyId: string;
  propertyCreatedAt?: string | null;
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
    INSERT INTO workspace_ga4_mappings (ownerId, siteUrl, propertyId, displayName, propertyCreatedAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ownerId, siteUrl) DO UPDATE SET
      propertyId = excluded.propertyId,
      displayName = CASE
        WHEN workspace_ga4_mappings.propertyId = excluded.propertyId
          THEN COALESCE(excluded.displayName, workspace_ga4_mappings.displayName)
        ELSE excluded.displayName
      END,
      propertyCreatedAt = CASE
        WHEN workspace_ga4_mappings.propertyId = excluded.propertyId
          THEN COALESCE(excluded.propertyCreatedAt, workspace_ga4_mappings.propertyCreatedAt)
        ELSE excluded.propertyCreatedAt
      END,
      updatedAt = excluded.updatedAt
  `, [mapping.ownerId, siteUrl, propertyId, mapping.displayName || null, mapping.propertyCreatedAt || null, nowIso()]);
}

export async function ensureWorkspaceGa4PropertyMetadata(db: AppDatabase, mapping: WorkspaceGa4Mapping) {
  const siteUrl = mapping.siteUrl.trim();
  const propertyId = mapping.propertyId.trim();
  const existing = await db.get<{ propertyCreatedAt?: string | null }>(
    'SELECT propertyCreatedAt FROM workspace_ga4_mappings WHERE ownerId = ? AND siteUrl = ? AND propertyId = ? LIMIT 1',
    [mapping.ownerId, siteUrl, propertyId],
  );
  if (existing?.propertyCreatedAt) return existing.propertyCreatedAt;
  if (!/^properties\/\d+$/.test(propertyId)) return null;

  const property = await googleApiFetchJson(
    db,
    mapping.ownerId,
    `https://analyticsadmin.googleapis.com/v1beta/${propertyId}`,
  );
  const propertyCreatedAt = typeof property?.createTime === 'string' && Number.isFinite(Date.parse(property.createTime))
    ? property.createTime
    : null;
  await upsertWorkspaceGa4Mapping(db, {
    ...mapping,
    displayName: mapping.displayName || (typeof property?.displayName === 'string' ? property.displayName : null),
    propertyCreatedAt,
    siteUrl,
  });
  return propertyCreatedAt;
}

export async function resolveWorkspaceGa4PropertyStartDate(db: AppDatabase, ownerId: string, siteUrl: string, propertyId: string) {
  const mapping = await db.get<{ propertyCreatedAt?: string | null }>(
    'SELECT propertyCreatedAt FROM workspace_ga4_mappings WHERE ownerId = ? AND siteUrl = ? AND propertyId = ? LIMIT 1',
    [ownerId, siteUrl.trim(), propertyId.trim()],
  );
  const createdAt = typeof mapping?.propertyCreatedAt === 'string' ? mapping.propertyCreatedAt : '';
  return Number.isFinite(Date.parse(createdAt)) ? createdAt.slice(0, 10) : null;
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
