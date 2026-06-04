import { Button, buttonVariants } from "@/components/ui/button";
import { AlertCircle, BarChart3, ExternalLink, Loader2, PlugZap } from "lucide-react";

type DataSource = "gsc" | "bing" | "ga4" | "blended";

type AppStatusPanelsProps = {
  apiError: string | null;
  bingSitesCount: number;
  dataSource: DataSource;
  fetchingSites: boolean;
  fullGa4SitesCount: number;
  ga4SitesCount: number;
  googleConnected: boolean;
  gscSitesCount: number;
  hasValidSelectedSite: boolean;
  isConnectingGoogle: boolean;
  onConnectGoogle: () => Promise<void>;
  onOpenGa4Setup: () => void;
  selectedSite: string;
  sessionExpired: boolean;
};

function renderNoPropertiesMessage(dataSource: DataSource) {
  if (dataSource === "gsc") {
    return "We couldn't find any Google Search Console properties associated with your account. Please make sure you have set up GSC for your website.";
  }

  if (dataSource === "bing") {
    return "We couldn't find any Bing Webmaster Tools properties yet. Connect Bing in Settings and make sure you have verified sites in Bing Webmaster Tools.";
  }

  if (dataSource === "blended") {
    return "We couldn't find any Search Console properties to blend yet. Connect Google data or sync a Search Console property first, then choose a GA4 property to add onsite behavior metrics.";
  }

  return "We couldn't find any Google Analytics 4 properties for this Google account. Your onboarding property is a Search Console property, and GA4 uses separate properties like properties/123456789. Make sure GA4 exists for the site and that this Google account has access to it.";
}

