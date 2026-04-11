import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Filter, Search, Download, Plus, Loader2, ArrowUpDown, ArrowUp, ArrowDown, Sparkles } from "lucide-react"
import { useAuth } from "@/src/contexts/AuthContext"
import { GscApiService, GscSearchAnalyticsRow } from "@/src/services/gscService"
import { saveFilter } from "@/src/services/dbService"
import { generateGscInsights } from "@/src/services/aiService"
import { format, subDays } from "date-fns"
import { DateRange } from "react-day-picker"
import Markdown from "react-markdown"
import { Overview } from "./Overview"

type SortColumn = 'key' | 'intent' | 'clicks' | 'impressions' | 'ctr' | 'position' | null;

export function GscDataGrid({ 
  siteUrl, 
  dimension = 'query', 
  dateRange,
  isCompareMode,
  compareDateRange
}: { 
  siteUrl: string, 
  dimension?: 'query' | 'page' | 'country', 
  dateRange?: DateRange,
  isCompareMode?: boolean,
  compareDateRange?: DateRange
}) {
  const [searchTerm, setSearchTerm] = useState("")
  const [intentFilter, setIntentFilter] = useState("all")
  const { accessToken, clearAccessToken } = useAuth()
  const [data, setData] = useState<(GscSearchAnalyticsRow & { compareClicks?: number, compareImpressions?: number, compareCtr?: number, comparePosition?: number })[]>([])
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

  useEffect(() => {
    setAiInsights(null)
    setAiError(null)
  }, [siteUrl, dimension, dateRange, searchTerm, intentFilter, minClicks, minImpressions, maxPosition, isQuestionOnly, minWords, sortColumn, sortDirection])

  useEffect(() => {
    if (accessToken && siteUrl && dateRange?.from && dateRange?.to) {
      setLoading(true)
      setError(null)
      const gscService = new GscApiService(accessToken)
      
      const startDate = format(dateRange.from, 'yyyy-MM-dd')
      const endDate = format(dateRange.to, 'yyyy-MM-dd')

      const promises = [
        gscService.querySearchAnalytics(siteUrl, startDate, endDate, [dimension])
      ];

      if (isCompareMode && compareDateRange?.from && compareDateRange?.to) {
        const compareStartDate = format(compareDateRange.from, 'yyyy-MM-dd')
        const compareEndDate = format(compareDateRange.to, 'yyyy-MM-dd')
        promises.push(
          gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, [dimension])
        )
      }

      Promise.all(promises)
        .then(([primaryRows, compareRows]) => {
          if (!isCompareMode || !compareRows) {
            setData(primaryRows)
            return;
          }

          // Merge primary and compare rows
          const compareMap = new Map(compareRows.map(row => [row.keys[0], row]));
          
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
          if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token")) {
            console.warn("GSC Access token expired or invalid. Prompting re-authentication.");
            clearAccessToken()
          } else {
            console.error("Failed to fetch GSC data:", err)
            setError(err.message)
          }
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [accessToken, siteUrl, dimension, dateRange, isCompareMode, compareDateRange, clearAccessToken])

  // Simple intent classification based on query keywords
  const classifyIntent = (query: string) => {
    const q = query.toLowerCase()
    if (q.includes("buy") || q.includes("price") || q.includes("cheap") || q.includes("software") || q.includes("tool")) return "Commercial"
    if (q.includes("how") || q.includes("what") || q.includes("guide") || q.includes("tutorial")) return "Informational"
    if (q.includes("review") || q.includes("vs") || q.includes("compare")) return "Commercial"
    return "Navigational"
  }

  const filteredData = data.filter(row => {
    const matchesSearch = row.keys[0].toLowerCase().includes(searchTerm.toLowerCase())
    if (!matchesSearch) return false
    
    if (dimension === 'query') {
      if (intentFilter !== 'all') {
        const intent = classifyIntent(row.keys[0]).toLowerCase()
        if (intent !== intentFilter) return false
      }
      
      if (isQuestionOnly) {
        const q = row.keys[0].toLowerCase()
        const firstWord = q.trim().split(/\s+/)[0]
        const questionWords = ["who", "what", "where", "when", "why", "how", "is", "are", "do", "does", "can", "could", "should", "would"]
        if (!questionWords.includes(firstWord) && !q.includes("?")) return false
      }
      
      if (minWords !== "") {
        const wordCount = row.keys[0].trim().split(/\s+/).length
        if (wordCount < minWords) return false
      }
    }

    if (minClicks !== "" && row.clicks < minClicks) return false
    if (minImpressions !== "" && row.impressions < minImpressions) return false
    if (maxPosition !== "" && row.position > maxPosition) return false

    return true
  })

  const sortedData = [...filteredData].sort((a, b) => {
    if (!sortColumn) return 0;
    
    let valA: any = a[sortColumn as keyof typeof a];
    let valB: any = b[sortColumn as keyof typeof b];

    if (sortColumn === 'key') {
      valA = a.keys[0];
      valB = b.keys[0];
    } else if (sortColumn === 'intent') {
      valA = classifyIntent(a.keys[0]);
      valB = classifyIntent(b.keys[0]);
    }

    if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
    if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  })

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

  const getTitle = () => {
    if (dimension === 'page') return 'Top Pages'
    if (dimension === 'country') return 'Top Countries'
    return 'Search Queries'
  }

  const getTitleWithCount = () => {
    return `${getTitle()} (${sortedData.length})`
  }

  const getSearchPlaceholder = () => {
    if (dimension === 'page') return 'Filter pages...'
    if (dimension === 'country') return 'Filter countries...'
    return 'Filter queries...'
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
      {selectedRowKey && (
        <Card className="border shadow-sm">
          <div className="p-4 border-b bg-muted/20 flex justify-between items-center">
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
        <div className="flex items-center justify-between">
          <CardTitle>{getTitleWithCount()}</CardTitle>
          <div className="flex items-center gap-2">
            <Dialog open={isAiDialogOpen} onOpenChange={(open) => {
              setIsAiDialogOpen(open)
              if (open && !aiInsights) {
                handleGenerateInsights()
              }
            }}>
              <DialogTrigger render={<Button size="sm" variant="secondary" className="bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border-indigo-200" />}>
                <Sparkles className="w-4 h-4 mr-2 text-indigo-500" />
                Analyze with AI
              </DialogTrigger>
              <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-indigo-500" />
                    AI SEO Insights
                  </DialogTitle>
                  <DialogDescription className="italic">
                    Analysis based on your current filters and sorting for {getTitle().toLowerCase()}.
                  </DialogDescription>
                </DialogHeader>
                <div className="py-4">
                  {isGeneratingAi ? (
                    <div className="flex flex-col items-center justify-center py-8 space-y-4">
                      <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                      <p className="text-sm text-muted-foreground">Analyzing data and generating insights...</p>
                    </div>
                  ) : aiError ? (
                    <div className="p-4 bg-destructive/10 text-destructive rounded-md text-sm">
                      {aiError}
                    </div>
                  ) : aiInsights ? (
                    <div className="prose prose-sm max-w-none dark:prose-invert">
                      <Markdown>{aiInsights}</Markdown>
                    </div>
                  ) : null}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => handleGenerateInsights()} disabled={isGeneratingAi}>
                    Regenerate
                  </Button>
                  <Button onClick={() => setIsAiDialogOpen(false)}>Close</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
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
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={getSearchPlaceholder()}
                className="pl-8"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            {dimension === 'query' && (
              <Select value={intentFilter} onValueChange={setIntentFilter}>
                <SelectTrigger className="w-[180px]">
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
              <DialogTrigger render={<Button variant="secondary" />}>
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
          
          {/* Active Filters Bar */}
          {(searchTerm || (dimension === 'query' && intentFilter !== 'all') || minClicks !== "" || minImpressions !== "" || maxPosition !== "" || isQuestionOnly || minWords !== "") && (
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

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[300px] cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('key')}>
                  <div className="flex items-center">
                    {getTitle()}
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
                sortedData.map((row, i) => {
                  const key = row.keys[0]
                  const intent = dimension === 'query' ? classifyIntent(key) : null
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
                        ) : (
                          key
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
      </CardContent>
    </Card>
    </div>
  )
}
