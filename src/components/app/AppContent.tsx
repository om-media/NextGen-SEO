import { lazy, Suspense, useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { DateRange } from "react-day-picker";
import { Database, Loader2 } from "lucide-react";
import type { Annotation } from "../../services/annotationsService";
import type { BingSite } from "../../services/bingService";
import type { GscSite } from "../../services/gscService";
import type { UserProfile } from "../../contexts/AuthContext";
import { canUseRawExports, canUseReconciliation, isMultiSitePlan } from "@/shared/plans";

const loadOverview = () => import("@/components/dashboard/Overview");
const loadAnnotationsSettings = () => import("@/components/dashboard/AnnotationsSettings");
const loadBlendedPagesView = () => import("@/components/dashboard/BlendedPagesView");
const loadGscDataGrid = () => import("@/components/dashboard/GscDataGrid");
const loadQueryCountView = () => import("@/components/dashboard/QueryCountView");

const Overview = lazy(() => loadOverview().then((module) => ({ default: module.Overview })));
const AnnotationsSettings = lazy(() => loadAnnotationsSettings().then((module) => ({ default: module.AnnotationsSettings })));
const BlendedPagesView = lazy(() => loadBlendedPagesView().then((module) => ({ default: module.BlendedPagesView })));
const GscDataGrid = lazy(() => loadGscDataGrid().then((module) => ({ default: module.GscDataGrid })));
const QueryCountView = lazy(() => loadQueryCountView().then((module) => ({ default: module.QueryCountView })));
const Ga4DataGrid = lazy(() => import("@/components/dashboard/Ga4DataGrid").then((module) => ({ default: module.Ga4DataGrid })));
const Ga4Overview = lazy(() => import("@/components/dashboard/Ga4Overview").then((module) => ({ default: module.Ga4Overview })));
const Ga4LlmTraffic = lazy(() => import("@/components/dashboard/Ga4LlmTraffic").then((module) => ({ default: module.Ga4LlmTraffic })));
const Ga4Demographics = lazy(() => import("@/components/dashboard/Ga4Demographics").then((module) => ({ default: module.Ga4Demographics })));
const BingDataGrid = lazy(() => import("@/components/dashboard/BingDataGrid").then((module) => ({ default: module.BingDataGrid })));
const CrawlInventoryView = lazy(() => import("@/components/dashboard/CrawlInventoryView").then((module) => ({ default: module.CrawlInventoryView })));
const LogAnalyzerView = lazy(() => import("@/components/dashboard/LogAnalyzerView").then((module) => ({ default: module.LogAnalyzerView })));
const PageIndexingView = lazy(() => import("@/components/dashboard/PageIndexingView").then((module) => ({ default: module.PageIndexingView })));
const RawDataView = lazy(() => import("@/components/dashboard/RawDataView").then((module) => ({ default: module.RawDataView })));
const ReconciliationView = lazy(() => import("@/components/dashboard/ReconciliationView").then((module) => ({ default: module.ReconciliationView })));
const WorkspaceSitesView = lazy(() => import("@/components/dashboard/WorkspaceSitesView").then((module) => ({ default: module.WorkspaceSitesView })));
const AIContentAuditorView = lazy(() => import("@/components/dashboard/AIContentAuditorView").then((module) => ({ default: module.AIContentAuditorView })));
const RankTrackerView = lazy(() => import("../dashboard/RankTrackerView").then((module) => ({ default: module.RankTrackerView })));

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
  ga4PropertyId?: string | null;
  ga4Sites: Array<{ siteUrl: string; displayName: string }>;
  ga4UserDimension: Ga4Dimension;
  gscDashboardTab: GscDashboardTab;
  warehouseRefreshKey?: number;
  isCompareMode: boolean;
  onAnnotationsChange: () => Promise<void>;
  onGa4DashboardTabChange: (value: Ga4DashboardTab) => void;
  onGa4UserDimensionChange: (value: Ga4Dimension) => void;
  onGscDashboardTabChange: (value: GscDashboardTab) => void;
  onOpenSettings: (tab?: "profile" | "workspace" | "integrations") => void;
  onActivateWorkspaceSite: (siteUrl: string) => Promise<void>;
  onOpenSiteWorkspace: (siteUrl: string, menu: "Dashboard" | "Crawl Inventory" | "Raw Data" | "Reconciliation") => void;
  selectedSite: string;
  workspaceSiteUrl?: string;
  setShowSystemAnnotations: (value: boolean) => void;
  setShowUserAnnotations: (value: boolean) => void;
  showSystemAnnotations: boolean;
  showUserAnnotations: boolean;
  sites: GscSite[];
  useLiveData: boolean;
  userProfile: UserProfile | null;
};

