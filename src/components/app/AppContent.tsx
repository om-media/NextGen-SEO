import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Overview } from "@/components/dashboard/Overview";
import { GscDataGrid } from "@/components/dashboard/GscDataGrid";
import { QueryCountView } from "@/components/dashboard/QueryCountView";
import { Ga4DataGrid } from "@/components/dashboard/Ga4DataGrid";
import { Ga4Overview } from "@/components/dashboard/Ga4Overview";
import { Ga4LlmTraffic } from "@/components/dashboard/Ga4LlmTraffic";
import { Ga4Demographics } from "@/components/dashboard/Ga4Demographics";
import { BingDataGrid } from "@/components/dashboard/BingDataGrid";
import { LogAnalyzerView } from "@/components/dashboard/LogAnalyzerView";
import { PageIndexingView } from "@/components/dashboard/PageIndexingView";
import { RankTrackerView } from "../dashboard/RankTrackerView";
import type { DateRange } from "react-day-picker";
import type { Annotation } from "../../services/annotationsService";
import type { BingSite } from "../../services/bingService";
import type { GscSite } from "../../services/gscService";
import type { UserProfile } from "../../contexts/AuthContext";

type DataSource = "gsc" | "bing" | "ga4";
type Ga4Dimension = "country" | "city" | "region" | "deviceCategory" | "browser" | "operatingSystem";

type AppContentProps = {
  activeMenu: string;
  annotations: Annotation[];
  apiError: string | null;
  bingSites: BingSite[];
  compareDateRange: DateRange;
  dataSource: DataSource;
  dateRange: DateRange;
  ga4Sites: Array<{ siteUrl: string; displayName: string }>;
  ga4UserDimension: Ga4Dimension;
  isCompareMode: boolean;
  onGa4UserDimensionChange: (value: Ga4Dimension) => void;
  selectedSite: string;
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
  ga4Sites,
  ga4UserDimension,
  isCompareMode,
  onGa4UserDimensionChange,
  selectedSite,
  showSystemAnnotations,
  showUserAnnotations,
  sites,
  useLiveData,
  userProfile,
}: AppContentProps) {
  const visibleAnnotations = getVisibleAnnotations(annotations, showSystemAnnotations, showUserAnnotations);

  return (
    <>
      {selectedSite && !apiError && dataSource === "gsc" && sites.some((site) => site.siteUrl === selectedSite) && activeMenu === "Dashboard" && (
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="bg-transparent border-b rounded-none w-full justify-start h-auto p-0 space-x-6 flex-wrap">
            <TabsTrigger value="overview" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Overview</TabsTrigger>
            <TabsTrigger value="queries" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Queries</TabsTrigger>
            <TabsTrigger value="pages" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Pages</TabsTrigger>
            <TabsTrigger value="countries" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Countries</TabsTrigger>
            <TabsTrigger value="query-count" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Query Count</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="space-y-4">
            <Overview siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} annotations={visibleAnnotations} />
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
            <QueryCountView siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} />
          </TabsContent>
        </Tabs>
      )}

      {selectedSite && !apiError && dataSource === "bing" && userProfile?.bingApiKey && bingSites.some((site) => site.siteUrl === selectedSite) && activeMenu === "Dashboard" && (
        <div className="space-y-4">
          <div className="p-4 border rounded-lg bg-card">
            <h3 className="text-lg font-medium mb-2">Bing Webmaster Tools Data</h3>
            <p className="text-sm text-muted-foreground">Bing integration is currently in beta. Advanced filtering and comparison features will be added soon.</p>
          </div>
          <BingDataGrid siteUrl={selectedSite} />
        </div>
      )}

      {selectedSite && !apiError && dataSource === "ga4" && ga4Sites.some((site) => site.siteUrl === selectedSite) && activeMenu === "Dashboard" && (
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="bg-transparent border-b rounded-none w-full justify-start h-auto p-0 space-x-6 flex-wrap">
            <TabsTrigger value="overview" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Overview</TabsTrigger>
            <TabsTrigger value="events" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Events</TabsTrigger>
            <TabsTrigger value="pages" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Pages</TabsTrigger>
            <TabsTrigger value="sources" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Traffic</TabsTrigger>
            <TabsTrigger value="countries" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3 data-[state=active]:shadow-none font-medium text-muted-foreground data-[state=active]:text-foreground transition-none">Users</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="space-y-4">
            <Ga4Overview siteUrl={selectedSite} dateRange={dateRange} isCompareMode={isCompareMode} compareDateRange={compareDateRange} annotations={visibleAnnotations} />
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
            <div className="flex justify-between items-center mt-8">
              <h3 className="text-lg font-medium">Detailed User Data</h3>
              <Select value={ga4UserDimension} onValueChange={(value) => onGa4UserDimensionChange(value as Ga4Dimension)}>
                <SelectTrigger className="w-[180px]">
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

      {selectedSite && !apiError && activeMenu === "Rank Tracker" && (
        <div className="space-y-4">
          <RankTrackerView siteUrl={selectedSite} />
        </div>
      )}

      {selectedSite && !apiError && activeMenu === "Server Logs" && (
        <div className="space-y-4">
          <LogAnalyzerView siteUrl={selectedSite} dateRange={dateRange} />
        </div>
      )}

      {selectedSite && !apiError && activeMenu === "Page Indexing" && (
        <div className="space-y-4">
          <PageIndexingView siteUrl={selectedSite} dateRange={dateRange} isLive={useLiveData} />
        </div>
      )}
    </>
  );
}
