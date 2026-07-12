import assert from "node:assert/strict";

import {
  getProfileWorkspaceSites,
  getWorkspaceSiteForGa4Property,
  readCachedSiteSelection,
  resolveSourceSwitchSelection,
  selectedGa4PropertyCacheKey,
  selectedSiteCacheKey,
  type SiteLike,
} from "./siteSelection";

class MemoryStorage {
  private store = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) {
      this.store.set(key, value);
    }
  }

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }

  removeItem(key: string) {
    this.store.delete(key);
  }
}

export function runSiteSelectionTests() {
  const alpha = "https://alpha.example/";
  const beta = "https://beta.example/";
  const workspaceSites: SiteLike[] = [
    { siteUrl: alpha },
    { siteUrl: beta },
  ];
  const ga4Sites: SiteLike[] = [
    { siteUrl: "properties/111", displayName: "Alpha Example GA4" },
    { siteUrl: "properties/222", displayName: "Beta Example Main Property" },
  ];
  const knownWorkspaceSites = getProfileWorkspaceSites(alpha, [alpha, beta], []);

  assert.equal(
    getWorkspaceSiteForGa4Property("properties/222", alpha, ga4Sites, workspaceSites),
    beta,
  );
  assert.equal(
    getWorkspaceSiteForGa4Property("properties/111", beta, ga4Sites, workspaceSites),
    alpha,
  );

  const storage = new MemoryStorage({
    [selectedSiteCacheKey("user-1", "gsc")]: alpha,
    [selectedSiteCacheKey("user-1", "ga4")]: beta,
    [selectedGa4PropertyCacheKey("user-1", beta)]: "properties/222",
  });

  const ga4Selection = resolveSourceSwitchSelection({
    activatedGa4PropertyId: null,
    activatedSiteUrl: alpha,
    availableGa4Sites: ga4Sites,
    availableWorkspaceSites: workspaceSites,
    currentSelectedGa4Property: "",
    currentSelectedGa4PropertySite: "",
    currentSelectedSite: alpha,
    knownWorkspaceSites,
    nextSource: "ga4",
    storage,
    userId: "user-1",
  });

  assert.deepEqual(ga4Selection, {
    selectedGa4Property: "properties/222",
    selectedGa4PropertySite: beta,
    selectedSite: beta,
  });

  const gscSelection = resolveSourceSwitchSelection({
    activatedGa4PropertyId: null,
    activatedSiteUrl: alpha,
    availableGa4Sites: ga4Sites,
    availableWorkspaceSites: workspaceSites,
    currentSelectedGa4Property: ga4Selection.selectedGa4Property,
    currentSelectedGa4PropertySite: ga4Selection.selectedGa4PropertySite,
    currentSelectedSite: ga4Selection.selectedSite,
    knownWorkspaceSites,
    nextSource: "gsc",
    storage,
    userId: "user-1",
  });

  assert.equal(gscSelection.selectedSite, alpha);

  const ga4SelectionAgain = resolveSourceSwitchSelection({
    activatedGa4PropertyId: null,
    activatedSiteUrl: alpha,
    availableGa4Sites: ga4Sites,
    availableWorkspaceSites: workspaceSites,
    currentSelectedGa4Property: gscSelection.selectedGa4Property,
    currentSelectedGa4PropertySite: gscSelection.selectedGa4PropertySite,
    currentSelectedSite: gscSelection.selectedSite,
    knownWorkspaceSites,
    nextSource: "ga4",
    storage,
    userId: "user-1",
  });

  assert.deepEqual(ga4SelectionAgain, ga4Selection);

  const userScopedStorage = new MemoryStorage({
    [selectedSiteCacheKey("user-a", "gsc")]: alpha,
    [selectedSiteCacheKey("user-b", "gsc")]: "https://unknown.example/",
  });

  assert.equal(
    readCachedSiteSelection({
      dataSource: "gsc",
      fallbackSite: beta,
      knownWorkspaceSites,
      storage: userScopedStorage,
      userId: "user-a",
    }),
    alpha,
  );

  assert.equal(
    readCachedSiteSelection({
      dataSource: "gsc",
      fallbackSite: beta,
      knownWorkspaceSites,
      storage: userScopedStorage,
      userId: "user-b",
    }),
    beta,
  );
  assert.equal(userScopedStorage.getItem(selectedSiteCacheKey("user-b", "gsc")), null);
}
