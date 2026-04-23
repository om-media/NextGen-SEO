import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/layout/AppSidebar"
import { WarehouseSync } from "@/components/dashboard/WarehouseSync"
import { Button } from "@/components/ui/button"
import { AuthProvider, useAuth } from "./contexts/AuthContext"
import { BarChart3 } from "lucide-react"
import { useEffect, useState } from "react"
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
import { AppContent } from "./components/app/AppContent"
import { AppHeader } from "./components/app/AppHeader"
import { AppStatusPanels } from "./components/app/AppStatusPanels"
import { AppToolbar } from "./components/app/AppToolbar"
import { SettingsDialog } from "./components/app/SettingsDialog"
import { UnlockSiteDialog } from "./components/app/UnlockSiteDialog"
import { getPreferredSiteUrl, mergeUniqueSites, type SiteLike } from "./lib/siteSelection"
import { fetchOfflineGscSites, isGa4ScopeError, isGoogleAuthError, persistKnownSites } from "./lib/siteData"

type DataSource = 'gsc' | 'bing' | 'ga4'

function MainApp() {
  const { user, userProfile, loading, accessToken, signInWithGoogle, signOut, clearAccessToken, unlockSite, setBingApiKey } = useAuth()
  const [sites, setSites] = useState<GscSite[]>(() => {
    const saved = localStorage.getItem('gsc_sites_cache');
    return saved ? JSON.parse(saved) : [];
  })
  const [bingSites, setBingSites] = useState<BingSite[]>([])
  const [ga4Sites, setGa4Sites] = useState<{siteUrl: string, displayName: string}[]>(() => {
    const saved = localStorage.getItem('ga4_sites_cache');
    return saved ? JSON.parse(saved) : [];
  })
  const [selectedSite, setSelectedSite] = useState<string>(() => {
    return localStorage.getItem('selected_site_cache') || "";
  })
  const [fetchingSites, setFetchingSites] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [dataSource, setDataSource] = useState<DataSource>('gsc')
  
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [tempBingKey, setTempBingKey] = useState("")

  const [useLiveData, setUseLiveData] = useState(true)

  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [showSystemAnnotations, setShowSystemAnnotations] = useState(true)
  const [showUserAnnotations, setShowUserAnnotations] = useState(true)

  const [activeMenu, setActiveMenu] = useState<string>("Dashboard")

  const handleMenuSelect = (menu: string) => {
    setActiveMenu(menu)
    if (menu === "LLM Traffic") {
      setDataSource('ga4')
    } else if (menu === "Rank Tracker" || menu === "Server Logs" || menu === "Page Indexing") {
      setDataSource('gsc')
    }
  }

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
    fetchAnnotations();
  }, [selectedSite, user?.uid])

  useEffect(() => {
    localStorage.setItem('gsc_sites_cache', JSON.stringify(sites));
  }, [sites]);

  useEffect(() => {
    localStorage.setItem('ga4_sites_cache', JSON.stringify(ga4Sites));
  }, [ga4Sites]);

  useEffect(() => {
    localStorage.setItem('selected_site_cache', selectedSite);
  }, [selectedSite]);

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

  useEffect(() => {
    if (dataSource === 'gsc') {
      if (accessToken) {
        setFetchingSites(true)
        setApiError(null)
        const gscService = new GscApiService(accessToken, userProfile?.tier || 'free')
        gscService.getSites()
          .then(fetchedSites => {
            setSessionExpired(false)
            setSites(fetchedSites)
            if (fetchedSites.length > 0) {
              setSelectedSite(getPreferredSiteUrl(
                selectedSite,
                fetchedSites,
                userProfile?.unlockedSites || [],
                userProfile?.tier,
                ga4Sites as SiteLike[],
              ))
              
              // Persist to user profile so they aren't lost on boot if token expires
              if (user && userProfile) {
                const knownUrls = fetchedSites.map(s => s.siteUrl);
                persistKnownSites(user.uid, knownUrls).catch(e => console.error("Failed caching known sites", e));
              }
            }
          })
          .catch(err => {
            if (isGoogleAuthError(err.message)) {
              console.warn("GSC Access token expired or invalid. Prompting re-authentication.");
              setSessionExpired(true);
              clearAccessToken()
              
              // Fallback to warehouse-synced / offline sites + known sites from profile
              fetchOfflineGscSites(userProfile)
                .then((offlineSites) => {
                  setSites(prev => mergeUniqueSites(prev, offlineSites));
                })
                .catch(e => console.error("Offline fallback err:", e));
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
            setSelectedSite("");
          });
      }
    } else if (dataSource === 'bing' && user) {
      if (!userProfile?.bingApiKey) {
        setBingSites([]);
        setSelectedSite("");
        return;
      }
      setFetchingSites(true)
      setApiError(null)
      const bingService = new BingApiService()
      bingService.getSites()
        .then(fetchedSites => {
          setBingSites(fetchedSites)
          if (fetchedSites.length > 0) {
            setSelectedSite(getPreferredSiteUrl(
              selectedSite,
              fetchedSites,
              userProfile?.unlockedSites || [],
              userProfile?.tier,
              ga4Sites as SiteLike[],
            ))
          }
        })
        .catch(err => {
          console.error("Failed to fetch Bing sites:", err)
          setApiError(err.message)
        })
        .finally(() => setFetchingSites(false))
    } else if (dataSource === 'ga4' && accessToken) {
      setFetchingSites(true)
      setApiError(null)
      const ga4Service = new Ga4ApiService(accessToken)
      ga4Service.getProperties()
        .then(fetchedSites => {
          setSessionExpired(false)
          setGa4Sites(fetchedSites)
          if (fetchedSites.length > 0) {
            setSelectedSite(getPreferredSiteUrl(
              selectedSite,
              fetchedSites,
              userProfile?.unlockedSites || [],
              userProfile?.tier,
              ga4Sites as SiteLike[],
            ))
          }
        })
        .catch(err => {
          if (isGoogleAuthError(err.message) || isGa4ScopeError(err.message)) {
            console.warn("GA4 Access token expired or missing scopes. Prompting re-authentication.");
            setSessionExpired(true);
            clearAccessToken()
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
    }
  }, [accessToken, clearAccessToken, userProfile?.tier, userProfile?.unlockedSites, userProfile?.bingApiKey, dataSource, user])

  const handleSiteSelect = async (siteUrl: string) => {
    if (!userProfile) return;
    
    const isUnlocked = userProfile.tier === 'enterprise' || userProfile.unlockedSites.includes(siteUrl);
    
    if (isUnlocked) {
      setSelectedSite(siteUrl);
      return;
    }

    const limit = userProfile.tier === 'free' ? 1 : userProfile.tier === 'pro' ? 3 : Infinity;
    
    if (userProfile.unlockedSites.length < limit) {
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
    await setBingApiKey(tempBingKey);
    setShowSettingsModal(false);
  };

  const currentSites = dataSource === 'gsc' ? sites : dataSource === 'bing' ? bingSites : ga4Sites;

  const switchDataSource = (nextSource: DataSource, availableSites: SiteLike[]) => {
    if (dataSource === nextSource) {
      return;
    }

    setDataSource(nextSource);

    if (availableSites.length > 0) {
      setSelectedSite(getPreferredSiteUrl(
        selectedSite,
        availableSites,
        userProfile?.unlockedSites || [],
        userProfile?.tier,
        ga4Sites as SiteLike[],
      ));
    }
  };

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

  return (
    <SidebarProvider>
      <GlobalSyncPoller siteUrl={selectedSite} />
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar selectedSite={selectedSite} activeMenu={activeMenu} onMenuSelect={handleMenuSelect} />
        <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
          <AppHeader
            accessToken={accessToken}
            activeMenu={activeMenu}
            currentSites={currentSites}
            dataSource={dataSource}
            onOpenSettings={() => {
              setTempBingKey(userProfile?.bingApiKey || "");
              setShowSettingsModal(true);
            }}
            onSelectSite={handleSiteSelect}
            onSignInWithGoogle={signInWithGoogle}
            onSignOut={signOut}
            onSwitchDataSource={(nextSource) => {
              const availableSites = nextSource === 'gsc' ? sites : nextSource === 'bing' ? bingSites : ga4Sites;
              switchDataSource(nextSource, availableSites);
            }}
            selectedSite={selectedSite}
            user={user}
            userProfile={userProfile}
          />
          <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-auto">
            <div className="max-w-7xl mx-auto space-y-6">
              <AppToolbar
                annotations={annotations}
                compareDateRange={compareDateRange}
                currentSiteUrl={selectedSite}
                dataSource={dataSource}
                dateRange={dateRange}
                firstName={user.displayName?.split(' ')[0]}
                isCompareMode={isCompareMode}
                onAnnotationsChange={fetchAnnotations}
                onCompareFromDateChange={handleCompareFromDateChange}
                onCompareToDateChange={handleCompareToDateChange}
                onFromDateChange={handleFromDateChange}
                onToDateChange={handleToDateChange}
                setIsCompareMode={setIsCompareMode}
                setShowSystemAnnotations={setShowSystemAnnotations}
                setShowUserAnnotations={setShowUserAnnotations}
                setUseLiveData={setUseLiveData}
                showSystemAnnotations={showSystemAnnotations}
                showUserAnnotations={showUserAnnotations}
                useLiveData={useLiveData}
              />

              <AppStatusPanels
                accessToken={accessToken}
                apiError={apiError}
                bingSitesCount={bingSites.length}
                dataSource={dataSource}
                fetchingSites={fetchingSites}
                ga4SitesCount={ga4Sites.length}
                gscSitesCount={sites.length}
                onSignInWithGoogle={signInWithGoogle}
                selectedSite={selectedSite}
                sessionExpired={sessionExpired}
              />

              {!( !accessToken && ((dataSource === 'gsc' && sites.length === 0) || (dataSource === 'ga4' && ga4Sites.length === 0) || (dataSource === 'bing' && bingSites.length === 0)) ) && (
                <AppContent
                  activeMenu={activeMenu}
                  annotations={annotations}
                  apiError={apiError}
                  bingSites={bingSites}
                  compareDateRange={compareDateRange}
                  dataSource={dataSource}
                  dateRange={dateRange}
                  ga4Sites={ga4Sites}
                  ga4UserDimension={ga4UserDimension}
                  isCompareMode={isCompareMode}
                  onGa4UserDimensionChange={setGa4UserDimension}
                  selectedSite={selectedSite}
                  showSystemAnnotations={showSystemAnnotations}
                  showUserAnnotations={showUserAnnotations}
                  sites={sites}
                  useLiveData={useLiveData}
                  userProfile={userProfile}
                />
              )}
            </div>
          </main>
        </div>
      </div>

      <UnlockSiteDialog
        onClose={() => setShowUnlockModal(false)}
        onConfirm={confirmUnlock}
        open={showUnlockModal}
        siteToUnlock={siteToUnlock}
        unlockError={unlockError}
        userProfile={userProfile}
      />
      <SettingsDialog
        dataSource={dataSource}
        onClose={() => setShowSettingsModal(false)}
        onSave={handleSaveSettings}
        onTempBingKeyChange={setTempBingKey}
        open={showSettingsModal}
        selectedSite={selectedSite}
        tempBingKey={tempBingKey}
      />
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
