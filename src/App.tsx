import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/layout/AppSidebar"
import { Button } from "@/components/ui/button"
import { AuthProvider, useAuth } from "./contexts/AuthContext"
import { BarChart3 } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useState } from "react"
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
import { CrawlAutoStarter } from "./components/dashboard/CrawlAutoStarter"

import { Toaster } from "@/components/ui/sonner"
import { toast } from "sonner"
import type { Ga4DashboardTab, GscDashboardTab } from "./components/app/AppContent"
import { AppHeader } from "./components/app/AppHeader"
import { AppStatusPanels } from "./components/app/AppStatusPanels"
import { AppToolbar } from "./components/app/AppToolbar"
import type { SettingsDraft } from "./components/app/SettingsDialog"
import { getPreferredSiteUrl, mergeUniqueSites, type SiteLike } from "./lib/siteSelection"
import { fetchOfflineGscSites, isGa4ScopeError, isGoogleAuthError, persistKnownSites } from "./lib/siteData"
import { getBillingConfig, openBillingPortal, startCheckout, type BillingConfig } from "./services/billingService"
import { canUseRawExports, canUseReconciliation, getPlanPropertyLimit, isMultiSitePlan } from "../shared/plans"

type DataSource = 'gsc' | 'bing' | 'ga4' | 'blended'

const selectedSiteCacheKey = (userId: string) => `selected_site_cache:${userId}`;
const selectedGa4PropertyCacheKey = (userId: string) => `selected_ga4_property_cache:${userId}`;

