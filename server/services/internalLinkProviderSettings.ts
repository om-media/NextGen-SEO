import type { AppDatabase } from '../database.js';
import { decryptSecret, encryptSecret, maskSecret } from './secretStorage.js';

const ALLOWED_INTERNAL_LINK_PROVIDERS = new Set([
  'anthropic',
  'cohere',
  'gemini',
  'jina',
  'local',
  'ollama',
  'openai',
  'openrouter',
  'voyage',
]);

type ProviderSettingsRow = {
  apiKeyEncrypted?: string | null;
  baseUrl?: string | null;
  createdAt?: string | null;
  embeddingModel?: string | null;
  enabled?: number | boolean | null;
  ownerId: string;
  provider: string;
  reviewModel?: string | null;
  updatedAt?: string | null;
};

export type InternalLinkProviderSettingsInput = {
  apiKey?: string | null;
  baseUrl?: string | null;
  clearApiKey?: boolean;
  embeddingModel?: string | null;
  enabled?: boolean;
  reviewModel?: string | null;
};

function normalizeText(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeInternalLinkProvider(value: unknown) {
  const provider = normalizeText(value).toLowerCase();
  if (!provider || !ALLOWED_INTERNAL_LINK_PROVIDERS.has(provider)) {
    throw new Error('Unsupported internal link provider.');
  }
  return provider;
}

function sanitizeUrl(value: unknown) {
  const text = normalizeText(value);
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) {
    throw new Error('Provider baseUrl must start with http:// or https://.');
  }
  return text.replace(/\/+$/, '');
}

function sanitizeModel(value: unknown) {
  const text = normalizeText(value);
  return text || null;
}

function apiKeyPreview(encrypted: string | null) {
  if (!encrypted) return null;
  try {
    return maskSecret(decryptSecret(encrypted));
  } catch {
    return 'stored';
  }
}

function serializeProviderSettings(row: ProviderSettingsRow) {
  const encrypted = row.apiKeyEncrypted || null;
  return {
    apiKeyPreview: apiKeyPreview(encrypted),
    baseUrl: row.baseUrl || null,
    createdAt: row.createdAt || null,
    embeddingModel: row.embeddingModel || null,
    enabled: row.enabled === null || row.enabled === undefined ? true : Boolean(row.enabled),
    hasApiKey: Boolean(encrypted),
    provider: row.provider,
    reviewModel: row.reviewModel || null,
    updatedAt: row.updatedAt || null,
  };
}

export async function listInternalLinkProviderSettings(db: AppDatabase, ownerId: string) {
  const rows = await db.all<ProviderSettingsRow>(`
    SELECT ownerId, provider, apiKeyEncrypted, baseUrl, embeddingModel, reviewModel, enabled, createdAt, updatedAt
    FROM internal_link_provider_settings
    WHERE ownerId = ?
    ORDER BY provider ASC
  `, [ownerId]);
  return rows.map(serializeProviderSettings);
}

export async function upsertInternalLinkProviderSettings(db: AppDatabase, ownerId: string, providerInput: unknown, input: InternalLinkProviderSettingsInput) {
  const provider = normalizeInternalLinkProvider(providerInput);
  const now = new Date().toISOString();
  const current = await db.get<ProviderSettingsRow>(`
    SELECT ownerId, provider, apiKeyEncrypted, baseUrl, embeddingModel, reviewModel, enabled, createdAt, updatedAt
    FROM internal_link_provider_settings
    WHERE ownerId = ? AND provider = ?
  `, [ownerId, provider]);

  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const apiKeyEncrypted = input.clearApiKey
    ? null
    : apiKey
      ? encryptSecret(apiKey)
      : current?.apiKeyEncrypted || null;
  const baseUrl = input.baseUrl === undefined ? current?.baseUrl || null : sanitizeUrl(input.baseUrl);
  const embeddingModel = input.embeddingModel === undefined ? current?.embeddingModel || null : sanitizeModel(input.embeddingModel);
  const reviewModel = input.reviewModel === undefined ? current?.reviewModel || null : sanitizeModel(input.reviewModel);
  const enabled = input.enabled === undefined ? (current?.enabled === null || current?.enabled === undefined ? true : Boolean(current.enabled)) : Boolean(input.enabled);

  await db.run(`
    INSERT INTO internal_link_provider_settings (
      ownerId, provider, apiKeyEncrypted, baseUrl, embeddingModel, reviewModel, enabled, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ownerId, provider) DO UPDATE SET
      apiKeyEncrypted=excluded.apiKeyEncrypted,
      baseUrl=excluded.baseUrl,
      embeddingModel=excluded.embeddingModel,
      reviewModel=excluded.reviewModel,
      enabled=excluded.enabled,
      updatedAt=excluded.updatedAt
  `, [ownerId, provider, apiKeyEncrypted, baseUrl, embeddingModel, reviewModel, enabled ? 1 : 0, current?.createdAt || now, now]);

  const saved = await db.get<ProviderSettingsRow>(`
    SELECT ownerId, provider, apiKeyEncrypted, baseUrl, embeddingModel, reviewModel, enabled, createdAt, updatedAt
    FROM internal_link_provider_settings
    WHERE ownerId = ? AND provider = ?
  `, [ownerId, provider]);
  return saved ? serializeProviderSettings(saved) : null;
}

export async function deleteInternalLinkProviderSettings(db: AppDatabase, ownerId: string, providerInput: unknown) {
  const provider = normalizeInternalLinkProvider(providerInput);
  const result = await db.run('DELETE FROM internal_link_provider_settings WHERE ownerId = ? AND provider = ?', [ownerId, provider]);
  return { deleted: result.changes > 0, provider };
}
export async function getInternalLinkProviderSettings(db: AppDatabase, ownerId: string, providerInput: unknown) {
  const provider = normalizeInternalLinkProvider(providerInput);
  const row = await db.get<ProviderSettingsRow>(`
    SELECT ownerId, provider, apiKeyEncrypted, baseUrl, embeddingModel, reviewModel, enabled, createdAt, updatedAt
    FROM internal_link_provider_settings
    WHERE ownerId = ? AND provider = ?
  `, [ownerId, provider]);
  if (!row) return null;
  return {
    ...serializeProviderSettings(row),
    apiKey: row.apiKeyEncrypted ? decryptSecret(row.apiKeyEncrypted) : null,
  };
}
