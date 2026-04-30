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
import { AlertCircle, Bell, Loader2, Lock, LogOut, Settings2, Sun } from "lucide-react";
import type { AppUser, UserProfile } from "../../contexts/AuthContext";
import type { SiteLike } from "../../lib/siteSelection";

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
  user: AppUser;
  userProfile: UserProfile | null;
};

function getSiteDisplayName(site: SiteLike) {
  if ("displayName" in site && site.displayName) {
    return site.displayName;
  }

  return site.siteUrl.replace("https://", "").replace("http://", "").replace("sc-domain:", "");
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
  user,
  userProfile,
}: AppHeaderProps) {
  const displayName = userProfile?.name || user.displayName || user.email.split("@")[0] || "User";
  const avatarUrl = userProfile?.avatarUrl || user.photoURL || "";
  const avatarFallback = displayName.charAt(0).toUpperCase() || "U";
  const selectedSiteOption = currentSites.find((site) => site.siteUrl === selectedSite) || null;

  return (
    <header className="sticky top-0 z-10 flex min-h-16 flex-wrap items-center gap-4 border-b border-[#E6ECE8] bg-[#FBFCFB]/92 px-4 py-2 backdrop-blur-xl sm:px-6">
      <SidebarTrigger />
      <div className="flex flex-1 items-center gap-4 min-w-0 overflow-x-auto pb-1 sm:pb-0 hide-scrollbars">
        <div className="hidden sm:block whitespace-nowrap">
          <h1 className="text-[15px] font-semibold leading-none">{activeMenu}</h1>
          <p className="mt-1 text-[11px] font-medium text-[#647067]">Live workspace</p>
        </div>

        {activeMenu === "Dashboard" && (
          <div className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-2xl border border-[#E6ECE8] bg-white p-1 shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
            <Button variant={dataSource === "gsc" ? "secondary" : "ghost"} size="sm" className="interactive-lift h-8 rounded-xl px-3 data-[state=open]:bg-[#EAF4EC]" onClick={() => onSwitchDataSource("gsc")}>
              Google Search Console
            </Button>
            <Button variant={dataSource === "bing" ? "secondary" : "ghost"} size="sm" className="interactive-lift h-8 rounded-xl px-3" onClick={() => onSwitchDataSource("bing")}>
              Bing Webmaster
            </Button>
            <Button variant={dataSource === "ga4" ? "secondary" : "ghost"} size="sm" className="interactive-lift h-8 rounded-xl px-3" onClick={() => onSwitchDataSource("ga4")}>
              Google Analytics 4
            </Button>
            <Button variant={dataSource === "blended" ? "secondary" : "ghost"} size="sm" className="interactive-lift h-8 rounded-xl px-3" onClick={() => onSwitchDataSource("blended")}>
              Blended
            </Button>
          </div>
        )}

        {currentSites.length > 0 && (
          <Select value={selectedSite} onValueChange={onSelectSite}>
            <SelectTrigger className={`h-9 shrink-0 rounded-2xl border border-[#E6ECE8] bg-white shadow-[0_8px_20px_rgba(15,61,46,0.06)] ${dataSource === "ga4" ? "w-[220px] sm:w-[340px]" : "w-[180px] sm:w-[250px]"}`}>
              <SelectValue placeholder="Select a property">
                {selectedSiteOption ? getSiteDisplayName(selectedSiteOption) : "Select a property"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              align="start"
              className={dataSource === "ga4" ? "max-w-[min(26rem,calc(100vw-2rem))] border-border/80 shadow-xl" : "border-border/80 shadow-xl"}
            >
              {currentSites.map((site) => {
                const isUnlocked = dataSource === "ga4"
                  ? true
                  : userProfile?.tier === "enterprise" || userProfile?.unlockedSites.includes(site.siteUrl);
                return (
                  <SelectItem key={site.siteUrl} value={site.siteUrl}>
                    <div className="flex min-w-0 items-center justify-between w-full gap-2">
                      <span className="min-w-0 truncate">{getSiteDisplayName(site)}</span>
                      {!isUnlocked && <Lock className="h-3 w-3 text-muted-foreground ml-2" />}
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}

        {(dataSource === "gsc" || dataSource === "blended") && !googleConnected && (
          <Button
            onClick={onConnectGoogle}
            variant="outline"
            size="sm"
            className="interactive-lift h-9 border-amber-500/60 bg-amber-50/80 text-amber-700 hover:bg-amber-100/70 hover:text-amber-800"
            disabled={isConnectingGoogle}
          >
            {isConnectingGoogle ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <AlertCircle className="w-4 h-4 mr-2" />}
            {isConnectingGoogle ? "Connecting..." : "Connect Google Data"}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" className="h-9 w-9 rounded-2xl border-[#E6ECE8] bg-white shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
          <Sun className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" className="relative h-9 w-9 rounded-2xl border-[#E6ECE8] bg-white shadow-[0_8px_20px_rgba(15,61,46,0.06)]">
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
    </header>
  );
}
