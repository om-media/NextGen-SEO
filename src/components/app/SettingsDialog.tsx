import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, ExternalLink, Loader2, ShieldAlert } from "lucide-react";
import type { UserProfile } from "../../contexts/AuthContext";

type DataSource = "gsc" | "bing" | "ga4" | "blended";

export type SettingsDraft = {
  avatarUrl: string;
  bingApiKey: string;
  bio: string;
  company: string;
  name: string;
};

type SettingsDialogProps = {
  dataSource: DataSource;
  draft: SettingsDraft;
  googleConnected: boolean;
  initialTab?: "profile" | "workspace" | "integrations";
  isConnectingGoogle: boolean;
  isDisconnectingGoogle: boolean;
  isUpdatingDefaultSite: boolean;
  onClose: () => void;
  onConnectGoogle: () => Promise<void>;
  onDisconnectGoogle: () => Promise<void>;
  onDraftChange: (draft: SettingsDraft) => void;
  onSave: () => Promise<void>;
  onSetDefaultSite: () => Promise<void>;
  open: boolean;
  selectedSite: string;
  userEmail?: string | null;
  userProfile: UserProfile | null;
};

function updateDraft(
  draft: SettingsDraft,
  onDraftChange: (draft: SettingsDraft) => void,
  patch: Partial<SettingsDraft>,
) {
  onDraftChange({
    ...draft,
    ...patch,
  });
}

