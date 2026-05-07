import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Overview } from "@/components/dashboard/Overview";
import { AnnotationsSettings } from "@/components/dashboard/AnnotationsSettings";
import { BlendedPagesView } from "@/components/dashboard/BlendedPagesView";
import { GscDataGrid } from "@/components/dashboard/GscDataGrid";
import { QueryCountView } from "@/components/dashboard/QueryCountView";
import { Ga4DataGrid } from "@/components/dashboard/Ga4DataGrid";
import { Ga4Overview } from "@/components/dashboard/Ga4Overview";
import { Ga4LlmTraffic } from "@/components/dashboard/Ga4LlmTraffic";
import { Ga4Demographics } from "@/components/dashboard/Ga4Demographics";
import { BingDataGrid } from "@/components/dashboard/BingDataGrid";
import { CrawlInventoryView } from "@/components/dashboard/CrawlInventoryView";
import { LogAnalyzerView } from "@/components/dashboard/LogAnalyzerView";
import { PageIndexingView } from "@/components/dashboard/PageIndexingView";
import { RawDataView } from "@/components/dashboard/RawDataView";
import { ReconciliationView } from "@/components/dashboard/ReconciliationView";
import { WorkspaceSitesView } from "@/components/dashboard/WorkspaceSitesView";
import { DataCoveragePanel } from "@/components/dashboard/DataCoveragePanel";
import { AIContentAuditorView } from "@/components/dashboard/AIContentAuditorView";
import { RankTrackerView } from "../dashboard/RankTrackerView";
import type { DateRange } from "react-day-picker";
import type { Annotation } from "../../services/annotationsService";
import type { BingSite } from "../../services/bingService";
import type { GscSite } from "../../services/gscService";
import type { UserProfile } from "../../contexts/AuthContext";
import { canUseRawExports, canUseReconciliation, isMultiSitePlan } from "@/shared/plans";

type DataSource = "gsc" | "bing" | "ga4" | "blended";
type Ga4Dimension = "country" | "city" | "region" | "deviceCategory" | "browser" | "operatingSystem";
export type GscDashboardTab = "overview" | "pages" | "queries" | "countries" | "query-count";
export type Ga4DashboardTab = "overview" | "events" | "pages" | "sources" | "countries";

type AppContentProps = {
  activeMenu: string;
  annotations: Annotation[];
  apiError: string | null;
  bingSites: BingSite[];
  compareDateRange: DateRange;
  dataSource: DataSource;
  dateRange: DateRange;
  ga4DashboardTab: Ga4DashboardTab;
  ga4Sites: Array<{ siteUrl: string; displayName: string }>;
  ga4UserDimension: Ga4Dimension;
  gscDashboardTab: GscDashboardTab;
  isCompareMode: boolean;
  onAnnotationsChange: () => Promise<void>;
  onGa4DashboardTabChange: (value: Ga4DashboardTab) => void;
  onGa4UserDimensionChange: (value: Ga4Dimension) => void;
  onGscDashboardTabChange: (value: GscDashboardTab) => void;
  onOpenSettings: (tab?: "profile" | "plan" | "workspace" | "integrations") => void;
  onActivateWorkspaceSite: (siteUrl: string) => Promise<void>;
  onOpenSiteWorkspace: (siteUrl: string, menu: "Dashboard" | "Crawl Inventory" | "Raw Data" | "Reconciliation") => void;
  selectedSite: string;
  setShowSystemAnnotations: (value: boolean) => void;
  setShowUserAnnotations: (value: boolean) => void;
  showSystemAnnotations: boolean;
  showUserAnnotations: boolean;
  sites: GscSite[];
  useLiveData: boolean;
  userProfile: UserProfile | null;
};

function getVisibleAnnotations(annotations: Annotation[], showSystemAnnotations: boolean, showUserAnnotations: boolean) {
  return annotations.filter(
    (annotation) =>
      (annotation.type === "system" && showSystemAnnotations) ||
      (annotation.type === "user" && showUserAnnotations),
  );
}