export function AppStatusPanels({
  apiError,
  bingSitesCount,
  dataSource,
  fetchingSites,
  fullGa4SitesCount,
  ga4SitesCount,
  googleConnected,
  gscSitesCount,
  hasValidSelectedSite,
  isConnectingGoogle,
  onConnectGoogle,
  onOpenGa4Setup,
  selectedSite,
  sessionExpired,
}: AppStatusPanelsProps) {
  const usesGscProperty = dataSource === "gsc" || dataSource === "blended";
  const hasNoSites =
    !googleConnected &&
    ((usesGscProperty && gscSitesCount === 0) ||
      (dataSource === "ga4" && ga4SitesCount === 0));

  const showDisconnectedBanner =
    !fetchingSites &&
    !apiError &&
    Boolean(selectedSite) &&
    !hasValidSelectedSite &&
    (!googleConnected || sessionExpired) &&
    ((usesGscProperty && gscSitesCount > 0) || (dataSource === "ga4" && ga4SitesCount > 0));

  const sourcePropertyCount = usesGscProperty ? gscSitesCount : dataSource === "ga4" ? ga4SitesCount : bingSitesCount;
  const showNoProperties =
    !fetchingSites &&
    !apiError &&
    sourcePropertyCount === 0 &&
    (googleConnected || dataSource === "bing");
  const showGa4PropertySetup =
    !fetchingSites &&
    !apiError &&
    dataSource === "ga4" &&
    googleConnected &&
    ga4SitesCount === 0 &&
    fullGa4SitesCount > 0;
  const showInvalidSelection =
    !fetchingSites &&
    !apiError &&
    sourcePropertyCount > 0 &&
    !hasValidSelectedSite &&
      (googleConnected || dataSource === "bing");
  if (hasNoSites) {
    return (
      <div className="mt-8 flex flex-col items-center justify-center space-y-6 rounded-2xl border border-border bg-card p-12 text-center shadow-[0_16px_44px_rgba(15,61,46,0.06)]">
        <div className="rounded-2xl bg-secondary p-4 text-secondary-foreground">
          <BarChart3 className="h-12 w-12 text-primary" />
        </div>
        <div className="space-y-2 max-w-md">
          {sessionExpired ? (
            <>
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">Offline and empty</h2>
              <p className="text-muted-foreground">
                Your Google API access token has expired securely. We attempted to fall back to Offline Mode, but we don't have any cached data available for your current sites.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">Connect your data</h2>
              <p className="text-muted-foreground">
                To view your Google Search Console and Google Analytics 4 performance, connect your Google data sources. Your app login is already active, and we only request read-only access to the reporting APIs.
              </p>
            </>
          )}
        </div>
        <Button onClick={onConnectGoogle} size="lg" className="px-8" disabled={isConnectingGoogle}>
          {isConnectingGoogle ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {isConnectingGoogle ? "Connecting Google Data..." : "Connect Google Data"}
        </Button>
      </div>
    );
  }

  return (
    <>
      {showDisconnectedBanner && (
        <div className="mb-6 flex flex-col items-center justify-between gap-4 rounded-2xl border border-amber-300 bg-amber-50/90 p-4 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200 sm:flex-row">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            <div className="text-sm">
              <strong>Google data needs attention</strong> - Your app login is still active, but the saved Google reporting connection needs attention. The dashboard is showing the latest stored data until you reconnect.
            </div>
          </div>
          <Button onClick={onConnectGoogle} variant="outline" size="sm" className="shrink-0 border-amber-500/30 text-amber-700 hover:bg-amber-500/20 dark:border-amber-900/60 dark:text-amber-100 dark:hover:bg-amber-900/30" disabled={isConnectingGoogle}>
            {isConnectingGoogle ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {isConnectingGoogle ? "Connecting..." : "Reconnect Google Data"}
          </Button>
        </div>
      )}

      {apiError && (
        <div className="flex flex-col items-start space-y-4 rounded-2xl border border-red-200 bg-red-50/90 p-6 shadow-[0_16px_44px_rgba(127,29,29,0.06)] dark:border-red-900/50 dark:bg-red-950/35">
          <div className="flex items-center gap-2 font-semibold text-red-600">
            <AlertCircle className="h-5 w-5" />
            <h3>API Access Required</h3>
          </div>
          <p className="text-sm text-foreground">The required Google API needs to be enabled before we can fetch live reporting data for this workspace.</p>
          {apiError.includes("https://console.developers.google.com") ? (
            <div className="space-y-4 w-full">
              <div className="break-all rounded-xl border border-[#E6ECE8] bg-white p-3 font-mono text-xs text-muted-foreground">{apiError}</div>
              <a
                href={apiError.match(/https:\/\/console\.developers\.google\.com[^\s]*/)?.[0] || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "default" })}
              >
                Enable API in Google Cloud Console <ExternalLink className="ml-2 h-4 w-4" />
              </a>
              <p className="text-xs text-muted-foreground mt-2">After enabling the API, wait a minute or two, then refresh this page.</p>
            </div>
          ) : (
            <div className="break-all rounded-xl border border-[#E6ECE8] bg-white p-3 font-mono text-xs text-muted-foreground">{apiError}</div>
          )}
        </div>
      )}

      {showGa4PropertySetup && (
        <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-[0_16px_44px_rgba(15,61,46,0.06)]">
          <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_70%_30%,rgba(15,61,46,0.08),transparent_45%)] dark:bg-[radial-gradient(circle_at_70%_30%,rgba(59,130,246,0.18),transparent_45%)]" />
          <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div className="flex max-w-2xl items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground">
                <PlugZap className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm font-semibold text-primary">Analytics setup needed</p>
                <h3 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-foreground">Choose your GA4 property</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Your Google account has GA4 properties available, but none clearly match the active workspace site. Pick the GA4 property for this site so Analytics reports cannot show data from another website.
                </p>
              </div>
            </div>
            <Button onClick={onOpenGa4Setup} className="shrink-0 rounded-xl px-5">Choose GA4 property</Button>
          </div>
        </div>
      )}

      {showNoProperties && !showGa4PropertySetup && (
        <div className="flex flex-col items-center justify-center space-y-3 rounded-2xl border border-border bg-card p-8 text-center shadow-[0_16px_44px_rgba(15,61,46,0.06)]">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-semibold tracking-[-0.01em] text-foreground">No properties found</h3>
          <p className="max-w-md text-sm leading-6 text-muted-foreground">{renderNoPropertiesMessage(dataSource)}</p>
        </div>
      )}

      {showInvalidSelection && (
        <div className="flex flex-col items-center justify-center space-y-3 rounded-2xl border border-border bg-card p-8 text-center shadow-[0_16px_44px_rgba(15,61,46,0.06)]">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Choose a property for this data source</h3>
          <p className="max-w-md text-sm leading-6 text-muted-foreground">
            Your previous selection doesn&apos;t belong to the current {dataSource === "ga4" ? "Google Analytics 4" : dataSource === "bing" ? "Bing Webmaster" : dataSource === "blended" ? "Blended page performance" : "Google Search Console"} view. Pick one from the selector in the top bar to continue.
          </p>
        </div>
      )}
    </>
  );
}
