import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/layout/AppSidebar"
import { Overview } from "@/components/dashboard/Overview"
import { GscDataGrid } from "@/components/dashboard/GscDataGrid"
import { QueryCountView } from "@/components/dashboard/QueryCountView"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { AuthProvider, useAuth } from "./contexts/AuthContext"
import { BarChart3, LogOut, AlertCircle, ExternalLink } from "lucide-react"
import { useEffect, useState } from "react"
import { GscApiService, GscSite } from "./services/gscService"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DatePicker } from "@/components/ui/date-picker"
import { subDays } from "date-fns"
import { DateRange } from "react-day-picker"

import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"

function MainApp() {
  const { user, loading, accessToken, signInWithGoogle, signOut, clearAccessToken } = useAuth()
  const [sites, setSites] = useState<GscSite[]>([])
  const [selectedSite, setSelectedSite] = useState<string>("")
  const [fetchingSites, setFetchingSites] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  
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
      setDateRange(prev => ({ ...prev, from: date }))
    }
  }

  const handleToDateChange = (date: Date | undefined) => {
    if (date) {
      setDateRange(prev => ({ ...prev, to: date }))
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

  useEffect(() => {
    if (accessToken) {
      setFetchingSites(true)
      setApiError(null)
      const gscService = new GscApiService(accessToken)
      gscService.getSites()
        .then(fetchedSites => {
          setSites(fetchedSites)
          if (fetchedSites.length > 0) {
            setSelectedSite(fetchedSites[0].siteUrl)
          }
        })
        .catch(err => {
          if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token")) {
            console.warn("GSC Access token expired or invalid. Prompting re-authentication.");
            clearAccessToken()
          } else {
            console.error("Failed to fetch sites:", err)
            setApiError(err.message)
          }
        })
        .finally(() => setFetchingSites(false))
    }
  }, [accessToken, clearAccessToken])

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

  if (!user || !accessToken) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
          <div className="flex flex-col space-y-2 text-center">
            <div className="mx-auto bg-primary text-primary-foreground p-3 rounded-xl mb-4">
              <BarChart3 className="h-8 w-8" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Welcome to NextGen SEO
            </h1>
            <p className="text-sm text-muted-foreground">
              {user && !accessToken 
                ? "Your Google Search Console session has expired (tokens are valid for 1 hour). Please re-authenticate to continue." 
                : "Sign in to connect your Google Search Console"}
            </p>
          </div>
          <Button onClick={signInWithGoogle} className="w-full" size="lg">
            {user && !accessToken ? "Reconnect Google Account" : "Sign in with Google"}
          </Button>
          {user && !accessToken && (
            <Button variant="ghost" onClick={signOut} className="w-full">
              Sign out
            </Button>
          )}
        </div>
      </div>
    )
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
              {sites.length > 0 && (
                <Select value={selectedSite} onValueChange={setSelectedSite}>
                  <SelectTrigger className="w-[250px] h-8 bg-muted/50 border-none">
                    <SelectValue placeholder="Select a property" />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map(site => (
                      <SelectItem key={site.siteUrl} value={site.siteUrl}>
                        {site.siteUrl.replace('https://', '').replace('http://', '').replace('sc-domain:', '')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex items-center gap-4">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" className="relative h-8 w-8 rounded-full" />}>
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={user.photoURL || ""} alt={user.displayName || "User"} />
                    <AvatarFallback>{user.displayName?.charAt(0) || "U"}</AvatarFallback>
                  </Avatar>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="end">
                  <DropdownMenuLabel className="font-normal">
                    <div className="flex flex-col space-y-1">
                      <p className="text-sm font-medium leading-none">{user.displayName}</p>
                      <p className="text-xs leading-none text-muted-foreground">
                        {user.email}
                      </p>
                    </div>
                  </DropdownMenuLabel>
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
                    <div className="flex items-center gap-2 bg-card border rounded-md p-1">
                      <DatePicker date={dateRange.from} setDate={handleFromDateChange} label="From" />
                      <span className="text-muted-foreground text-sm font-medium px-1">to</span>
                      <DatePicker date={dateRange.to} setDate={handleToDateChange} label="To" />
                    </div>
                  </div>
                  {isCompareMode && (
                    <div className="flex items-center gap-2 bg-muted/30 border border-dashed rounded-md p-1">
                      <span className="text-muted-foreground text-sm font-medium px-2">vs</span>
                      <DatePicker date={compareDateRange.from} setDate={handleCompareFromDateChange} label="Compare From" />
                      <span className="text-muted-foreground text-sm font-medium px-1">to</span>
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
                      <Button 
                        render={<a href={apiError.match(/https:\/\/console\.developers\.google\.com[^\s]*/)?.[0] || "#"} target="_blank" rel="noopener noreferrer" />} 
                        variant="default"
                      >
                        Enable API in Google Cloud Console <ExternalLink className="ml-2 h-4 w-4" />
                      </Button>
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
                    We couldn't find any Google Search Console properties associated with your account. 
                    Please make sure you have set up GSC for your website.
                  </p>
                </div>
              )}

              {selectedSite && !apiError && (
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
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <MainApp />
    </AuthProvider>
  )
}