export function SettingsDialog({
  dataSource,
  draft,
  googleConnected,
  initialTab = "profile",
  isConnectingGoogle,
  isDisconnectingGoogle,
  isUpdatingDefaultSite,
  onClose,
  onConnectGoogle,
  onDisconnectGoogle,
  onDraftChange,
  onSave,
  onSetDefaultSite,
  open,
  selectedSite,
  userEmail,
  userProfile,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState(initialTab);

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
    }
  }, [initialTab, open]);

  const displayName = draft.name.trim() || userEmail || "User";
  const avatarFallback = displayName.charAt(0).toUpperCase() || "U";
  const activeSites = userProfile?.unlockedSites || [];
  const knownSites = userProfile?.knownSites || [];
  const bingConnected = Boolean(userProfile?.bingConnected);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b border-border bg-card px-6 py-5">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Manage your profile, workspace defaults, and integrations in one place.</DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="flex max-h-[calc(88vh-84px)] flex-col">
          <div className="border-b border-border bg-background px-6 py-4">
            <TabsList className="grid w-full grid-cols-3 rounded-2xl border border-border bg-card/80 p-1 shadow-sm">
              <TabsTrigger value="profile" className="rounded-xl data-[state=active]:bg-secondary data-[state=active]:text-secondary-foreground data-[state=active]:shadow-sm">Profile</TabsTrigger>
              <TabsTrigger value="workspace" className="rounded-xl data-[state=active]:bg-secondary data-[state=active]:text-secondary-foreground data-[state=active]:shadow-sm">Workspace</TabsTrigger>
              <TabsTrigger value="integrations" className="rounded-xl data-[state=active]:bg-secondary data-[state=active]:text-secondary-foreground data-[state=active]:shadow-sm">Integrations</TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-y-auto bg-background px-6 py-5">
            <TabsContent value="profile" className="mt-0 space-y-5 pt-0">
              <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
                <div className="flex items-center gap-4">
                  <Avatar className="h-16 w-16 ring-1 ring-border">
                    <AvatarImage src={draft.avatarUrl} alt={displayName} />
                    <AvatarFallback>{avatarFallback}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-base font-semibold">{displayName}</p>
                    <p className="text-sm text-muted-foreground">{draft.company.trim() || "No company set yet"}</p>
                    <p className="text-xs text-muted-foreground">{userEmail || "No email available"}</p>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-border bg-card p-4 shadow-sm space-y-2">
                  <Label htmlFor="profile-name">Name</Label>
                  <Input id="profile-name" value={draft.name} onChange={(event) => updateDraft(draft, onDraftChange, { name: event.target.value })} placeholder="Your full name" />
                </div>
                <div className="rounded-2xl border border-border bg-card p-4 shadow-sm space-y-2">
                  <Label htmlFor="profile-company">Company</Label>
                  <Input id="profile-company" value={draft.company} onChange={(event) => updateDraft(draft, onDraftChange, { company: event.target.value })} placeholder="Your company or brand" />
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-card p-4 shadow-sm space-y-2">
                <Label htmlFor="profile-avatar">Avatar image URL</Label>
                <Input id="profile-avatar" value={draft.avatarUrl} onChange={(event) => updateDraft(draft, onDraftChange, { avatarUrl: event.target.value })} placeholder="https://example.com/avatar.jpg" />
                <p className="text-xs text-muted-foreground">Use any hosted image URL. This updates your app profile avatar everywhere in the workspace.</p>
              </div>

              <div className="rounded-2xl border border-border bg-card p-4 shadow-sm space-y-2">
                <Label htmlFor="profile-bio">Bio</Label>
                <Textarea
                  id="profile-bio"
                  value={draft.bio}
                  onChange={(event) => updateDraft(draft, onDraftChange, { bio: event.target.value })}
                  placeholder="A short bio for your workspace profile"
                  className="min-h-24"
                />
              </div>
            </TabsContent>

            <TabsContent value="workspace" className="mt-0 space-y-5 pt-0">
              <div className="rounded-2xl border border-[#E6ECE8] bg-white p-5 shadow-sm space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">Default property</p>
                    <p className="text-sm text-muted-foreground">This property opens first when you come back to the dashboard.</p>
                  </div>
                  <Button variant="outline" onClick={onSetDefaultSite} disabled={!selectedSite || selectedSite === userProfile?.activatedSiteUrl || isUpdatingDefaultSite}>
                    {isUpdatingDefaultSite ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {selectedSite === userProfile?.activatedSiteUrl ? "Current default" : "Make current selection default"}
                  </Button>
                </div>
                <div className="rounded-xl border border-border bg-background px-3 py-2 text-sm">
                  <span className="font-medium">Current default:</span>{" "}
                  {userProfile?.activatedSiteUrl || "No default property saved yet"}
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-card p-5 shadow-sm space-y-3">
                <div>
                  <p className="text-sm font-medium">Active properties</p>
                  <p className="text-sm text-muted-foreground">These properties are included in your workspace.</p>
                </div>
                {activeSites.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {activeSites.map((siteUrl) => (
                      <Badge key={siteUrl} variant="outline" className="max-w-full truncate">
                        {siteUrl}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No active properties yet.</p>
                )}
              </div>

              <div className="rounded-2xl border border-border bg-card p-5 shadow-sm space-y-2">
                <p className="text-sm font-medium">Known properties cache</p>
                <p className="text-sm text-muted-foreground">We currently know about {knownSites.length} properties for faster workspace recovery.</p>
              </div>
            </TabsContent>

            <TabsContent value="integrations" className="mt-0 space-y-5 pt-0">
              <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Google data connection</p>
                    <p className="text-sm text-muted-foreground">Your app login stays separate from Search Console and GA4 access.</p>
                    <div className="flex items-center gap-2 text-sm">
                      {googleConnected ? (
                        <>
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          <span className="text-emerald-700">Connected for Search Console and GA4 source updates</span>
                        </>
                      ) : (
                        <>
                          <span className="h-2 w-2 rounded-full bg-amber-500" />
                          <span className="text-amber-700">Needs attention before Google source data can refresh</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Button variant="outline" onClick={onConnectGoogle} disabled={isConnectingGoogle || isDisconnectingGoogle}>
                      {isConnectingGoogle ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      {googleConnected ? "Reconnect Google Data" : "Connect Google Data"}
                    </Button>
                    {googleConnected && (
                      <Button variant="ghost" onClick={onDisconnectGoogle} disabled={isConnectingGoogle || isDisconnectingGoogle}>
                        {isDisconnectingGoogle ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldAlert className="mr-2 h-4 w-4" />}
                        Disconnect Google Data
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[#E6ECE8] bg-white p-5 shadow-sm space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="bing-key">Bing Webmaster Tools API Key</Label>
                  <Badge variant={bingConnected ? "secondary" : "outline"}>{bingConnected ? "Connected" : "Not connected"}</Badge>
                </div>
                <Input
                  id="bing-key"
                  value={draft.bingApiKey}
                  onChange={(event) => updateDraft(draft, onDraftChange, { bingApiKey: event.target.value })}
                  placeholder="Enter your Bing API key"
                />
                <p className="text-xs text-muted-foreground">Enter a new key to connect Bing, or leave this blank to keep the existing connection unchanged.</p>
              </div>

              <div className="rounded-2xl border border-dashed border-border bg-card p-5 shadow-sm">
                <p className="text-sm font-medium">Need help getting your Bing API key?</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Sign in to Bing Webmaster Tools, verify your site, then open Settings and API Access to generate one key for your account.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <a href="https://www.bing.com/webmasters/about" target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                    Open Bing Webmaster Tools
                    <ExternalLink className="ml-2 h-4 w-4" />
                  </a>
                  <a href="https://learn.microsoft.com/en-us/bingwebmaster/getting-access" target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                    View instructions
                    <ExternalLink className="ml-2 h-4 w-4" />
                  </a>
                </div>
              </div>

              {selectedSite && dataSource === "gsc" && (
                <div className="space-y-2 border-t border-border bg-card pt-4">
                  <Label>Automated analysis</Label>
                  <p className="text-sm text-balance text-muted-foreground">
                    Search Console, GA4, and crawl data are collected in the background for the current workspace site.
                  </p>
                </div>
              )}
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="border-t border-border bg-card px-6 py-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
