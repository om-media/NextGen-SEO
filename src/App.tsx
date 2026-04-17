import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/layout/AppSidebar"
import { Overview } from "@/components/dashboard/Overview"
import { GscDataGrid } from "@/components/dashboard/GscDataGrid"
import { QueryCountView } from "@/components/dashboard/QueryCountView"
import { Ga4DataGrid } from "@/components/dashboard/Ga4DataGrid"
import { Ga4Overview } from "@/components/dashboard/Ga4Overview"
import { BingDataGrid } from "@/components/dashboard/BingDataGrid"
import { WarehouseSync } from "@/components/dashboard/WarehouseSync"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button, buttonVariants } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuGroup, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuPortal, DropdownMenuSubContent } from "@/components/ui/dropdown-menu"
import { AuthProvider, useAuth } from "./contexts/AuthContext"
import { BarChart3, LogOut, AlertCircle, ExternalLink, Lock, Settings2 } from "lucide-react"
import { useEffect, useState } from "react"
import { GscApiService, GscSite } from "./services/gscService"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DatePicker } from "@/components/ui/date-picker"
import { subDays, differenceInDays } from "date-fns"
import { DateRange } from "react-day-picker"

import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

import { AuthScreen } from "./components/auth/AuthScreen"
import { BingApiService, BingSite } from "./services/bingService"
import { Ga4ApiService } from "./services/ga4Service"
import { Input } from "@/components/ui/input"

