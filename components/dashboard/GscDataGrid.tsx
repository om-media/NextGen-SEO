import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Filter, Search, Download, Plus, Loader2, ArrowUpDown, ArrowUp, ArrowDown, Sparkles, Check } from "lucide-react"
import { useAuth } from "@/src/contexts/AuthContext"
import { GscApiService, GscSearchAnalyticsRow } from "@/src/services/gscService"
import { saveFilter } from "@/src/services/dbService"
import { generateGscInsights } from "@/src/services/aiService"
import { format, subDays } from "date-fns"
import { DateRange } from "react-day-picker"
import { Overview } from "./Overview"
import { authFetch } from "@/src/lib/authFetch"
import { GscAiInsightsDialog } from "./GscAiInsightsDialog"
import {
  classifyIntent,
  filterGridData,
  getGridSearchPlaceholder,
  getGridTitle,
  getGridTitleWithCount,
  hasActiveGridFilters,
  sortGridData,
  type GridFilters,
  type GridRow,
  type SortColumn,
} from "./gscGridUtils"
import { useRankTrackerKeywords } from "./useRankTrackerKeywords"

export function GscDataGrid({ 
  siteUrl, 
  dimension = 'query', 
  dateRange,
  isCompareMode,
  compareDateRange,
  useLiveData = true,
  hideTrackerButton = false
}: { 
  siteUrl: string, 
  dimension?: 'query' | 'page' | 'country', 
  dateRange?: DateRange,
  isCompareMode?: boolean,
  compareDateRange?: DateRange,
  useLiveData?: boolean,
  hideTrackerButton?: boolean
}) {
  const [searchTerm, setSearchTerm] = useState("")
  const [intentFilter, setIntentFilter] = useState("all")
  const { accessToken, userProfile, clearAccessToken } = useAuth()
  const [data, setData] = useState<GridRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // Sort state
  const [sortColumn, setSortColumn] = useState<SortColumn>('clicks')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')

  // Advanced filters state
  const [minClicks, setMinClicks] = useState<number | "">("")
  const [minImpressions, setMinImpressions] = useState<number | "">("")
  const [maxPosition, setMaxPosition] = useState<number | "">("")
  const [isQuestionOnly, setIsQuestionOnly] = useState(false)
  const [minWords, setMinWords] = useState<number | "">("")
  const [isAdvancedFiltersOpen, setIsAdvancedFiltersOpen] = useState(false)

  // Save filter state
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false)
  const [filterName, setFilterName] = useState("")
  const [isSavingFilter, setIsSavingFilter] = useState(false)

  // AI Insights state
  const [isAiDialogOpen, setIsAiDialogOpen] = useState(false)
  const [aiInsights, setAiInsights] = useState<string | null>(null)
  const [isGeneratingAi, setIsGeneratingAi] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  // Selected row for chart
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null)

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 100

  const { addKeywordToTracker, addedKeywords, addingKeywords } = useRankTrackerKeywords({
    dimension,
    hideTrackerButton,
    siteUrl,
  })

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1)
  }, [searchTerm, intentFilter, minClicks, minImpressions, maxPosition, isQuestionOnly, minWords, sortColumn, sortDirection, dimension, dateRange, compareDateRange, isCompareMode])

  useEffect(() => {
    setAiInsights(null)
    setAiError(null)
  }, [siteUrl, dimension, dateRange, searchTerm, intentFilter, minClicks, minImpressions, maxPosition, isQuestionOnly, minWords, sortColumn, sortDirection])

  useEffect(() => {
    if (siteUrl && dateRange?.from && dateRange?.to) {
      setLoading(true)
      setError(null)
      const gscService = new GscApiService(accessToken, userProfile?.tier || 'free')
      
      const startDate = format(dateRange.from, 'yyyy-MM-dd')
      const endDate = format(dateRange.to, 'yyyy-MM-dd')

      const fetchWarehouseData = async (start: string, end: string) => {
        const res = await authFetch('/api/warehouse/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteUrl, startDate: start, endDate: end, dimensions: [dimension] })
        })
        if (!res.ok) throw new Error("Failed to fetch warehouse data")
        const json = await res.json()
        return json.map((r: any) => ({
          keys: [r[dimension]],
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position
        }))
      }

      const promises = [
        useLiveData 
          ? gscService.querySearchAnalytics(siteUrl, startDate, endDate, [dimension])
          : fetchWarehouseData(startDate, endDate)
      ];

      if (isCompareMode && compareDateRange?.from && compareDateRange?.to) {
        const compareStartDate = format(compareDateRange.from, 'yyyy-MM-dd')
        const compareEndDate = format(compareDateRange.to, 'yyyy-MM-dd')
        promises.push(
          useLiveData
            ? gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, [dimension])
            : fetchWarehouseData(compareStartDate, compareEndDate)
        )
      }

      Promise.all(promises)
        .then(([primaryRows, compareRows]) => {
          if (!isCompareMode || !compareRows) {
            setData(primaryRows)
            return;
          }

          // Merge primary and compare rows
          const compareMap = new Map((compareRows as any[]).map(row => [row.keys[0], row]));
          
          const mergedData = primaryRows.map(row => {
            const compareRow = compareMap.get(row.keys[0]);
            return {
              ...row,
              compareClicks: compareRow?.clicks || 0,
              compareImpressions: compareRow?.impressions || 0,
              compareCtr: compareRow?.ctr || 0,
              comparePosition: compareRow?.position || 0,
            };
          });

          // Add rows that are only in compare data (optional, but good for completeness)
          // For now, let's just stick to the primary rows to keep it simple and focused on current performance.
          
          setData(mergedData)
        })
        .catch(err => {
          if (err.message === 'UNAUTHORIZED' || err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token")) {
            console.warn("GSC Access token expired or invalid. Prompting re-authentication.");
            clearAccessToken()
            setError("Your Google session has expired. Please click 'Reconnect Google' at the top to restore live data.")
          } else if (err.message.includes("sufficient permission")) {
            setError("You do not have sufficient permission to view data for this property. Please select a different property or verify your access in Google Search Console.")
          } else {
            console.error("Failed to fetch GSC data:", err)
            setError(err.message)
          }
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [accessToken, siteUrl, dimension, dateRange, isCompareMode, compareDateRange, clearAccessToken, useLiveData])

  const gridFilters: GridFilters = {
    intentFilter,
    isQuestionOnly,
    maxPosition,
    minClicks,
    minImpressions,
    minWords,
    searchTerm,
  }

  const filteredData = filterGridData(data, dimension, gridFilters, siteUrl)
  const sortedData = sortGridData(filteredData, sortColumn, sortDirection, siteUrl)

  const totalPages = Math.ceil(filteredData.length / pageSize)

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column)
      setSortDirection('desc')
    }
  }

  const renderSortIcon = (column: SortColumn) => {
    if (sortColumn !== column) return <ArrowUpDown className="ml-2 h-4 w-4 text-muted-foreground opacity-50" />
    return sortDirection === 'asc' ? <ArrowUp className="ml-2 h-4 w-4" /> : <ArrowDown className="ml-2 h-4 w-4" />
  }

  const handleSaveFilter = async () => {
    if (!filterName.trim()) return
    
    setIsSavingFilter(true)
    try {
      const configuration = JSON.stringify({
        searchTerm,
        intentFilter: dimension === 'query' ? intentFilter : 'all',
        dimension,
        minClicks,
        minImpressions,
        maxPosition,
        isQuestionOnly: dimension === 'query' ? isQuestionOnly : false,
        minWords: dimension === 'query' ? minWords : ""
      })
      
      await saveFilter({
        name: filterName,
        projectId: siteUrl,
        configuration
      })
      
      setIsSaveDialogOpen(false)
      setFilterName("")
      // In a real app, we might want to trigger a refresh of the sidebar here
      // or use a global state/context for saved filters
    } catch (err) {
      console.error("Failed to save filter:", err)
    } finally {
      setIsSavingFilter(false)
    }
  }

  const handleGenerateInsights = async () => {
    setIsGeneratingAi(true)
    setAiError(null)
    try {
      const insights = await generateGscInsights(sortedData, dimension, searchTerm, intentFilter)
      setAiInsights(insights)
    } catch (err: any) {
      setAiError(err.message)
    } finally {
      setIsGeneratingAi(false)
    }
  }

  const renderDifference = (current: number, previous: number | undefined, isPercentage: boolean = false, inverse: boolean = false) => {
    if (!isCompareMode || previous === undefined) return null;
    
    const diff = current - previous;
    if (diff === 0) return null;

    let isPositive = diff > 0;
    if (inverse) isPositive = !isPositive;

    const formattedDiff = isPercentage 
      ? `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(2)}%`
      : `${diff > 0 ? '+' : ''}${Number.isInteger(diff) ? diff.toLocaleString() : diff.toFixed(1)}`;

    return (
      <span className={`text-xs ml-2 ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
        {formattedDiff}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-4 border border-destructive/50 bg-destructive/10 rounded-lg text-destructive text-sm">
          {error}
        </div>
      )}
      {selectedRowKey && (
        <Card className="border shadow-sm">
          <div className="p-4 border-b bg-muted/20 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h3 className="font-semibold text-lg">Historic Trend</h3>
              <p className="text-sm text-muted-foreground">
                Performance over time for {dimension}: <span className="font-medium text-foreground">{selectedRowKey}</span>
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setSelectedRowKey(null)}>
              Close Chart
            </Button>
          </div>
          <div className="p-6">
            <Overview 
              siteUrl={siteUrl} 
              dateRange={dateRange} 
              filterDimension={dimension} 
              filterValue={selectedRowKey} 
              isCompareMode={isCompareMode}
              compareDateRange={compareDateRange}
            />
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <CardTitle className="leading-tight">{getGridTitleWithCount(dimension, sortedData.length)}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <GscAiInsightsDialog
              description={`Analysis based on your current filters and sorting for ${getGridTitle(dimension).toLowerCase()}.`}
              error={aiError}
              insights={aiInsights}
              isGenerating={isGeneratingAi}
              onGenerate={handleGenerateInsights}
              onOpenChange={setIsAiDialogOpen}
              open={isAiDialogOpen}
              title="AI SEO Insights"
            />
            <Button variant="outline" size="sm">
              <Download className="w-4 h-4 mr-2" />
              Export
            </Button>
            <Dialog open={isSaveDialogOpen} onOpenChange={setIsSaveDialogOpen}>
              <DialogTrigger render={<Button size="sm" />}>
                <Plus className="w-4 h-4 mr-2" />
                Save Filter
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Save Custom Filter</DialogTitle>
                  <DialogDescription>
                    Save your current search and intent filters to quickly access them later from the sidebar.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="flex flex-col gap-2">
                    <label htmlFor="name" className="text-sm font-medium">
                      Filter Name
                    </label>
                    <Input
                      id="name"
                      placeholder="e.g., High Intent Commercial Queries"
                      value={filterName}
                      onChange={(e) => setFilterName(e.target.value)}
                    />
                  </div>
                  <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
                    <p className="font-medium mb-1">Current Configuration:</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li>Dimension: {dimension}</li>
                      {searchTerm && <li>Search: "{searchTerm}"</li>}
                      {dimension === 'query' && intentFilter !== 'all' && <li>Intent: {intentFilter}</li>}
                      {minClicks !== "" && <li>Min Clicks: {minClicks}</li>}
                      {minImpressions !== "" && <li>Min Impressions: {minImpressions}</li>}
                      {maxPosition !== "" && <li>Max Position: {maxPosition}</li>}
                      {dimension === 'query' && isQuestionOnly && <li>Questions Only</li>}
                      {dimension === 'query' && minWords !== "" && <li>Min Words: {minWords}</li>}
                      {!searchTerm && (dimension !== 'query' || intentFilter === 'all') && minClicks === "" && minImpressions === "" && maxPosition === "" && !isQuestionOnly && minWords === "" && <li>No active filters</li>}
                    </ul>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsSaveDialogOpen(false)}>Cancel</Button>
                  <Button onClick={handleSaveFilter} disabled={!filterName.trim() || isSavingFilter}>
                    {isSavingFilter && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save Filter
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 mb-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <div className="relative w-full sm:flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={getGridSearchPlaceholder(dimension)}
                className="pl-8"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              {dimension === 'query' && (
                <Select value={intentFilter} onValueChange={setIntentFilter}>
                  <SelectTrigger className="w-[140px] sm:w-[180px]">
                    <SelectValue placeholder="Intent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Intents</SelectItem>
                    <SelectItem value="commercial">Commercial</SelectItem>
                    <SelectItem value="informational">Informational</SelectItem>
                    <SelectItem value="navigational">Navigational</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <Dialog open={isAdvancedFiltersOpen} onOpenChange={setIsAdvancedFiltersOpen}>
                <DialogTrigger render={<Button variant="secondary" className="shrink-0" />}>
                  <Filter className="w-4 h-4 mr-2" />
                  Advanced Filters
                </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Advanced Filters</DialogTitle>
                  <DialogDescription>
                    Filter your data by specific performance metrics.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  {dimension === 'query' && (
                    <>
                      <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium">Query Type</label>
                        <Select value={isQuestionOnly ? "questions" : "all"} onValueChange={(v) => setIsQuestionOnly(v === "questions")}>
                          <SelectTrigger>
                            <SelectValue placeholder="All Queries" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Queries</SelectItem>
                            <SelectItem value="questions">Questions Only</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium">Minimum Words</label>
                        <Input
                          type="number"
                          placeholder="e.g., 3"
                          value={minWords}
                          onChange={(e) => setMinWords(e.target.value ? Number(e.target.value) : "")}
                        />
                      </div>
                    </>
                  )}
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">Minimum Clicks</label>
                    <Input
                      type="number"
                      placeholder="e.g., 100"
                      value={minClicks}
                      onChange={(e) => setMinClicks(e.target.value ? Number(e.target.value) : "")}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">Minimum Impressions</label>
                    <Input
                      type="number"
                      placeholder="e.g., 1000"
                      value={minImpressions}
                      onChange={(e) => setMinImpressions(e.target.value ? Number(e.target.value) : "")}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">Maximum Position</label>
                    <Input
                      type="number"
                      placeholder="e.g., 10"
                      value={maxPosition}
                      onChange={(e) => setMaxPosition(e.target.value ? Number(e.target.value) : "")}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={() => setIsAdvancedFiltersOpen(false)}>Apply Filters</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            </div>
          </div>
          
          {/* Active Filters Bar */}
          {hasActiveGridFilters(dimension, gridFilters) && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Active filters:</span>
              {searchTerm && (
                <Badge variant="secondary" className="font-normal">
                  Search: {searchTerm}
                </Badge>
              )}
              {dimension === 'query' && intentFilter !== 'all' && (
                <Badge variant="secondary" className="font-normal capitalize">
                  Intent: {intentFilter}
                </Badge>
              )}
              {dimension === 'query' && isQuestionOnly && (
                <Badge variant="secondary" className="font-normal">
                  Questions Only
                </Badge>
              )}
              {dimension === 'query' && minWords !== "" && (
                <Badge variant="secondary" className="font-normal">
                  Words &ge; {minWords}
                </Badge>
              )}
              {minClicks !== "" && (
                <Badge variant="secondary" className="font-normal">
                  Clicks &ge; {minClicks}
                </Badge>
              )}
              {minImpressions !== "" && (
                <Badge variant="secondary" className="font-normal">
                  Impressions &ge; {minImpressions}
                </Badge>
              )}
              {maxPosition !== "" && (
                <Badge variant="secondary" className="font-normal">
                  Position &le; {maxPosition}
                </Badge>
              )}
              <Button 
                variant="ghost" 
                size="sm" 
                className="h-6 px-2 text-xs"
                onClick={() => {
                  setSearchTerm("")
                  setIntentFilter("all")
                  setMinClicks("")
                  setMinImpressions("")
                  setMaxPosition("")
                  setIsQuestionOnly(false)
                  setMinWords("")
                }}
              >
                Clear all
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[300px] cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('key')}>
                  <div className="flex items-center">
                    {getGridTitle(dimension)}
                    {renderSortIcon('key')}
                  </div>
                </TableHead>
                {dimension === 'query' && (
                  <TableHead className="cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('intent')}>
                    <div className="flex items-center">
                      Intent
                      {renderSortIcon('intent')}
                    </div>
                  </TableHead>
                )}
                <TableHead className="text-right cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('clicks')}>
                  <div className="flex items-center justify-end">
                    Clicks
                    {renderSortIcon('clicks')}
                  </div>
                </TableHead>
                <TableHead className="text-right cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('impressions')}>
                  <div className="flex items-center justify-end">
                    Impressions
                    {renderSortIcon('impressions')}
                  </div>
                </TableHead>
                <TableHead className="text-right cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('ctr')}>
                  <div className="flex items-center justify-end">
                    CTR
                    {renderSortIcon('ctr')}
                  </div>
                </TableHead>
                <TableHead className="text-right cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('position')}>
                  <div className="flex items-center justify-end">
                    Position
                    {renderSortIcon('position')}
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={dimension === 'query' ? 6 : 5} className="h-24 text-center">
                    <div className="flex items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-muted-foreground">Loading data...</span>
                    </div>
                  </TableCell>
                </TableRow>
              ) : error ? (
                <TableRow>
                  <TableCell colSpan={dimension === 'query' ? 6 : 5} className="h-24 text-center text-destructive">
                    {error}
                  </TableCell>
                </TableRow>
              ) : sortedData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={dimension === 'query' ? 6 : 5} className="h-24 text-center text-muted-foreground">
                    No data found.
                  </TableCell>
                </TableRow>
              ) : (
                sortedData.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((row, i) => {
                  const key = row.keys[0]
                  const intent = dimension === 'query' ? classifyIntent(key, siteUrl) : null
                  return (
                    <TableRow 
                      key={i}
                      className={`cursor-pointer hover:bg-muted/50 ${selectedRowKey === key ? 'bg-muted' : ''}`}
                      onClick={() => setSelectedRowKey(key)}
                    >
                      <TableCell className="font-medium max-w-[300px] truncate" title={key}>
                        {dimension === 'page' ? (
                          <a href={key} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                            {key.replace(siteUrl, '/')}
                          </a>
                        ) : dimension === 'country' ? (
                          <span className="uppercase">{key}</span>
                        ) : dimension === 'query' ? (
                          <div className="flex items-center justify-between">
                            <span className="truncate">{key}</span>
                            {!hideTrackerButton && (
                              <Button
                                variant="ghost" 
                                size="icon" 
                                className={`h-6 w-6 ml-2 z-10 ${addedKeywords.has(key) ? 'text-green-500 opacity-100 cursor-default' : 'text-muted-foreground hover:text-primary opacity-50 hover:opacity-100'}`}
                                title={addedKeywords.has(key) ? "Added to Rank Tracker" : "Add to Rank Tracker"}
                                disabled={addedKeywords.has(key) || addingKeywords.has(key)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!addedKeywords.has(key) && !addingKeywords.has(key)) {
                                    addKeywordToTracker(key, row.position);
                                  }
                                }}
                              >
                                {addingKeywords.has(key) ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : addedKeywords.has(key) ? (
                                  <Check className="h-4 w-4" />
                                ) : (
                                  <Plus className="h-4 w-4" />
                                )}
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="truncate">{key}</span>
                        )}
                      </TableCell>
                      {dimension === 'query' && (
                        <TableCell>
                          <Badge variant={intent === "Commercial" ? "default" : "secondary"} className="font-normal">
                            {intent}
                          </Badge>
                        </TableCell>
                      )}
                      <TableCell className="text-right">
                        {row.clicks.toLocaleString()}
                        {renderDifference(row.clicks, row.compareClicks)}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.impressions.toLocaleString()}
                        {renderDifference(row.impressions, row.compareImpressions)}
                      </TableCell>
                      <TableCell className="text-right">
                        {(row.ctr * 100).toFixed(2)}%
                        {renderDifference(row.ctr, row.compareCtr, true)}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.position.toFixed(1)}
                        {renderDifference(row.position, row.comparePosition, false, true)}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
        
        {/* Pagination Controls */}
        {!loading && !error && sortedData.length > 0 && (
          <div className="flex items-center justify-between mt-4">
            <div className="text-sm text-muted-foreground">
              Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, sortedData.length)} of {sortedData.length} entries
            </div>
            <div className="flex items-center space-x-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              <div className="text-sm font-medium">
                Page {currentPage} of {totalPages}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  )
}
