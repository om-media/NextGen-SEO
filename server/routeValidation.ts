import { isIsoDateString } from './validation.js';

export type BoundedIntegerResult =
  | { ok: true; value: number }
  | { ok: false };

export function parseBoundedInteger(
  value: unknown,
  options: { defaultValue: number; max: number; min: number },
): BoundedIntegerResult {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: options.defaultValue };
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    return { ok: false };
  }

  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    return { ok: false };
  }

  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < options.min
    || parsed > options.max
  ) {
    return { ok: false };
  }

  return { ok: true, value: parsed };
}

export function isValidIsoDateRange(startDate: unknown, endDate: unknown) {
  return isIsoDateString(startDate)
    && isIsoDateString(endDate)
    && startDate <= endDate;
}

export function isValidOptionalIsoDateRange(startDate: unknown, endDate: unknown) {
  if (startDate !== undefined && !isIsoDateString(startDate)) return false;
  if (endDate !== undefined && !isIsoDateString(endDate)) return false;
  return startDate === undefined || endDate === undefined || startDate <= endDate;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
}
