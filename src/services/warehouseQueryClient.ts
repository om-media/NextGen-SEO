import { authFetch } from "@/src/lib/authFetch";

const CACHE_TTL_MS = 90_000;
const MAX_CACHE_ENTRIES = 80;

type CacheEntry = {
  expiresAt: number;
  promise: Promise<unknown>;
};

const warehouseQueryCache = new Map<string, CacheEntry>();

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function trimCache() {
  const now = Date.now();
  for (const [key, entry] of warehouseQueryCache) {
    if (entry.expiresAt <= now) warehouseQueryCache.delete(key);
  }

  while (warehouseQueryCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = warehouseQueryCache.keys().next().value;
    if (!oldestKey) break;
    warehouseQueryCache.delete(oldestKey);
  }
}

export async function fetchCachedWarehouseQuery<T = unknown>(
  body: Record<string, unknown>,
  cacheKeyExtra = "",
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  trimCache();

  const key = `${cacheKeyExtra}:${stableStringify(body)}`;
  if (options.signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const cached = warehouseQueryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise as Promise<T>;
  }

  const promise = authFetch("/api/warehouse/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  }).then(async (response) => {
    if (!response.ok) {
      warehouseQueryCache.delete(key);
      throw new Error("Failed to fetch warehouse data");
    }

    return response.json() as Promise<T>;
  }).catch((error) => {
    warehouseQueryCache.delete(key);
    throw error;
  });

  warehouseQueryCache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    promise,
  });

  return promise;
}
