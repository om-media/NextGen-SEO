export type SiteLike = {
  siteUrl: string;
  displayName?: string;
  permissionLevel?: string;
};

export type DashboardDataSource = "gsc" | "bing" | "ga4" | "blended";
export type PersistedSelectionSource = "gsc" | "bing" | "ga4";

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function cleanSiteIdentity(url: string) {
  return url
    ?.trim()
    .replace(/^(https?:\/\/|sc-domain:)/i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
    .toLowerCase() || '';
}

export function getSelectionPersistenceSource(dataSource: DashboardDataSource): PersistedSelectionSource {
  if (dataSource === "ga4") {
    return "ga4";
  }
  if (dataSource === "bing") {
    return "bing";
  }
  return "gsc";
}

export function legacySelectedSiteCacheKey(userId: string) {
  return `selected_site_cache:${userId}`;
}

export function selectedSiteCacheKey(userId: string, source: PersistedSelectionSource) {
  return `selected_site_cache:${source}:${userId}`;
}

export function legacySelectedGa4PropertyCacheKey(userId: string) {
  return `selected_ga4_property_cache:${userId}`;
}

export function selectedGa4PropertyCacheKey(userId: string, siteUrl: string) {
  return `selected_ga4_property_cache:${userId}:${encodeURIComponent(siteUrl || "__global__")}`;
}

export function getProfileWorkspaceSites(
  activatedSiteUrl?: string | null,
  unlockedSites: string[] = [],
  knownSites: string[] = [],
) {
  return Array.from(new Set([
    activatedSiteUrl || "",
    ...unlockedSites,
    ...knownSites,
  ].filter(Boolean)));
}

export function readCachedSiteSelection({
  dataSource,
  fallbackSite,
  knownWorkspaceSites,
  storage,
  userId,
}: {
  dataSource: DashboardDataSource;
  fallbackSite: string;
  knownWorkspaceSites: string[];
  storage: StorageLike;
  userId: string;
}) {
  const persistenceSource = getSelectionPersistenceSource(dataSource);
  const scopedCache = storage.getItem(selectedSiteCacheKey(userId, persistenceSource)) || "";
  const legacyCache = persistenceSource === "gsc"
    ? storage.getItem(legacySelectedSiteCacheKey(userId)) || ""
    : "";
  const cachedSite = scopedCache || legacyCache;
  const isKnown = cachedSite && knownWorkspaceSites.includes(cachedSite);

  if (cachedSite && !isKnown) {
    storage.removeItem(selectedSiteCacheKey(userId, persistenceSource));
    if (persistenceSource === "gsc") {
      storage.removeItem(legacySelectedSiteCacheKey(userId));
    }
  }

  return isKnown ? cachedSite : fallbackSite;
}

export function normalizeSiteMatchText(value: string) {
  return value
    .toLowerCase()
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function getWorkspaceSiteMatchCandidates(workspaceSite: string) {
  const normalized = normalizeSiteMatchText(workspaceSite);
  if (!normalized) {
    return [];
  }

  const host = workspaceSite
    .toLowerCase()
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  const hostParts = host.split(".").filter(Boolean);
  const registrableName = hostParts.length > 2 && hostParts[hostParts.length - 2] === "co"
    ? hostParts.slice(0, -2).join("")
    : hostParts.slice(0, -1).join("");

  return Array.from(new Set([
    normalized,
    normalizeSiteMatchText(registrableName),
  ].filter((candidate) => candidate.length >= 8)));
}

export function isGa4PropertyForWorkspaceSite(site: SiteLike, workspaceSite: string) {
  const candidates = getWorkspaceSiteMatchCandidates(workspaceSite);
  if (candidates.length === 0) {
    return false;
  }

  const propertyLabel = normalizeSiteMatchText(`${site.siteUrl} ${site.displayName || ""}`);
  return candidates.some((candidate) => propertyLabel.includes(candidate));
}

export function getGa4PropertyForWorkspaceSite(availableSites: SiteLike[], workspaceSite: string) {
  return availableSites.find((site) => isGa4PropertyForWorkspaceSite(site, workspaceSite))?.siteUrl || "";
}

export function getPreferredGa4PropertyId(
  availableSites: SiteLike[],
  options: {
    activatedGa4PropertyId?: string | null;
    activatedSiteUrl?: string | null;
    allowUnscopedPreference?: boolean;
    currentPreference?: string;
    currentPreferenceSite?: string;
    workspaceSite: string;
  },
) {
  const {
    activatedGa4PropertyId,
    activatedSiteUrl,
    allowUnscopedPreference = false,
    currentPreference = "",
    currentPreferenceSite = "",
    workspaceSite,
  } = options;

  if (
    currentPreference &&
    (allowUnscopedPreference || currentPreferenceSite === workspaceSite) &&
    availableSites.some((site) => site.siteUrl === currentPreference)
  ) {
    return currentPreference;
  }

  const savedDefaultSite = activatedGa4PropertyId
    ? availableSites.find((site) => site.siteUrl === activatedGa4PropertyId)
    : null;
  if (
    workspaceSite &&
    workspaceSite === activatedSiteUrl &&
    savedDefaultSite &&
    isGa4PropertyForWorkspaceSite(savedDefaultSite, workspaceSite)
  ) {
    return activatedGa4PropertyId || "";
  }

  return getGa4PropertyForWorkspaceSite(availableSites, workspaceSite);
}

export function getWorkspaceSiteForGa4Property(
  propertyId: string,
  preferredWorkspaceSite: string,
  availableGa4Sites: SiteLike[],
  availableWorkspaceSites: SiteLike[],
) {
  const property = availableGa4Sites.find((site) => site.siteUrl === propertyId);
  if (!property) {
    return preferredWorkspaceSite;
  }

  if (preferredWorkspaceSite && isGa4PropertyForWorkspaceSite(property, preferredWorkspaceSite)) {
    return preferredWorkspaceSite;
  }

  const matchingWorkspaceSite = availableWorkspaceSites.find((site) =>
    isGa4PropertyForWorkspaceSite(property, site.siteUrl),
  );
  if (matchingWorkspaceSite?.siteUrl) {
    return matchingWorkspaceSite.siteUrl;
  }

  const labelMatch = findMatchingSite(property.displayName || property.siteUrl, availableWorkspaceSites, availableGa4Sites);
  return labelMatch?.siteUrl || preferredWorkspaceSite;
}

export function resolveSourceSwitchSelection({
  activatedGa4PropertyId,
  activatedSiteUrl,
  availableGa4Sites,
  availableWorkspaceSites,
  currentSelectedGa4Property,
  currentSelectedGa4PropertySite,
  currentSelectedSite,
  knownWorkspaceSites,
  nextSource,
  storage,
  userId,
}: {
  activatedGa4PropertyId?: string | null;
  activatedSiteUrl?: string | null;
  availableGa4Sites: SiteLike[];
  availableWorkspaceSites: SiteLike[];
  currentSelectedGa4Property: string;
  currentSelectedGa4PropertySite: string;
  currentSelectedSite: string;
  knownWorkspaceSites: string[];
  nextSource: DashboardDataSource;
  storage?: StorageLike | null;
  userId?: string | null;
}) {
  const fallbackSite = getPreferredSiteUrl(
    activatedSiteUrl || currentSelectedSite,
    availableWorkspaceSites,
    knownWorkspaceSites,
    undefined,
    availableGa4Sites,
  );
  const nextSelectedSite = userId && storage
    ? readCachedSiteSelection({
      dataSource: nextSource,
      fallbackSite: fallbackSite || currentSelectedSite,
      knownWorkspaceSites,
      storage,
      userId,
    })
    : (fallbackSite || currentSelectedSite);

  if (nextSource !== "ga4") {
    return {
      selectedGa4Property: currentSelectedGa4Property,
      selectedGa4PropertySite: currentSelectedGa4PropertySite,
      selectedSite: nextSelectedSite,
    };
  }

  const cachedProperty = userId && storage && nextSelectedSite
    ? storage.getItem(selectedGa4PropertyCacheKey(userId, nextSelectedSite)) || ""
    : "";

  return {
    selectedGa4Property: getPreferredGa4PropertyId(availableGa4Sites, {
      activatedGa4PropertyId,
      activatedSiteUrl,
      allowUnscopedPreference: Boolean(cachedProperty),
      currentPreference: cachedProperty || currentSelectedGa4Property,
      currentPreferenceSite: cachedProperty ? nextSelectedSite : currentSelectedGa4PropertySite,
      workspaceSite: nextSelectedSite,
    }),
    selectedGa4PropertySite: nextSelectedSite,
    selectedSite: nextSelectedSite,
  };
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
      if (displayClean === targetClean) {
        return true;
      }
    }

    return false;
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
  if (match) {
    return match.siteUrl;
  }

  const firstUnlocked = availableSites.find((site) => unlockedSites.includes(site.siteUrl));
  return firstUnlocked?.siteUrl || availableSites[0]?.siteUrl || '';
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
