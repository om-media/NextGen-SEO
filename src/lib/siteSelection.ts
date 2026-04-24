export type SiteLike = {
  siteUrl: string;
  displayName?: string;
  permissionLevel?: string;
};

function cleanSiteIdentity(url: string) {
  return url?.replace(/^(https?:\/\/|sc-domain:)/, '').replace(/\/$/, '').toLowerCase() || '';
}

export function findMatchingSite(targetUrl: string, availableSites: SiteLike[], ga4Sites: SiteLike[] = []) {
  if (!targetUrl) {
    return null;
  }

  let targetClean = cleanSiteIdentity(targetUrl);

  if (targetUrl.startsWith('properties/')) {
    const ga4Match = ga4Sites.find((site) => site.siteUrl === targetUrl);
    if (ga4Match?.displayName) {
      targetClean = cleanSiteIdentity(ga4Match.displayName);
    }
  }

  const exactMatch = availableSites.find((site) => site.siteUrl === targetUrl);
  if (exactMatch) {
    return exactMatch;
  }

  return availableSites.find((site) => {
    const siteClean = cleanSiteIdentity(site.siteUrl);
    if (siteClean === targetClean) {
      return true;
    }

    if (site.displayName) {
      const displayClean = cleanSiteIdentity(site.displayName);
      if (displayClean.includes(targetClean) || targetClean.includes(displayClean)) {
        return true;
      }
    }

    return siteClean.includes(targetClean) || targetClean.includes(siteClean);
  }) || null;
}

export function getPreferredSiteUrl(
  selectedSite: string,
  availableSites: SiteLike[],
  unlockedSites: string[],
  tier?: string,
  ga4Sites: SiteLike[] = [],
) {
  if (availableSites.length === 0) {
    return '';
  }

  const match = findMatchingSite(selectedSite, availableSites, ga4Sites);
  const matchIsAccessible = Boolean(match) && (tier === 'enterprise' || unlockedSites.includes(match.siteUrl));
  if (match && matchIsAccessible) {
    return match.siteUrl;
  }

  const firstUnlocked = availableSites.find((site) => tier === 'enterprise' || unlockedSites.includes(site.siteUrl));
  if (tier === 'enterprise') {
    return firstUnlocked?.siteUrl || availableSites[0]?.siteUrl || '';
  }

  return firstUnlocked?.siteUrl || '';
}

export function mergeUniqueSites<T extends SiteLike>(existingSites: T[], incomingSites: T[]) {
  const merged = [...existingSites];
  for (const site of incomingSites) {
    if (!merged.some((existing) => existing.siteUrl === site.siteUrl)) {
      merged.push(site);
    }
  }
  return merged;
}
