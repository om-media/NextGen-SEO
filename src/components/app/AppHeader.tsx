import { SidebarTrigger } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, Bell, Loader2, LogOut, Settings2 } from "lucide-react";
import type { AppUser, UserProfile } from "../../contexts/AuthContext";
import type { SiteLike } from "../../lib/siteSelection";
import { ThemeToggle } from "./ThemeToggle";

type DataSource = "gsc" | "bing" | "ga4" | "blended";

type AppHeaderProps = {
  activeMenu: string;
  currentSites: SiteLike[];
  dataSource: DataSource;
  googleConnected: boolean;
  isConnectingGoogle: boolean;
  onOpenSettings: () => void;
  onSelectSite: (siteUrl: string) => void;
  onConnectGoogle: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onSwitchDataSource: (nextSource: DataSource) => void;
  selectedSite: string;
  selectedWorkspaceSite: string;
  user: AppUser;
  userProfile: UserProfile | null;
};

function getSiteDisplayName(site: SiteLike) {
  if ("displayName" in site && site.displayName) {
    return site.displayName;
  }

  return site.siteUrl.replace("https://", "").replace("http://", "").replace("sc-domain:", "");
}

function getPlainSiteName(siteUrl: string | null | undefined) {
  if (!siteUrl) {
    return "No site selected";
  }

  return siteUrl.replace("https://", "").replace("http://", "").replace("sc-domain:", "").replace(/\/$/, "");
}

const DATA_SOURCE_LABELS: Record<DataSource, string> = {
  bing: "Bing Webmaster",
  blended: "Blended",
  ga4: "Google Analytics 4",
  gsc: "Google Search Console",
};
const DATA_SOURCE_OPTIONS: DataSource[] = ["gsc", "bing", "ga4", "blended"];

function getMenuDisplayLabel(menu: string) {
  if (menu === "Raw Data") {
    return "Source Data";
  }

  return menu;
}