export function AppContent({
  activeMenu,
  annotations,
  apiError,
  bingSites,
  compareDateRange,
  dataSource,
  dateRange,
  ga4DashboardTab,
  ga4Sites,
  ga4UserDimension,
  gscDashboardTab,
  isCompareMode,
  onAnnotationsChange,
  onGa4DashboardTabChange,
  onGa4UserDimensionChange,
  onGscDashboardTabChange,
  onActivateWorkspaceSite,
  onOpenSettings,
  onOpenSiteWorkspace,
  selectedSite,
  setShowSystemAnnotations,
  setShowUserAnnotations,
  showSystemAnnotations,
  showUserAnnotations,
  sites,
  useLiveData,
  userProfile,
}: AppContentProps) {
  const visibleAnnotations = getVisibleAnnotations(annotations, showSystemAnnotations, showUserAnnotations);
  const isUnlockedSite = (siteUrl: string) =>
    userProfile?.tier === "enterprise" || Boolean(userProfile?.unlockedSites.includes(siteUrl));
  const rawWorkspaceSite = userProfile?.activatedSiteUrl || (!selectedSite.startsWith("properties/") ? selectedSite : "");
  const canUseMultiSite = isMultiSitePlan(userProfile?.tier);
  const dashboardTabListClass = "w-full justify-start gap-10 rounded-none border-b border-border bg-transparent p-0";
  const dashboardTabTriggerClass = "flex-none rounded-none border-0 bg-transparent px-0 py-3 text-sm font-medium text-muted-foreground shadow-none transition-colors after:inset-x-0 after:bottom-[-1px] after:bg-primary data-active:bg-transparent data-active:text-primary data-active:shadow-none";

  return (
    <>
      {selectedSite && !apiError && dataSource === "gsc" && sites.some((site) => site.siteUrl === selectedSite) && isUnlockedSite(selectedSite) && activeMenu === "Dashboard" && (
        <Tabs
          value={gscDashboardTab}
          onValueChange={(value) => onGscDashboardTabChange(value as GscDashboardTab)}
          className="space-y-4"
        >
          <TabsList variant="line" className={dashboardTabListClass}>
            <TabsTrigger value="overview" className={dashboardTabTriggerClass}>Overview</TabsTrigger>
            <TabsTrigger value="pages" className={dashboardTabTriggerClass}>Pages</TabsTrigger>
            <TabsTrigger value="queries" className={dashboardTabTriggerClass}>Queries</TabsTrigger>
            <TabsTrigger value="countries" className={dashboardTabTriggerClass}>Countries</TabsTrigger>
            <TabsTrigger value="query-count" className={dashboardTabTriggerClass}>Visible Queries</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="space-y-4">
            <Overview
              siteUrl={selectedSite}
              dateRange={dateRange}
              isCompareMode={isCompareMode}
              compareDateRange={compareDateRange}
              annotations={visibleAnnotations}
              useLiveData={useLiveData}
              annotationControls={
                <AnnotationsSettings
                  currentSiteUrl={selectedSite}
                  annotations={annotations}
                  onAnnotationsChange={onAnnotationsChange}
                  showSystemAnnotations={showSystemAnnotations}
                  setShowSystemAnnotations={setShowSystemAnnotations}
                  showUserAnnotations={showUserAnnotations}
                  setShowUserAnnotations={setShowUserAnnotations}
                />
              }
            />
            <DataCoveragePanel
              dateRange={dateRange}
              ga4PropertyId={userProfile?.activatedGa4PropertyId || null}
              siteUrl={selectedSite}
            />
            <GscDataGrid siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} useLiveData={useLiveData} hideTrackerButton={true} />
          </TabsContent>
          <TabsContent value="queries" className="space-y-4">
            <GscDataGrid siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} useLiveData={useLiveData} />
          </TabsContent>
          <TabsContent value="pages" className="space-y-4">
            <GscDataGrid siteUrl={selectedSite} dimension="page" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} useLiveData={useLiveData} />
          </TabsContent>
          <TabsContent value="countries" className="space-y-4">
            <GscDataGrid siteUrl={selectedSite} dimension="country" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} useLiveData={useLiveData} />
          </TabsContent>
          <TabsContent value="query-count" className="space-y-4">
            <QueryCountView siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} useLiveData={useLiveData} />
          </TabsContent>
        </Tabs>
      )}

      {selectedSite && !apiError && dataSource === "blended" && sites.some((site) => site.siteUrl === selectedSite) && isUnlockedSite(selectedSite) && activeMenu === "Dashboard" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-[0_12px_32px_rgba(15,61,46,0.04)]">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Blended page decisions</p>
            <h3 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-foreground">Pages Performance</h3>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              This view joins GSC search visibility with GA4 onsite behavior by canonical page path. It does not blend GA4 sessions into query-level data.
            </p>
          </div>
          <BlendedPagesView
            siteUrl={selectedSite}
            dateRange={dateRange}
            isCompareMode={isCompareMode}
            compareDateRange={compareDateRange}
            ga4PropertyId={userProfile?.activatedGa4PropertyId || null}
          />
          <DataCoveragePanel
            dateRange={dateRange}
            ga4PropertyId={userProfile?.activatedGa4PropertyId || null}
            siteUrl={selectedSite}
          />
        </div>
      )}

      {selectedSite && !apiError && dataSource === "bing" && userProfile?.bingConnected && bingSites.some((site) => site.siteUrl === selectedSite) && isUnlockedSite(selectedSite) && activeMenu === "Dashboard" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
            <h3 className="mb-1 text-lg font-semibold tracking-[-0.01em] text-foreground">Bing Webmaster Tools data</h3>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">Review Bing query visibility for the active workspace site and export the loaded query rows when you need parity with Bing Webmaster Tools.</p>
          </div>
          <BingDataGrid siteUrl={selectedSite} />
        </div>
      )}

      {selectedSite && !apiError && dataSource === "ga4" && ga4Sites.some((site) => site.siteUrl === selectedSite) && activeMenu === "Dashboard" && (
        <Tabs
          value={ga4DashboardTab}
          onValueChange={(value) => onGa4DashboardTabChange(value as Ga4DashboardTab)}
          className="space-y-4"
        >
          <TabsList variant="line" className={dashboardTabListClass}>
            <TabsTrigger value="overview" className={dashboardTabTriggerClass}>Overview</TabsTrigger>
            <TabsTrigger value="events" className={dashboardTabTriggerClass}>Events</TabsTrigger>
            <TabsTrigger value="pages" className={dashboardTabTriggerClass}>Pages</TabsTrigger>
            <TabsTrigger value="sources" className={dashboardTabTriggerClass}>Traffic</TabsTrigger>
            <TabsTrigger value="countries" className={dashboardTabTriggerClass}>Users</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="space-y-4">
            <Ga4Overview siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} annotations={visibleAnnotations} />
            {rawWorkspaceSite && (
              <DataCoveragePanel
                dateRange={dateRange}
                ga4PropertyId={selectedSite}
                siteUrl={rawWorkspaceSite}
              />
            )}
            <Ga4DataGrid siteUrl={selectedSite} dimension="date" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
          </TabsContent>
          <TabsContent value="events" className="space-y-4">
            <Ga4DataGrid siteUrl={selectedSite} dimension="eventName" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} metrics={["eventCount", "totalUsers"]} />
          </TabsContent>
          <TabsContent value="pages" className="space-y-4">
            <Ga4DataGrid siteUrl={selectedSite} dimension="pagePath" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
          </TabsContent>
          <TabsContent value="sources" className="space-y-4">
            <Ga4DataGrid siteUrl={selectedSite} dimension="sessionSourceMedium" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
          </TabsContent>
          <TabsContent value="countries" className="space-y-4">
            <Ga4Demographics siteUrl={selectedSite} dateRange={dateRange} />
            <div className="mt-8 flex items-center justify-between rounded-2xl border border-border bg-card p-5 shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
              <div>
                <h3 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Detailed user data</h3>
                <p className="mt-1 text-sm text-muted-foreground">Switch the dimension used for the detailed GA4 user breakdown.</p>
              </div>
              <Select value={ga4UserDimension} onValueChange={(value) => onGa4UserDimensionChange(value as Ga4Dimension)}>
                <SelectTrigger className="w-[190px] rounded-xl border-border bg-card shadow-sm">
                  <SelectValue placeholder="Select Dimension" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="country">Country</SelectItem>
                  <SelectItem value="city">City</SelectItem>
                  <SelectItem value="region">Region</SelectItem>
                  <SelectItem value="deviceCategory">Device Category</SelectItem>
                  <SelectItem value="browser">Browser</SelectItem>
                  <SelectItem value="operatingSystem">Operating System</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Ga4DataGrid siteUrl={selectedSite} dimension={ga4UserDimension} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
          </TabsContent>
        </Tabs>
      )}

      {selectedSite && !apiError && dataSource === "ga4" && activeMenu === "LLM Traffic" && ga4Sites.some((site) => site.siteUrl === selectedSite) && (
        <div className="space-y-4">
          <Ga4LlmTraffic siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
        </div>
      )}

      {selectedSite && !apiError && isUnlockedSite(selectedSite) && activeMenu === "Rank Tracker" && (
        <div className="space-y-4">
          <RankTrackerView siteUrl={selectedSite} />
        </div>
      )}

      {selectedSite && !apiError && isUnlockedSite(selectedSite) && activeMenu === "Server Logs" && (
        <div className="space-y-4">
          <LogAnalyzerView siteUrl={selectedSite} dateRange={dateRange} />
        </div>
      )}

      {selectedSite && !apiError && isUnlockedSite(selectedSite) && activeMenu === "Page Indexing" && (
        <div className="space-y-4">
          <PageIndexingView siteUrl={selectedSite} dateRange={dateRange} isLive={useLiveData} />
        </div>
      )}

      {selectedSite && !apiError && isUnlockedSite(selectedSite) && activeMenu === "Crawl Inventory" && (
        <div className="space-y-4">
          <CrawlInventoryView
            siteUrl={selectedSite}
            defaultStartUrl={userProfile?.activatedSiteUrl || (selectedSite.startsWith("http") ? selectedSite : null)}
          />
        </div>
      )}

      {rawWorkspaceSite && !apiError && isUnlockedSite(rawWorkspaceSite) && activeMenu === "Raw Data" && canUseRawExports(userProfile?.tier) && (
        <div className="space-y-4">
          <RawDataView
            dateRange={dateRange}
            ga4PropertyId={userProfile?.activatedGa4PropertyId || null}
            siteUrl={rawWorkspaceSite}
          />
        </div>
      )}

      {rawWorkspaceSite && !apiError && isUnlockedSite(rawWorkspaceSite) && activeMenu === "Reconciliation" && canUseReconciliation(userProfile?.tier) && (
        <div className="space-y-4">
          <ReconciliationView
            dateRange={dateRange}
            ga4PropertyId={userProfile?.activatedGa4PropertyId || null}
            siteUrl={rawWorkspaceSite}
          />
        </div>
      )}

      {!apiError && activeMenu === "Sites" && canUseMultiSite && (
        <div className="space-y-4">
          <WorkspaceSitesView onActivateSite={onActivateWorkspaceSite} onOpenSite={onOpenSiteWorkspace} />
        </div>
      )}

      {activeMenu === "Settings" && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[
            {
              title: "Profile",
              description: "Update your display name, company, bio, and avatar image.",
              action: "Edit profile",
              tab: "profile" as const,
            },
            {
              title: "Plan",
              description: "Review property limits, billing status, and upgrade options.",
              action: "View plan",
              tab: "plan" as const,
            },
            {
              title: "Workspace",
              description: "Manage your default property and active site access.",
              action: "Workspace settings",
              tab: "workspace" as const,
            },
            {
              title: "Integrations",
              description: "Reconnect Google data, add Bing API keys, and sync warehouse data.",
              action: "Open integrations",
              tab: "integrations" as const,
            },
          ].map((item) => (
            <div key={item.tab} className="flex min-h-[220px] flex-col justify-between rounded-2xl border border-border bg-card p-5 shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
              <div>
                <p className="text-lg font-semibold tracking-[-0.01em] text-foreground">{item.title}</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
              </div>
              <Button className="mt-6 justify-start" variant="outline" onClick={() => onOpenSettings(item.tab)}>
                {item.action}
              </Button>
            </div>
          ))}
        </div>
      )}

      {activeMenu === "AI Content Auditor" && (
        rawWorkspaceSite && !apiError && isUnlockedSite(rawWorkspaceSite) ? (
          <AIContentAuditorView dateRange={dateRange} siteUrl={rawWorkspaceSite} useLiveData={useLiveData} />
        ) : null
      )}
    </>
  );
}
