import fs from 'node:fs/promises';
import path from 'node:path';

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function createSeededRng(seed) {
  let state = Number(seed) >>> 0;
  if (!state) state = 0x6d2b79f5;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function pickOne(values, rng) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const index = Math.floor(rng() * values.length);
  return values[index];
}

export function toIsoDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date.toISOString().slice(0, 10);
}

export function addIsoDays(isoDate, deltaDays) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date: ${isoDate}`);
  }
  date.setUTCDate(date.getUTCDate() + Number(deltaDays || 0));
  return toIsoDate(date);
}

export function resolveDateRange(days, endDate = new Date()) {
  const safeDays = Math.max(1, Number(days || 1));
  const end = toIsoDate(endDate);
  const start = addIsoDays(end, -(safeDays - 1));
  return { startDate: start, endDate: end };
}

export function percentile(values, point) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const p = clamp(Number(point), 0, 100) / 100;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function summarizeDurations(values) {
  const samples = [...(values || [])].filter(Number.isFinite);
  return {
    count: samples.length,
    p50Ms: samples.length ? Number(percentile(samples, 50).toFixed(2)) : null,
    p95Ms: samples.length ? Number(percentile(samples, 95).toFixed(2)) : null,
    p99Ms: samples.length ? Number(percentile(samples, 99).toFixed(2)) : null,
    maxMs: samples.length ? Number(Math.max(...samples).toFixed(2)) : null,
    minMs: samples.length ? Number(Math.min(...samples).toFixed(2)) : null,
  };
}

export function jainFairnessIndex(values) {
  const samples = [...(values || [])].filter((value) => Number.isFinite(value) && value >= 0);
  if (!samples.length) return 0;
  const sum = samples.reduce((total, value) => total + value, 0);
  const sumSquares = samples.reduce((total, value) => total + value * value, 0);
  if (!sum || !sumSquares) return 0;
  return Number(((sum * sum) / (samples.length * sumSquares)).toFixed(4));
}

export function parseDurationMs(value, fallbackMs) {
  if (value === undefined || value === null || value === '') return fallbackMs;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = String(value).trim().toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)(ms|s|m)$/);
  if (!match) {
    throw new Error(`Invalid duration value: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === 'ms') return amount;
  if (unit === 's') return amount * 1000;
  return amount * 60_000;
}

export function formatMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return 'n/a';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(2)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

export function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) {
      result._.push(current);
      continue;
    }

    const withoutPrefix = current.slice(2);
    const [rawKey, inlineValue] = withoutPrefix.split('=', 2);
    if (!rawKey) continue;

    if (inlineValue !== undefined) {
      result[rawKey] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[rawKey] = true;
      continue;
    }

    result[rawKey] = next;
    index += 1;
  }

  return result;
}

export async function readJsonFile(filePath) {
  const contents = await fs.readFile(filePath, 'utf8');
  return JSON.parse(contents);
}

export async function writeJsonFile(filePath, value) {
  const targetPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function runWithConcurrency(limit, items, worker) {
  const safeLimit = Math.max(1, Number(limit || 1));
  const results = new Array(items.length);
  let cursor = 0;

  async function consume() {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= items.length) break;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, () => consume()));
  return results;
}

export function mergeConfig(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    return extra === undefined ? base : extra;
  }

  const output = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = mergeConfig(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function normalizeUrlBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}
