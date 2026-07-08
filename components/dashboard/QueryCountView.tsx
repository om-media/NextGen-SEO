import { useState, useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useAuth } from "@/src/contexts/AuthContext"
import { GscApiService } from "@/src/services/gscService"
import { addDays, format, parseISO } from "date-fns"
import { DateRange } from "react-day-picker"
import { Loader2, ArrowUpDown, ArrowUp, ArrowDown, Download } from "lucide-react"
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

const hasPageKeys = (row: any) => (
  typeof row?.keys?.[0] === "string" &&
  row.keys[0].length > 0
);

const QUERY_VISIBILITY_NOTE =
  "Search Console only exposes non-anonymized query rows here. Rare or privacy-filtered queries can be hidden by Google, so visible query counts may be lower than total site impressions suggest.";

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

export function QueryCountView({ 
  siteUrl, 
  dateRange,
  isCompareMode,
  compareDateRange,
  refreshKey = 0,
  useLiveData = true
}: { 
  siteUrl: string, 
  dateRange?: DateRange,
  isCompareMode?: boolean,
  compareDateRange?: DateRange,
  refreshKey?: number,
  useLiveData?: boolean
}) {
  const { userProfile } = useAuth()
  
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
    
    const startDate = format(dateRange.from, 'yyyy-MM-dd')
    const endDate = format(dateRange.to, 'yyyy-MM-dd')
    
    const fetchWarehouseData = async (start: string, end: string) => {
      const allRows: any[] = [];
      const rowLimit = 50000;
      let startRow = 0;
      let hasMore = true;

      while (hasMore) {
        const res = await authFetch('/api/warehouse/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteUrl, startDate: start, endDate: end, dimensions: ['page'], rowLimit, startRow })
        })
        if (!res.ok) throw new Error("Failed to fetch warehouse data")
        const json = await res.json()
        const pageRows = Array.isArray(json) ? json : [];
        allRows.push(...pageRows);
        hasMore = pageRows.length === rowLimit;
        startRow += rowLimit;
      }

      return allRows.map((r: any) => ({
        keys: [r.page],
        queryCount: Number(r.queryCount) || 0,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position
      })).filter(hasPageKeys)
    }

    const promises = [
      fetchWarehouseData(startDate, endDate)
    ];

    if (isCompareMode && compareDateRange?.from && compareDateRange?.to) {
      const compareStartDate = format(compareDateRange.from, 'yyyy-MM-dd')
      const compareEndDate = format(compareDateRange.to, 'yyyy-MM-dd')
      promises.push(
        fetchWarehouseData(compareStartDate, compareEndDate)
      )
    }

    Promise.all(promises)
      .then(([primaryRows, compareRows]) => {
        // Aggregate unique queries per page
        const pageMap = new Map<string, {
          querySet: Set<string>,
          queryCount: number,
          clicks: number,
          impressions: number,
          compareQuerySet?: Set<string>,
          compareQueryCount?: number,
          compareClicks?: number,
          compareImpressions?: number
        }>()
        
        primaryRows.filter(hasPageKeys).forEach(row => {
          const page = row.keys[0]
          const query = row.keys[1]
          
          if (!pageMap.has(page)) {
            pageMap.set(page, { querySet: new Set(), queryCount: 0, clicks: 0, impressions: 0 })
          }
          
          const agg = pageMap.get(page)!
          if (query) agg.querySet.add(query)
          else agg.queryCount += Number(row.queryCount) || 0
          agg.clicks += row.clicks
          agg.impressions += row.impressions
        })

        if (isCompareMode && compareRows) {
          compareRows.filter(hasPageKeys).forEach(row => {
            const page = row.keys[0]
            const query = row.keys[1]
            
            if (!pageMap.has(page)) {
              pageMap.set(page, {
                querySet: new Set(),
                queryCount: 0,
                clicks: 0,
                impressions: 0,
                compareQuerySet: new Set(),
                compareQueryCount: 0,
                compareClicks: 0,
                compareImpressions: 0
              })
            }
            
            const agg = pageMap.get(page)!
            if (!agg.compareQuerySet) agg.compareQuerySet = new Set();
            if (query) agg.compareQuerySet.add(query)
            else agg.compareQueryCount = (agg.compareQueryCount || 0) + (Number(row.queryCount) || 0)
            agg.compareClicks = (agg.compareClicks || 0) + row.clicks
            agg.compareImpressions = (agg.compareImpressions || 0) + row.impressions
          })
        }

        const result = Array.from(pageMap.entries()).map(([page, data]) => ({
          page,
          queryCount: data.querySet.size || data.queryCount,
          clicks: data.clicks,
          impressions: data.impressions,
          compareQueryCount: data.compareQuerySet?.size || data.compareQueryCount || 0,
          compareClicks: data.compareClicks || 0,
          compareImpressions: data.compareImpressions || 0
        }))

        setTableData(result)
      })
      .catch(err => {
        if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token") || err.message.includes("GOOGLE_NOT_CONNECTED")) {
          setError("Your Google connection needs attention. Please click 'Reconnect Google Data' at the top to restore reporting access.")
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
  }, [siteUrl, dateRange, isCompareMode, compareDateRange, refreshKey, userProfile?.googleConnected, userProfile?.tier, useLiveData])

  // Fetch Chart Data (Historic Trend of Unique Queries)
  useEffect(() => {
    if (!siteUrl || !dateRange?.from || !dateRange?.to) return;
    
    setLoadingChart(true)
    
    const gscService = new GscApiService(null, userProfile?.tier || 'free')
    const startDate = format(dateRange.from, 'yyyy-MM-dd')
    const endDate = format(dateRange.to, 'yyyy-MM-dd')
    
    const filterGroups = selectedPage ? [{
      filters: [{ dimension: 'page', expression: selectedPage, operator: 'equals' }]
    }] : undefined;

    const fetchWarehouseData = async (start: string, end: string) => {
      const res = await authFetch('/api/warehouse/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteUrl,
          startDate: start,
          endDate: end,
          dimensions: selectedPage ? ['date', 'page'] : ['date'],
          metric: 'queryCount',
          dimensionFilterGroups: filterGroups
        })
      })
      if (!res.ok) throw new Error("Failed to fetch warehouse data")
      const json = await res.json()
      return json.map((r: any) => ({
        keys: [r.date],
        queryCount: Number(r.queryCount) || 0,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position
      })).filter((row: any) => typeof row.keys?.[0] === "string" && row.keys[0].length > 0)
    }

    const fetchLiveDateQueryRows = async (start: string, end: string) => {
      const rows: any[] = [];
      let cursor = parseISO(start);
      const finalDate = parseISO(end);

      // Unique-query counts are extremely sensitive to row caps. Fetch one day at
      // a time so a busy day cannot steal rows from the rest of the range.
      while (cursor <= finalDate) {
        const day = format(cursor, 'yyyy-MM-dd');
        const dayRows = await gscService.querySearchAnalytics(siteUrl, day, day, ['date', 'query'], filterGroups, true);
        rows.push(...dayRows);
        cursor = addDays(cursor, 1);
      }

      return rows;
    };

    const fetchQueryCountRows = async (start: string, end: string) => {
      const warehouseRows = await fetchWarehouseData(start, end);
      if (warehouseRows.some((row: any) => Number(row.queryCount) > 0)) {
        return warehouseRows;
      }

      if (useLiveData && userProfile?.googleConnected) {
        try {
          return await fetchLiveDateQueryRows(start, end);
        } catch (err) {
          console.warn("Daily live query-count fetch failed; using warehouse counts.", err);
        }
      }

      return warehouseRows;
    };

    const promises = [
      fetchQueryCountRows(startDate, endDate)
    ];

    if (isCompareMode && compareDateRange?.from && compareDateRange?.to) {
      const compareStartDate = format(compareDateRange.from, 'yyyy-MM-dd')
      const compareEndDate = format(compareDateRange.to, 'yyyy-MM-dd')
      promises.push(
        fetchQueryCountRows(compareStartDate, compareEndDate)
      )
    }

    Promise.all(promises)
      .then(([primaryRows, compareRows]) => {
        // Aggregate unique queries per date
        const dateMap = new Map<string, { querySet: Set<string>, queryCount: number }>()
        
        primaryRows.forEach(row => {
          const date = row.keys[0]
          const query = row.keys[1]
          const explicitCount = Number(row.queryCount) || 0
          
          if (!dateMap.has(date)) {
            dateMap.set(date, { querySet: new Set(), queryCount: 0 })
          }
          
          const current = dateMap.get(date)!
          if (query) current.querySet.add(query)
          else current.queryCount += explicitCount
        })

        const primaryResult = Array.from(dateMap.entries()).map(([date, data]) => ({
          date: format(parseISO(date), 'MMM d, yyyy'),
          rawDate: date,
          queryCount: data.querySet.size || data.queryCount
        })).sort((a, b) => a.rawDate.localeCompare(b.rawDate))

        if (isCompareMode && compareRows) {
          const compareDateMap = new Map<string, { querySet: Set<string>, queryCount: number }>()
          compareRows.forEach(row => {
            const date = row.keys[0]
            const query = row.keys[1]
            const explicitCount = Number(row.queryCount) || 0
            if (!compareDateMap.has(date)) {
              compareDateMap.set(date, { querySet: new Set(), queryCount: 0 })
            }
            const current = compareDateMap.get(date)!
            if (query) current.querySet.add(query)
            else current.queryCount += explicitCount
          })

          const compareResult = Array.from(compareDateMap.entries()).map(([date, data]) => ({
            rawDate: date,
            compareQueryCount: data.querySet.size || data.queryCount
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
        if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token") || err.message.includes("GOOGLE_NOT_CONNECTED")) {
          setError("Your Google connection needs attention. Please click 'Reconnect Google Data' at the top to restore reporting access.")
        } else if (err.message.includes("sufficient permission")) {
          // Error is already handled by the table fetch
        } else {
          console.error("Failed to load query count chart data:", err)
        }
      })
      .finally(() => {
        setLoadingChart(false)
      })
  }, [siteUrl, dateRange, isCompareMode, compareDateRange, refreshKey, selectedPage, userProfile?.googleConnected, userProfile?.tier, useLiveData])

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
      <span className={`text-xs ml-2 ${isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
        {formattedDiff}
      </span>
    );
  };

  const exportPageRows = () => {
    const startDate = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : "start";
    const endDate = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : "end";
    exportCsv(`gsc-visible-queries-by-page-${startDate}-${endDate}.csv`, sortedTableData.map((row) => ({
      page: row.page,
      visibleQueries: row.queryCount,
      clicks: row.clicks,
      impressions: row.impressions,
      compareVisibleQueries: isCompareMode ? row.compareQueryCount : "",
      compareClicks: isCompareMode ? row.compareClicks : "",
      compareImpressions: isCompareMode ? row.compareImpressions : "",
    })));
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-4 text-sm text-destructive bg-destructive/10 rounded-md">
          {error}
        </div>
      )}

      <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <div className="flex flex-col items-start justify-between gap-3 border-b border-border bg-card p-5 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-lg">Daily Visible Queries</h3>
              <span
                className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
                title={QUERY_VISIBILITY_NOTE}
              >
                GSC filtered
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {selectedPage
                ? `Daily visible queries for: ${selectedPage.replace(siteUrl, '/')}`
                : 'Daily visible queries for the entire property'}
            </p>
            <p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">
              {QUERY_VISIBILITY_NOTE}
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
            <div className="h-[300px] min-w-0 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="color_queryCount" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.1}/>
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis
                    dataKey="date"
                    stroke="var(--muted-foreground)"
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
                    tick={<CustomYAxisTick fill="var(--primary)" formatter={(v: number) => v.toLocaleString()} />}
                  />
                  <Tooltip 
                    contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--popover)', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    labelStyle={{ fontWeight: 'bold', marginBottom: '4px', color: 'var(--foreground)' }}
                    formatter={(value: number) => [value.toLocaleString(), 'Visible queries']}
                  />
                  <Area
                    type="monotone"
                    dataKey="queryCount"
                    name="Visible queries"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#color_queryCount)"
                    activeDot={{ r: 6 }}
                  />
                  {isCompareMode && (
                    <Line
                      type="monotone"
                      dataKey="compareQueryCount"
                      name="Compare visible queries"
                      stroke="var(--primary)"
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

      <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <div className="flex flex-col gap-3 border-b border-border bg-card p-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="font-semibold text-lg">Visible Queries by Page</h3>
            <p className="text-sm text-muted-foreground">
              Period totals include only non-anonymized Search Console query rows. Click a page to view its daily visible-query trend above.
            </p>
          </div>
          <Button variant="outline" size="sm" className="rounded-xl bg-background" onClick={exportPageRows} disabled={loadingTable || sortedTableData.length === 0}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50%] cursor-pointer select-none hover:bg-muted/60" onClick={() => handleSort('page')}>
                  <div className="flex items-center">
                    Page URL
                    {renderSortIcon('page')}
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer select-none text-right hover:bg-muted/60" onClick={() => handleSort('queryCount')}>
                  <div className="flex items-center justify-end">
                    Visible Queries
                    {renderSortIcon('queryCount')}
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer select-none text-right hover:bg-muted/60" onClick={() => handleSort('clicks')}>
                  <div className="flex items-center justify-end">
                    Total Clicks
                    {renderSortIcon('clicks')}
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer select-none text-right hover:bg-muted/60" onClick={() => handleSort('impressions')}>
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
                  className={`cursor-pointer hover:bg-muted/60 ${selectedPage === row.page ? 'bg-secondary/60' : ''}`}
                  onClick={() => setSelectedPage(row.page)}
                >
                  <TableCell className="font-medium max-w-[500px] truncate" title={row.page}>
                    {row.page.replace(siteUrl, '/')}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-primary">
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
          <div className="flex items-center justify-between border-t border-border px-5 py-4">
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
