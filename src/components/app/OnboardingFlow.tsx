import { useEffect, useMemo, useState } from "react";
import { BarChart3, CheckCircle2, ExternalLink, Globe, KeyRound, Loader2, Lock, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { UserProfile } from "../../contexts/AuthContext";
import type { GscSite } from "../../services/gscService";
import type { SiteLike } from "../../lib/siteSelection";
import { getPlanDefinition, getPlanDisplayName, getPlanPropertyLimit, getRemainingPropertySlots } from "../../../shared/plans";

type OnboardingFlowProps = {
  bingApiKey?: string;
  fetchingSites: boolean;
  fetchingGa4Sites: boolean;
  ga4Sites: SiteLike[];
  googleConnected: boolean;
  isConnectingGoogle: boolean;
  onComplete: (bingApiKey: string, activatedGa4Property?: { siteUrl: string; displayName: string } | null) => Promise<void>;
  onConnectGoogle: () => Promise<void>;
  onOpenPlan: () => void;
  onSelectGa4Property: (siteUrl: string) => void;
  onSelectSite: (siteUrl: string) => void;
  selectedGa4Property: string;
  selectedSite: string;
  sites: GscSite[];
  userName?: string;
  userProfile: UserProfile | null;
};

type OnboardingStep = "connect" | "property" | "bing";

function getPropertyLabel(site: GscSite) {
  return site.siteUrl
    .replace("https://", "")
    .replace("http://", "")
    .replace("sc-domain:", "");
}

export function OnboardingFlow({
  bingApiKey,
  fetchingSites,
  fetchingGa4Sites,
  ga4Sites,
  googleConnected,
  isConnectingGoogle,
  onComplete,
  onConnectGoogle,
  onOpenPlan,
  onSelectGa4Property,
  onSelectSite,
  selectedGa4Property,
  selectedSite,
  sites,
  userName,
  userProfile,
}: OnboardingFlowProps) {
  const [step, setStep] = useState<OnboardingStep>(googleConnected ? "property" : "connect");
  const [bingKeyDraft, setBingKeyDraft] = useState(bingApiKey || "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justConnectedGoogle, setJustConnectedGoogle] = useState(false);
  const planDefinition = getPlanDefinition(userProfile?.tier);
  const planName = getPlanDisplayName(userProfile?.tier);
  const isFirstActivation = !userProfile?.onboardingCompleted;
  const effectiveUnlockedSites = isFirstActivation ? [] : (userProfile?.unlockedSites || []);

  useEffect(() => {
    if (googleConnected) {
      setJustConnectedGoogle(true);
    }
  }, [googleConnected]);

  const propertyOptions = useMemo(() => sites.map((site) => {
    const isUnlocked = getPlanPropertyLimit(userProfile?.tier) === null || effectiveUnlockedSites.includes(site.siteUrl);
    return {
      siteUrl: site.siteUrl,
      label: getPropertyLabel(site),
      isUnlocked,
    };
  }), [effectiveUnlockedSites, sites, userProfile?.tier]);

  const selectedProperty = propertyOptions.find((site) => site.siteUrl === selectedSite);
  const selectedGa4PropertyOption = ga4Sites.find((site) => site.siteUrl === selectedGa4Property) || null;
  const canActivate = Boolean(selectedSite);
  const planLimit = getPlanPropertyLimit(userProfile?.tier);
  const unlockedCount = effectiveUnlockedSites.length;
  const wouldExceedLimit = Boolean(
    selectedProperty &&
    !selectedProperty.isUnlocked &&
    planLimit !== null &&
    unlockedCount >= planLimit,
  );

  const stepIndex = step === "connect" ? 1 : step === "property" ? 2 : 3;
  const remainingSlots = getRemainingPropertySlots(userProfile?.tier, unlockedCount);

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
      setError("Choose your first property before finishing setup.");
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
                your login is ready. Now choose the reporting access and first site this workspace should use.
              </p>
            </div>

            <Card className="border-[#E6ECE8] bg-white/90 shadow-[0_16px_44px_rgba(15,61,46,0.08)] backdrop-blur-xl">
              <CardHeader className="pb-4">
                <CardTitle className="text-base">Setup progress</CardTitle>
                <CardDescription>Three short steps to activate your first workspace.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Progress value={(stepIndex / 3) * 100} className="h-2" />
                <div className="space-y-3">
                  {[
                    { id: "connect", label: "Connect Google data", icon: Globe },
                    { id: "property", label: "Choose first property", icon: Sparkles },
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
                            {index === 1 && "Pick the property you want to activate first."}
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
                  <CardTitle className="text-2xl">Choose your first property</CardTitle>
                  <CardDescription className="text-base leading-7">
                    Activate the site you want the app to open on by default. You can always add more later based on your plan.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {justConnectedGoogle && (
                    <div className="rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                      Google data connected successfully. Your available Search Console properties are ready below.
                    </div>
                  )}

                  <div className="rounded-2xl border border-[#E6ECE8] bg-[#FBFCFB] p-5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium">Plan capacity</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {planLimit === null
                            ? `${planName} includes unlimited property activations.`
                            : `You have used ${unlockedCount} of ${planLimit} property slots on your ${planName} plan.`}
                        </p>
                      </div>
                      {remainingSlots !== null && (
                        <Badge variant={remainingSlots > 0 ? "secondary" : "destructive"}>
                          {remainingSlots} slot{remainingSlots === 1 ? "" : "s"} left
                        </Badge>
                      )}
                    </div>
                  </div>

                  {fetchingSites ? (
                    <div className="rounded-2xl border border-[#E6ECE8] bg-[#FBFCFB] p-6 text-sm text-muted-foreground">
                      Loading your Google Search Console properties...
                    </div>
                  ) : propertyOptions.length > 0 ? (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="onboarding-property">Property</Label>
                        <Select value={selectedSite} onValueChange={onSelectSite}>
                          <SelectTrigger id="onboarding-property" className="h-12">
                            <SelectValue placeholder="Choose a property" />
                          </SelectTrigger>
                          <SelectContent>
                            {propertyOptions.map((site) => (
                              <SelectItem key={site.siteUrl} value={site.siteUrl}>
                                <div className="flex items-center gap-2">
                                  <span>{site.label}</span>
                                  {!site.isUnlocked && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {selectedProperty && (
                        <div className="rounded-2xl border border-[#E6ECE8] bg-[#FBFCFB] p-5">
                          <p className="text-sm font-medium">{selectedProperty.label}</p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {selectedProperty.isUnlocked
                              ? "This property is already active for your account."
                              : planLimit === null
                                ? `This property will use your ${planName} workspace access.`
                                : `This property will use one of your ${planLimit} ${planName} property slots.`}
                          </p>
                        </div>
                      )}

                      <div className="space-y-2">
                        <Label htmlFor="onboarding-ga4-property">Matching GA4 property (optional)</Label>
                        <Select value={selectedGa4Property} onValueChange={onSelectGa4Property}>
                          <SelectTrigger id="onboarding-ga4-property" className="h-12">
                            <SelectValue placeholder={fetchingGa4Sites ? "Loading GA4 properties..." : ga4Sites.length > 0 ? "Choose a GA4 property" : "No GA4 properties found"} />
                          </SelectTrigger>
                          <SelectContent>
                            {ga4Sites.length > 0 ? ga4Sites.map((site) => (
                              <SelectItem key={site.siteUrl} value={site.siteUrl}>
                                {site.displayName || site.siteUrl}
                              </SelectItem>
                            )) : (
                              <SelectItem value="__none__" disabled>
                                No GA4 properties available
                              </SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                        <p className="text-sm text-muted-foreground">
                          GA4 uses a separate property inventory from Search Console. If you have a GA4 property for this site, choose it now. You can also skip this and map it later.
                        </p>
                      </div>

                      {wouldExceedLimit && (
                        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                          <p>
                            You&apos;ve already used all property slots for your current plan. Pick an already unlocked property or upgrade before activating another site.
                          </p>
                          <Button variant="outline" size="sm" className="mt-3 border-amber-300 bg-white/80 text-amber-900 hover:bg-white" onClick={onOpenPlan}>
                            View Plan Options
                          </Button>
                        </div>
                      )}
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
                    disabled={!canActivate || fetchingSites || propertyOptions.length === 0 || wouldExceedLimit}
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
                    <p className="mt-2 text-xs text-muted-foreground">
                      Current plan: {planDefinition.displayName} ({planDefinition.monthlyPriceLabel}/month) with {planLimit === null ? "unlimited properties" : `${planLimit} active propert${planLimit === 1 ? "y" : "ies"}`}.
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