const AppContent = lazy(() => import("./components/app/AppContent").then((module) => ({ default: module.AppContent })));
const OnboardingFlow = lazy(() => import("./components/app/OnboardingFlow").then((module) => ({ default: module.OnboardingFlow })));
const SettingsDialog = lazy(() => import("./components/app/SettingsDialog").then((module) => ({ default: module.SettingsDialog })));
const UnlockSiteDialog = lazy(() => import("./components/app/UnlockSiteDialog").then((module) => ({ default: module.UnlockSiteDialog })));
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
  const [settingsInitialTab, setSettingsInitialTab] = useState<"profile" | "plan" | "workspace" | "integrations">("profile")
  const [sites, setSites] = useState<GscSite[]>(() => {
    const saved = localStorage.getItem('gsc_sites_cache');
    return saved ? JSON.parse(saved) : [];
  })
  const [bingSites, setBingSites] = useState<BingSite[]>([])
  const [ga4Sites, setGa4Sites] = useState<{siteUrl: string, displayName: string}[]>(() => {
    const saved = localStorage.getItem('ga4_sites_cache');
    return saved ? JSON.parse(saved) : [];
  })
  const [selectedSite, setSelectedSite] = useState("")
  const [selectedGa4Property, setSelectedGa4Property] = useState("")
  const [initializedSelectionsForUser, setInitializedSelectionsForUser] = useState<string | null>(null)
  const [fetchingSites, setFetchingSites] = useState(false)
  const [isConnectingGoogleData, setIsConnectingGoogleData] = useState(false)
  const [isDisconnectingGoogleData, setIsDisconnectingGoogleData] = useState(false)
  const [isStartingCheckout, setIsStartingCheckout] = useState(false)
  const [isOpeningBillingPortal, setIsOpeningBillingPortal] = useState(false)
  const [isUpdatingDefaultSite, setIsUpdatingDefaultSite] = useState(false)
  const [billingConfig, setBillingConfig] = useState<BillingConfig | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [dataSource, setDataSource] = useState<DataSource>('gsc')
  const [gscSyncVersion, setGscSyncVersion] = useState(0)
  const [backgroundEffectsReady, setBackgroundEffectsReady] = useState(false)
  const bumpGscSyncVersion = useCallback(() => setGscSyncVersion((version) => version + 1), [])
  
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

  const openSettings = (tab: "profile" | "plan" | "workspace" | "integrations" = "profile") => {
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
    } else if (menu === "Sites" || menu === "Rank Tracker" || menu === "Server Logs" || menu === "Page Indexing" || menu === "Crawl Inventory" || menu === "Raw Data" || menu === "Reconciliation") {
      setDataSource('gsc')
    }
  }

  const handleOpenSiteWorkspace = (siteUrl: string, menu: "Dashboard" | "Crawl Inventory" | "Raw Data" | "Reconciliation") => {
    setSelectedSite(siteUrl);
    setDataSource('gsc');
    setActiveMenu(menu);
  };

  useEffect(() => {
    setGscDashboardTab("overview")
    setGa4DashboardTab("overview")
  }, [dataSource, selectedSite])

  useEffect(() => {
    if ((activeMenu === "Sites" && !isMultiSitePlan(userProfile?.tier)) || (activeMenu === "Raw Data" && !canUseRawExports(userProfile?.tier)) || (activeMenu === "Reconciliation" && !canUseReconciliation(userProfile?.tier))) {
      setActiveMenu("Dashboard");
    }
  }, [activeMenu, userProfile?.tier])

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
    localStorage.setItem('gsc_sites_cache', JSON.stringify(sites));
  }, [sites]);

  useEffect(() => {
    localStorage.setItem('ga4_sites_cache', JSON.stringify(ga4Sites));
  }, [ga4Sites]);

  useEffect(() => {
    if (!user?.uid || initializedSelectionsForUser !== user.uid) {
      return;
    }

    localStorage.setItem(selectedSiteCacheKey(user.uid), selectedSite);
    localStorage.removeItem('selected_site_cache');
  }, [initializedSelectionsForUser, selectedSite, user?.uid]);

  useEffect(() => {
    if (!user?.uid || initializedSelectionsForUser !== user.uid) {
      return;
    }

    localStorage.setItem(selectedGa4PropertyCacheKey(user.uid), selectedGa4Property);
    localStorage.removeItem('selected_ga4_property_cache');
  }, [initializedSelectionsForUser, selectedGa4Property, user?.uid]);

  useEffect(() => {
    if (userProfile?.activatedSiteUrl && !selectedSite) {
      setSelectedSite(userProfile.activatedSiteUrl);
    }
  }, [selectedSite, userProfile?.activatedSiteUrl]);

  useEffect(() => {
    if (!userProfile || isOnboarding || userProfile.tier === 'enterprise' || !selectedSite) {
      return;
    }

    const selectedSiteStillUnlocked = Boolean(getPreferredSiteUrl(
      selectedSite,
      userProfile.unlockedSites.map((siteUrl) => ({ siteUrl })),
      userProfile.unlockedSites,
      userProfile.tier,
      ga4Sites as SiteLike[],
    ));

    if (selectedSiteStillUnlocked) {
      return;
    }

    setSelectedSite(userProfile.activatedSiteUrl || userProfile.unlockedSites[0] || "");
  }, [ga4Sites, isOnboarding, selectedSite, userProfile]);

  useEffect(() => {
    const userKey = user?.uid || null;
    if (!userKey) {
      setInitializedSelectionsForUser(null);
      return;
    }

    if (!userProfile || initializedSelectionsForUser === userKey) {
      return;
    }

    const cachedSite = localStorage.getItem(selectedSiteCacheKey(userKey)) || "";
    const cachedGa4Property = localStorage.getItem(selectedGa4PropertyCacheKey(userKey)) || "";
    setSelectedSite(cachedSite || userProfile.activatedSiteUrl || userProfile.unlockedSites[0] || "");
    setSelectedGa4Property(cachedGa4Property || userProfile.activatedGa4PropertyId || "");
    setInitializedSelectionsForUser(userKey);
  }, [
    initializedSelectionsForUser,
    user?.uid,
    userProfile?.activatedGa4PropertyId,
    userProfile?.activatedSiteUrl,
    userProfile?.unlockedSites,
  ]);

  useEffect(() => {
    if (!user) {
      setBillingConfig(null)
      return
    }

    if (!showSettingsModal && !backgroundEffectsReady) {
      return;
    }

    getBillingConfig()
      .then(setBillingConfig)
      .catch((error) => {
        console.warn("Failed to load billing config:", error)
        setBillingConfig(null)
      })
  }, [backgroundEffectsReady, showSettingsModal, user])

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

  const [showUnlockModal, setShowUnlockModal] = useState(false)
  const [siteToUnlock, setSiteToUnlock] = useState<string | null>(null)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [showGa4PropertyDialog, setShowGa4PropertyDialog] = useState(false)
  const [isSavingGa4Property, setIsSavingGa4Property] = useState(false)
  const [pendingGa4Property, setPendingGa4Property] = useState("")

  const getPreferredGa4PropertyId = (availableSites: SiteLike[]) => {
    const savedWorkspaceDefault = userProfile?.activatedGa4PropertyId || "";
    const preferred = userProfile?.tier === 'enterprise'
      ? selectedGa4Property || savedWorkspaceDefault
      : savedWorkspaceDefault;
    if (!preferred) {
      return "";
    }

    return availableSites.some((site) => site.siteUrl === preferred) || preferred === userProfile?.activatedGa4PropertyId
      ? preferred
      : "";
  };

  useEffect(() => {
    const googleConnected = Boolean(userProfile?.googleConnected)

    if (googleConnected && isOnboarding) {
      const ga4Service = new Ga4ApiService()
      ga4Service.getProperties()
        .then((fetchedSites) => {
          setGa4Sites(fetchedSites)
        })
        .catch((err) => {
          console.warn("Failed to fetch GA4 properties during onboarding:", err)
          setGa4Sites([])
        })
    }

    if (dataSource === 'gsc' || dataSource === 'blended') {
      if (googleConnected) {
        if (!backgroundEffectsReady && !isOnboarding) {
          fetchOfflineGscSites(userProfile)
            .then((offlineSites) => {
              setSites(prev => mergeUniqueSites(prev, offlineSites));
            })
            .catch(e => console.error("Offline fallback err:", e));
          return;
        }

        setFetchingSites(true)
        setApiError(null)
        const gscService = new GscApiService(null, userProfile?.tier || 'free')
        gscService.getSites()
          .then(fetchedSites => {
            setSessionExpired(false)
            setSites(fetchedSites)
            if (fetchedSites.length > 0 && !isOnboarding) {
              // Persist to user profile so they aren't lost on boot if token expires
              if (user && userProfile) {
                const knownUrls = fetchedSites.map(s => s.siteUrl);
                persistKnownSites(user.uid, knownUrls).catch(e => console.error("Failed caching known sites", e));
              }
            }
          })
          .catch(err => {
            if (isGoogleAuthError(err.message) || err.message.includes('GOOGLE_NOT_CONNECTED')) {
              console.warn("Stored Google connection is missing or expired.");
              
              // Fallback to warehouse-synced / offline sites + known sites from profile
              fetchOfflineGscSites(userProfile)
                .then((offlineSites) => {
                  setSessionExpired(offlineSites.length === 0);
                  setSites(prev => mergeUniqueSites(prev, offlineSites));
                })
                .catch(e => {
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
          .finally(() => setFetchingSites(false))
      } else {
        // No GSC token, populate with offline sites to access local warehouse
        fetchOfflineGscSites(userProfile)
          .then((offlineSites) => {
             if (offlineSites.length > 0) {
               setSessionExpired(true);
             }
             setSites(prev => mergeUniqueSites(prev, offlineSites));
          }).catch(e => {
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
      bingService.getSites()
        .then(fetchedSites => {
          setBingSites(fetchedSites)
        })
        .catch(err => {
          console.error("Failed to fetch Bing sites:", err)
          setApiError(err.message)
        })
        .finally(() => setFetchingSites(false))
    } else if (dataSource === 'ga4' && googleConnected) {
      if (!backgroundEffectsReady && !isOnboarding) {
        return;
      }
      setFetchingSites(true)
      setApiError(null)
      const ga4Service = new Ga4ApiService()
      ga4Service.getProperties()
          .then(fetchedSites => {
            setSessionExpired(false)
            setGa4Sites(fetchedSites)
          if (fetchedSites.length > 0 && !isOnboarding) {
            setSelectedGa4Property(getPreferredGa4PropertyId(fetchedSites))
          }
        })
        .catch(err => {
          if (isGoogleAuthError(err.message) || isGa4ScopeError(err.message) || err.message.includes('GOOGLE_NOT_CONNECTED')) {
            console.warn("Stored Google connection is missing or expired.");
            setSessionExpired(true);
          } else if (err.message.includes("Google Analytics Admin API has not been used in project") || err.message.includes("is disabled")) {
            console.error("GA4 API not enabled:", err)
            setApiError(err.message)
          } else if (err.message === "Failed to fetch") {
            console.error("Network error fetching GA4 sites:", err)
            setApiError("Network error: Unable to connect to Google Analytics API. This could be due to an adblocker, privacy extension, or network connectivity issue.")
          } else {
            console.error("Failed to fetch GA4 sites:", err)
            setApiError(err.message)
          }
        })
        .finally(() => setFetchingSites(false))
    } else if (dataSource === 'ga4' && !googleConnected) {
      setGa4Sites([])
    }
  }, [backgroundEffectsReady, dataSource, isOnboarding, user, userProfile])

  const handleSiteSelect = async (siteUrl: string) => {
    if (!userProfile) return;
    
    const isUnlocked = userProfile.tier === 'enterprise' || userProfile.unlockedSites.includes(siteUrl);
    
    if (isUnlocked) {
      setSelectedSite(siteUrl);
      return;
    }

    const limit = getPlanPropertyLimit(userProfile.tier);
    
    if (limit === null || userProfile.unlockedSites.length < limit) {
      // They can unlock it
      setSiteToUnlock(siteUrl);
      setShowUnlockModal(true);
      setUnlockError(null);
    } else {
      // Reached limit
      setSiteToUnlock(siteUrl);
      setShowUnlockModal(true);
      setUnlockError(`You have reached the maximum number of sites (${limit}) for your ${userProfile.tier} tier.`);
    }
  };

  const confirmUnlock = async () => {
    if (!siteToUnlock) return;
    try {
      await unlockSite(siteToUnlock);
      setSelectedSite(siteToUnlock);
      setShowUnlockModal(false);
      setSiteToUnlock(null);
    } catch (err: any) {
      setUnlockError(err.message);
    }
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

  const handleGa4PropertySelect = async (propertyId: string) => {
    setSelectedGa4Property(propertyId);

    if (isOnboarding) {
      return;
    }

    const selectedProperty = ga4Sites.find((site) => site.siteUrl === propertyId);
    try {
      await updateDefaultGa4Property(propertyId, selectedProperty?.displayName || null);
    } catch (err) {
      console.warn("Failed to persist default GA4 property:", err);
    }
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
      await updateDefaultGa4Property(pendingGa4Property, selectedProperty?.displayName || null);
      setSelectedGa4Property(pendingGa4Property);
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

    const isUnlocked = userProfile?.tier === 'enterprise' || userProfile?.unlockedSites.includes(selectedSite);
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

  const handleStartCheckout = async (targetPlan: "pro" | "enterprise") => {
    setIsStartingCheckout(true);
    const checkoutToast = toast.loading(targetPlan === "enterprise" ? "Preparing enterprise contact flow" : "Preparing checkout", {
      description: targetPlan === "enterprise"
        ? "We’re opening the enterprise upgrade path for this workspace."
        : "We’re opening the upgrade flow for this workspace.",
    });

    try {
      const url = await startCheckout(targetPlan);
      window.open(url, "_blank", "noopener,noreferrer");
      toast.success(targetPlan === "enterprise" ? "Enterprise flow opened" : "Checkout opened", {
        id: checkoutToast,
        description: "Continue the plan change in the newly opened billing window.",
      });
    } catch (err: any) {
      toast.error("Billing flow unavailable", {
        id: checkoutToast,
        description: err.message || "We couldn't open billing right now.",
      });
    } finally {
      setIsStartingCheckout(false);
    }
  };

  const handleOpenBillingPortal = async () => {
    setIsOpeningBillingPortal(true);
    const portalToast = toast.loading("Opening billing portal", {
      description: "We’re preparing your self-serve billing workspace.",
    });

    try {
      const url = await openBillingPortal();
      window.open(url, "_blank", "noopener,noreferrer");
      toast.success("Billing portal opened", {
        id: portalToast,
        description: "Manage payment methods, invoices, and subscription details in the new tab.",
      });
    } catch (err: any) {
      toast.error("Billing portal unavailable", {
        id: portalToast,
        description: err.message || "We couldn't open the billing portal right now.",
      });
    } finally {
      setIsOpeningBillingPortal(false);
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
  const accessibleGscSites =
    userProfile?.tier === 'enterprise'
      ? sites
      : sites.filter((site) => userProfile?.unlockedSites.includes(site.siteUrl));
  const accessibleBingSites =
    userProfile?.tier === 'enterprise'
      ? bingSites
      : bingSites.filter((site) => userProfile?.unlockedSites.includes(site.siteUrl));
  const accessibleGa4Sites =
    userProfile?.tier === 'enterprise'
      ? ga4SitesWithSavedDefault
      : savedGa4Property
        ? ga4SitesWithSavedDefault.filter((site) => site.siteUrl === savedGa4Property.siteUrl)
        : [];
  const accessibleWorkspaceSites = accessibleGscSites.length > 0
    ? accessibleGscSites
    : (userProfile?.unlockedSites || []).map((siteUrl) => ({ siteUrl, permissionLevel: "warehouse" }));

  const currentSites = dataSource === 'ga4' ? accessibleGa4Sites : dataSource === 'bing' ? accessibleBingSites : accessibleGscSites;
  const currentSelection = dataSource === 'ga4' ? selectedGa4Property : selectedSite;
  const showStatusPanels = activeMenu === "Dashboard";
  const showReportToolbar = [
    "AI Content Auditor",
    "Dashboard",
    "LLM Traffic",
    "Page Indexing",
    "Raw Data",
    "Reconciliation",
    "Server Logs",
  ].includes(activeMenu);
  const hasValidSelectedSite = currentSites.some((site) => {
    if (site.siteUrl !== currentSelection) {
      return false;
    }

    if (dataSource === 'ga4') {
      return true;
    }

    return userProfile?.tier === 'enterprise' || Boolean(userProfile?.unlockedSites.includes(site.siteUrl));
  });

  const switchDataSource = (nextSource: DataSource, availableSites: SiteLike[]) => {
    if (dataSource === nextSource) {
      return;
    }

    setDataSource(nextSource);

    if (availableSites.length > 0) {
      if (isOnboarding) {
        if (nextSource === 'ga4') {
          setSelectedGa4Property("");
        }
      } else {
        if (nextSource === 'ga4') {
          setSelectedGa4Property(getPreferredGa4PropertyId(availableSites));
        }
      }
    } else {
      if (nextSource === 'ga4') {
        setSelectedGa4Property("");
      }
    }
  };

  useEffect(() => {
    if (isOnboarding) {
      return;
    }

    if (dataSource === 'ga4') {
      if (currentSites.length === 0) {
        if (ga4Sites.length > 0) {
          return;
        }
        setSelectedGa4Property("");
        return;
      }

      if (!currentSites.some((site) => site.siteUrl === currentSelection)) {
        setSelectedGa4Property(getPreferredGa4PropertyId(currentSites));
      }
      return;
    }

    if (!userProfile || userProfile.tier === 'enterprise') {
      return;
    }

    const selectedSiteIsAccessible = Boolean(selectedSite && userProfile.unlockedSites.includes(selectedSite));
    if (!selectedSite || !selectedSiteIsAccessible) {
      const preferred = getPreferredSiteUrl(
        userProfile.activatedSiteUrl || selectedSite,
        accessibleWorkspaceSites,
        userProfile.unlockedSites,
        userProfile.tier,
        ga4Sites as SiteLike[],
      );
      setSelectedSite((current) => preferred || current);
    }
  }, [accessibleWorkspaceSites, currentSites, currentSelection, dataSource, ga4Sites, isOnboarding, selectedSite, userProfile]);

  useEffect(() => {
    if (!userProfile || isOnboarding || userProfile.tier === 'enterprise') {
      return;
    }

    if (userProfile.activatedGa4PropertyId && selectedGa4Property !== userProfile.activatedGa4PropertyId) {
      setSelectedGa4Property(userProfile.activatedGa4PropertyId);
    }
  }, [isOnboarding, selectedGa4Property, userProfile]);

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
          onOpenPlan={() => openSettings("plan")}
          onSelectGa4Property={setSelectedGa4Property}
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
          <CrawlAutoStarter siteUrl={selectedSite} />
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
                  ga4PropertyId={dataSource === 'ga4' ? selectedGa4Property : userProfile?.activatedGa4PropertyId || null}
                  gscSyncVersion={gscSyncVersion}
                  isCompareMode={isCompareMode}
                  onCompareFromDateChange={handleCompareFromDateChange}
                  onCompareToDateChange={handleCompareToDateChange}
                  onFromDateChange={handleFromDateChange}
                  onOpenRawData={() => setActiveMenu("Raw Data")}
                  onToDateChange={handleToDateChange}
                  onWarehouseCoverageChange={bumpGscSyncVersion}
                  rawDataAvailable={canUseRawExports(userProfile?.tier)}
                  setIsCompareMode={setIsCompareMode}
                />
              )}

              {showStatusPanels && (
                <AppStatusPanels
                  apiError={apiError}
                  bingSitesCount={bingSites.length}
                  billingStatus={userProfile?.billingStatus}
                  dataSource={dataSource}
                  fetchingSites={fetchingSites}
                  fullGa4SitesCount={ga4Sites.length}
                  ga4SitesCount={accessibleGa4Sites.length}
                  googleConnected={Boolean(userProfile?.googleConnected)}
                  gscSitesCount={accessibleGscSites.length}
                  hasValidSelectedSite={hasValidSelectedSite}
                  isConnectingGoogle={isConnectingGoogleData}
                  onConnectGoogle={handleConnectGoogleData}
                  onOpenGa4Setup={() => setShowGa4PropertyDialog(true)}
                  onOpenPlan={() => openSettings("plan")}
                  selectedSite={currentSelection}
                  sessionExpired={sessionExpired}
                />
              )}

              {(activeMenu === "Settings" || activeMenu === "AI Content Auditor" || !( !userProfile?.googleConnected && (((dataSource === 'gsc' || dataSource === 'blended') && sites.length === 0) || (dataSource === 'ga4' && ga4Sites.length === 0) || (dataSource === 'bing' && bingSites.length === 0)) )) && (
                <Suspense fallback={<DashboardContentFallback />}>
                  <AppContent
                    key={`${dataSource}-${selectedSite}-${selectedGa4Property}`}
                    activeMenu={activeMenu}
                    annotations={annotations}
                    apiError={apiError}
                    bingSites={bingSites}
                    compareDateRange={compareDateRange}
                    dataSource={dataSource}
                    dateRange={dateRange}
                    ga4DashboardTab={ga4DashboardTab}
                    ga4Sites={accessibleGa4Sites}
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
                    selectedSite={dataSource === 'ga4' ? selectedGa4Property : selectedSite}
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
        <UnlockSiteDialog
          onClose={() => setShowUnlockModal(false)}
          onConfirm={confirmUnlock}
          onOpenPlan={() => openSettings("plan")}
          open={showUnlockModal}
          siteToUnlock={siteToUnlock}
          unlockError={unlockError}
          userProfile={userProfile}
        />
        <SettingsDialog
          billingConfig={billingConfig}
          dataSource={dataSource}
          googleConnected={Boolean(userProfile?.googleConnected)}
          initialTab={settingsInitialTab}
          isConnectingGoogle={isConnectingGoogleData}
          isDisconnectingGoogle={isDisconnectingGoogleData}
          isOpeningBillingPortal={isOpeningBillingPortal}
          isStartingCheckout={isStartingCheckout}
          isUpdatingDefaultSite={isUpdatingDefaultSite}
          onClose={() => setShowSettingsModal(false)}
          onConnectGoogle={handleConnectGoogleData}
          onDisconnectGoogle={handleDisconnectGoogleData}
          draft={settingsDraft}
          onDraftChange={setSettingsDraft}
          onOpenBillingPortal={handleOpenBillingPortal}
          onSave={handleSaveSettings}
          onSetDefaultSite={handleSetDefaultSite}
          onStartCheckout={handleStartCheckout}
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
