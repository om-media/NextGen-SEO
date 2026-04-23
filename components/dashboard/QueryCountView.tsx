import { useState, useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useAuth } from "@/src/contexts/AuthContext"
import { GscApiService } from "@/src/services/gscService"
import { format, parseISO } from "date-fns"
import { DateRange } from "react-day-picker"
import { Loader2, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react"
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { authFetch } from "@/src/lib/authFetch"

type SortColumn = 'page' | 'queryCount' | 'clicks' | 'impressions' | null;

const CustomYAxisTick = (props: any) => {
  const { x, y, payload, fill, formatter, textAnchor } = props;
  const text = formatter ? formatter(payload.value) : payload.value;
  
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={-10}
        dy={0}
        textAnchor={textAnchor}
        fontSize={12}
        fontWeight="500"
        stroke="white"
        strokeWidth={4}
        strokeLinejoin="round"
        style={{ paintOrder: 'stroke' }}
      >
        {text}
      </text>
      <text
        x={0}
        y={-10}
        dy={0}
        textAnchor={textAnchor}
        fill={fill}
        fontSize={12}
        fontWeight="500"
      >
        {text}
      </text>
    </g>
  );
};

export function QueryCountView({ 
  siteUrl, 
  dateRange,
  isCompareMode,
  compareDateRange,
  useLiveData = true
}: { 
  siteUrl: string, 
  dateRange?: DateRange,
  isCompareMode?: boolean,
  compareDateRange?: DateRange,
  useLiveData?: boolean
}) {
  const { accessToken, userProfile, clearAccessToken } = useAuth()
  
  const [tableData, setTableData] = useState<any[]>([])
  const [chartData, setChartData] = useState<any[]>([])
  
  const [loadingTable, setLoadingTable] = useState(false)
  const [loadingChart, setLoadingChart] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const [selectedPage, setSelectedPage] = useState<string | null>(null)

  // Sort state
  const [sortColumn, setSortColumn] = useState<SortColumn>('queryCount')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')

  // Pagination state
  const [pageIndex, setPageIndex] = useState(0)
  const pageSize = 100

  // Fetch Table Data (Pages and their Query Count)
  useEffect(() => {
    if (!siteUrl || !dateRange?.from || !dateRange?.to) return;
    
    setLoadingTable(true)
    setError(null)
    
    const gscService = new GscApiService(accessToken, userProfile?.tier || 'free')
    const startDate = format(dateRange.from, 'yyyy-MM-dd')
    const endDate = format(dateRange.to, 'yyyy-MM-dd')
    
    const fetchWarehouseData = async (start: string, end: string) => {
      const res = await authFetch('/api/warehouse/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteUrl, startDate: start, endDate: end, dimensions: ['page', 'query'] })
      })
      if (!res.ok) throw new Error("Failed to fetch warehouse data")
      const json = await res.json()
      return json.map((r: any) => ({
        keys: [r.page, r.query],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position
      }))
    }

    const promises = [
      useLiveData 
        ? gscService.querySearchAnalytics(siteUrl, startDate, endDate, ['page', 'query'])
        : fetchWarehouseData(startDate, endDate)
    ];

    if (isCompareMode && compareDateRange?.from && compareDateRange?.to) {
      const compareStartDate = format(compareDateRange.from, 'yyyy-MM-dd')
      const compareEndDate = format(compareDateRange.to, 'yyyy-MM-dd')
      promises.push(
        useLiveData
          ? gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, ['page', 'query'])
          : fetchWarehouseData(compareStartDate, compareEndDate)
      )
    }

    Promise.all(promises)
      .then(([primaryRows, compareRows]) => {
        // Aggregate unique queries per page
        const pageMap = new Map<string, { querySet: Set<string>, clicks: number, impressions: number, compareQuerySet?: Set<string>, compareClicks?: number, compareImpressions?: number }>()
        
        primaryRows.forEach(row => {
          const page = row.keys[0]
          const query = row.keys[1]
          
          if (!pageMap.has(page)) {
            pageMap.set(page, { querySet: new Set(), clicks: 0, impressions: 0 })
          }
          
          const agg = pageMap.get(page)!
          agg.querySet.add(query)
          agg.clicks += row.clicks
          agg.impressions += row.impressions
        })

        if (isCompareMode && compareRows) {
          compareRows.forEach(row => {
            const page = row.keys[0]
            const query = row.keys[1]
            
            if (!pageMap.has(page)) {
              pageMap.set(page, { querySet: new Set(), clicks: 0, impressions: 0, compareQuerySet: new Set(), compareClicks: 0, compareImpressions: 0 })
            }
            
            const agg = pageMap.get(page)!
            if (!agg.compareQuerySet) agg.compareQuerySet = new Set();
            agg.compareQuerySet.add(query)
            agg.compareClicks = (agg.compareClicks || 0) + row.clicks
            agg.compareImpressions = (agg.compareImpressions || 0) + row.impressions
          })
        }

        const result = Array.from(pageMap.entries()).map(([page, data]) => ({
          page,
          queryCount: data.querySet.size,
          clicks: data.clicks,
          impressions: data.impressions,
          compareQueryCount: data.compareQuerySet ? data.compareQuerySet.size : 0,
          compareClicks: data.compareClicks || 0,
          compareImpressions: data.compareImpressions || 0
        }))

        setTableData(result)
      })
      .catch(err => {
        if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token")) {
          console.warn("GSC Access token expired or invalid. Prompting re-authentication.");
          clearAccessToken()
        } else if (err.message.includes("sufficient permission")) {
          setError("You do not have sufficient permission to view data for this property. Please select a different property or verify your access in Google Search Console.")
        } else {
          console.error("Failed to load query count table data:", err)
          setError(err.message)
        }
      })
      .finally(() => {
        setLoadingTable(false)
      })
  }, [accessToken, siteUrl, dateRange, isCompareMode, compareDateRange, clearAccessToken, useLiveData])

  // Fetch Chart Data (Historic Trend of Unique Queries)
  useEffect(() => {
    if (!siteUrl || !dateRange?.from || !dateRange?.to) return;
    
    setLoadingChart(true)
    
    const gscService = new GscApiService(accessToken, userProfile?.tier || 'free')
    const startDate = format(dateRange.from, 'yyyy-MM-dd')
    const endDate = format(dateRange.to, 'yyyy-MM-dd')
    
    const filterGroups = selectedPage ? [{
      filters: [{ dimension: 'page', expression: selectedPage, operator: 'equals' }]
    }] : undefined;

    const fetchWarehouseData = async (start: string, end: string) => {
      const res = await authFetch('/api/warehouse/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteUrl, startDate: start, endDate: end, dimensions: ['date', 'query'], dimensionFilterGroups: filterGroups })
      })
      if (!res.ok) throw new Error("Failed to fetch warehouse data")
      const json = await res.json()
      return json.map((r: any) => ({
        keys: [r.date, r.query],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position
      }))
    }

    const promises = [
      useLiveData
        ? gscService.querySearchAnalytics(siteUrl, startDate, endDate, ['date', 'query'], filterGroups)
        : fetchWarehouseData(startDate, endDate)
    ];

    if (isCompareMode && compareDateRange?.from && compareDateRange?.to) {
      const compareStartDate = format(compareDateRange.from, 'yyyy-MM-dd')
      const compareEndDate = format(compareDateRange.to, 'yyyy-MM-dd')
      promises.push(
        useLiveData
          ? gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, ['date', 'query'], filterGroups)
          : fetchWarehouseData(compareStartDate, compareEndDate)
      )
    }

    Promise.all(promises)
      .then(([primaryRows, compareRows]) => {
        // Aggregate unique queries per date
        const dateMap = new Map<string, Set<string>>()
        
        primaryRows.forEach(row => {
          const date = row.keys[0]
          const query = row.keys[1]
          
          if (!dateMap.has(date)) {
            dateMap.set(date, new Set())
          }
          
          dateMap.get(date)!.add(query)
        })

        const primaryResult = Array.from(dateMap.entries()).map(([date, querySet]) => ({
          date: format(parseISO(date), 'MMM d, yyyy'),
          rawDate: date,
          queryCount: querySet.size
        })).sort((a, b) => a.rawDate.localeCompare(b.rawDate))

        if (isCompareMode && compareRows) {
          const compareDateMap = new Map<string, Set<string>>()
          compareRows.forEach(row => {
            const date = row.keys[0]
            const query = row.keys[1]
            if (!compareDateMap.has(date)) {
              compareDateMap.set(date, new Set())
            }
            compareDateMap.get(date)!.add(query)
          })

          const compareResult = Array.from(compareDateMap.entries()).map(([date, querySet]) => ({
            rawDate: date,
            compareQueryCount: querySet.size
          })).sort((a, b) => a.rawDate.localeCompare(b.rawDate))

          // Align by index
          const mergedResult = primaryResult.map((item, index) => ({
            ...item,
            compareQueryCount: compareResult[index]?.compareQueryCount || 0
          }))
          setChartData(mergedResult)
        } else {
          setChartData(primaryResult)
        }
      })
      .catch(err => {
        if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token")) {
          clearAccessToken()
        } else if (err.message.includes("sufficient permission")) {
          // Error is already handled by the table fetch
        } else {
          console.error("Failed to load query count chart data:", err)
        }
      })
      .finally(() => {
        setLoadingChart(false)
      })
  }, [accessToken, siteUrl, dateRange, isCompareMode, compareDateRange, selectedPage, clearAccessToken, useLiveData])

  const sortedTableData = useMemo(() => {
    return [...tableData].sort((a, b) => {
      if (!sortColumn) return 0;
      const valA = a[sortColumn];
      const valB = b[sortColumn];
      if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    })
  }, [tableData, sortColumn, sortDirection])

  const pageCount = Math.ceil(sortedTableData.length / pageSize)
  const currentData = sortedTableData.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)

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

  const renderDifference = (current: number, previous: number | undefined) => {
    if (!isCompareMode || previous === undefined) return null;
    
    const diff = current - previous;
    if (diff === 0) return null;

    const isPositive = diff > 0;
    const formattedDiff = `${diff > 0 ? '+' : ''}${diff.toLocaleString()}`;

    return (
      <span className={`text-xs ml-2 ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
        {formattedDiff}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-4 text-sm text-destructive bg-destructive/10 rounded-md">
          {error}
        </div>
      )}

      <Card className="overflow-hidden border shadow-sm">
        <div className="p-4 border-b bg-muted/20 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h3 className="font-semibold text-lg">Historic Trend</h3>
            <p className="text-sm text-muted-foreground">
              {selectedPage ? `Unique queries over time for: ${selectedPage.replace(siteUrl, '/')}` : 'Total unique queries over time for the entire property'}
            </p>
          </div>
          {selectedPage && (
            <Button variant="outline" size="sm" onClick={() => setSelectedPage(null)}>
              Clear Selection
            </Button>
          )}
        </div>
        <CardContent className="p-6">
          {loadingChart ? (
            <div className="h-[300px] flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="color_queryCount" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.1}/>
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis
                    dataKey="date"
                    stroke="#888888"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={30}
                    scale="point"
                    padding={{ left: 10, right: 10 }}
                  />
                  <YAxis
                    mirror={true}
                    tickFormatter={(v) => v.toLocaleString()}
                    axisLine={false}
                    tickLine={false}
                    tickCount={5}
                    domain={[0, 'auto']}
                    tick={<CustomYAxisTick fill="#6366f1" formatter={(v: number) => v.toLocaleString()} />}
                  />
                  <Tooltip 
                    contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    labelStyle={{ fontWeight: 'bold', marginBottom: '4px', color: '#0f172a' }}
                    formatter={(value: number) => [value.toLocaleString(), 'Unique Queries']}
                  />
                  <Area
                    type="monotone"
                    dataKey="queryCount"
                    name="Unique Queries"
                    stroke="#6366f1"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#color_queryCount)"
                    activeDot={{ r: 6 }}
                  />
                  {isCompareMode && (
                    <Line
                      type="monotone"
                      dataKey="compareQueryCount"
                      name="Compare Unique Queries"
                      stroke="#6366f1"
                      strokeWidth={2}
                      strokeDasharray="5 5"
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden border shadow-sm">
        <div className="p-4 border-b bg-muted/20">
          <h3 className="font-semibold text-lg">Query Count by Page</h3>
          <p className="text-sm text-muted-foreground">
            Click a page to view its historic trend above.
          </p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50%] cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('page')}>
                  <div className="flex items-center">
                    Page URL
                    {renderSortIcon('page')}
                  </div>
                </TableHead>
                <TableHead className="text-right cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('queryCount')}>
                  <div className="flex items-center justify-end">
                    Total Unique Queries
                    {renderSortIcon('queryCount')}
                  </div>
                </TableHead>
                <TableHead className="text-right cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('clicks')}>
                  <div className="flex items-center justify-end">
                    Total Clicks
                    {renderSortIcon('clicks')}
                  </div>
                </TableHead>
                <TableHead className="text-right cursor-pointer hover:bg-muted/50 select-none" onClick={() => handleSort('impressions')}>
                  <div className="flex items-center justify-end">
                    Total Impressions
                    {renderSortIcon('impressions')}
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingTable ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : currentData.map((row, i) => (
                <TableRow 
                  key={i} 
                  className={`cursor-pointer hover:bg-muted/50 ${selectedPage === row.page ? 'bg-muted' : ''}`}
                  onClick={() => setSelectedPage(row.page)}
                >
                  <TableCell className="font-medium max-w-[500px] truncate" title={row.page}>
                    {row.page.replace(siteUrl, '/')}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-indigo-600">
                    {row.queryCount.toLocaleString()}
                    {renderDifference(row.queryCount, row.compareQueryCount)}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.clicks.toLocaleString()}
                    {renderDifference(row.clicks, row.compareClicks)}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.impressions.toLocaleString()}
                    {renderDifference(row.impressions, row.compareImpressions)}
                  </TableCell>
                </TableRow>
              ))}
              {!loadingTable && sortedTableData.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No data found for this date range.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination Controls */}
        {pageCount > 1 && (
          <div className="flex items-center justify-between px-4 py-4 border-t">
            <div className="flex-1 text-sm text-muted-foreground">
              Showing {pageIndex * pageSize + 1} to {Math.min((pageIndex + 1) * pageSize, sortedTableData.length)} of {sortedTableData.length} entries
            </div>
            <div className="flex items-center space-x-2">
              <Button
                variant="outline"
                className="h-8 w-8 p-0"
                onClick={() => setPageIndex(Math.max(0, pageIndex - 1))}
                disabled={pageIndex === 0}
              >
                <span className="sr-only">Go to previous page</span>
                &lt;
              </Button>
              <div className="flex w-[100px] items-center justify-center text-sm font-medium">
                Page {pageIndex + 1} of {pageCount}
              </div>
              <Button
                variant="outline"
                className="h-8 w-8 p-0"
                onClick={() => setPageIndex(Math.min(pageCount - 1, pageIndex + 1))}
                disabled={pageIndex >= pageCount - 1}
              >
                <span className="sr-only">Go to next page</span>
                &gt;
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