export function AppHeader({
  activeMenu,
  currentSites,
  dataSource,
  googleConnected,
  isConnectingGoogle,
  onOpenSettings,
  onSelectSite,
  onConnectGoogle,
  onSignOut,
  onSwitchDataSource,
  selectedSite,
  selectedWorkspaceSite,
  user,
  userProfile,
}: AppHeaderProps) {
  const displayName = userProfile?.name || user.displayName || user.email.split("@")[0] || "User";
  const avatarUrl = userProfile?.avatarUrl || user.photoURL || "";
  const avatarFallback = displayName.charAt(0).toUpperCase() || "U";
  const selectedSiteOption = currentSites.find((site) => site.siteUrl === selectedSite) || null;
  const showGoogleConnectAction =
    activeMenu === "Dashboard" &&
    (dataSource === "gsc" || dataSource === "blended") &&
    !googleConnected;
  const selectorLabel = dataSource === "ga4" ? "Analytics property" : dataSource === "bing" ? "Bing site" : "Workspace site";
  const shouldShowWorkspaceContext = dataSource === "ga4" && Boolean(selectedWorkspaceSite);

  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-border bg-background/92 px-4 py-2 backdrop-blur-xl sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-3 md:flex-none">
        <SidebarTrigger />
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold leading-none">{getMenuDisplayLabel(activeMenu)}</h1>
          <p className="mt-1 hidden text-[11px] font-medium text-muted-foreground sm:block">Live workspace</p>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2 md:order-3">
        <ThemeToggle />
        <Button variant="outline" size="icon" className="relative h-9 w-9 rounded-2xl border-border bg-card shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
          <Bell className="h-4 w-4" />
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[#16A34A]" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<button className="interactive-lift inline-flex h-10 w-10 items-center justify-center rounded-full bg-transparent p-0 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />}>
            <Avatar className="h-9 w-9 rounded-full">
              <AvatarImage src={avatarUrl} alt={displayName} />
              <AvatarFallback>{avatarFallback}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">{displayName}</p>
                  <p className="text-xs leading-none text-muted-foreground">{user.email}</p>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenSettings} className="cursor-pointer">
              <Settings2 className="mr-2 h-4 w-4" />
              <span>Settings</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSignOut} className="text-destructive focus:text-destructive cursor-pointer">
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="order-3 flex w-full min-w-0 flex-col gap-2 md:order-2 md:w-auto md:flex-1 md:flex-row md:items-center">
        {activeMenu === "Dashboard" && (
          <>
            <div className="flex min-w-0 flex-col gap-1 md:hidden">
              <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Data source</span>
              <Select value={dataSource} onValueChange={(value) => onSwitchDataSource(value as DataSource)}>
                <SelectTrigger className="h-9 w-full rounded-2xl border border-border bg-card shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
                  <SelectValue placeholder="Choose data source">{DATA_SOURCE_LABELS[dataSource]}</SelectValue>
                </SelectTrigger>
                <SelectContent align="start" className="border-border/80 shadow-xl">
                  {DATA_SOURCE_OPTIONS.map((source) => (
                    <SelectItem key={source} value={source}>
                      {DATA_SOURCE_LABELS[source]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="hidden shrink-0 items-center gap-1 whitespace-nowrap rounded-2xl border border-border bg-card p-1 shadow-[0_8px_20px_rgba(15,61,46,0.06)] md:flex">
              <Button aria-label="Show Google Search Console dashboard" variant={dataSource === "gsc" ? "secondary" : "ghost"} size="sm" className="interactive-lift h-8 rounded-xl px-3 data-[state=open]:bg-secondary" onClick={() => onSwitchDataSource("gsc")}>
                Google Search Console
              </Button>
              <Button aria-label="Show Bing Webmaster dashboard" variant={dataSource === "bing" ? "secondary" : "ghost"} size="sm" className="interactive-lift h-8 rounded-xl px-3" onClick={() => onSwitchDataSource("bing")}>
                Bing Webmaster
              </Button>
              <Button aria-label="Show Google Analytics dashboard" variant={dataSource === "ga4" ? "secondary" : "ghost"} size="sm" className="interactive-lift h-8 rounded-xl px-3" onClick={() => onSwitchDataSource("ga4")}>
                Google Analytics 4
              </Button>
              <Button aria-label="Show blended page dashboard" variant={dataSource === "blended" ? "secondary" : "ghost"} size="sm" className="interactive-lift h-8 rounded-xl px-3" onClick={() => onSwitchDataSource("blended")}>
                Blended
              </Button>
            </div>
          </>
        )}

        {currentSites.length > 0 && (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{selectorLabel}</span>
            <Select value={selectedSite} onValueChange={onSelectSite}>
              <SelectTrigger className={`h-9 w-full min-w-0 rounded-2xl border border-border bg-card shadow-[0_8px_20px_rgba(15,61,46,0.06)] md:w-[260px] ${dataSource === "ga4" ? "lg:w-[340px]" : "lg:w-[280px]"}`}>
                <SelectValue placeholder={`Select ${selectorLabel.toLowerCase()}`}>
                  {selectedSiteOption ? getSiteDisplayName(selectedSiteOption) : `Select ${selectorLabel.toLowerCase()}`}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align="start"
                className={dataSource === "ga4" ? "max-w-[min(26rem,calc(100vw-2rem))] border-border/80 shadow-xl" : "border-border/80 shadow-xl"}
              >
                {currentSites.map((site) => (
                  <SelectItem key={site.siteUrl} value={site.siteUrl}>
                    <span className="min-w-0 truncate">{getSiteDisplayName(site)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {shouldShowWorkspaceContext && (
          <div className="flex h-9 min-w-0 items-center rounded-2xl border border-border bg-secondary/70 px-3 text-xs text-muted-foreground md:max-w-[260px]">
            <span className="mr-1 shrink-0 font-semibold text-foreground">Site</span>
            <span className="min-w-0 truncate">{getPlainSiteName(selectedWorkspaceSite)}</span>
          </div>
        )}

        {showGoogleConnectAction && (
          <Button
            onClick={onConnectGoogle}
            variant="outline"
            size="sm"
            className="interactive-lift h-9 w-full border-amber-500/60 bg-amber-50/80 text-amber-700 hover:bg-amber-100/70 hover:text-amber-800 md:w-auto"
            disabled={isConnectingGoogle}
          >
            {isConnectingGoogle ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <AlertCircle className="w-4 h-4 mr-2" />}
            {isConnectingGoogle ? "Connecting..." : "Connect Google Data"}
          </Button>
        )}
      </div>
    </header>
  );
}
