import crypto from 'node:crypto';
import type { AppDatabase } from '../database.js';

export type SiteScopeSourceRecord = {
  createdAt: string | null;
  propertyId: string | null;
  siteScopeId: string;
  siteUrl: string | null;
  sourceKey: string;
  sourceType: string;
  updatedAt: string | null;
};

export type SiteScopeRecord = {
  canonicalDomain: string;
  createdAt: string | null;
  id: string;
  ownerId: string;
  updatedAt: string | null;
};

export type EnsureSiteScopeInput = {
  ownerId: string;
  propertyId?: string | null;
  siteUrl?: string | null;
  sourceKey?: string | null;
  sourceType?: string | null;
};

export type EnsureSiteScopeResult = {
  canonicalDomain: string;
  scope: SiteScopeRecord;
  sources: SiteScopeSourceRecord[];
};

const ensuredDatabases = new WeakSet<object>();

function nowIso() {
  return new Date().toISOString();
}

function hashScopeId(ownerId: string, canonicalDomain: string) {
  return `scope_${crypto.createHash('sha256').update(`${ownerId}\n${canonicalDomain}`).digest('hex').slice(0, 24)}`;
}

function normalizeText(value: unknown) {
  return String(value ?? '').trim();
}

function stripWww(value: string) {
  return value.replace(/^www\./i, '').toLowerCase();
}

function normalizeSourceType(value: unknown) {
  return normalizeText(value || 'workspace-site').toLowerCase() || 'workspace-site';
}

function maybeHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return /^https?:$/i.test(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeUrlValue(value: unknown): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  const parsed = maybeHttpUrl(raw);
  if (!parsed) return null;
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  if (!parsed.pathname) parsed.pathname = '/';
  return parsed.toString();
}

function normalizeDomainValue(value: unknown): string | null {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return null;
  if (raw.startsWith('sc-domain:')) {
    const domain = stripWww(raw.slice('sc-domain:'.length));
    return domain || null;
  }
  const parsed = maybeHttpUrl(raw);
  if (parsed) return stripWww(parsed.hostname);
  const host = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? stripWww(host) : null;
}

function normalizeStoredSiteUrl(value: unknown, canonicalDomain: string | null) {
  const raw = normalizeText(value);
  const normalizedUrl = normalizeUrlValue(raw);
  if (normalizedUrl) return normalizedUrl;
  if (raw.toLowerCase().startsWith('sc-domain:')) {
    return canonicalDomain ? `sc-domain:${canonicalDomain}` : raw.toLowerCase();
  }
  return raw || null;
}

function normalizeSourceKey(input: { canonicalDomain: string | null; propertyId: string | null; siteUrl: string | null; sourceKey: string | null; sourceType: string }) {
  const raw = normalizeText(input.sourceKey);
  if (input.sourceType === 'ga4-property') {
    return normalizeText(input.propertyId || raw) || null;
  }
  if (raw.toLowerCase().startsWith('sc-domain:')) {
    return input.canonicalDomain ? `sc-domain:${input.canonicalDomain}` : raw.toLowerCase();
  }
  const normalizedUrl = normalizeUrlValue(raw);
  if (normalizedUrl) return normalizedUrl;
  if (raw && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) return stripWww(raw);
  if (raw) return raw;
  if (input.sourceType === 'ga4-property') return normalizeText(input.propertyId) || null;
  if (input.siteUrl) return input.siteUrl;
  return input.canonicalDomain ? `sc-domain:${input.canonicalDomain}` : null;
}

function normalizeInput(input: EnsureSiteScopeInput) {
  const sourceType = normalizeSourceType(input.sourceType);
  const rawSiteUrl = normalizeText(input.siteUrl) || null;
  const siteUrl = normalizeStoredSiteUrl(rawSiteUrl, null);
  const propertyId = normalizeText(input.propertyId) || null;
  const canonicalDomain =
    normalizeDomainValue(input.sourceKey) ||
    normalizeDomainValue(siteUrl) ||
    normalizeDomainValue(rawSiteUrl) ||
    normalizeDomainValue(propertyId);
  const storedSiteUrl = normalizeStoredSiteUrl(rawSiteUrl, canonicalDomain);
  const sourceKey = normalizeSourceKey({
    canonicalDomain,
    propertyId,
    siteUrl: storedSiteUrl,
    sourceKey: normalizeText(input.sourceKey) || null,
    sourceType,
  });
  return {
    canonicalDomain,
    ownerId: normalizeText(input.ownerId),
    propertyId,
    siteUrl: storedSiteUrl,
    sourceKey,
    sourceType,
  };
}

