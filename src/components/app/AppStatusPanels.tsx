import { Button, buttonVariants } from "@/components/ui/button";
import { AlertCircle, BarChart3, ExternalLink } from "lucide-react";

type DataSource = "gsc" | "bing" | "ga4";

type AppStatusPanelsProps = {
  accessToken: string | null;
  apiError: string | null;
  bingSitesCount: number;
  dataSource: DataSource;
  fetchingSites: boolean;
  ga4SitesCount: number;
  gscSitesCount: number;
  onSignInWithGoogle: () => Promise<void>;
  selectedSite: string;
  sessionExpired: boolean;
};

function renderNoPropertiesMessage(dataSource: DataSource) {
  if (dataSource === "gsc") {
    return "We couldn't find any Google Search Console properties associated with your account. Please make sure you have set up GSC for your website.";
  }

  if (dataSource === "bing") {
    return "We couldn't find any Bing Webmaster Tools properties. Please make sure your API key is correct and you have sites verified in Bing.";
  }

  return "We couldn't find any Google Analytics 4 properties associated with your account. Please make sure you have set up GA4 for your website.";
}

export function AppStatusPanels({
  accessToken,
  apiError,
  bingSitesCount,
  dataSource,
  fetchingSites,
  ga4SitesCount,
  gscSitesCount,
  onSignInWithGoogle,
  selectedSite,
  sessionExpired,
}: AppStatusPanelsProps) {
  const hasNoSites =
    !accessToken &&
    ((dataSource === "gsc" && gscSitesCount === 0) ||
      (dataSource === "ga4" && ga4SitesCount === 0) ||
      (dataSource === "bing" && bingSitesCount === 0));

  const showDisconnectedBanner =
    (!accessToken || sessionExpired) &&
    ((dataSource === "gsc" && gscSitesCount > 0) || (dataSource === "ga4" && ga4SitesCount > 0));

  const showNoProperties =
    !selectedSite && !fetchingSites && !apiError && (accessToken || dataSource === "bing");

  if (hasNoSites) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center border rounded-lg bg-card shadow-sm space-y-6 mt-8">
        <div className="bg-primary/10 p-4 rounded-full">
          <BarChart3 className="h-12 w-12 text-primary" />
        </div>
        <div className="space-y-2 max-w-md">
          {sessionExpired ? (
            <>
              <h2 className="text-2xl font-bold tracking-tight">Offline & Empty</h2>
              <p className="text-muted-foreground">
                Your Google API access token has expired securely. We attempted to fall back to Offline Mode, but we don't have any cached data available for your current sites.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-bold tracking-tight">Connect your data</h2>
              <p className="text-muted-foreground">
                To view your Google Search Console and Google Analytics 4 performance, you need to connect your Google account. We only request read-only access.
              </p>
            </>
          )}
        </div>
        <Button onClick={onSignInWithGoogle} size="lg" className="px-8">
          Connect Google Account
        </Button>
      </div>
    );
  }

  return (
    <>
      {showDisconnectedBanner && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-600 rounded-lg p-3 mb-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            <div className="text-sm">
              <strong>Live API Disconnected</strong> - Your 1-hour Google Cloud security session expired. You are currently viewing offline Cached & Server Log Data.
            </div>
          </div>
          <Button onClick={onSignInWithGoogle} variant="outline" size="sm" className="shrink-0 border-amber-500/30 text-amber-700 hover:bg-amber-500/20">
            Reconnect Google
          </Button>
        </div>
      )}

      {apiError && (
        <div className="p-6 border border-destructive/50 bg-destructive/10 rounded-lg flex flex-col items-start space-y-4">
          <div className="flex items-center gap-2 text-destructive font-semibold">
            <AlertCircle className="h-5 w-5" />
            <h3>API Access Required</h3>
          </div>
          <p className="text-sm text-foreground">The API needs to be enabled for your Firebase project before we can fetch your data.</p>
          {apiError.includes("https://console.developers.google.com") ? (
            <div className="space-y-4 w-full">
              <div className="p-3 bg-background rounded border text-xs font-mono text-muted-foreground break-all">{apiError}</div>
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
            <div className="p-3 bg-background rounded border text-xs font-mono text-muted-foreground break-all">{apiError}</div>
          )}
        </div>
      )}

      {showNoProperties && (
        <div className="p-8 text-center border rounded-lg bg-card flex flex-col items-center justify-center space-y-3">
          <AlertCircle className="h-10 w-10 text-muted-foreground" />
          <h3 className="text-lg font-medium">No properties found</h3>
          <p className="text-sm text-muted-foreground max-w-md">{renderNoPropertiesMessage(dataSource)}</p>
        </div>
      )}
    </>
  );
}
