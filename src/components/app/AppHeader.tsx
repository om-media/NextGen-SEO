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
import { AlertCircle, Lock, LogOut, Settings2 } from "lucide-react";
import type { User } from "firebase/auth";
import type { UserProfile } from "../../contexts/AuthContext";
import type { SiteLike } from "../../lib/siteSelection";

type DataSource = "gsc" | "bing" | "ga4";

type AppHeaderProps = {
  accessToken: string | null;
  activeMenu: string;
  currentSites: SiteLike[];
  dataSource: DataSource;
  onOpenSettings: () => void;
  onSelectSite: (siteUrl: string) => void;
  onSignInWithGoogle: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onSwitchDataSource: (nextSource: DataSource) => void;
  selectedSite: string;
  user: User;
  userProfile: UserProfile | null;
};

function getSiteDisplayName(site: SiteLike) {
  if ("displayName" in site && site.displayName) {
    return site.displayName;
  }

  return site.siteUrl.replace("https://", "").replace("http://", "").replace("sc-domain:", "");
}

export function AppHeader({
  accessToken,
  activeMenu,
  currentSites,
  dataSource,
  onOpenSettings,
  onSelectSite,
  onSignInWithGoogle,
  onSignOut,
  onSwitchDataSource,
  selectedSite,
  user,
  userProfile,
}: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex min-h-14 flex-wrap items-center gap-4 border-b bg-background px-4 py-2 sm:px-6">
      <SidebarTrigger />
      <div className="flex flex-1 items-center gap-4 min-w-0 overflow-x-auto pb-1 sm:pb-0 hide-scrollbars">
        <h1 className="text-lg font-semibold hidden sm:block whitespace-nowrap">{activeMenu}</h1>

        {activeMenu === "Dashboard" && (
          <div className="flex items-center gap-1 sm:gap-2 border rounded-md p-1 bg-muted/30 whitespace-nowrap shrink-0">
            <Button variant={dataSource === "gsc" ? "secondary" : "ghost"} size="sm" className="h-7" onClick={() => onSwitchDataSource("gsc")}>
              Google Search Console
            </Button>
            <Button variant={dataSource === "bing" ? "secondary" : "ghost"} size="sm" className="h-7" onClick={() => onSwitchDataSource("bing")}>
              Bing Webmaster
            </Button>
            <Button variant={dataSource === "ga4" ? "secondary" : "ghost"} size="sm" className="h-7" onClick={() => onSwitchDataSource("ga4")}>
              Google Analytics 4
            </Button>
          </div>
        )}

        {currentSites.length > 0 && (
          <Select value={selectedSite} onValueChange={onSelectSite}>
            <SelectTrigger className="w-[180px] sm:w-[250px] shrink-0 h-8 bg-muted/50 border-none">
              <SelectValue placeholder="Select a property" />
            </SelectTrigger>
            <SelectContent>
              {currentSites.map((site) => {
                const isUnlocked = userProfile?.tier === "enterprise" || userProfile?.unlockedSites.includes(site.siteUrl);
                return (
                  <SelectItem key={site.siteUrl} value={site.siteUrl}>
                    <div className="flex items-center justify-between w-full">
                      <span>{getSiteDisplayName(site)}</span>
                      {!isUnlocked && <Lock className="h-3 w-3 text-muted-foreground ml-2" />}
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}

        {dataSource === "gsc" && !accessToken && (
          <Button
            onClick={onSignInWithGoogle}
            variant="outline"
            size="sm"
            className="h-8 border-yellow-500 text-yellow-600 hover:bg-yellow-50/50 hover:text-yellow-700"
          >
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