function MainApp() {
  const { user, userProfile, loading, accessToken, signInWithGoogle, signOut, clearAccessToken, unlockSite, setTier, setBingApiKey } = useAuth()
  const [sites, setSites] = useState<GscSite[]>([])
  const [bingSites, setBingSites] = useState<BingSite[]>([])
  const [ga4Sites, setGa4Sites] = useState<{siteUrl: string, displayName: string}[]>([])
  const [selectedSite, setSelectedSite] = useState<string>("")
  const [fetchingSites, setFetchingSites] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [dataSource, setDataSource] = useState<'gsc' | 'bing' | 'ga4'>('gsc')
  
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [tempBingKey, setTempBingKey] = useState("")

  const findMatchingSite = (targetUrl: string, availableSites: any[]) => {
    if (!targetUrl) return null;
    const cleanUrl = (url: string) => url?.replace(/^(https?:\/\/|sc-domain:)/, '').replace(/\/$/, '').toLowerCase() || '';
    const targetClean = cleanUrl(targetUrl);
    
    const exactMatch = availableSites.find(s => s.siteUrl === targetUrl);
    if (exactMatch) return exactMatch;

    const fuzzyMatch = availableSites.find(s => {
      const siteClean = cleanUrl(s.siteUrl);
      if (siteClean === targetClean) return true;
      
      // For GA4, siteUrl is 'properties/123', so we check displayName
      if (s.displayName) {
        const displayClean = s.displayName.toLowerCase();
        if (displayClean.includes(targetClean)) return true;
      }
      return false;
    });
    return fuzzyMatch || null;
  }

  // Default date range: last 28 days (ending 2 days ago because GSC data is delayed)
  const [dateRange, setDateRange] = useState<DateRange>({
    from: subDays(new Date(), 30),
    to: subDays(new Date(), 2),
  })

  const [isCompareMode, setIsCompareMode] = useState(false)
  const [compareDateRange, setCompareDateRange] = useState<DateRange>({
    from: subDays(new Date(), 59),
    to: subDays(new Date(), 31),
  })

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
            setSites(fetchedSites)
            if (fetchedSites.length > 0) {
              const match = findMatchingSite(selectedSite, fetchedSites);
              if (match) {
                setSelectedSite(match.siteUrl);
              } else {
                const firstUnlocked = fetchedSites.find(s => userProfile?.tier === 'enterprise' || userProfile?.unlockedSites.includes(s.siteUrl));
                setSelectedSite(firstUnlocked?.siteUrl || fetchedSites[0]?.siteUrl || "")
              }
            }
          })
          .catch(err => {
            if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token")) {
              console.warn("GSC Access token expired or invalid. Prompting re-authentication.");
              clearAccessToken()
              
              // Fallback to warehouse-synced / unlocked sites
              if (userProfile?.unlockedSites && userProfile?.unlockedSites.length > 0) {
                const offlineSites = userProfile.unlockedSites.map(url => ({ siteUrl: url, permissionLevel: 'warehouse' }));
                setSites(offlineSites);
                if (!findMatchingSite(selectedSite, offlineSites)) {
                  setSelectedSite(offlineSites[0].siteUrl);
                }
              }
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
        // No GSC token, populate with mapped unlocked sites to access local warehouse
        if (userProfile?.unlockedSites && userProfile?.unlockedSites.length > 0) {
          const offlineSites = userProfile.unlockedSites.map(url => ({ siteUrl: url, permissionLevel: 'warehouse' }));
          setSites(offlineSites);
          if (!findMatchingSite(selectedSite, offlineSites)) {
            setSelectedSite(offlineSites[0].siteUrl);
          }
        } else {
          setSites([]);
          setSelectedSite("");
        }
      }
    } else if (dataSource === 'bing' && user) {
      if (!userProfile?.bingApiKey) {
        setBingSites([]);
        setSelectedSite("");
        return;
      }
      setFetchingSites(true)
      setApiError(null)
      const bingService = new BingApiService(user.uid)
      bingService.getSites()
        .then(fetchedSites => {
          setBingSites(fetchedSites)
          if (fetchedSites.length > 0) {
            const match = findMatchingSite(selectedSite, fetchedSites);
            if (match) {
              setSelectedSite(match.siteUrl);
            } else {
              const firstUnlocked = fetchedSites.find(s => userProfile?.tier === 'enterprise' || userProfile?.unlockedSites.includes(s.siteUrl));
              setSelectedSite(firstUnlocked?.siteUrl || fetchedSites[0]?.siteUrl || "")
            }
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
          setGa4Sites(fetchedSites)
          if (fetchedSites.length > 0) {
            const match = findMatchingSite(selectedSite, fetchedSites);
            if (match) {
              setSelectedSite(match.siteUrl);
            } else {
              const firstUnlocked = fetchedSites.find(s => userProfile?.tier === 'enterprise' || userProfile?.unlockedSites.includes(s.siteUrl));
              setSelectedSite(firstUnlocked?.siteUrl || fetchedSites[0]?.siteUrl || "")
            }
          }
        })
        .catch(err => {
          if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token") || err.message.includes("insufficient authentication scopes")) {
            console.warn("GA4 Access token expired or missing scopes. Prompting re-authentication.");
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
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar selectedSite={selectedSite} />
        <div className="flex-1 flex flex-col">
          <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b bg-background px-4 sm:px-6">
            <SidebarTrigger />
            <div className="flex-1 flex items-center gap-4">
              <h1 className="text-lg font-semibold hidden sm:block">Dashboard</h1>
              <div className="flex items-center gap-2 border rounded-md p-1 bg-muted/30">
                <Button 
                  variant={dataSource === 'gsc' ? 'secondary' : 'ghost'} 
                  size="sm" 
                  className="h-7"
                  onClick={() => {
                    if (dataSource !== 'gsc') {
                      setDataSource('gsc');
                      if (sites.length > 0) {
                        const match = findMatchingSite(selectedSite, sites);
                        if (match) {
                          setSelectedSite(match.siteUrl);
                        } else {
                          const firstUnlocked = sites.find(s => userProfile?.tier === 'enterprise' || userProfile?.unlockedSites.includes(s.siteUrl));
                          setSelectedSite(firstUnlocked?.siteUrl || sites[0]?.siteUrl || "");
                        }
                      }
                    }
                  }}
                >
                  Google Search Console
                </Button>
                <Button 
                  variant={dataSource === 'bing' ? 'secondary' : 'ghost'} 
                  size="sm" 
                  className="h-7"
                  onClick={() => {
                    if (dataSource !== 'bing') {
                      setDataSource('bing');
                      if (bingSites.length > 0) {
                        const match = findMatchingSite(selectedSite, bingSites);
                        if (match) {
                          setSelectedSite(match.siteUrl);
                        } else {
                          const firstUnlocked = bingSites.find(s => userProfile?.tier === 'enterprise' || userProfile?.unlockedSites.includes(s.siteUrl));
                          setSelectedSite(firstUnlocked?.siteUrl || bingSites[0]?.siteUrl || "");
                        }
                      }
                    }
                  }}
                >
                  Bing Webmaster
                </Button>
                <Button 
                  variant={dataSource === 'ga4' ? 'secondary' : 'ghost'} 
                  size="sm" 
                  className="h-7"
                  onClick={() => {
                    if (dataSource !== 'ga4') {
                      setDataSource('ga4');
                      if (ga4Sites.length > 0) {
                        const match = findMatchingSite(selectedSite, ga4Sites);
                        if (match) {
                          setSelectedSite(match.siteUrl);
                        } else {
                          const firstUnlocked = ga4Sites.find(s => userProfile?.tier === 'enterprise' || userProfile?.unlockedSites.includes(s.siteUrl));
                          setSelectedSite(firstUnlocked?.siteUrl || ga4Sites[0]?.siteUrl || "");
                        }
                      }
                    }
                  }}
                >
                  Google Analytics 4
                </Button>
              </div>
              {(dataSource === 'gsc' ? sites : dataSource === 'bing' ? bingSites : ga4Sites).length > 0 && (
                <Select value={selectedSite} onValueChange={handleSiteSelect}>
                  <SelectTrigger className="w-[250px] h-8 bg-muted/50 border-none">
                    <SelectValue placeholder="Select a property" />
                  </SelectTrigger>
                  <SelectContent>
                    {(dataSource === 'gsc' ? sites : dataSource === 'bing' ? bingSites : ga4Sites).map(site => {
                      const isUnlocked = userProfile?.tier === 'enterprise' || userProfile?.unlockedSites.includes(site.siteUrl);
                      const displayName = 'displayName' in site ? (site as any).displayName : site.siteUrl.replace('https://', '').replace('http://', '').replace('sc-domain:', '');
                      return (
                        <SelectItem key={site.siteUrl} value={site.siteUrl}>
                          <div className="flex items-center justify-between w-full">
                            <span>{displayName}</span>
                            {!isUnlocked && <Lock className="h-3 w-3 text-muted-foreground ml-2" />}
                          </div>
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              )}
              {dataSource === 'gsc' && !accessToken && (
                <Button onClick={signInWithGoogle} variant="outline" size="sm" className="h-8 border-yellow-500 text-yellow-600 hover:bg-yellow-50/50 hover:text-yellow-700">
                  <AlertCircle className="w-4 h-4 mr-2" />
                  Reconnect Google
                </Button>
              )}
            </div>
            <div className="flex items-center gap-4">
              <DropdownMenu>
                <DropdownMenuTrigger render={<button className="inline-flex items-center justify-center whitespace-nowrap rounded-full text-sm font-medium transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 h-8 w-8 relative" />}>
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={user.photoURL || ""} alt={user.displayName || "User"} />
                    <AvatarFallback>{user.displayName?.charAt(0) || "U"}</AvatarFallback>
                  </Avatar>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="font-normal">
                      <div className="flex flex-col space-y-1">
                        <p className="text-sm font-medium leading-none">{user.displayName}</p>
                        <p className="text-xs leading-none text-muted-foreground">
                          {user.email}
                        </p>
                      </div>
                    </DropdownMenuLabel>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => {
                    setTempBingKey(userProfile?.bingApiKey || "");
                    setShowSettingsModal(true);
                  }} className="cursor-pointer">
                    <Settings2 className="mr-2 h-4 w-4" />
                    <span>Settings</span>
                  </DropdownMenuItem>
                  <DropdownMenuGroup>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Settings2 className="mr-2 h-4 w-4" />
                        <span>Test Tiers</span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuPortal>
                        <DropdownMenuSubContent>
                          <DropdownMenuItem onClick={() => setTier('free')}>
                            Free Tier (1 site)
                            {userProfile?.tier === 'free' && " ✓"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setTier('pro')}>
                            Pro Tier (3 sites)
                            {userProfile?.tier === 'pro' && " ✓"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setTier('enterprise')}>
                            Enterprise (Unlimited)
                            {userProfile?.tier === 'enterprise' && " ✓"}
                          </DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuPortal>
                    </DropdownMenuSub>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={signOut} className="text-destructive focus:text-destructive cursor-pointer">
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>Log out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-auto">
            <div className="max-w-7xl mx-auto space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">Welcome back, {user.displayName?.split(' ')[0]}!</h2>
                  <p className="text-muted-foreground">
                    Here's an overview of your search performance.
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center space-x-2">
                      <Switch 
                        id="compare-mode" 
                        checked={isCompareMode}
                        onCheckedChange={setIsCompareMode}
                      />
                      <Label htmlFor="compare-mode" className="text-sm font-medium cursor-pointer">Compare</Label>
                    </div>
                    {selectedSite && dataSource === 'gsc' && (
                      <div className="hidden sm:block">
                        <WarehouseSync siteUrl={selectedSite} />
                      </div>
                    )}
                    <div className="flex items-center gap-2 bg-card border rounded-md p-1">
                      <DatePicker date={dateRange.from} setDate={handleFromDateChange} label="From" />
                      <span className="text-muted-foreground text-sm font-medium px-2">to</span>
                      <DatePicker date={dateRange.to} setDate={handleToDateChange} label="To" />
                    </div>
                  </div>
                  {isCompareMode && (
                    <div className="flex items-center gap-2 bg-muted/30 border border-dashed rounded-md p-1">
                      <span className="text-muted-foreground text-sm font-medium px-2">vs</span>
                      <DatePicker date={compareDateRange.from} setDate={handleCompareFromDateChange} label="Compare From" />
                      <span className="text-muted-foreground text-sm font-medium px-2">to</span>
                      <DatePicker date={compareDateRange.to} setDate={handleCompareToDateChange} label="Compare To" />
                    </div>
                  )}
                </div>
              </div>

              {apiError && (
                <div className="p-6 border border-destructive/50 bg-destructive/10 rounded-lg flex flex-col items-start space-y-4">
                  <div className="flex items-center gap-2 text-destructive font-semibold">
                    <AlertCircle className="h-5 w-5" />
                    <h3>API Access Required</h3>
                  </div>
                  <p className="text-sm text-foreground">
                    The Google Search Console API needs to be enabled for your Firebase project before we can fetch your data.
                  </p>
                  {apiError.includes("https://console.developers.google.com") ? (
                    <div className="space-y-4 w-full">
                      <div className="p-3 bg-background rounded border text-xs font-mono text-muted-foreground break-all">
                        {apiError}
                      </div>
                      <a 
                        href={apiError.match(/https:\/\/console\.developers\.google\.com[^\s]*/)?.[0] || "#"} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className={buttonVariants({ variant: "default" })}
                      >
                        Enable API in Google Cloud Console <ExternalLink className="ml-2 h-4 w-4" />
                      </a>
                      <p className="text-xs text-muted-foreground mt-2">
                        After enabling the API, wait a minute or two, then refresh this page.
                      </p>
                    </div>
                  ) : (
                    <div className="p-3 bg-background rounded border text-xs font-mono text-muted-foreground break-all">
                      {apiError}
                    </div>
                  )}
                </div>
              )}

              {!selectedSite && !fetchingSites && !apiError && (
                <div className="p-8 text-center border rounded-lg bg-card flex flex-col items-center justify-center space-y-3">
                  <AlertCircle className="h-10 w-10 text-muted-foreground" />
                  <h3 className="text-lg font-medium">No properties found</h3>
                  <p className="text-sm text-muted-foreground max-w-md">
                    {dataSource === 'gsc' 
                      ? "We couldn't find any Google Search Console properties associated with your account. Please make sure you have set up GSC for your website."
                      : dataSource === 'bing'
                      ? "We couldn't find any Bing Webmaster Tools properties. Please make sure your API key is correct and you have sites verified in Bing."
                      : "We couldn't find any Google Analytics 4 properties associated with your account. Please make sure you have set up GA4 for your website."}
                  </p>
                </div>
              )}

              {selectedSite && !apiError && dataSource === 'gsc' && sites.some(s => s.siteUrl === selectedSite) && (
                <Tabs defaultValue="overview" className="space-y-4">
                  <TabsList className="bg-transparent border-b rounded-none w-full justify-start h-auto p-0 space-x-6">
                    <TabsTrigger value="overview" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Overview</TabsTrigger>
                    <TabsTrigger value="queries" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Queries</TabsTrigger>
                    <TabsTrigger value="pages" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Pages</TabsTrigger>
                    <TabsTrigger value="countries" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Countries</TabsTrigger>
                    <TabsTrigger value="query-count" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Query Count</TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="space-y-4">
                    <Overview siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                    <GscDataGrid siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                  </TabsContent>
                  <TabsContent value="queries" className="space-y-4">
                    <GscDataGrid siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                  </TabsContent>
                  <TabsContent value="pages" className="space-y-4">
                    <GscDataGrid siteUrl={selectedSite} dimension="page" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                  </TabsContent>
                  <TabsContent value="countries" className="space-y-4">
                    <GscDataGrid siteUrl={selectedSite} dimension="country" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                  </TabsContent>
                  <TabsContent value="query-count" className="space-y-4">
                    <QueryCountView siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                  </TabsContent>
                </Tabs>
              )}

              {selectedSite && !apiError && dataSource === 'bing' && userProfile?.bingApiKey && bingSites.some(s => s.siteUrl === selectedSite) && (
                <div className="space-y-4">
                  <div className="p-4 border rounded-lg bg-card">
                    <h3 className="text-lg font-medium mb-2">Bing Webmaster Tools Data</h3>
                    <p className="text-sm text-muted-foreground">
                      Bing integration is currently in beta. Advanced filtering and comparison features will be added soon.
                    </p>
                  </div>
                  <BingDataGrid siteUrl={selectedSite} />
                </div>
              )}

              {selectedSite && !apiError && dataSource === 'ga4' && ga4Sites.some(s => s.siteUrl === selectedSite) && (
                <Tabs defaultValue="overview" className="space-y-4">
                  <TabsList className="bg-transparent border-b rounded-none w-full justify-start h-auto p-0 space-x-6 overflow-x-auto">
                    <TabsTrigger value="overview" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Overview</TabsTrigger>
                    <TabsTrigger value="pages" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Pages</TabsTrigger>
                    <TabsTrigger value="sources" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Sources/Mediums</TabsTrigger>
                    <TabsTrigger value="countries" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Countries</TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="space-y-4">
                    <Ga4Overview siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                    <Ga4DataGrid siteUrl={selectedSite} dimension="date" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                  </TabsContent>
                  <TabsContent value="pages" className="space-y-4">
                    <Ga4DataGrid siteUrl={selectedSite} dimension="pagePath" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                  </TabsContent>
                  <TabsContent value="sources" className="space-y-4">
                    <Ga4DataGrid siteUrl={selectedSite} dimension="sessionSourceMedium" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                  </TabsContent>
                  <TabsContent value="countries" className="space-y-4">
                    <Ga4DataGrid siteUrl={selectedSite} dimension="country" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
                  </TabsContent>
                </Tabs>
              )}
            </div>
          </main>
        </div>
      </div>

      <Dialog open={showUnlockModal} onOpenChange={setShowUnlockModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unlock Property</DialogTitle>
            <DialogDescription>
              {unlockError ? (
                <span className="text-destructive">{unlockError}</span>
              ) : (
                <span>
                  You are about to unlock <strong>{siteToUnlock}</strong>. 
                  Your current tier ({userProfile?.tier}) allows you to unlock up to {userProfile?.tier === 'free' ? 1 : userProfile?.tier === 'pro' ? 3 : 'unlimited'} properties.
                  Once unlocked, you cannot remove it.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowUnlockModal(false)}>Cancel</Button>
            {!unlockError && (
              <Button onClick={confirmUnlock}>Confirm Unlock</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showSettingsModal} onOpenChange={setShowSettingsModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>
              Configure your API keys and integrations.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="bing-key">Bing Webmaster Tools API Key</Label>
              <Input 
                id="bing-key" 
                value={tempBingKey} 
                onChange={(e) => setTempBingKey(e.target.value)} 
                placeholder="Enter your Bing API Key"
              />
              <p className="text-xs text-muted-foreground">
                You can generate this key in the Bing Webmaster Tools portal under Settings &gt; API Access.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSettingsModal(false)}>Cancel</Button>
            <Button onClick={handleSaveSettings}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  )
}

import { ErrorBoundary } from "./components/ErrorBoundary"

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <MainApp />
      </AuthProvider>
    </ErrorBoundary>
  )
}