async function ensureSiteScopeSchema(db: AppDatabase) {
  if (ensuredDatabases.has(db as object)) return;
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_site_scopes_owner_domain_unique_runtime
    ON site_scopes(ownerId, canonicalDomain)
  `);
  ensuredDatabases.add(db as object);
}

async function loadScopeWithSources(db: AppDatabase, siteScopeId: string): Promise<EnsureSiteScopeResult> {
  const scope = await db.get<SiteScopeRecord>(
    `SELECT id, ownerId, canonicalDomain, createdAt, updatedAt FROM site_scopes WHERE id = ? LIMIT 1`,
    [siteScopeId],
  );
  if (!scope) throw new Error(`Logical site scope ${siteScopeId} no longer exists.`);
  const sources = await db.all<SiteScopeSourceRecord>(
    `SELECT siteScopeId, sourceType, sourceKey, siteUrl, propertyId, createdAt, updatedAt
     FROM site_scope_sources
     WHERE siteScopeId = ?
     ORDER BY sourceType ASC, sourceKey ASC`,
    [siteScopeId],
  );
  return { canonicalDomain: scope.canonicalDomain, scope, sources };
}

export async function resolveSiteScopeBySiteUrl(db: AppDatabase, ownerId: string, siteUrl: string) {
  await ensureSiteScopeSchema(db);
  const normalizedSiteUrl = normalizeStoredSiteUrl(siteUrl, normalizeDomainValue(siteUrl));
  const canonicalDomain = normalizeDomainValue(normalizedSiteUrl || siteUrl);
  const scope = await db.get<SiteScopeRecord>(
    `SELECT scopes.id, scopes.ownerId, scopes.canonicalDomain, scopes.createdAt, scopes.updatedAt
     FROM site_scopes scopes
     LEFT JOIN site_scope_sources sources ON sources.siteScopeId = scopes.id
     WHERE scopes.ownerId = ?
       AND (sources.siteUrl = ? OR scopes.canonicalDomain = ?)
     ORDER BY CASE WHEN sources.siteUrl = ? THEN 0 ELSE 1 END,
              COALESCE(scopes.updatedAt, scopes.createdAt) DESC,
              scopes.id ASC
     LIMIT 1`,
    [ownerId, normalizedSiteUrl, canonicalDomain, normalizedSiteUrl],
  );
  return scope ? loadScopeWithSources(db, scope.id) : null;
}

export async function ensureSiteScope(db: AppDatabase, input: EnsureSiteScopeInput): Promise<EnsureSiteScopeResult> {
  await ensureSiteScopeSchema(db);
  const normalized = normalizeInput(input);
  if (!normalized.ownerId) throw new Error('ownerId is required to resolve a logical site scope.');
  if (!normalized.canonicalDomain) throw new Error('Unable to derive a canonical domain for this site scope.');

  const stableId = hashScopeId(normalized.ownerId, normalized.canonicalDomain);
  const persistedId = await db.transaction(async () => {
    const mapping = normalized.sourceKey
      ? await db.get<{ id: string }>(
          `SELECT scopes.id
           FROM site_scope_sources sources
           JOIN site_scopes scopes ON scopes.id = sources.siteScopeId
           WHERE scopes.ownerId = ? AND sources.sourceType = ? AND sources.sourceKey = ?
           LIMIT 1`,
          [normalized.ownerId, normalized.sourceType, normalized.sourceKey],
        )
      : undefined;

    const existingByDomain = await db.get<{ id: string }>(
      `SELECT id FROM site_scopes WHERE ownerId = ? AND canonicalDomain = ? LIMIT 1`,
      [normalized.ownerId, normalized.canonicalDomain],
    );

    const siteScopeId = mapping?.id || existingByDomain?.id || stableId;
    const stamp = nowIso();

    await db.run(
      `INSERT INTO site_scopes (id, ownerId, canonicalDomain, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ownerId = excluded.ownerId,
         canonicalDomain = excluded.canonicalDomain,
         updatedAt = excluded.updatedAt`,
      [siteScopeId, normalized.ownerId, normalized.canonicalDomain, stamp, stamp],
    );

    const mappings = new Map<string, { propertyId: string | null; siteUrl: string | null; sourceKey: string; sourceType: string }>();
    if (normalized.sourceKey) {
      mappings.set(`${normalized.sourceType}::${normalized.sourceKey}`, {
        propertyId: normalized.propertyId,
        siteUrl: normalized.siteUrl,
        sourceKey: normalized.sourceKey,
        sourceType: normalized.sourceType,
      });
    }
    if (normalized.siteUrl) {
      mappings.set(`workspace-site::${normalized.siteUrl}`, {
        propertyId: normalized.propertyId,
        siteUrl: normalized.siteUrl,
        sourceKey: normalized.siteUrl,
        sourceType: 'workspace-site',
      });
      mappings.set(`crawl-site::${normalized.siteUrl}`, {
        propertyId: normalized.propertyId,
        siteUrl: normalized.siteUrl,
        sourceKey: normalized.siteUrl,
        sourceType: 'crawl-site',
      });
    }
    mappings.set(`gsc-site::${normalized.canonicalDomain}`, {
      propertyId: normalized.propertyId,
      siteUrl: `sc-domain:${normalized.canonicalDomain}`,
      sourceKey: `sc-domain:${normalized.canonicalDomain}`,
      sourceType: 'gsc-site',
    });

    for (const mappingEntry of mappings.values()) {
      await db.run(
        `DELETE FROM site_scope_sources
         WHERE sourceType = ? AND sourceKey = ? AND siteScopeId IN (
           SELECT id FROM site_scopes WHERE ownerId = ? AND id <> ?
         )`,
        [mappingEntry.sourceType, mappingEntry.sourceKey, normalized.ownerId, siteScopeId],
      );

      await db.run(
        `INSERT INTO site_scope_sources (siteScopeId, sourceType, sourceKey, siteUrl, propertyId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(siteScopeId, sourceType, sourceKey) DO UPDATE SET
           siteUrl = excluded.siteUrl,
           propertyId = excluded.propertyId,
           updatedAt = excluded.updatedAt`,
        [
          siteScopeId,
          mappingEntry.sourceType,
          mappingEntry.sourceKey,
          mappingEntry.siteUrl,
          mappingEntry.propertyId,
          stamp,
          stamp,
        ],
      );
    }

    return siteScopeId;
  })();

  return loadScopeWithSources(db, persistedId);
}
