import { useEffect, useMemo, useState } from "react";
import { BarChart3, CheckCircle2, ExternalLink, Globe, KeyRound, Loader2, Search, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import type { UserProfile } from "../../contexts/AuthContext";
import type { GscSite } from "../../services/gscService";
import type { SiteLike } from "../../lib/siteSelection";

type OnboardingFlowProps = {
  fetchingSites: boolean;
  fetchingGa4Sites: boolean;
  ga4Sites: SiteLike[];
  googleConnected: boolean;
  isConnectingGoogle: boolean;
  onComplete: (bingApiKey: string, activatedGa4Property?: { siteUrl: string; displayName: string } | null) => Promise<void>;
  onConnectGoogle: () => Promise<void>;
  onSelectGa4Property: (siteUrl: string) => void;
  onSelectSite: (siteUrl: string) => void;
  selectedGa4Property: string;
  selectedSite: string;
  sites: GscSite[];
  userName?: string;
  userProfile: UserProfile | null;
};

type OnboardingStep = "connect" | "property" | "bing";
const ONBOARDING_STEPS: OnboardingStep[] = ["connect", "property", "bing"];

function getPropertyLabel(site: GscSite) {
  return site.siteUrl
    .replace("https://", "")
    .replace("http://", "")
    .replace("sc-domain:", "");
}

function getGa4PropertyLabel(site: SiteLike) {
  return site.displayName || site.siteUrl;
}

export function OnboardingFlow({
  fetchingSites,
  fetchingGa4Sites,
  ga4Sites,
  googleConnected,
  isConnectingGoogle,
  onComplete,
  onConnectGoogle,
  onSelectGa4Property,
  onSelectSite,
  selectedGa4Property,
  selectedSite,
  sites,
  userName,
  userProfile,
}: OnboardingFlowProps) {
  const [step, setStep] = useState<OnboardingStep>(googleConnected ? "property" : "connect");
  const [bingKeyDraft, setBingKeyDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justConnectedGoogle, setJustConnectedGoogle] = useState(false);
  const [propertySearch, setPropertySearch] = useState("");
  const [ga4Search, setGa4Search] = useState("");
  const isFirstActivation = !userProfile?.onboardingCompleted;
  const effectiveUnlockedSites = isFirstActivation ? [] : (userProfile?.unlockedSites || []);

  useEffect(() => {
    if (googleConnected) {
      setJustConnectedGoogle(true);
    }
  }, [googleConnected]);

  const propertyOptions = useMemo(() => sites.map((site) => {
    return {
      siteUrl: site.siteUrl,
      label: getPropertyLabel(site),
      isUnlocked: true,
    };
  }), [sites]);

  const selectedProperty = propertyOptions.find((site) => site.siteUrl === selectedSite);
  const filteredPropertyOptions = propertyOptions.filter((site) =>
    site.label.toLowerCase().includes(propertySearch.trim().toLowerCase()) ||
    site.siteUrl.toLowerCase().includes(propertySearch.trim().toLowerCase()),
  );
  const filteredGa4Options = ga4Sites.filter((site) => {
    const query = ga4Search.trim().toLowerCase();
    if (!query) return true;
    return getGa4PropertyLabel(site).toLowerCase().includes(query) || site.siteUrl.toLowerCase().includes(query);
  });
  const selectedGa4PropertyOption = ga4Sites.find((site) => site.siteUrl === selectedGa4Property) || null;
  const canActivate = Boolean(selectedSite);
  const stepIndex = ONBOARDING_STEPS.indexOf(step) + 1;

  const handleConnectGoogle = async () => {
    setError(null);
    try {
      await onConnectGoogle();
      setJustConnectedGoogle(true);
      setStep("property");
    } catch (err: any) {
      setError(err.message || "Failed to connect Google.");
    }
  };

  const handleFinish = async () => {
    if (!selectedSite) {
      setError("Choose the default property for this workspace before finishing setup.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onComplete(
        bingKeyDraft,
        selectedGa4PropertyOption
          ? { siteUrl: selectedGa4PropertyOption.siteUrl, displayName: selectedGa4PropertyOption.displayName || selectedGa4PropertyOption.siteUrl }
          : null,
      );
    } catch (err: any) {
      setError(err.message || "We couldn't finish your workspace setup.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(15,61,46,0.12),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(47,125,246,0.10),_transparent_34%),linear-gradient(180deg,_#FBFCFB_0%,_#F8FAF9_48%,_#F6F8F7_100%)] px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-8 lg:flex-row lg:items-start">
        <div className="lg:w-[360px]">
          <div className="sticky top-8 space-y-6">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-[#0F3D2E] p-3 text-white shadow-[0_16px_32px_rgba(15,61,46,0.18)]">
                <BarChart3 className="h-7 w-7" />
              </div>
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-muted-foreground">NextGen SEO</p>
                <h1 className="text-3xl font-semibold tracking-[-0.03em] text-[#0F172A]">Activate your workspace</h1>
              </div>
            </div>

            <div className="space-y-3">
              <Badge variant="secondary" className="rounded-full bg-[#EAF4EC] px-3 py-1 text-xs font-semibold text-[#0F3D2E] hover:bg-[#EAF4EC]">
                Workspace setup
              </Badge>
              <p className="text-base leading-7 text-[#647067]">
                {userName ? `${userName}, ` : ""}
                your login is ready. Now connect reporting access and choose the default site this workspace should open.
              </p>
            </div>

            <Card className="border-[#E6ECE8] bg-white/90 shadow-[0_16px_44px_rgba(15,61,46,0.08)] backdrop-blur-xl">
              <CardHeader className="pb-4">
                <CardTitle className="text-base">Setup progress</CardTitle>
                <CardDescription>Three short steps to activate your workspace and start importing reporting history.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Progress value={(stepIndex / ONBOARDING_STEPS.length) * 100} className="h-2" />
                <div className="space-y-3">
                  {[
                    { id: "connect", label: "Connect Google data", icon: Globe },
                    { id: "property", label: "Choose default property", icon: Sparkles },
                    { id: "bing", label: "Optional Bing setup", icon: KeyRound },
                  ].map((item, index) => {
                    const Icon = item.icon;
                    const isDone = stepIndex > index + 1;
                    const isActive = step === item.id;
                    return (
                      <div
                        key={item.id}
                        className={`flex items-center gap-3 rounded-2xl border px-3 py-3 transition ${
                          isActive ? "border-[#0F3D2E]/25 bg-[#EAF4EC]" : "border-[#E6ECE8] bg-white/70"
                        }`}
                      >
                        <div className={`flex h-9 w-9 items-center justify-center rounded-full ${
                          isDone ? "bg-emerald-100 text-emerald-700" : isActive ? "bg-[#0F3D2E] text-white" : "bg-[#EEF3F0] text-[#647067]"
                        }`}>
                          {isDone ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{item.label}</p>
                          <p className="text-xs text-muted-foreground">
                            {index === 0 && "Enable live Search Console and GA4 reporting."}
                            {index === 1 && "Pick the Search Console and GA4 properties for this workspace."}
                            {index === 2 && "Add Bing now or skip it for later."}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="flex-1">
          <Card className="min-h-[560px] overflow-hidden rounded-[28px] border-[#E6ECE8] bg-white/94 shadow-[0_24px_80px_rgba(15,61,46,0.12)] backdrop-blur-xl">
            {step === "connect" && (
              <>
                <CardHeader className="relative overflow-hidden border-b border-[#E6ECE8] bg-[#FBFCFB] pb-8">
                  <img
                    src="/images/hero-mountains.png"
                    alt=""
                    className="pointer-events-none absolute bottom-[-44px] right-[-160px] w-[620px] max-w-none opacity-60"
                  />
                  <div className="relative flex flex-wrap items-center gap-3">
                    <Badge variant="secondary" className="rounded-full bg-[#EAF4EC] px-3 py-1 text-[#0F3D2E] hover:bg-[#EAF4EC]">
                      Step 1 of 3
                    </Badge>
                    <Badge variant="secondary" className="rounded-full bg-white px-3 py-1 text-[#647067] hover:bg-white">
                      Read-only reporting
                    </Badge>
                  </div>
                  <CardTitle className="relative pt-4 text-3xl tracking-[-0.035em] text-[#0F172A]">Connect reporting data</CardTitle>
                  <CardDescription className="relative max-w-2xl text-base leading-7 text-[#647067]">
                    Link Search Console and GA4 so the dashboard opens with real performance data. Your app login stays separate.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5 pt-6">
                  <div className="grid gap-4 md:grid-cols-3">
                    {[
                      ["What we read", "Search Console properties, GA4 properties, and reporting metrics."],
                      ["What we do not ask for", "No write access, no site changes, and no forced Bing setup."],
                      ["Next", "Pick the first property your workspace should open by default."],
                    ].map(([title, body]) => (
                      <div key={title} className="rounded-2xl border border-[#E6ECE8] bg-[#FBFCFB] p-5">
                        <p className="text-sm font-semibold text-[#0F172A]">{title}</p>
                        <p className="mt-2 text-sm leading-6 text-[#647067]">{body}</p>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-2xl border border-dashed border-[#D9E5DE] bg-white/80 p-5">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-[#0F172A]">Already signed into the app</p>
                        <p className="mt-1 max-w-2xl text-sm leading-6 text-[#647067]">
                          This button only opens Google&apos;s permission window for reporting data. It is not your SaaS registration step.
                        </p>
                      </div>
                      <div className="rounded-xl bg-[#EAF4EC] px-3 py-2 text-xs font-semibold text-[#0F3D2E]">
                        Account ready
                      </div>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="justify-between border-t border-[#E6ECE8] bg-[#FBFCFB]">
                  <p className="max-w-md text-sm text-[#647067]">Read-only reporting access. You can disconnect it later from Settings.</p>
                  <Button onClick={handleConnectGoogle} size="lg" className="min-w-[210px]" disabled={isConnectingGoogle}>
                    {isConnectingGoogle ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {isConnectingGoogle ? "Connecting Google Data..." : "Connect Google Data"}
                  </Button>
                </CardFooter>
              </>
            )}

            {step === "property" && (
              <>
                <CardHeader className="pb-6">
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <Badge variant="secondary" className="rounded-full bg-[#EAF4EC] px-3 py-1 text-[#0F3D2E] hover:bg-[#EAF4EC]">
                      Step 2 of 3
                    </Badge>
                    <Badge variant="secondary" className="rounded-full bg-white px-3 py-1 text-[#647067] hover:bg-white">
                      Default workspace site
                    </Badge>
                  </div>
                  <CardTitle className="text-2xl">Choose your default property</CardTitle>
                  <CardDescription className="text-base leading-7">
                    Pick the site the app opens first. Historical Search Console and Analytics imports will start automatically for the selected workspace.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {justConnectedGoogle && (
                    <div className="rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                      Google data connected successfully. Your available Search Console properties are ready below.
                    </div>
                  )}

                  {fetchingSites ? (
                    <div className="rounded-2xl border border-[#E6ECE8] bg-[#FBFCFB] p-6 text-sm text-muted-foreground">
                      Loading your Google Search Console properties...
                    </div>
                  ) : propertyOptions.length > 0 ? (
                    <>
                      <div className="space-y-3">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                          <div>
                            <Label htmlFor="onboarding-property-search">Search Console property</Label>
                            <p className="mt-1 text-sm text-[#647067]">
                              Search and choose the property this workspace should open first.
                            </p>
                          </div>
                          <p className="text-xs font-medium text-[#647067]">{propertyOptions.length} properties found</p>
                        </div>
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#647067]" />
                          <Input
                            id="onboarding-property-search"
                            value={propertySearch}
                            onChange={(event) => setPropertySearch(event.target.value)}
                            placeholder="Search properties..."
                            className="h-11 rounded-2xl border-[#E6ECE8] bg-white pl-9"
                          />
                        </div>
                        <div className="max-h-[300px] space-y-2 overflow-y-auto rounded-2xl border border-[#E6ECE8] bg-[#FBFCFB] p-2">
                          {filteredPropertyOptions.length > 0 ? filteredPropertyOptions.map((site) => {
                            const isSelected = selectedSite === site.siteUrl;
                            const canUseSlot = true;
                            return (
                              <button
                                key={site.siteUrl}
                                type="button"
                                disabled={!canUseSlot}
                                onClick={() => onSelectSite(site.siteUrl)}
                                className={`flex w-full items-start justify-between gap-4 rounded-2xl border p-4 text-left transition ${
                                  isSelected
                                    ? "border-[#0F3D2E] bg-[#EAF4EC] shadow-[0_10px_24px_rgba(15,61,46,0.08)]"
                                    : "border-transparent bg-white hover:border-[#D9E5DE] hover:bg-white"
                                } ${!canUseSlot ? "cursor-not-allowed opacity-55" : ""}`}
                              >
                                <div className="min-w-0">
                                  <p className="break-all text-sm font-semibold text-[#0F172A]">{site.siteUrl}</p>
                                  <p className="mt-1 break-all text-xs text-[#647067]">Display name: {site.label}</p>
                                </div>
                                <div className="shrink-0 pt-0.5">
                                  {isSelected ? (
                                    <span className="rounded-full bg-[#0F3D2E] px-2.5 py-1 text-xs font-semibold text-white">Selected</span>
                                  ) : canUseSlot ? (
                                    <span className="rounded-full bg-[#EEF3F0] px-2.5 py-1 text-xs font-medium text-[#647067]">Available</span>
                                  ) : null}
                                </div>
                              </button>
                            );
                          }) : (
                            <div className="rounded-2xl border border-dashed border-[#D9E5DE] bg-white p-5 text-sm text-[#647067]">
                              No properties match that search.
                            </div>
                          )}
                        </div>
                      </div>

                      {selectedProperty && (
                        <div className="rounded-2xl border border-[#E6ECE8] bg-[#FBFCFB] p-5">
                          <p className="text-sm font-medium">{selectedProperty.label}</p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {selectedProperty.isUnlocked
                              ? "This property is already active for your account."
                              : "This property will become your default workspace site."}
                          </p>
                        </div>
                      )}

                      <div className="space-y-3">
                        <Label htmlFor="onboarding-ga4-property">Matching GA4 property (optional)</Label>
                        <p className="text-sm text-muted-foreground">
                          GA4 uses a separate property inventory from Search Console. If you have a GA4 property for this site, choose it now. You can also skip this and map it later.
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#647067]" />
                            <Input
                              id="onboarding-ga4-property"
                              value={ga4Search}
                              onChange={(event) => setGa4Search(event.target.value)}
                              placeholder={fetchingGa4Sites ? "Loading GA4 properties..." : "Search GA4 properties..."}
                              className="h-11 rounded-2xl border-[#E6ECE8] bg-white pl-9"
                              disabled={fetchingGa4Sites || ga4Sites.length === 0}
                            />
                          </div>
                          <p className="text-xs font-medium text-[#647067]">
                            {fetchingGa4Sites ? "Loading..." : `${ga4Sites.length} GA4 properties found`}
                          </p>
                        </div>
                        <div className="max-h-[250px] space-y-2 overflow-y-auto rounded-2xl border border-[#E6ECE8] bg-[#FBFCFB] p-2">
                          {fetchingGa4Sites ? (
                            <div className="flex items-center gap-2 rounded-2xl bg-white p-4 text-sm text-[#647067]">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Loading GA4 properties...
                            </div>
                          ) : ga4Sites.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-[#D9E5DE] bg-white p-5 text-sm text-[#647067]">
                              No GA4 properties found. You can finish setup now and map GA4 later from Settings.
                            </div>
                          ) : filteredGa4Options.length > 0 ? (
                            filteredGa4Options.map((site) => {
                              const isSelected = selectedGa4Property === site.siteUrl;
                              const label = getGa4PropertyLabel(site);
                              return (
                                <button
                                  key={site.siteUrl}
                                  type="button"
                                  onClick={() => onSelectGa4Property(site.siteUrl)}
                                  className={`flex w-full items-start justify-between gap-4 rounded-2xl border p-4 text-left transition ${
                                    isSelected
                                      ? "border-[#0F3D2E] bg-[#EAF4EC] shadow-[0_10px_24px_rgba(15,61,46,0.08)]"
                                      : "border-transparent bg-white hover:border-[#D9E5DE] hover:bg-white"
                                  }`}
                                >
                                  <div className="min-w-0">
                                    <p className="break-words text-sm font-semibold text-[#0F172A]">{label}</p>
                                    {label !== site.siteUrl ? (
                                      <p className="mt-1 break-all text-xs text-[#647067]">{site.siteUrl}</p>
                                    ) : null}
                                  </div>
                                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                                    isSelected ? "bg-[#0F3D2E] text-white" : "bg-[#EEF3F0] text-[#647067]"
                                  }`}>
                                    {isSelected ? "Selected" : "GA4"}
                                  </span>
                                </button>
                              );
                            })
                          ) : (
                            <div className="rounded-2xl border border-dashed border-[#D9E5DE] bg-white p-5 text-sm text-[#647067]">
                              No GA4 properties match that search.
                            </div>
                          )}
                        </div>
                        {selectedGa4PropertyOption ? (
                          <div className="flex flex-col gap-2 rounded-2xl border border-[#E6ECE8] bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-[#0F172A]">Selected GA4 property</p>
                              <p className="mt-1 break-words text-sm text-[#647067]">
                                {getGa4PropertyLabel(selectedGa4PropertyOption)}
                              </p>
                            </div>
                            <Button variant="outline" size="sm" onClick={() => onSelectGa4Property("")}>
                              Skip GA4
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-[#D9E5DE] bg-[#FBFCFB] p-6 text-sm leading-7 text-muted-foreground">
                      We couldn&apos;t find any Search Console properties yet. Double-check that the connected Google account has GSC access, then reconnect and try again.
                    </div>
                  )}
                </CardContent>
                <CardFooter className="justify-between">
                  <Button variant="ghost" onClick={() => setStep("connect")}>
                    Back
                  </Button>
                  <Button
                    disabled={!canActivate || fetchingSites || propertyOptions.length === 0}
                    onClick={() => setStep("bing")}
                    size="lg"
                  >
                    Continue
                  </Button>
                </CardFooter>
              </>
            )}

            {step === "bing" && (
              <>
                <CardHeader className="pb-6">
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <Badge variant="secondary" className="rounded-full bg-[#EAF4EC] px-3 py-1 text-[#0F3D2E] hover:bg-[#EAF4EC]">
                      Step 3 of 3
                    </Badge>
                    <Badge variant="secondary" className="rounded-full bg-white px-3 py-1 text-[#647067] hover:bg-white">
                      Optional integration
                    </Badge>
                  </div>
                  <CardTitle className="text-2xl">Optional Bing setup</CardTitle>
                  <CardDescription className="text-base leading-7">
                    Add your Bing Webmaster API key now, or skip it and do it later from Settings. Your Google workspace will still be ready immediately.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="bing-api-key">Bing API key</Label>
                    <Input
                      id="bing-api-key"
                      placeholder="Paste your Bing Webmaster API key"
                      value={bingKeyDraft}
                      onChange={(event) => setBingKeyDraft(event.target.value)}
                    />
                    <p className="text-sm text-muted-foreground">
                      Leave this blank if you want to finish setup now and configure Bing later.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-dashed border-[#D9E5DE] bg-[#FBFCFB] p-5">
                    <p className="text-sm font-medium">Need a Bing API key?</p>
                    <p className="mt-2 text-sm leading-7 text-muted-foreground">
                      Open Bing Webmaster Tools, verify your site if needed, then go to Settings and API Access to generate your key.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <a
                        href="https://www.bing.com/webmasters/about"
                        target="_blank"
                        rel="noreferrer"
                        className={buttonVariants({ variant: "outline" })}
                      >
                        Open Bing Webmaster Tools
                        <ExternalLink className="ml-2 h-4 w-4" />
                      </a>
                      <a
                        href="https://learn.microsoft.com/en-us/bingwebmaster/getting-access"
                        target="_blank"
                        rel="noreferrer"
                        className={buttonVariants({ variant: "ghost" })}
                      >
                        API key instructions
                        <ExternalLink className="ml-2 h-4 w-4" />
                      </a>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[#E6ECE8] bg-[#FBFCFB] p-5">
                    <p className="text-sm font-medium">Your workspace will open with</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {selectedProperty ? `${selectedProperty.label} as your first active property.` : "your selected property once activation finishes."}
                    </p>
                  </div>
                </CardContent>
                <CardFooter className="justify-between">
                  <Button variant="ghost" onClick={() => setStep("property")} disabled={submitting}>
                    Back
                  </Button>
                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setBingKeyDraft("");
                        void handleFinish();
                      }}
                      disabled={submitting}
                    >
                      Skip Bing
                    </Button>
                    <Button onClick={handleFinish} size="lg" disabled={submitting}>
                      {submitting ? "Finishing setup..." : "Finish setup"}
                    </Button>
                  </div>
                </CardFooter>
              </>
            )}

            {error && (
              <div className="px-6 pb-6">
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
