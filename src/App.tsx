import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/layout/AppSidebar"
import { Button } from "@/components/ui/button"
import { AuthProvider, useAuth } from "./contexts/AuthContext"
import { BarChart3 } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { GscApiService, GscSite } from "./services/gscService"
import { subDays, differenceInDays } from "date-fns"
import { DateRange } from "react-day-picker"
import { Label } from "@/components/ui/label"

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

import { AuthScreen } from "./components/auth/AuthScreen"
import { BingApiService, BingSite } from "./services/bingService"
import { Ga4ApiService } from "./services/ga4Service"
import { Input } from "@/components/ui/input"
import { AnnotationsService, Annotation } from "./services/annotationsService"
import { GlobalSyncPoller } from "./components/dashboard/GlobalSyncPoller"

import { Toaster } from "@/components/ui/sonner"
import { toast } from "sonner"
import type { Ga4DashboardTab, GscDashboardTab } from "./components/app/AppContent"
import { AppHeader } from "./components/app/AppHeader"
import { AppStatusPanels } from "./components/app/AppStatusPanels"
import { AppToolbar } from "./components/app/AppToolbar"
import type { SettingsDraft } from "./components/app/SettingsDialog"
import { getPreferredGa4PropertyId, getPreferredSiteUrl, getProfileWorkspaceSites, getSelectionPersistenceSource, getWorkspaceSiteForGa4Property, isGa4PropertyForWorkspaceSite, legacySelectedGa4PropertyCacheKey, legacySelectedSiteCacheKey, mergeUniqueSites, readCachedSiteSelection, resolveSourceSwitchSelection, selectedGa4PropertyCacheKey, selectedSiteCacheKey, type SiteLike } from "./lib/siteSelection"
import { useSelectorRequestGate } from "./lib/useSelectorRequestGate"
import { fetchOfflineGscSites, isGa4ScopeError, isGoogleAuthError, persistKnownSites } from "./lib/siteData"

type DataSource = 'gsc' | 'bing' | 'ga4' | 'blended'

const gscSitesCacheKey = (userId: string) => `gsc_sites_cache:${userId}`;
const ga4SitesCacheKey = (userId: string) => `ga4_sites_cache:${userId}`;

