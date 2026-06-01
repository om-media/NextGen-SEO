import { useEffect, useState } from "react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { BarChart3, Crown, Filter, LayoutDashboard, Settings, Sparkles, Loader2, Bot, Target, Server, FileSearch, Plus, Globe2, PanelsTopLeft } from "lucide-react"
import { getFilters, SavedFilter } from "@/src/services/dbService"
import { useAuth } from "@/src/contexts/AuthContext"
import { getPlanDisplayName, getPlanPropertyLimit, getPlanPropertyLimitLabel, isMultiSitePlan } from "@/shared/plans"

const baseItems = [
  { title: "Dashboard", icon: LayoutDashboard },
  { title: "Rank Tracker", icon: Target },
  { title: "Server Logs", icon: Server },
  { title: "Page Indexing", icon: FileSearch },
  { title: "Crawl Inventory", icon: Globe2 },
  { title: "LLM Traffic", icon: Bot },
  { title: "AI Content Auditor", icon: Sparkles },
  { title: "Settings", icon: Settings },
]

export function AppSidebar({ selectedSite, activeMenu = "Dashboard", onMenuSelect }: { selectedSite?: string, activeMenu?: string, onMenuSelect?: (menu: string) => void }) {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const [loadingFilters, setLoadingFilters] = useState(false)
  const { user, userProfile } = useAuth()
  const canUseMultiSite = isMultiSitePlan(userProfile?.tier)
  const items = canUseMultiSite
    ? [baseItems[0], { title: "Sites", icon: PanelsTopLeft }, ...baseItems.slice(1)]
    : baseItems
  const propertyLimit = getPlanPropertyLimit(userProfile?.tier)

  useEffect(() => {
    if (user && selectedSite) {
      setLoadingFilters(true)
      getFilters(selectedSite)
        .then(filters => {
          if (filters) setSavedFilters(filters)
        })
        .catch(err => console.error("Failed to load filters", err))
        .finally(() => setLoadingFilters(false))
    } else {
      setSavedFilters([])
    }
  }, [user, selectedSite])

  const propertyLimitLabel = getPlanPropertyLimitLabel(userProfile?.tier)
  const planDisplayName = getPlanDisplayName(userProfile?.tier)
  const savedFilterCount = savedFilters.length
  const isPaidPlan = userProfile?.tier === "pro" || userProfile?.tier === "enterprise"
  const activeSiteCount = userProfile
    ? Math.max(userProfile.unlockedSites.length, userProfile.activatedSiteUrl ? 1 : 0)
    : 0

  return (
    <Sidebar className="w-[240px] border-r border-border bg-background">
      <SidebarHeader className="p-4">
        <div className="p-0">
          <div className="flex items-center gap-3 text-lg font-semibold">
            <div className="rounded-2xl bg-primary p-2.5 text-primary-foreground shadow-[0_10px_22px_rgba(15,61,46,0.16)]">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <div className="text-[18px] font-semibold text-foreground">NextGen SEO</div>
              <div className="text-[12px] font-medium text-muted-foreground">Search intelligence</div>
            </div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="px-3 text-[12px] font-semibold normal-case tracking-normal text-muted-foreground">Analytics</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    isActive={activeMenu === item.title}
                    onClick={() => onMenuSelect && onMenuSelect(item.title)}
                    className="interactive-lift h-10 rounded-2xl px-3 data-[active=true]:bg-secondary data-[active=true]:text-secondary-foreground"
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="px-3 text-[12px] font-semibold normal-case tracking-normal text-muted-foreground">Custom Filters</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              {loadingFilters ? (
                <SidebarMenuItem>
                  <div className="flex items-center px-2 py-1.5 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading...
                  </div>
                </SidebarMenuItem>
              ) : (
                <>
                  <SidebarMenuItem>
                    <div className="flex items-center justify-between px-2 py-1.5 text-sm text-muted-foreground">
                      <span>My filters</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{savedFilterCount}</span>
                    </div>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <div className="flex items-center justify-between px-2 py-1.5 text-sm text-muted-foreground">
                      <span>Saved filters</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{savedFilterCount}</span>
                    </div>
                  </SidebarMenuItem>
                  {savedFilters.map((filter) => (
                    <SidebarMenuItem key={filter.id}>
                      <SidebarMenuButton render={<a href="#" />}>
                        <Filter className="h-4 w-4" />
                        <span className="truncate">{filter.name}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </>
              )}
              <SidebarMenuItem>
                <button className="mt-2 flex h-10 w-full items-center gap-2 rounded-2xl border border-border bg-card px-3 text-sm font-medium text-foreground shadow-[0_8px_20px_rgba(15,61,46,0.06)] transition hover:bg-background">
                  <Plus className="h-4 w-4" />
                  Create Filter
                </button>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-4 p-4">
        {!isPaidPlan && (
          <div className="rounded-2xl bg-secondary p-4 text-secondary-foreground shadow-[0_12px_28px_rgba(124,58,237,0.08)]">
            <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-xl bg-card/70 text-amber-500 shadow-sm">
              <Crown className="h-4 w-4" />
            </div>
            <div className="text-sm font-semibold text-primary">Upgrade to Pro</div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">Unlock advanced insights, historical data, and AI recommendations.</p>
            <button className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl bg-card px-3 text-xs font-semibold text-primary shadow-sm transition hover:-translate-y-0.5">
              Upgrade Now
              <span aria-hidden="true">-&gt;</span>
            </button>
          </div>
        )}
        {userProfile && (
          <div className="flex flex-col justify-center space-y-3 rounded-2xl border border-border bg-card p-4 shadow-[0_10px_24px_rgba(15,61,46,0.05)]">
            <div className="mb-1 flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span className="uppercase tracking-wider">{planDisplayName} Plan</span>
              <span>{activeSiteCount} / {propertyLimit === null ? "Unlimited" : propertyLimitLabel} Sites</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width] duration-500"
                style={{ width: propertyLimit === null ? "100%" : `${Math.min(100, Math.max(0, (activeSiteCount / propertyLimit) * 100))}%` }}
              />
            </div>
            <button className="w-fit text-xs font-medium text-primary">View Plan Details</button>
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          &copy; 2026 NextGen SEO
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
