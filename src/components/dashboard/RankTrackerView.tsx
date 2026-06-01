import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Target, TrendingUp, TrendingDown, Minus, RefreshCw, Plus, Trash2, ArrowRight, Download } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts'
import { Badge } from "@/components/ui/badge"
import { GscApiService } from "@/src/services/gscService"
import { useAuth } from "@/src/contexts/AuthContext"
import { authFetch } from "@/src/lib/authFetch"

interface RankTrackerViewProps {
  siteUrl: string;
}

type RankTrackingStatus = {
  autoCollectionEnabled: boolean;
  collectionCadence: string;
  totalKeywords: number;
  freshCount: number;
  staleCount: number;
  neverCollectedCount: number;
  latestUpdated: string | null;
  today: string;
};

function exportCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((line) => line.map(escape).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

function formatRankDate(value: string | null | undefined) {
  if (!value) return "Pending";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00Z`));
  } catch {
    return value;
  }
}

export function RankTrackerView({ siteUrl }: RankTrackerViewProps) {
  const { userProfile } = useAuth()
  const [keywords, setKeywords] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [rankStatus, setRankStatus] = useState<RankTrackingStatus | null>(null)
  
  // New Keyword Form
  const [newKeywords, setNewKeywords] = useState("")
  const [newLocation, setNewLocation] = useState("US")
  const [newDevice, setNewDevice] = useState("desktop")
  const [newTargetDomain, setNewTargetDomain] = useState("")
  
  // Auto-fill target domain when dialog opens based on siteUrl
  useEffect(() => {
    if (siteUrl && !siteUrl.includes('properties/')) {
       setNewTargetDomain(siteUrl.replace(/^https?:\/\//, '').replace(/^sc-domain:/, '').split('/')[0])
    } else {
       setNewTargetDomain("")
    }
  }, [siteUrl])
  
  // Selection & History
  const [selectedKeywordId, setSelectedKeywordId] = useState<string | null>(null)
  const [historyData, setHistoryData] = useState<any[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const fetchKeywords = async () => {
    setLoading(true)
    try {
      const res = await authFetch(`/api/rank-tracking/keywords?siteUrl=${encodeURIComponent(siteUrl)}`)
      if (res.ok) {
        const data = await res.json()
        setKeywords(data)
        if (data.length > 0 && !selectedKeywordId) {
          setSelectedKeywordId(data[0].id)
        }
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const fetchRankStatus = async () => {
    try {
      const res = await authFetch(`/api/rank-tracking/status?siteUrl=${encodeURIComponent(siteUrl)}`)
      if (res.ok) {
        setRankStatus(await res.json())
      }
    } catch (e) {
      console.error(e)
    }
  }

  const fetchHistory = async (id: string) => {
    setHistoryLoading(true)
    try {
      const res = await authFetch(`/api/rank-tracking/history?keywordId=${id}`)
      if (res.ok) {
        const data = await res.json()
        // Format for Recharts
        setHistoryData(data.map((d: any) => ({
          date: d.date,
          // We invert position so chart goes UP when rank improves (rank 1 is highest)
          positionRaw: d.position,
          position: d.position === 101 ? -1 : d.position 
        })))
      }
    } catch (e) {
      console.error(e)
    } finally {
      setHistoryLoading(false)
    }
  }

  useEffect(() => {
    if (siteUrl) {
      fetchKeywords()
      fetchRankStatus()
    }
  }, [siteUrl])

  useEffect(() => {
    if (selectedKeywordId) {
      fetchHistory(selectedKeywordId)
    }
  }, [selectedKeywordId])

  const handleAddKeywords = async () => {
    const keywordArray = newKeywords.split(',').map(k => k.trim()).filter(k => k.length > 0)
    if (keywordArray.length === 0) return

    try {
      const res = await authFetch('/api/rank-tracking/keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteUrl,
          keywords: keywordArray,
          location: newLocation,
          device: newDevice,
          targetDomain: newTargetDomain.trim()
        })
      })
      if (res.ok) {
        setNewKeywords("")
        // let the newTargetDomain stay sticky for convenience
        setAddDialogOpen(false)
        await fetchKeywords() // Pull the keywords locally instantly
        await fetchRankStatus()
        
        // Trigger a fresh sync with live hints automatically.
        handleSync(true); // pass true to indicate it is an auto-sync and avoid blocking
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleDeleteKeyword = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await authFetch(`/api/rank-tracking/keywords/${id}`, { method: 'DELETE' })
      if (selectedKeywordId === id) {
        setSelectedKeywordId(null)
        setHistoryData([])
      }
      await fetchKeywords()
      await fetchRankStatus()
    } catch (e) {
      console.error(e)
    }
  }

  const handleSync = async (stealth: boolean | React.MouseEvent = false) => {
    const isStealth = typeof stealth === 'boolean' && stealth;
    if (!isStealth) setSyncing(true)
    try {
      // Create a hint map if we possess live GSC auth keys
      let gscHints: Record<string, { position: number, url: string }> = {};
      
      // Fetch latest keywords to guarantee we don't use stale state after adding
      const currentKeywordsRes = await authFetch(`/api/rank-tracking/keywords?siteUrl=${encodeURIComponent(siteUrl)}`);
      const currentKeywordsData = currentKeywordsRes.ok ? await currentKeywordsRes.json() : [];

      try {
         // Google Search Console typically lags by 2-3 days. 
         // End the window 2 days ago to avoid 0-impression null zones, and look back 14 days total.
         const end = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
         const start = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; 
         
         if (userProfile?.googleConnected && currentKeywordsData.length > 0) {
           const liveService = new GscApiService(null, 'free');
           
           // Query for all currently tracked keywords so they don't get truncated by the 2500 limit
           const regexList = currentKeywordsData.map((k: any) => 
               k.keyword.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
           );
           const filterGroups = [{
             filters: [{
               dimension: 'query',
               operator: 'includingRegex',
               expression: `^(${regexList.join('|')})$`
             }]
           }];
           
           // Determine target domain nicely
           const explicitTargetDomain = currentKeywordsData[0].targetDomain;
           const defaultDomain = siteUrl.replace(/^https?:\/\//, '').replace(/^sc-domain:/, '').replace(/^www\./, '').split('/')[0];
           const domainToUse = explicitTargetDomain || defaultDomain;
           
           // Try variations of the site URL since the user might be using a GA4 property ID initially
           const gscSiteUrlsToTry = [
             siteUrl,
             `sc-domain:${domainToUse}`,
             `https://${domainToUse}/`,
             `https://www.${domainToUse}/`,  
           ];

           let liveData: any = null;
           for (const tryUrl of gscSiteUrlsToTry) {
             try {
               const res = await liveService.querySearchAnalytics(tryUrl, start, end, ['query', 'page', 'device', 'country'], filterGroups, true);
               if (Array.isArray(res)) {
                 liveData = res;
                 break; // Success!
               }
             } catch(e) {
               console.debug(`GSC Hint attempt failed for ${tryUrl}`);
             }
           }

           if (Array.isArray(liveData)) {
              // Now we store stats per unique combination of Query + Device + Location
              const queryStats: Record<string, { impressions: number, pos: number, url: string }> = {};
              const fallbackStats: Record<string, { impressions: number, pos: number, url: string }> = {};
              
              const mapLocToGsc = (loc: string) => {
                 if (loc === 'UK') return 'gbr';
                 if (loc === 'US') return 'usa';
                 if (loc === 'CA') return 'can';
                 if (loc === 'AU') return 'aus';
                 return loc.toLowerCase();
              };

              const validKeys = new Set(currentKeywordsData.map((k: any) => 
                 `${k.keyword.toLowerCase().trim()}|${k.device.toLowerCase()}|${mapLocToGsc(k.location)}`
              ));

              liveData.forEach((row: any) => {
                if (row.keys && row.keys.length >= 4) {
                  const query = row.keys[0];
                  const url = row.keys[1];
                  const device = row.keys[2].toLowerCase();
                  const country = row.keys[3].toLowerCase();
                  
                  const pos = Math.round(row.position);
                  const impressions = row.impressions || 0;
                  
                  // Always track the absolute best canonical ranking globally as an ultimate fallback
                  if (!fallbackStats[query] || impressions > fallbackStats[query].impressions) {
                    fallbackStats[query] = { impressions, pos, url };
                  }

                  const compositeKey = `${query}|${device}|${country}`;

                  // Only process rows that correspond to our tracked permutations for exact precision
                  if (validKeys.has(compositeKey)) {
                     const existing = queryStats[compositeKey];
                     if (!existing || impressions > existing.impressions) {
                       queryStats[compositeKey] = { impressions, pos, url };
                     }
                  }
                }
              });

              for (const [key, data] of Object.entries(queryStats)) {
                 gscHints[key] = { position: data.pos, url: data.url };
              }
              for (const [query, data] of Object.entries(fallbackStats)) {
                 if (gscHints[query] === undefined) {
                    gscHints[query] = { position: data.pos, url: data.url };
                 }
              }
           }
         }
      } catch(e) {
         console.warn("GSC Hint fetch failed (expected if unauthenticated)", e);
      }

      const res = await authFetch('/api/rank-tracking/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteUrl, force: true, gscHints })
      })
      if (res.ok) {
        await fetchKeywords()
        await fetchRankStatus()
        if (selectedKeywordId) fetchHistory(selectedKeywordId)
      }
    } catch (e) {
      console.error(e)
    } finally {
      if (!isStealth) setSyncing(false)
    }
  }

  const renderRankBadge = (rank: number | null) => {
    if (rank === null) return <Badge variant="outline" className="text-muted-foreground">No Data</Badge>
    if (rank === 101 || rank > 100) return <Badge variant="secondary" className="bg-muted text-muted-foreground">100+</Badge>
    if (rank <= 3) return <Badge className="bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800">{rank}</Badge>
    if (rank <= 10) return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800">{rank}</Badge>
    return <Badge variant="outline">{rank}</Badge>
  }

  // Calculate KPIs
  const top3 = keywords.filter(k => k.currentPosition && k.currentPosition <= 3).length
  const top10 = keywords.filter(k => k.currentPosition && k.currentPosition <= 10).length
  const avgRank = keywords.filter(k => k.currentPosition && k.currentPosition <= 100).length > 0 
    ? Math.round(keywords.filter(k => k.currentPosition && k.currentPosition <= 100).reduce((acc, k) => acc + k.currentPosition, 0) / keywords.filter(k => k.currentPosition && k.currentPosition <= 100).length)
    : 0

  const exportKeywords = () => {
    exportCsv(`rank-tracker-keywords-${new Date().toISOString().slice(0, 10)}.csv`, keywords.map((keyword) => ({
      keyword: keyword.keyword,
      currentPosition: keyword.currentPosition ?? "",
      previousPosition: keyword.previousPosition ?? "",
      rankingUrl: keyword.rankingUrl || "",
      location: keyword.location,
      device: keyword.device,
      targetDomain: keyword.targetDomain || "",
      updatedAt: keyword.lastUpdated || "",
    })));
  };

  const exportSelectedHistory = () => {
    const keyword = keywords.find(k => k.id === selectedKeywordId);
    if (!keyword) return;
    const safeKeyword = String(keyword.keyword).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "keyword";
    exportCsv(`rank-tracker-history-${safeKeyword}-${new Date().toISOString().slice(0, 10)}.csv`, historyData.map((row) => ({
      keyword: keyword.keyword,
      date: row.date,
      position: row.positionRaw,
    })));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-[#E9F0EB] bg-white/90 p-5 shadow-[0_12px_32px_rgba(15,61,46,0.045)] sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.01em] text-[#0F172A]">
            Rank Tracker <Badge variant="outline" className="ml-2 border-[#0F3D2E]/20 bg-[#EAF4EC] text-[#0F3D2E]">Beta</Badge>
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[#647067]">Monitor daily Google keyword rankings with our Hybrid Engine.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportKeywords} disabled={loading || keywords.length === 0}>
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={handleSync} disabled={loading || syncing || keywords.length === 0}>
            <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Refreshing" : "Refresh"}
          </Button>
          
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogTrigger render={<Button size="sm" />}>
              <Plus className="w-4 h-4 mr-2" />
              Add Keywords
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Keywords to Track</DialogTitle>
                <DialogDescription>
                  Enter keywords separated by commas to begin tracking their daily positions.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Keywords</label>
                  <Input 
                    placeholder="e.g. best seo tool, rank tracker, buy shoes" 
                    value={newKeywords} 
                    onChange={e => setNewKeywords(e.target.value)} 
                  />
                </div>
                {/* Hiding target domain input so users don't have to think about it manually */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Location</label>
                    <Select value={newLocation} onValueChange={setNewLocation}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="US">United States</SelectItem>
                        <SelectItem value="UK">United Kingdom</SelectItem>
                        <SelectItem value="CA">Canada</SelectItem>
                        <SelectItem value="AU">Australia</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Device</label>
                    <Select value={newDevice} onValueChange={setNewDevice}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="desktop">Desktop</SelectItem>
                        <SelectItem value="mobile">Mobile</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleAddKeywords} disabled={!newKeywords.trim()}>Add Keywords</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {rankStatus && rankStatus.totalKeywords > 0 && (
        <div className={`flex flex-col gap-3 rounded-2xl border p-4 text-sm sm:flex-row sm:items-center sm:justify-between ${
          rankStatus.staleCount > 0
            ? "border-amber-200 bg-amber-50 text-amber-950"
            : "border-[#DCEBE2] bg-[#F2FAF5] text-[#0F3D2E]"
        }`}>
          <div>
            <p className="font-medium">
              Automatic daily rank collection is {rankStatus.autoCollectionEnabled ? "enabled" : "disabled"}.
            </p>
            <p className="mt-1 text-xs opacity-80">
              {rankStatus.freshCount.toLocaleString()} of {rankStatus.totalKeywords.toLocaleString()} keywords have today's data
              {rankStatus.latestUpdated ? `; latest stored date is ${formatRankDate(rankStatus.latestUpdated)}.` : "."}
            </p>
          </div>
          {rankStatus.staleCount > 0 && (
            <Button variant="outline" size="sm" onClick={handleSync} disabled={loading || syncing}>
              <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
              Refresh stale ranks
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_10px_24px_rgba(15,61,46,0.045)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Average Position</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgRank || '--'}</div>
            <p className="text-xs text-muted-foreground">Across top 100 tracking</p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_10px_24px_rgba(15,61,46,0.045)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Top 3 Rankings</CardTitle>
            <TrendingUp className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{top3}</div>
            <p className="text-xs text-muted-foreground">High visibility terms</p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_10px_24px_rgba(15,61,46,0.045)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Top 10 Rankings</CardTitle>
            <ArrowRight className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{top10}</div>
            <p className="text-xs text-muted-foreground">Page 1 organic results</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)] lg:col-span-2">
          <CardHeader className="border-b border-[#E6ECE8] bg-white">
            <CardTitle>Tracked Keywords</CardTitle>
            <CardDescription>Select a keyword to view its ranking history.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-8 text-center text-muted-foreground">Loading keywords...</div>
            ) : keywords.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground flex flex-col items-center">
                <Target className="w-12 h-12 mb-4 opacity-20" />
                <p>No keywords tracked yet.</p>
                <Button variant="link" onClick={() => setAddDialogOpen(true)}>Add your first keyword</Button>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <Table>
                <TableHeader className="sticky top-0 z-10 bg-[#FBFCFB]">
                    <TableRow>
                      <TableHead>Keyword</TableHead>
                      <TableHead>Device/Loc</TableHead>
                      <TableHead className="text-center">Current Rank</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead className="hidden md:table-cell">URL</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {keywords.map(kw => (
                      <TableRow 
                        key={kw.id} 
                        className={`cursor-pointer transition-colors hover:bg-[#F6FAF7] ${selectedKeywordId === kw.id ? 'bg-[#EAF4EC]' : ''}`}
                        onClick={() => setSelectedKeywordId(kw.id)}
                      >
                        <TableCell className="font-medium">{kw.keyword}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Badge variant="outline" className="text-[10px] uppercase py-0 leading-tight">{kw.device}</Badge>
                            <Badge variant="outline" className="text-[10px] uppercase py-0 leading-tight">{kw.location}</Badge>
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          {renderRankBadge(kw.currentPosition)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatRankDate(kw.lastUpdated)}
                        </TableCell>
                        <TableCell className="hidden md:table-cell max-w-[200px] truncate text-xs text-muted-foreground" title={kw.rankingUrl}>
                          {kw.rankingUrl === 'gsc_aggregated' ? 'GSC Data' : kw.rankingUrl === 'gsc_live_auth' ? 'GSC Live Auth' : kw.rankingUrl ? (() => { 
                            try { 
                              const path = new URL(kw.rankingUrl).pathname; 
                              return path === '/' ? 'Homepage' : path;
                            } catch(e) { return kw.rankingUrl } 
                          })() : '--'}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={(e) => handleDeleteKeyword(kw.id, e)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)] lg:col-span-1">
          <CardHeader className="border-b border-[#E6ECE8] bg-white">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <CardTitle>Position History</CardTitle>
                <CardDescription className="truncate">
                  {selectedKeywordId ? keywords.find(k => k.id === selectedKeywordId)?.keyword : "Select a keyword"}
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={exportSelectedHistory} disabled={!selectedKeywordId || historyLoading || historyData.length === 0}>
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {!selectedKeywordId ? (
               <div className="flex h-[300px] items-center justify-center rounded-2xl border border-dashed border-[#D9E5DE] bg-[#FBFCFB] text-muted-foreground">
                 Select a keyword to view
               </div>
            ) : historyLoading ? (
               <div className="flex h-[300px] items-center justify-center rounded-2xl border border-dashed border-[#D9E5DE] bg-[#FBFCFB] text-muted-foreground">
                 Loading history...
               </div>
            ) : historyData.length === 0 ? (
               <div className="flex h-[300px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#D9E5DE] bg-[#FBFCFB] text-muted-foreground">
                 <p>Rank history will appear after automatic collection runs.</p>
               </div>
            ) : (
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={historyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" fontSize={12} tickLine={false} axisLine={false} />
                      {/* Inverted Y-Axis logic for Recharts: smaller numbers at top */}
                      <YAxis 
                        reversed={true} 
                        domain={[1, 100]} 
                        fontSize={12} 
                        tickLine={false} 
                        axisLine={false}
                        tickCount={5}
                      />
                      <RechartsTooltip 
                        contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                        formatter={(value: any) => [value === -1 ? '100+' : value, 'Position']}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="positionRaw" 
                        stroke="#3b82f6" 
                        strokeWidth={3} 
                        dot={{ r: 4, strokeWidth: 2 }} 
                        activeDot={{ r: 6 }} 
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
            )}
          </CardContent>
          <CardFooter className="border-t border-[#E6ECE8] bg-[#FBFCFB] py-3 text-xs text-muted-foreground">
             Data powered by Google Search Console integration and anonymous SERP checks.
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
