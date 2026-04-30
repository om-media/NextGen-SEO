export function canonicalPageKey(value: string, siteUrl?: string) {
  const rawValue = String(value || '').trim();
  if (!rawValue) return '/';

  const parseUrl = (candidate: string) => {
    try {
      return new URL(candidate);
    } catch {
      return null;
    }
  };

  const absolute = parseUrl(rawValue);
  if (absolute) {
    return normalizePath(absolute.pathname);
  }

  if (siteUrl && /^https?:\/\//i.test(siteUrl)) {
    try {
      return normalizePath(new URL(rawValue, siteUrl).pathname);
    } catch {
      // Fall through to path normalization.
    }
  }

  const withoutQuery = rawValue.split('#')[0].split('?')[0];
  return normalizePath(withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`);
}

function normalizePath(path: string) {
  const trimmed = String(path || '').trim().split('#')[0].split('?')[0] || '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}
