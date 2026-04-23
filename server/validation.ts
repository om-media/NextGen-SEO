export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isIsoDateString(value: unknown): value is string {
  return isNonEmptyString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function asTrimmedString(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function hasValidMetricRows(rows: unknown, minKeys: number) {
  return Array.isArray(rows) && rows.every((row) => {
    if (!row || typeof row !== 'object') {
      return false;
    }

    const candidate = row as {
      keys?: unknown;
      clicks?: unknown;
      impressions?: unknown;
      ctr?: unknown;
      position?: unknown;
    };

    return Array.isArray(candidate.keys)
      && candidate.keys.length >= minKeys
      && typeof candidate.clicks === 'number'
      && typeof candidate.impressions === 'number'
      && typeof candidate.ctr === 'number'
      && typeof candidate.position === 'number';
  });
}

export function isValidWarehouseDimensions(value: unknown): value is string[] {
  const validDimensions = new Set(['date', 'query', 'page']);
  return isStringArray(value) && value.every((dimension) => validDimensions.has(dimension));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateDimensionFilterGroups(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((group) => {
    if (!isPlainObject(group)) {
      return false;
    }

    const filters = group.filters;
    if (filters === undefined) {
      return true;
    }

    return Array.isArray(filters) && filters.every((filter) => {
      if (!isPlainObject(filter)) {
        return false;
      }

      const dimension = filter.dimension;
      const operator = filter.operator;
      const expression = filter.expression;

      return typeof dimension === 'string'
        && typeof operator === 'string'
        && (expression === undefined || typeof expression === 'string');
    });
  });
}

export function isAllowedAnnotationType(value: unknown): value is 'user' | 'system' {
  return value === 'user' || value === 'system';
}

export function isAllowedDevice(value: unknown): value is 'desktop' | 'mobile' | 'tablet' {
  return value === 'desktop' || value === 'mobile' || value === 'tablet';
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