function readCachedList<T>(key: string): T[] {
  try {
    const saved = localStorage.getItem(key);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const AppContent = lazy(() => import("./components/app/AppContent").then((module) => ({ default: module.AppContent })));
const OnboardingFlow = lazy(() => import("./components/app/OnboardingFlow").then((module) => ({ default: module.OnboardingFlow })));
const SettingsDialog = lazy(() => import("./components/app/SettingsDialog").then((module) => ({ default: module.SettingsDialog })));
const Ga4PropertyDialog = lazy(() => import("./components/app/Ga4PropertyDialog").then((module) => ({ default: module.Ga4PropertyDialog })));

function DashboardContentFallback() {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground shadow-[0_12px_32px_rgba(15,61,46,0.04)]">
      Loading workspace...
    </div>
  );
}

function MainApp() {
  const { user, userProfile, loading, signOut, connectGoogleServices, disconnectGoogleServices, unlockSite, setBingApiKey, completeOnboarding, updateDefaultSite, updateDefaultGa4Property, updateUserProfile } = useAuth()
  const isOnboarding = Boolean(userProfile && !userProfile.onboardingCompleted)
  const [settingsInitialTab, setSettingsInitialTab] = useState<"profile" | "workspace" | "integrations">("profile")
  const [sites, setSites] = useState<GscSite[]>([])
  const [bingSites, setBingSites] = useState<BingSite[]>([])
  const [ga4Sites, setGa4Sites] = useState<{siteUrl: string, displayName: string}[]>([])
  const [selectedSite, setSelectedSite] = useState("")
  const [selectedGa4Property, setSelectedGa4Property] = useState("")
  const [selectedGa4PropertySite, setSelectedGa4PropertySite] = useState("")
  const explicitSiteSelectionRef = useRef(false)
  const explicitGa4SelectionRef = useRef(false)
  const [initializedSelectionsForUser, setInitializedSelectionsForUser] = useState<string | null>(null)
  const [fetchingSites, setFetchingSites] = useState(false)
  const [isConnectingGoogleData, setIsConnectingGoogleData] = useState(false)
  const [isDisconnectingGoogleData, setIsDisconnectingGoogleData] = useState(false)
  const [isUpdatingDefaultSite, setIsUpdatingDefaultSite] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [dataSource, setDataSource] = useState<DataSource>('gsc')
  const [gscSyncVersion, setGscSyncVersion] = useState(0)
  const [backgroundEffectsReady, setBackgroundEffectsReady] = useState(false)
  const bumpGscSyncVersion = useCallback(() => setGscSyncVersion((version) => version + 1), [])
  const selectorRequestGate = useSelectorRequestGate<"gsc" | "bing" | "ga4" | "onboarding-ga4">()
  
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>({
    avatarUrl: "",
    bingApiKey: "",
    bio: "",
    company: "",
    name: "",
  })

  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [showSystemAnnotations, setShowSystemAnnotations] = useState(false)
  const [showUserAnnotations, setShowUserAnnotations] = useState(false)

  const [activeMenu, setActiveMenu] = useState<string>("Dashboard")
  const [gscDashboardTab, setGscDashboardTab] = useState<GscDashboardTab>("overview")
  const [ga4DashboardTab, setGa4DashboardTab] = useState<Ga4DashboardTab>("overview")

  const openSettings = (tab: "profile" | "workspace" | "integrations" = "profile") => {
    setSettingsInitialTab(tab)
    setSettingsDraft({
      avatarUrl: userProfile?.avatarUrl || user?.photoURL || "",
      bingApiKey: "",
      bio: userProfile?.bio || "",
      company: userProfile?.company || "",
      name: userProfile?.name || user?.displayName || "",
    })
    setShowSettingsModal(true)
  }

  const handleMenuSelect = (menu: string) => {
    setActiveMenu(menu)
    if (menu === "LLM Traffic") {
      setDataSource('ga4')
    } else if (menu === "Sites" || menu === "Rank Tracker" || menu === "Server Logs" || menu === "Page Indexing" || menu === "Crawl Inventory" || menu === "Internal Links" || menu === "Raw Data" || menu === "Reconciliation") {
      setDataSource('gsc')
    }
  }

  const handleOpenSiteWorkspace = (siteUrl: string, menu: "Dashboard" | "Crawl Inventory" | "Internal Links" | "Raw Data" | "Reconciliation") => {
    setSelectedSite(siteUrl);
    setDataSource('gsc');
    setActiveMenu(menu);
  };

  useEffect(() => {
    setGscDashboardTab("overview")
    setGa4DashboardTab("overview")
  }, [dataSource, selectedSite])

  const fetchAnnotations = async () => {
    if (user?.uid) {
       try {
         const data = await AnnotationsService.getAnnotations(user.uid, selectedSite);
         setAnnotations(data);
       } catch (err) {
         console.warn("Failed to fetch annotations:", err)
       }
    }
  }

  useEffect(() => {
    if (!backgroundEffectsReady) return;

    const timer = window.setTimeout(() => {
      void fetchAnnotations();
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [backgroundEffectsReady, selectedSite, user?.uid])

  useEffect(() => {
    if (!user) {
      setBackgroundEffectsReady(false);
      return;
    }

    setBackgroundEffectsReady(false);
    const timer = window.setTimeout(() => {
      setBackgroundEffectsReady(true);
    }, 3500);

    return () => window.clearTimeout(timer);
  }, [user?.uid])

  useEffect(() => {
    if (!user?.uid || initializedSelectionsForUser !== user.uid) {
      return;
    }

    localStorage.setItem(gscSitesCacheKey(user.uid), JSON.stringify(sites));
    localStorage.removeItem('gsc_sites_cache');
  }, [initializedSelectionsForUser, sites, user?.uid]);

  useEffect(() => {
    if (!user?.uid || initializedSelectionsForUser !== user.uid) {
      return;
    }

    localStorage.setItem(ga4SitesCacheKey(user.uid), JSON.stringify(ga4Sites));
    localStorage.removeItem('ga4_sites_cache');
  }, [ga4Sites, initializedSelectionsForUser, user?.uid]);

  useEffect(() => {
    if (!user?.uid || initializedSelectionsForUser !== user.uid) {
      return;
    }

    const persistenceSource = getSelectionPersistenceSource(dataSource);
    localStorage.setItem(selectedSiteCacheKey(user.uid, persistenceSource), selectedSite);
    if (persistenceSource === "gsc") {
      localStorage.removeItem(legacySelectedSiteCacheKey(user.uid));
    }
  }, [dataSource, initializedSelectionsForUser, selectedSite, user?.uid]);

  useEffect(() => {
    if (!user?.uid || initializedSelectionsForUser !== user.uid) {
      return;
    }

    if (!selectedGa4Property || !selectedGa4PropertySite) {
      return;
    }

    localStorage.setItem(selectedGa4PropertyCacheKey(user.uid, selectedGa4PropertySite || selectedSite), selectedGa4Property);
    localStorage.removeItem('selected_ga4_property_cache');
    localStorage.removeItem(legacySelectedGa4PropertyCacheKey(user.uid));
  }, [initializedSelectionsForUser, selectedGa4Property, selectedGa4PropertySite, selectedSite, user?.uid]);

  useEffect(() => {
    if (userProfile?.activatedSiteUrl && !selectedSite) {
      setSelectedSite(userProfile.activatedSiteUrl);
    }
  }, [selectedSite, userProfile?.activatedSiteUrl]);

  useEffect(() => {
    const userKey = user?.uid || null;
    if (!userKey) {
      setInitializedSelectionsForUser(null);
      setSites([]);
      setBingSites([]);
      setGa4Sites([]);
      setSelectedSite("");
      setSelectedGa4Property("");
      setSelectedGa4PropertySite("");
      return;
    }

    if (!userProfile) {
      if (initializedSelectionsForUser && initializedSelectionsForUser !== userKey) {
        setInitializedSelectionsForUser(null);
        setSites([]);
        setBingSites([]);
        setGa4Sites([]);
        setSelectedSite("");
        setSelectedGa4Property("");
        setSelectedGa4PropertySite("");
      }
      return;
    }

    if (initializedSelectionsForUser === userKey) {
      return;
    }

    setSites(readCachedList<GscSite>(gscSitesCacheKey(userKey)));
    setBingSites([]);
    setGa4Sites(readCachedList<{siteUrl: string, displayName: string}>(ga4SitesCacheKey(userKey)));
    localStorage.removeItem('gsc_sites_cache');
    localStorage.removeItem('ga4_sites_cache');
    const profileWorkspaceSites = getProfileWorkspaceSites(
      userProfile.activatedSiteUrl,
      userProfile.unlockedSites || [],
      userProfile.knownSites || [],
    );
    const initialSite = readCachedSiteSelection({
      dataSource: "gsc",
      fallbackSite: userProfile.activatedSiteUrl || userProfile.unlockedSites[0] || userProfile.knownSites?.[0] || "",
      knownWorkspaceSites: profileWorkspaceSites,
      storage: localStorage,
      userId: userKey,
    });
    const cachedGa4Property = initialSite
      ? localStorage.getItem(selectedGa4PropertyCacheKey(userKey, initialSite)) || ""
      : "";
    localStorage.removeItem(legacySelectedGa4PropertyCacheKey(userKey));
    localStorage.removeItem(legacySelectedSiteCacheKey(userKey));
    explicitSiteSelectionRef.current = false;
    explicitGa4SelectionRef.current = false;
    setSelectedSite(initialSite);
    setSelectedGa4Property(cachedGa4Property);
    setSelectedGa4PropertySite(initialSite);
    setInitializedSelectionsForUser(userKey);
  }, [
    initializedSelectionsForUser,
    user?.uid,
    userProfile?.activatedGa4PropertyId,
    userProfile?.activatedSiteUrl,
    userProfile?.knownSites,
    userProfile?.unlockedSites,
  ]);

  const [dateRange, setDateRange] = useState<DateRange>({
    from: subDays(new Date(), 30),
    to: subDays(new Date(), 2),
  })

  const [isCompareMode, setIsCompareMode] = useState(false)
  const [compareDateRange, setCompareDateRange] = useState<DateRange>({
    from: subDays(new Date(), 59),
    to: subDays(new Date(), 31),
  })

  type Ga4Dimension = 'country' | 'city' | 'region' | 'deviceCategory' | 'browser' | 'operatingSystem';
  const [ga4UserDimension, setGa4UserDimension] = useState<Ga4Dimension>('country')
  
  const [sessionExpired, setSessionExpired] = useState(false);

  const handleFromDateChange = (date: Date | undefined) => {
    if (date) {
      setDateRange(prev => {
        const newRange = { ...prev, from: date }
        if (newRange.from && newRange.to) {
          const diff = differenceInDays(newRange.to, newRange.from)
          setCompareDateRange({
            from: subDays(newRange.from, diff + 1),
            to: subDays(newRange.from, 1)
          })
        }
        return newRange
      })
    }
  }

  const handleToDateChange = (date: Date | undefined) => {
    if (date) {
      setDateRange(prev => {
        const newRange = { ...prev, to: date }
        if (newRange.from && newRange.to) {
          const diff = differenceInDays(newRange.to, newRange.from)
          setCompareDateRange({
            from: subDays(newRange.from, diff + 1),
            to: subDays(newRange.from, 1)
          })
        }
        return newRange
      })
    }
  }

  const handleCompareFromDateChange = (date: Date | undefined) => {
    if (date) {
      setCompareDateRange(prev => ({ ...prev, from: date }))
    }
  }

  const handleCompareToDateChange = (date: Date | undefined) => {
    if (date) {
      setCompareDateRange(prev => ({ ...prev, to: date }))
    }
  }

  const [showGa4PropertyDialog, setShowGa4PropertyDialog] = useState(false)
  const [isSavingGa4Property, setIsSavingGa4Property] = useState(false)
  const [pendingGa4Property, setPendingGa4Property] = useState("")


  useEffect(() => {
    const googleConnected = Boolean(userProfile?.googleConnected)
    let cancelled = false;
    const startedScopes: Array<"gsc" | "bing" | "ga4" | "onboarding-ga4"> = [];
    const beginRequest = (scope: "gsc" | "bing" | "ga4" | "onboarding-ga4") => {
      startedScopes.push(scope);
      return selectorRequestGate.begin(scope);
    };

    if (googleConnected && isOnboarding) {
      const ga4Service = new Ga4ApiService()
      const onboardingGa4RequestId = beginRequest("onboarding-ga4")
      ga4Service.getProperties()
        .then((fetchedSites) => {
          if (cancelled || !selectorRequestGate.isCurrent("onboarding-ga4", onboardingGa4RequestId)) return;
          setGa4Sites(fetchedSites)
        })
        .catch((err) => {
          if (cancelled || !selectorRequestGate.isCurrent("onboarding-ga4", onboardingGa4RequestId)) return;
          console.warn("Failed to fetch GA4 properties during onboarding:", err)
          setGa4Sites([])
        })
    }

    if (dataSource === 'gsc' || dataSource === 'blended') {
      if (googleConnected) {
        if (!backgroundEffectsReady && !isOnboarding) {
          const offlineGscRequestId = beginRequest("gsc")
          fetchOfflineGscSites(userProfile)
            .then((offlineSites) => {
              if (cancelled || !selectorRequestGate.isCurrent("gsc", offlineGscRequestId)) return;
              setSites(prev => mergeUniqueSites(prev, offlineSites));
            })
            .catch(e => console.error("Offline fallback err:", e));
          return () => {
            cancelled = true;
            startedScopes.forEach((scope) => selectorRequestGate.cancel(scope));
          };
        }

        setFetchingSites(true)
        setApiError(null)
        const gscService = new GscApiService(null, userProfile?.tier || 'free')
        const gscRequestId = beginRequest("gsc")
        gscService.getSites()
          .then(fetchedSites => {
            if (cancelled || !selectorRequestGate.isCurrent("gsc", gscRequestId)) return;
            setSessionExpired(false)
            setSites(fetchedSites)
            if (fetchedSites.length > 0 && !isOnboarding) {
              if (user && userProfile) {
                const knownUrls = fetchedSites.map(s => s.siteUrl);
                persistKnownSites(user.uid, knownUrls).catch(e => console.error("Failed caching known sites", e));
              }
            }
          })
          .catch(err => {
            if (cancelled || !selectorRequestGate.isCurrent("gsc", gscRequestId)) return;
            if (isGoogleAuthError(err.message) || err.message.includes('GOOGLE_NOT_CONNECTED')) {
              console.warn("Stored Google connection is missing or expired.");
              fetchOfflineGscSites(userProfile)
                .then((offlineSites) => {
                  if (cancelled || !selectorRequestGate.isCurrent("gsc", gscRequestId)) return;
                  setSessionExpired(offlineSites.length === 0);
                  setSites(prev => mergeUniqueSites(prev, offlineSites));
                })
                .catch(e => {
                  if (cancelled || !selectorRequestGate.isCurrent("gsc", gscRequestId)) return;
                  setSessionExpired(true);
                  console.error("Offline fallback err:", e);
                });
            } else if (err.message === "Failed to fetch") {
              console.error("Network error fetching sites:", err)
              setApiError("Network error: Unable to connect to Google Search Console API. This could be due to an adblocker, privacy extension, or network connectivity issue.")
            } else {
              console.error("Failed to fetch sites:", err)
              setApiError(err.message)
            }
          })
          .finally(() => {
            if (!cancelled && selectorRequestGate.isCurrent("gsc", gscRequestId)) setFetchingSites(false);
          })
      } else {
        const offlineOnlyGscRequestId = beginRequest("gsc")
        fetchOfflineGscSites(userProfile)
          .then((offlineSites) => {
             if (cancelled || !selectorRequestGate.isCurrent("gsc", offlineOnlyGscRequestId)) return;
             if (offlineSites.length > 0) {
               setSessionExpired(true);
             }
             setSites(prev => mergeUniqueSites(prev, offlineSites));
          }).catch(e => {
            if (cancelled || !selectorRequestGate.isCurrent("gsc", offlineOnlyGscRequestId)) return;
            console.error("Offline fallback err:", e);
            setSites([]);
          });
      }
    } else if (dataSource === 'bing' && user) {
      if (!userProfile?.bingConnected) {
        setBingSites([]);
        return;
      }
      if (!backgroundEffectsReady && !isOnboarding) {
        return;
      }
      setFetchingSites(true)
      setApiError(null)
      const bingService = new BingApiService()
      const bingRequestId = beginRequest("bing")
      bingService.getSites()
        .then(fetchedSites => {
          if (cancelled || !selectorRequestGate.isCurrent("bing", bingRequestId)) return;
          setBingSites(fetchedSites)
        })
        .catch(err => {
          if (cancelled || !selectorRequestGate.isCurrent("bing", bingRequestId)) return;
          console.error("Failed to fetch Bing sites:", err)
          setApiError(err.message)
        })
        .finally(() => {
          if (!cancelled && selectorRequestGate.isCurrent("bing", bingRequestId)) setFetchingSites(false);
        })
    } else if (dataSource === 'ga4' && googleConnected) {
      if (!backgroundEffectsReady && !isOnboarding) {
        return;
      }
      setFetchingSites(true)
      setApiError(null)
      const ga4Service = new Ga4ApiService()
      const ga4RequestId = beginRequest("ga4")
      ga4Service.getProperties()
        .then(fetchedSites => {
          if (cancelled || !selectorRequestGate.isCurrent("ga4", ga4RequestId)) return;
          setSessionExpired(false)
          setGa4Sites(fetchedSites)
        })
        .catch(err => {
          if (cancelled || !selectorRequestGate.isCurrent("ga4", ga4RequestId)) return;
          if (isGoogleAuthError(err.message) || isGa4ScopeError(err.message) || err.message.includes('GOOGLE_NOT_CONNECTED')) {
            console.warn("Stored Google connection is missing or expired.");
            setSessionExpired(true);
          } else if (err.message.includes("Google Analytics Admin API has not been used in project") || err.message.includes("is disabled")) {
            console.error("GA4 API not enabled:", err)
            setSessionExpired(true)
          } else if (err.message === "Failed to fetch") {
            console.error("Network error fetching GA4 sites:", err)
            setSessionExpired(true)
          } else {
            console.error("Failed to fetch GA4 sites:", err)
            setSessionExpired(true)
          }
        })
        .finally(() => {
          if (!cancelled && selectorRequestGate.isCurrent("ga4", ga4RequestId)) setFetchingSites(false);
        })
    } else if (dataSource === 'ga4' && !googleConnected) {
      setGa4Sites([])
    }

    return () => {
      cancelled = true;
      startedScopes.forEach((scope) => selectorRequestGate.cancel(scope));
    };
  }, [backgroundEffectsReady, dataSource, isOnboarding, selectedSite, user, userProfile])

  const handleSiteSelect = async (siteUrl: string) => {
    explicitSiteSelectionRef.current = true;
    explicitGa4SelectionRef.current = false;
    setSelectedSite(siteUrl);
    if (dataSource === "ga4") {
      const cachedProperty = user?.uid
        ? localStorage.getItem(selectedGa4PropertyCacheKey(user.uid, siteUrl)) || ""
        : "";
      setSelectedGa4Property(getPreferredGa4PropertyId(accessibleGa4Sites, {
        activatedGa4PropertyId: userProfile?.activatedGa4PropertyId,
        activatedSiteUrl: userProfile?.activatedSiteUrl,
        allowUnscopedPreference: Boolean(cachedProperty),
        currentPreference: cachedProperty,
        currentPreferenceSite: cachedProperty ? siteUrl : selectedGa4PropertySite,
        workspaceSite: siteUrl,
      }));
      setSelectedGa4PropertySite(siteUrl);
    }
  };

  const handleOnboardingGa4PropertySelect = (propertyId: string) => {
    setSelectedGa4Property(propertyId);
    setSelectedGa4PropertySite(selectedSite || "__global__");
  };

  const handleSaveSettings = async () => {
    await updateUserProfile({
      avatarUrl: settingsDraft.avatarUrl,
      bio: settingsDraft.bio,
      company: settingsDraft.company,
      name: settingsDraft.name,
    });
    if (settingsDraft.bingApiKey.trim()) {
      await setBingApiKey(settingsDraft.bingApiKey.trim());
    }
    setSettingsDraft((prev) => ({ ...prev, bingApiKey: "" }));
    setShowSettingsModal(false);
  };

  const handleGa4PropertySelect = (propertyId: string) => {
    explicitGa4SelectionRef.current = true;
    const workspaceSiteForProperty = getWorkspaceSiteForGa4Property(propertyId, selectedSite, accessibleGa4Sites, accessibleWorkspaceSites);
    if (workspaceSiteForProperty && workspaceSiteForProperty !== selectedSite) {
      setSelectedSite(workspaceSiteForProperty);
    }
    setSelectedGa4Property(propertyId);
    setSelectedGa4PropertySite(workspaceSiteForProperty || selectedSite);
  };

  const handleSaveGa4Property = async () => {
    if (!pendingGa4Property) {
      return;
    }

    const selectedProperty = ga4Sites.find((site) => site.siteUrl === pendingGa4Property);
    setIsSavingGa4Property(true);

    const saveToast = toast.loading("Saving GA4 property", {
      description: "We’re assigning the selected GA4 property to this workspace.",
    });

    try {
      await updateDefaultGa4Property(pendingGa4Property, selectedProperty?.displayName || null, selectedSite || null);
      setSelectedGa4Property(pendingGa4Property);
      setSelectedGa4PropertySite(selectedSite);
      toast.success("GA4 property saved", {
        id: saveToast,
        description: "This workspace will now use the selected GA4 property by default.",
      });
      setShowGa4PropertyDialog(false);
    } catch (err: any) {
      toast.error("Failed to save GA4 property", {
        id: saveToast,
        description: err.message || "We couldn't assign that GA4 property to this workspace.",
      });
    } finally {
      setIsSavingGa4Property(false);
    }
  };

  const handleConnectGoogleData = async () => {
    setIsConnectingGoogleData(true);
    setApiError(null);

    const connectingToast = toast.loading("Connecting Google data", {
      description: "We’re opening Google consent so we can enable live Search Console and GA4 data.",
    });

    try {
      const connectionMessage = await connectGoogleServices();
      setSessionExpired(false);
      toast.success("Google data connected", {
        id: connectingToast,
        description: connectionMessage || "Google access is ready. Historical imports are queued for this workspace.",
      });
    } catch (err: any) {
      toast.error("Google data connection failed", {
        id: connectingToast,
        description: err.message || "We couldn't finish connecting your Google data.",
      });
      throw err;
    } finally {
      setIsConnectingGoogleData(false);
    }
  };

  const handleFinishOnboarding = async (
    bingApiKey: string,
    activatedGa4Property?: { siteUrl: string; displayName: string } | null,
  ) => {
    if (!selectedSite) {
      throw new Error("Choose a property to activate first.");
    }

    const isUnlocked = userProfile?.unlockedSites.includes(selectedSite) || userProfile?.knownSites?.includes(selectedSite);
    if (!isUnlocked) {
      await unlockSite(selectedSite);
    }

    if (bingApiKey.trim()) {
      await setBingApiKey(bingApiKey.trim());
    }

    const selectedGa4 = activatedGa4Property || (
      selectedGa4Property
        ? {
          siteUrl: selectedGa4Property,
          displayName: ga4Sites.find((site) => site.siteUrl === selectedGa4Property)?.displayName || selectedGa4Property,
        }
        : null
    );

    await completeOnboarding(selectedSite, selectedGa4);
  };

  const handleDisconnectGoogleData = async () => {
    setIsDisconnectingGoogleData(true);
    const disconnectToast = toast.loading("Disconnecting Google data", {
      description: "We’re removing the saved Search Console and GA4 connection from this workspace.",
    });

    try {
      await disconnectGoogleServices();
      setSessionExpired(true);
      toast.success("Google data disconnected", {
        id: disconnectToast,
        description: "Your app login is still active. Reconnect Google Data whenever you want live reporting again.",
      });
    } catch (err: any) {
      toast.error("Failed to disconnect Google data", {
        id: disconnectToast,
        description: err.message || "We couldn't remove the saved Google data connection.",
      });
    } finally {
      setIsDisconnectingGoogleData(false);
    }
  };

  const handleSetDefaultSite = async () => {
    if (!selectedSite) {
      return;
    }

    setIsUpdatingDefaultSite(true);
    const defaultToast = toast.loading("Saving default property", {
      description: "We’re updating the property that should open first for this workspace.",
    });

    try {
      await updateDefaultSite(selectedSite);
      toast.success("Default property updated", {
        id: defaultToast,
        description: "This property will now open first when you return to the dashboard.",
      });
    } catch (err: any) {
      toast.error("Failed to update default property", {
        id: defaultToast,
        description: err.message || "We couldn't update your default property.",
      });
    } finally {
      setIsUpdatingDefaultSite(false);
    }
  };

  const savedGa4Property = userProfile?.activatedGa4PropertyId
    ? {
      siteUrl: userProfile.activatedGa4PropertyId,
      displayName: userProfile.activatedGa4DisplayName || userProfile.activatedGa4PropertyId,
    }
    : null;
  const ga4SitesWithSavedDefault = savedGa4Property && !ga4Sites.some((site) => site.siteUrl === savedGa4Property.siteUrl)
    ? [savedGa4Property, ...ga4Sites]
    : ga4Sites;
  const accessibleGscSites = sites;
  const accessibleBingSites = bingSites;
  const accessibleGa4Sites = ga4SitesWithSavedDefault;
  const workspaceMatchedGa4Sites = selectedSite
    ? accessibleGa4Sites.filter((site) => isGa4PropertyForWorkspaceSite(site, selectedSite))
    : accessibleGa4Sites;
  const selectedGa4PropertyForDashboard = selectedGa4PropertySite === selectedSite && accessibleGa4Sites.some((site) => site.siteUrl === selectedGa4Property)
    ? selectedGa4Property
    : "";
  const activeGa4PropertyId = selectedGa4PropertyForDashboard || null;
  const activeGa4Selection = activeGa4PropertyId || "";
  const visibleGa4Sites = dataSource === 'ga4' ? accessibleGa4Sites : workspaceMatchedGa4Sites;
  const accessibleWorkspaceSites = accessibleGscSites.length > 0
    ? accessibleGscSites
    : (userProfile?.unlockedSites || []).map((siteUrl) => ({ siteUrl, permissionLevel: "warehouse" }));

  const currentSites = dataSource === 'ga4' ? accessibleGa4Sites : dataSource === 'bing' ? accessibleBingSites : accessibleGscSites;
  const currentSelection = dataSource === 'ga4' ? activeGa4Selection : selectedSite;
  const showStatusPanels = activeMenu === "Dashboard";
  const showReportToolbar = [
    "AI Content Auditor",
    "Dashboard",
    "LLM Traffic",
    "Internal Links",
    "Page Indexing",
    "Raw Data",
    "Reconciliation",
    "Server Logs",
  ].includes(activeMenu);
  const hasValidSelectedSite = currentSites.some((site) => site.siteUrl === currentSelection);

  const switchDataSource = (nextSource: DataSource, availableSites: SiteLike[]) => {
    if (dataSource === nextSource) {
      return;
    }

    const nextSelection = resolveSourceSwitchSelection({
      activatedGa4PropertyId: userProfile?.activatedGa4PropertyId,
      activatedSiteUrl: userProfile?.activatedSiteUrl,
      availableGa4Sites: nextSource === "ga4" ? availableSites : accessibleGa4Sites,
      availableWorkspaceSites: accessibleWorkspaceSites,
      currentSelectedGa4Property: selectedGa4Property,
      currentSelectedGa4PropertySite: selectedGa4PropertySite,
      currentSelectedSite: selectedSite,
      knownWorkspaceSites: getProfileWorkspaceSites(
        userProfile?.activatedSiteUrl,
        userProfile?.unlockedSites || [],
        userProfile?.knownSites || [],
      ),
      nextSource,
      storage: user?.uid ? localStorage : null,
      userId: user?.uid || null,
    });

    setDataSource(nextSource);

    if (nextSelection.selectedSite && nextSelection.selectedSite !== selectedSite) {
      setSelectedSite(nextSelection.selectedSite);
    }

    if (nextSource !== "ga4") {
      return;
    }

    if (isOnboarding || availableSites.length === 0) {
      setSelectedGa4Property("");
      setSelectedGa4PropertySite(nextSelection.selectedSite || selectedSite);
      return;
    }

    setSelectedGa4Property(nextSelection.selectedGa4Property);
    setSelectedGa4PropertySite(nextSelection.selectedGa4PropertySite);
  };

  useEffect(() => {
    if (isOnboarding) {
      return;
    }

    if (dataSource === 'ga4') {
      if (currentSites.length === 0) {
        if (!fetchingSites && !explicitGa4SelectionRef.current) {
          setSelectedGa4Property("");
        }
        return;
      }

      if (!currentSites.some((site) => site.siteUrl === currentSelection)) {
        if (!fetchingSites && !explicitGa4SelectionRef.current) {
          setSelectedGa4Property((current) => getPreferredGa4PropertyId(currentSites, {
            activatedGa4PropertyId: userProfile?.activatedGa4PropertyId,
            activatedSiteUrl: userProfile?.activatedSiteUrl,
            currentPreference: current,
            currentPreferenceSite: selectedGa4PropertySite,
            workspaceSite: selectedSite,
          }));
          setSelectedGa4PropertySite(selectedSite);
        }
      }
      return;
    }

    if (!userProfile) {
      return;
    }

    if (dataSource === 'bing') {
      return;
    }

    const selectedSiteIsAccessible = Boolean(selectedSite && accessibleWorkspaceSites.some((site) => site.siteUrl === selectedSite));
    if (!selectedSite || (!selectedSiteIsAccessible && !fetchingSites && !explicitSiteSelectionRef.current)) {
      const preferred = getPreferredSiteUrl(
        userProfile.activatedSiteUrl || selectedSite,
        accessibleWorkspaceSites,
        userProfile.unlockedSites,
        userProfile.tier,
        ga4Sites as SiteLike[],
      );
      setSelectedSite((current) => preferred || current);
    }
  }, [accessibleWorkspaceSites, currentSites, currentSelection, dataSource, fetchingSites, isOnboarding, selectedSite, userProfile]);

  useEffect(() => {
    if (!user?.uid || initializedSelectionsForUser !== user.uid || isOnboarding || !selectedSite) {
      return;
    }

    const cachedProperty = localStorage.getItem(selectedGa4PropertyCacheKey(user.uid, selectedSite)) || "";
    if (cachedProperty && accessibleGa4Sites.some((site) => site.siteUrl === cachedProperty)) {
      if (!explicitGa4SelectionRef.current && (selectedGa4Property !== cachedProperty || selectedGa4PropertySite !== selectedSite)) {
        setSelectedGa4Property(cachedProperty);
        setSelectedGa4PropertySite(selectedSite);
      }
      return;
    }

    if (cachedProperty) {
      localStorage.removeItem(selectedGa4PropertyCacheKey(user.uid, selectedSite));
    }

    const selectedPropertyIsAvailable = selectedGa4Property
      ? accessibleGa4Sites.some((site) => site.siteUrl === selectedGa4Property)
      : false;
    if (selectedGa4PropertySite !== selectedSite || (selectedGa4Property && !selectedPropertyIsAvailable)) {
      if (explicitGa4SelectionRef.current && selectedGa4Property && selectedGa4PropertySite === selectedSite) {
        return;
      }
      const fallbackProperty = getPreferredGa4PropertyId(accessibleGa4Sites, {
        activatedGa4PropertyId: userProfile?.activatedGa4PropertyId,
        activatedSiteUrl: userProfile?.activatedSiteUrl,
        currentPreference: "",
        currentPreferenceSite: selectedGa4PropertySite,
        workspaceSite: selectedSite,
      });
      setSelectedGa4Property(fallbackProperty);
      setSelectedGa4PropertySite(selectedSite);
    }
  }, [
    accessibleGa4Sites,
    initializedSelectionsForUser,
    isOnboarding,
    selectedGa4Property,
    selectedGa4PropertySite,
    selectedSite,
    user?.uid,
  ]);

  useEffect(() => {
    if (!userProfile || isOnboarding) {
      return;
    }

    if (dataSource === 'ga4' && selectedGa4Property && !selectedGa4PropertyForDashboard) {
      setSelectedGa4Property("");
    }
  }, [dataSource, isOnboarding, selectedGa4Property, selectedGa4PropertyForDashboard]);

  useEffect(() => {
    if (!showGa4PropertyDialog) {
      return;
    }

    setPendingGa4Property(selectedGa4Property || userProfile?.activatedGa4PropertyId || "");
  }, [selectedGa4Property, showGa4PropertyDialog, userProfile?.activatedGa4PropertyId]);

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <BarChart3 className="h-8 w-8 text-primary" />
          <p className="text-sm text-muted-foreground">Loading NextGen SEO...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return <AuthScreen />
  }

  if (userProfile && !userProfile.onboardingCompleted) {
    return (
      <Suspense fallback={<DashboardContentFallback />}>
        <OnboardingFlow
          fetchingSites={fetchingSites}
          fetchingGa4Sites={fetchingSites}
          ga4Sites={ga4Sites}
          googleConnected={Boolean(userProfile.googleConnected)}
          isConnectingGoogle={isConnectingGoogleData}
          onComplete={handleFinishOnboarding}
          onConnectGoogle={handleConnectGoogleData}
          onSelectGa4Property={handleOnboardingGa4PropertySelect}
          onSelectSite={setSelectedSite}
          selectedGa4Property={selectedGa4Property}
          selectedSite={selectedSite}
          sites={sites}
          userName={(user.displayName || user.email || '').split(' ')[0]}
          userProfile={userProfile}
        />
      </Suspense>
    )
  }

  return (
    <SidebarProvider>
      {backgroundEffectsReady && (
        <>
          <GlobalSyncPoller siteUrl={selectedSite} />
        </>
      )}
      <div className="app-shell-bg flex min-h-screen w-full">
        <AppSidebar selectedSite={selectedSite} activeMenu={activeMenu} onMenuSelect={handleMenuSelect} />
        <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
          <AppHeader
            activeMenu={activeMenu}
            currentSites={currentSites}
            dataSource={dataSource}
            googleConnected={Boolean(userProfile?.googleConnected)}
            onOpenSettings={() => {
              openSettings("profile");
            }}
            onSelectSite={dataSource === 'ga4' ? handleGa4PropertySelect : handleSiteSelect}
            onConnectGoogle={handleConnectGoogleData}
            isConnectingGoogle={isConnectingGoogleData}
            onSignOut={signOut}
            onSwitchDataSource={(nextSource) => {
              const availableSites = nextSource === 'ga4' ? accessibleGa4Sites : nextSource === 'bing' ? accessibleBingSites : accessibleGscSites;
              switchDataSource(nextSource, availableSites);
            }}
            selectedSite={currentSelection}
            selectedWorkspaceSite={selectedSite}
            user={user}
            userProfile={userProfile}
          />
          <main className="flex-1 p-4 sm:p-6 overflow-auto">
            <div className="max-w-[1480px] mx-auto space-y-6">
              {showReportToolbar && (
                <AppToolbar
                  activeMenu={activeMenu}
                  compareDateRange={compareDateRange}
                  currentSiteUrl={selectedSite}
                  dataSource={dataSource}
                  dateRange={dateRange}
                  firstName={(userProfile?.name || user.displayName || user.email || '').split(' ')[0]}
                  ga4PropertyId={activeGa4PropertyId}
                  gscSyncVersion={gscSyncVersion}
                  isCompareMode={isCompareMode}
                  onCompareFromDateChange={handleCompareFromDateChange}
                  onCompareToDateChange={handleCompareToDateChange}
                  onFromDateChange={handleFromDateChange}
                  onOpenRawData={() => setActiveMenu("Raw Data")}
                  onToDateChange={handleToDateChange}
                  onWarehouseCoverageChange={bumpGscSyncVersion}
                  rawDataAvailable={true}
                  setIsCompareMode={setIsCompareMode}
                />
              )}

              {showStatusPanels && (
                <AppStatusPanels
                  apiError={apiError}
                  bingSitesCount={bingSites.length}
                  dataSource={dataSource}
                  fetchingSites={fetchingSites}
                  fullGa4SitesCount={ga4Sites.length}
                  ga4SitesCount={visibleGa4Sites.length}
                  googleConnected={Boolean(userProfile?.googleConnected)}
                  gscSitesCount={accessibleGscSites.length}
                  hasValidSelectedSite={hasValidSelectedSite}
                  isConnectingGoogle={isConnectingGoogleData}
                  onConnectGoogle={handleConnectGoogleData}
                  onOpenGa4Setup={() => setShowGa4PropertyDialog(true)}
                  selectedSite={currentSelection}
                  sessionExpired={sessionExpired}
                />
              )}

              {(activeMenu === "Settings" || activeMenu === "AI Content Auditor" || !( !userProfile?.googleConnected && (((dataSource === 'gsc' || dataSource === 'blended') && sites.length === 0) || (dataSource === 'ga4' && ga4Sites.length === 0) || (dataSource === 'bing' && bingSites.length === 0)) )) && (
                <Suspense fallback={<DashboardContentFallback />}>
                  <AppContent
                    activeMenu={activeMenu}
                    annotations={annotations}
                    apiError={apiError}
                    bingSites={bingSites}
                    compareDateRange={compareDateRange}
                    dataSource={dataSource}
                    dateRange={dateRange}
                    ga4DashboardTab={ga4DashboardTab}
                    ga4PropertyId={activeGa4PropertyId}
                    ga4Sites={visibleGa4Sites}
                    ga4UserDimension={ga4UserDimension}
                    gscDashboardTab={gscDashboardTab}
                    warehouseRefreshKey={gscSyncVersion}
                    isCompareMode={isCompareMode}
                    onAnnotationsChange={fetchAnnotations}
                    onGa4DashboardTabChange={setGa4DashboardTab}
                    onGa4UserDimensionChange={setGa4UserDimension}
                    onGscDashboardTabChange={setGscDashboardTab}
                    onActivateWorkspaceSite={unlockSite}
                    onOpenSettings={openSettings}
                    onOpenSiteWorkspace={handleOpenSiteWorkspace}
                    selectedSite={dataSource === 'ga4' ? activeGa4Selection : selectedSite}
                    workspaceSiteUrl={selectedSite}
                    setShowSystemAnnotations={setShowSystemAnnotations}
                    setShowUserAnnotations={setShowUserAnnotations}
                    showSystemAnnotations={showSystemAnnotations}
                    showUserAnnotations={showUserAnnotations}
                    sites={sites}
                    useLiveData={false}
                    userProfile={userProfile}
                  />
                </Suspense>
              )}
            </div>
          </main>
        </div>
      </div>

      <Suspense fallback={null}>
        <SettingsDialog
          dataSource={dataSource}
          googleConnected={Boolean(userProfile?.googleConnected)}
          initialTab={settingsInitialTab}
          isConnectingGoogle={isConnectingGoogleData}
          isDisconnectingGoogle={isDisconnectingGoogleData}
          isUpdatingDefaultSite={isUpdatingDefaultSite}
          onClose={() => setShowSettingsModal(false)}
          onConnectGoogle={handleConnectGoogleData}
          onDisconnectGoogle={handleDisconnectGoogleData}
          draft={settingsDraft}
          onDraftChange={setSettingsDraft}
          onSave={handleSaveSettings}
          onSetDefaultSite={handleSetDefaultSite}
          open={showSettingsModal}
          selectedSite={selectedSite}
          userEmail={user.email}
          userProfile={userProfile}
        />
        <Ga4PropertyDialog
          open={showGa4PropertyDialog}
          properties={ga4Sites}
          selectedProperty={pendingGa4Property}
          saving={isSavingGa4Property}
          onClose={() => setShowGa4PropertyDialog(false)}
          onSave={handleSaveGa4Property}
          onSelect={setPendingGa4Property}
        />
      </Suspense>
    </SidebarProvider>
  )
}

import { ErrorBoundary } from "./components/ErrorBoundary"

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <MainApp />
        <Toaster />
      </AuthProvider>
    </ErrorBoundary>
  )
}