function DeferredOverviewGrid(props: {
  compareDateRange: DateRange;
  dateRange: DateRange;
  isCompareMode: boolean;
  onLoadingChange?: (loading: boolean) => void;
  refreshKey: number;
  selectedSite: string;
  useLiveData: boolean;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    props.onLoadingChange?.(true);
    void loadGscDataGrid();
    const timer = window.setTimeout(() => setReady(true), 100);
    return () => {
      window.clearTimeout(timer);
      props.onLoadingChange?.(false);
    };
  }, [props.compareDateRange, props.dateRange, props.isCompareMode, props.onLoadingChange, props.refreshKey, props.selectedSite, props.useLiveData]);

  useEffect(() => {
    if (ready) props.onLoadingChange?.(false);
  }, [props.onLoadingChange, ready]);

  if (!ready) {
    return (
      <div className="rounded-2xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground shadow-[0_10px_28px_rgba(15,61,46,0.04)]">
        Preparing query table...
      </div>
    );
  }

  return (
    <GscDataGrid
      siteUrl={props.selectedSite}
      dateRange={props.dateRange}
      isCompareMode={props.isCompareMode}
      compareDateRange={props.compareDateRange}
      useLiveData={props.useLiveData}
      hideTrackerButton={true}
      onLoadingChange={props.onLoadingChange}
      refreshKey={props.refreshKey}
    />
  );
}

function ReportLoadingOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-[0_10px_28px_rgba(15,61,46,0.04)] sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-primary">
          <Database className="h-4 w-4" />
        </div>
        <div>
          <div className="flex items-center gap-2 font-semibold text-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Loading report data
          </div>
          <p className="mt-0.5">Metrics, chart, and query rows will update as stored data finishes loading.</p>
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary sm:w-40">
        <div className="h-full w-1/2 animate-pulse rounded-full bg-primary/70" />
      </div>
    </div>
  );
}

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
  ga4PropertyId,
  ga4Sites,
  ga4UserDimension,
  gscDashboardTab,
  warehouseRefreshKey = 0,
  isCompareMode,
  onAnnotationsChange,
  onGa4DashboardTabChange,
  onGa4UserDimensionChange,
  onGscDashboardTabChange,
  onActivateWorkspaceSite,
  onOpenSettings,
  onOpenSiteWorkspace,
  selectedSite,
  workspaceSiteUrl,
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
  const [isGscOverviewLoading, setIsGscOverviewLoading] = useState(false);
  const [isGscOverviewGridLoading, setIsGscOverviewGridLoading] = useState(false);
  const showGscOverviewLoading = gscDashboardTab === "overview" && (isGscOverviewLoading || isGscOverviewGridLoading);

  useEffect(() => {
    if (activeMenu !== "Dashboard") return;

    if (dataSource === "gsc") {
      void loadOverview();
      void loadGscDataGrid();
      void loadQueryCountView();
      void loadAnnotationsSettings();
    } else if (dataSource === "blended") {
      void loadBlendedPagesView();
    }
  }, [activeMenu, dataSource]);

  return (
    <Suspense fallback={<div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">Loading view...</div>}>
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
            <ReportLoadingOverlay visible={showGscOverviewLoading} />
            <Overview
              siteUrl={selectedSite}
              dateRange={dateRange}
              isCompareMode={isCompareMode}
              compareDateRange={compareDateRange}
              annotations={visibleAnnotations}
              onLoadingChange={setIsGscOverviewLoading}
              refreshKey={warehouseRefreshKey}
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
            <DeferredOverviewGrid
              selectedSite={selectedSite}
              dateRange={dateRange}
              isCompareMode={isCompareMode}
              compareDateRange={compareDateRange}
              onLoadingChange={setIsGscOverviewGridLoading}
              useLiveData={useLiveData}
              refreshKey={warehouseRefreshKey}
            />
          </TabsContent>
          <TabsContent value="queries" className="space-y-4">
            <GscDataGrid siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} useLiveData={useLiveData} refreshKey={warehouseRefreshKey} />
          </TabsContent>
          <TabsContent value="pages" className="space-y-4">
            <GscDataGrid siteUrl={selectedSite} dimension="page" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} useLiveData={useLiveData} refreshKey={warehouseRefreshKey} />
          </TabsContent>
          <TabsContent value="countries" className="space-y-4">
            <GscDataGrid siteUrl={selectedSite} dimension="country" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} useLiveData={useLiveData} refreshKey={warehouseRefreshKey} />
          </TabsContent>
          <TabsContent value="query-count" className="space-y-4">
            <QueryCountView siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} useLiveData={useLiveData} refreshKey={warehouseRefreshKey} />
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
            ga4PropertyId={ga4PropertyId || null}
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

      {!selectedSite && !apiError && dataSource === "ga4" && activeMenu === "Dashboard" && workspaceSiteUrl && (
        <div className="rounded-2xl border border-border bg-card p-8 text-center shadow-[0_16px_44px_rgba(15,61,46,0.06)]">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary text-primary">
            <Database className="h-5 w-5" />
          </div>
          <h3 className="mt-4 text-lg font-semibold tracking-[-0.01em] text-foreground">Map a GA4 property for this site</h3>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Analytics reports are scoped to the active workspace site. Choose the GA4 property that belongs to this site before the dashboard shows sessions, events, traffic, or user breakdowns.
          </p>
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
            <Ga4Overview siteUrl={selectedSite} workspaceSiteUrl={workspaceSiteUrl} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} annotations={visibleAnnotations} />
            <Ga4DataGrid siteUrl={selectedSite} workspaceSiteUrl={workspaceSiteUrl} dimension="date" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
          </TabsContent>
          <TabsContent value="events" className="space-y-4">
            <Ga4DataGrid siteUrl={selectedSite} workspaceSiteUrl={workspaceSiteUrl} dimension="eventName" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} metrics={["eventCount", "totalUsers"]} />
          </TabsContent>
          <TabsContent value="pages" className="space-y-4">
            <Ga4DataGrid siteUrl={selectedSite} workspaceSiteUrl={workspaceSiteUrl} dimension="pagePath" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
          </TabsContent>
          <TabsContent value="sources" className="space-y-4">
            <Ga4DataGrid siteUrl={selectedSite} workspaceSiteUrl={workspaceSiteUrl} dimension="sessionSourceMedium" dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
          </TabsContent>
          <TabsContent value="countries" className="space-y-4">
            <Ga4Demographics siteUrl={selectedSite} workspaceSiteUrl={workspaceSiteUrl} dateRange={dateRange} />
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
            <Ga4DataGrid siteUrl={selectedSite} workspaceSiteUrl={workspaceSiteUrl} dimension={ga4UserDimension} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
          </TabsContent>
        </Tabs>
      )}

      {selectedSite && !apiError && dataSource === "ga4" && activeMenu === "LLM Traffic" && ga4Sites.some((site) => site.siteUrl === selectedSite) && (
        <div className="space-y-4">
          <Ga4LlmTraffic siteUrl={selectedSite} workspaceSiteUrl={workspaceSiteUrl} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
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
            ga4PropertyId={ga4PropertyId || null}
            siteUrl={rawWorkspaceSite}
          />
        </div>
      )}

      {rawWorkspaceSite && !apiError && isUnlockedSite(rawWorkspaceSite) && activeMenu === "Reconciliation" && canUseReconciliation(userProfile?.tier) && (
        <div className="space-y-4">
          <ReconciliationView
            dateRange={dateRange}
            ga4PropertyId={ga4PropertyId || null}
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
              title: "Workspace",
              description: "Manage your default property and active site access.",
              action: "Workspace settings",
              tab: "workspace" as const,
            },
            {
              title: "Integrations",
              description: "Reconnect Google data and add Bing API keys when extra sources need attention.",
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
    </Suspense>
  );
}
