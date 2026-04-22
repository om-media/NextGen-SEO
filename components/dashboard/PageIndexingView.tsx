import React, { useState, useEffect } from "react";
import { useAuth } from "@/src/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { format, formatDistanceToNow, parseISO, subDays } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { AlertCircle, CheckCircle2, ShieldAlert, Loader2, RefreshCw, ChevronDown, ChevronRight, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

import { DateRange } from "react-day-picker";
import { toast } from "sonner";

interface IndexingRow {
  url: string;
  clicks: number;
  impressions: number;
  lastCrawl: string | null;
  inspectionResult: any;
  coverageState: string | null;
  lastInspectionTime: string | null;
}

export function PageIndexingView({ siteUrl, dateRange, isLive }: { siteUrl: string, dateRange: DateRange | undefined, isLive: boolean }) {
  const [data, setData] = useState<IndexingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState<'all' | 'indexed' | 'not_indexed' | 'at_risk'>('all');
  const [inspectingParams, setInspectingParams] = useState<Record<string, boolean>>({});
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const { accessToken, clearAccessToken } = useAuth();

  const [isAutoSyncing, setIsAutoSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{current: number, total: number} | null>(null);

  useEffect(() => {
    fetchData();
  }, [siteUrl, dateRange, isLive, accessToken]);

  const processingRef = React.useRef(false);

  // Global Backend Poller Effect
  useEffect(() => {
    let mounted = true;
    let pollInterval: any = null;

    const pollStatus = async () => {
      try {
        const res = await fetch(`/api/indexing/auto-sync/status?siteUrl=${encodeURIComponent(siteUrl)}`);
        const result = await res.json();
        
        if (!mounted) return;

        if (result.status === 'running') {
          setIsAutoSyncing(true);
          setSyncProgress({ current: result.current, total: result.total });
        } else if (result.status === 'completed') {
          if (isAutoSyncing) { // If it transitioned to completed
            setIsAutoSyncing(false);
            setSyncProgress(null);
            fetchData(); // Refresh the grid
          }
        } else if (result.status === 'error') {
           if (isAutoSyncing) {
             setIsAutoSyncing(false);
             setSyncProgress(null);
             fetchData();
           }
        } else {
          setIsAutoSyncing(false);
          setSyncProgress(null);
        }
      } catch (err) {
        console.error(err);
      }
    };

    pollInterval = setInterval(pollStatus, 3000);
    pollStatus(); // Initial check!

    return () => {
      mounted = false;
      if (pollInterval) clearInterval(pollInterval);
    }
  }, [siteUrl, isAutoSyncing]); // Also react when local state changes so we know when to trigger the toast

  const triggerBackgroundSync = async (uninspectedData: IndexingRow[]) => {
    if (!accessToken || isAutoSyncing || processingRef.current) return;
    
    const uninspectedUrls = uninspectedData.filter(r => {
      if (!r.inspectionResult) return true; // Never inspected
      
      // Sync again ONLY if Googlebot has crawled it since our last inspection check
      if (r.lastCrawl && r.lastInspectionTime) {
        const crawlTime = new Date(r.lastCrawl).getTime();
        const inspectTime = new Date(r.lastInspectionTime).getTime();
        return crawlTime > inspectTime;
      }
      return false;
    }).map(r => r.url);
    
    if (uninspectedUrls.length === 0) return;

    processingRef.current = true;
    try {
      const res = await fetch('/api/indexing/auto-sync/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          siteUrl,
          accessToken,
          uninspectedUrls
        })
      });
      const data = await res.json();
      if (data.success) {
        setIsAutoSyncing(true);
        if (!data.alreadyRunning) {
          toast("Background Sync Started", {
            description: "Fetching index statuses smoothly in the background. You can leave this page.",
          });
        }
      }
    } catch(err) {
       console.error("Failed to start bg sync", err);
    } finally {
       processingRef.current = false;
    }
  };

  const fetchData = async () => {
    if (!accessToken && isLive) return; // Wait for token if live
    setLoading(true);
    try {
      const start = dateRange?.from ? format(dateRange.from, 'yyyy-MM-dd') : format(subDays(new Date(), 28), 'yyyy-MM-dd');
      const end = dateRange?.to ? format(dateRange.to, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');

      const res = await fetch(`/api/indexing/grid?siteUrl=${encodeURIComponent(siteUrl)}&startDate=${start}&endDate=${end}&isLive=${isLive}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      const json = await res.json();
      setData(json);
      
      if (json && json.length > 0) {
        triggerBackgroundSync(json);
      }
      
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      const lines = text.split('\n');
      const urls = lines
        .map(l => {
          const match = l.match(/(https?:\/\/[^\s",]+)/);
          return match ? match[1] : null;
        })
        .filter(Boolean) as string[];

      if (urls.length === 0) {
        toast.error("No valid URLs found in CSV");
        return;
      }

      toast("Processing CSV...", { description: `Found ${urls.length} target URLs to seed.` });

      try {
        const res = await fetch('/api/indexing/seed-urls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteUrl, urls })
        });
        const json = await res.json();
        if (json.success) {
          toast.success(`Seeded ${json.added} ghost URLs!`, { description: "They have been added to the matrix grid." });
          fetchData();
        } else {
          toast.error("Failed to seed URLs from CSV");
        }
      } catch(err) {
        console.error("Failed to seed URLs", err);
        toast.error("Failed to process CSV request");
      }
    };
    reader.readAsText(file);
    
    // reset input so same file can be uploaded again if needed
    e.target.value = '';
  };

  const handleInspect = async (url: string) => {
    if (!accessToken) return;
    setInspectingParams(prev => ({ ...prev, [url]: true }));
    try {
      const res = await fetch("/api/indexing/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl, inspectionUrl: url, accessToken })
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error?.message || result.error || "Failed to inspect URL (Check GSC quotas)");
      }
      if (result.success) {
        // Update local state
        setData(prev => prev.map(row => {
          if (row.url === url) {
            return {
              ...row,
              coverageState: result.coverageState,
              inspectionResult: result.inspectionResult,
              lastInspectionTime: result.lastInspectionTime
            };
          }
          return row;
        }));
        toast.success("Inspection successful", { description: "URL status has been refreshed." });
      }
    } catch (err: any) {
      console.error("Inspection failed:", err);
      const isNetworkDrop = err?.message === 'Failed to fetch';
      
      if (err?.message?.includes("invalid authentication credentials") || err?.message?.includes("OAuth 2 access token") || err?.message === 'UNAUTHORIZED') {
        clearAccessToken();
        toast.error("Session expired", {
          description: "Your Google session has expired. Please click 'Reconnect Google' to restore access."
        });
      } else {
        toast.error(isNetworkDrop ? "Connection lost" : "Inspection failed", {
          description: isNetworkDrop ? "Your network connection was interrupted. Please try again." : (err?.message || "Could not reach the server."),
        });
      }
    } finally {
      setInspectingParams(prev => ({ ...prev, [url]: false }));
    }
  };

  const getStatusBadge = (coverageState: string | null) => {
    if (!coverageState) return <span className="text-gray-400 text-xs">Unknown (Not Inspected)</span>;
    
    const lower = coverageState.toLowerCase();
    
    if (lower.includes("not indexed") || lower.includes("error") || lower.includes("failed")) {
      return (
        <div className="flex items-center text-red-600 text-xs font-medium">
          <AlertCircle className="w-3 h-3 mr-1" />
          {coverageState}
        </div>
      );
    }
    
    if (lower.includes("indexed")) {
      return (
        <div className="flex items-center text-emerald-600 text-xs font-medium">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          {coverageState}
        </div>
      );
    }
    
    return (
      <div className="flex items-center text-orange-500 text-xs font-medium">
        <AlertCircle className="w-3 h-3 mr-1" />
        {coverageState}
      </div>
    );
  };

  const formatEnum = (str: string | undefined | null) => {
    if (!str) return 'N/A';
    return str.replace(/_/g, ' ')
              .replace('STATE UNSPECIFIED', 'Unspecified')
              .toLowerCase()
              .replace(/\b\w/g, c => c.toUpperCase());
  };

  const getQualityInsight = (row: any) => {
    const coverage = row.coverageState || "";
    
    if (coverage === "Crawled - currently not indexed") {
      return (
        <div className="col-span-2 md:col-span-4 mt-4 p-3 bg-orange-50 border border-orange-200 rounded-md">
           <div className="flex items-start gap-2 max-w-full">
               <AlertCircle className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
               <div className="text-sm text-orange-900 space-y-2 flex-1 min-w-0 pr-2">
                   <p className="font-semibold text-base mb-1">Crawled, but rejected for Indexing</p>
                   <p className="whitespace-normal break-words">Googlebot successfully visited this page, read the contents, but actively decided <strong>not</strong> to include it in search results.</p>
                   <p className="whitespace-normal break-words">This is almost always a <strong>Quality issue</strong>. Google's algorithm deemed the content too "thin", too generic, outdated, or fundamentally unhelpful to users. Alternatively, it might be an RSS feed, pagination page, or taxonomy tag that Google prefers to keep out of the main index.</p>
               </div>
           </div>
       </div>
      );
    }
    
    if (coverage === "Discovered - currently not indexed") {
      return (
        <div className="col-span-2 md:col-span-4 mt-4 p-3 bg-orange-50 border border-orange-200 rounded-md">
           <div className="flex items-start gap-2 max-w-full">
               <AlertCircle className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
               <div className="text-sm text-orange-900 space-y-2 flex-1 min-w-0 pr-2">
                   <p className="font-semibold text-base mb-1">Discovered, but Delayed (Crawl Budget)</p>
                   <p className="whitespace-normal break-words">Google knows this URL exists (usually from a sitemap or another link), but it actively chose <strong>not to crawl it yet</strong>.</p>
                   <p className="whitespace-normal break-words">This happens when a site is massive and runs out of "Crawl Budget", or if the server was responding too slowly and Google delayed the crawl to avoid crashing your site.</p>
               </div>
           </div>
       </div>
      );
    }
    
    return null;
  }

  const getCanonicalInsight = (row: any) => {
    const userCanon = row.inspectionResult?.indexStatusResult?.userCanonical;
    const googleCanon = row.inspectionResult?.indexStatusResult?.googleCanonical;
    
    // Ignore if not a mismatch or no canonicals provided
    if (!userCanon || !googleCanon || googleCanon === row.url || googleCanon === userCanon) return null;
    
    let isDomainMismatch = false;
    try {
      if (new URL(userCanon).hostname !== new URL(googleCanon).hostname) {
        isDomainMismatch = true;
      }
    } catch(e) {}

    return (
      <div className="col-span-2 md:col-span-4 mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
         <div className="flex items-start gap-2 max-w-full">
             <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
             <div className="text-sm text-red-900 space-y-2 flex-1 min-w-0 pr-2">
                 <p className="font-semibold text-base mb-1">Canonical Mismatch Detected</p>
                 {isDomainMismatch ? (
                     <>
                       <p className="whitespace-normal break-words">Google completely ignored your canonical tag and selected a URL on a <strong>different domain string</strong>.</p>
                       <p className="whitespace-normal break-words">This specifically happens with International SEO or subdomains (e.g. <code>.com</code> vs <code>.co.uk</code> or <code>www.</code> vs non-www) that have identical duplicate content.</p>
                       <p className="whitespace-normal break-words"><strong>How to fix:</strong> If you want BOTH of these specific regional pages to rank in their respective countries, you must implement proper <strong>hreflang tags</strong> immediately. Otherwise, Google's algorithm will ruthlessly delete one from the index to prevent duplication.</p>
                     </>
                 ) : (
                     <>
                       <p className="whitespace-normal break-words">Google ignored your canonical tag and selected a different URL as the "true" version of this page.</p>
                       <p className="whitespace-normal break-words">This generally means the content on this page is identical (or aggressively similar) to the Google-selected URL. Google consolidation algorithm prefers its discovered URL over yours.</p>
                       <p className="whitespace-normal break-words"><strong>How to fix:</strong> If you intentionally want this exact URL to rank, you must differentiate its content to make it unique, fix wildcard URL parameters, or check for internal linking trails that confuse Googlebots.</p>
                     </>
                 )}
             </div>
         </div>
     </div>
    )
  }

  let displayData = [...data];
  if (filterMode === 'at_risk') {
    displayData = displayData.filter(d => 
      // Example of "At Risk": Crawled by Google Bot, has impressions > 0, but status is not "indexed" (if known) or it hasn't been crawled in 15 days
      (d.impressions > 0 && d.coverageState && !d.coverageState.toLowerCase().includes("indexed")) ||
      (d.lastCrawl === null && d.impressions > 10)
    );
  } else if (filterMode === 'indexed') {
    displayData = displayData.filter(d => d.coverageState?.toLowerCase().includes("indexed") && !d.coverageState?.toLowerCase().includes("not indexed"));
  } else if (filterMode === 'not_indexed') {
    displayData = displayData.filter(d => d.coverageState && (!d.coverageState.toLowerCase().includes("indexed") || d.coverageState.toLowerCase().includes("not indexed")));
  }
  
  // Sort by Impressions descending
  displayData.sort((a, b) => b.impressions - a.impressions);

  const indexedCount = data.filter(d => d.coverageState?.toLowerCase().includes("indexed") && !d.coverageState?.toLowerCase().includes("not indexed")).length;
  const notIndexedCount = data.filter(d => d.coverageState && (!d.coverageState.toLowerCase().includes("indexed") || d.coverageState.toLowerCase().includes("not indexed"))).length;
  const totalUrls = data.length;

  return (
    <div className="space-y-6 max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center flex-wrap gap-3">
            <h2 className="text-2xl font-bold tracking-tight">Hybrid Page Indexing</h2>
            {isAutoSyncing && syncProgress && (
               <div className="flex items-center space-x-2 text-xs font-medium text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full animate-pulse border border-emerald-100">
                 <RefreshCw className="h-3 w-3 animate-spin" />
                 <span>Auto-syncing {syncProgress.current} / {syncProgress.total}</span>
               </div>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            Fusing Live Search Console Traffic with Raw Server Logs and the Real-time URL Inspection API.
          </p>
        </div>
        <div className="flex items-center space-x-4 shrink-0">
          <div className="relative">
             <input type="file" accept=".csv" id="csv-upload" className="hidden" onChange={handleCsvUpload} />
             <Button variant="outline" size="sm" onClick={() => document.getElementById('csv-upload')?.click()}>
               <Upload className="w-4 h-4 mr-2" />
               Import GSC CSV
             </Button>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => triggerBackgroundSync(data)}
            disabled={!accessToken || isAutoSyncing || (!data.some(r => !r.inspectionResult || (r.lastCrawl && r.lastInspectionTime && new Date(r.lastCrawl).getTime() > new Date(r.lastInspectionTime).getTime())))}
          >
            {isAutoSyncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            {accessToken ? "Sync Outdated URLs" : "Reconnect to Sync"}
          </Button>
          <div className="flex items-center space-x-2">
            <Switch 
               id="risk-mode" 
               checked={filterMode === 'at_risk'} 
               onCheckedChange={(checked) => setFilterMode(checked ? 'at_risk' : 'all')} 
            />
            <Label htmlFor="risk-mode" className="flex items-center text-sm font-medium cursor-pointer">
              <ShieldAlert className="w-4 h-4 text-orange-500 mr-2" />
              Show URLs at Risk
            </Label>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card 
          className={`bg-card shadow-sm border cursor-pointer transition-colors ${filterMode === 'all' ? 'ring-2 ring-primary' : 'hover:bg-muted/50'}`}
          onClick={() => setFilterMode('all')}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Known URLs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{totalUrls.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card 
          className={`bg-card shadow-sm border cursor-pointer transition-colors ${filterMode === 'indexed' ? 'ring-2 ring-primary' : 'hover:bg-muted/50'}`}
          onClick={() => setFilterMode('indexed')}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Confirmed Indexed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-emerald-600">{indexedCount.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card 
          className={`bg-card shadow-sm border cursor-pointer transition-colors ${filterMode === 'not_indexed' ? 'ring-2 ring-primary' : 'hover:bg-muted/50'}`}
          onClick={() => setFilterMode('not_indexed')}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Not Indexed / Flagged</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-red-600">{notIndexedCount.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden border shadow-sm">
        <div className="overflow-x-auto max-h-[600px]">
          <Table>
            <TableHeader className="bg-muted/50 sticky top-0 z-10">
              <TableRow>
                <TableHead className="w-[300px]">URL</TableHead>
                <TableHead className="text-right">Impressions</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead>Server Log (Last Crawl)</TableHead>
                <TableHead>Status (GSC Inspection)</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-64 text-center">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
                    <p className="mt-2 text-sm text-muted-foreground">Analyzing Indexing Matrix...</p>
                  </TableCell>
                </TableRow>
              ) : displayData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    No URLs match this criteria.
                  </TableCell>
                </TableRow>
              ) : (
                displayData.map((row) => (
                  <React.Fragment key={row.url}>
                    <TableRow className="hover:bg-muted/30">
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => setExpandedRows(prev => ({...prev, [row.url]: !prev[row.url]}))}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            {expandedRows[row.url] ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                          <div className="truncate max-w-[300px]" title={row.url}>
                            {row.url.replace(siteUrl, '/')}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">{row.impressions.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{row.clicks.toLocaleString()}</TableCell>
                      <TableCell>
                        {row.lastCrawl ? (
                          <span className="text-xs text-muted-foreground" title={new Date(row.lastCrawl).toLocaleString()}>
                            {formatDistanceToNow(parseISO(row.lastCrawl), { addSuffix: true })}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400 italic">Never</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div 
                          className="cursor-pointer hover:opacity-80"
                          onClick={() => setExpandedRows(prev => ({...prev, [row.url]: !prev[row.url]}))}
                        >
                          {getStatusBadge(row.coverageState)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => handleInspect(row.url)}
                          disabled={inspectingParams[row.url]}
                          className="h-8"
                        >
                          {inspectingParams[row.url] ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <><RefreshCw className="w-3 h-3 mr-1" /> Inspect</>
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                    {expandedRows[row.url] && (
                      <TableRow className="bg-muted/20 border-b">
                        <TableCell colSpan={6} className="p-4">
                          {!row.inspectionResult ? (
                            <div className="text-sm text-muted-foreground italic flex items-center justify-center py-4">
                              No profound Google Search Console inspection data available. Click 'Inspect' to fetch the latest details.
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm bg-background block p-4 rounded-md border">
                              <div>
                                <span className="font-semibold text-xs text-muted-foreground uppercase">Verdict</span>
                                <div className="mt-1 flex items-center">
                                  {row.inspectionResult?.indexStatusResult?.verdict === "PASS" ? 
                                    <span className="text-emerald-600 font-medium">{row.inspectionResult.indexStatusResult.verdict}</span> :
                                    <span className="text-orange-500 font-medium">{row.inspectionResult?.indexStatusResult?.verdict || "UNKNOWN"}</span>
                                  }
                                </div>
                              </div>
                              <div>
                                <span className="font-semibold text-xs text-muted-foreground uppercase">Page Fetch State</span>
                                <div className="mt-1 font-medium">{formatEnum(row.inspectionResult?.indexStatusResult?.pageFetchState)}</div>
                              </div>
                              <div>
                                <span className="font-semibold text-xs text-muted-foreground uppercase">Robots.txt</span>
                                <div className="mt-1 font-medium">{formatEnum(row.inspectionResult?.indexStatusResult?.robotsTxtState)}</div>
                              </div>
                              <div>
                                <span className="font-semibold text-xs text-muted-foreground uppercase">Indexing State</span>
                                <div className="mt-1 font-medium">{formatEnum(row.inspectionResult?.indexStatusResult?.indexingState)}</div>
                              </div>
                              
                              {(row.inspectionResult?.indexStatusResult?.googleCanonical || row.inspectionResult?.indexStatusResult?.userCanonical) && (
                                <div className="col-span-2 md:col-span-4 grid grid-cols-1 md:grid-cols-2 gap-4 mt-2 mb-1">
                                  <div className="min-w-0 overflow-hidden">
                                    <span className="font-semibold text-xs text-muted-foreground uppercase">User Canonical</span>
                                    <div className="mt-1 text-xs break-all whitespace-pre-wrap bg-muted/50 p-2 rounded border">{row.inspectionResult?.indexStatusResult?.userCanonical || 'None provided'}</div>
                                  </div>
                                  <div className="min-w-0 overflow-hidden">
                                    <span className="font-semibold text-xs text-muted-foreground uppercase">Google Selected Canonical</span>
                                      <div className="mt-1 text-xs break-all whitespace-pre-wrap bg-muted/50 p-2 rounded border">
                                        {row.inspectionResult?.indexStatusResult?.googleCanonical === row.url ? "Same as URL" : (row.inspectionResult?.indexStatusResult?.googleCanonical || 'None selected')}
                                      </div>
                                  </div>
                                </div>
                              )}
                              
                              {getCanonicalInsight(row)}
                              {getQualityInsight(row)}
                              
                              <div className="col-span-2 md:col-span-4 mt-2 flex items-center gap-2">
                                <span className="font-semibold text-xs text-muted-foreground uppercase">GSC Last Crawl Time:</span>
                                <span>{row.inspectionResult?.indexStatusResult?.lastCrawlTime ? new Date(row.inspectionResult.indexStatusResult.lastCrawlTime).toLocaleString() : 'Never'}</span>
                              </div>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
