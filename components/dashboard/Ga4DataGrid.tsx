import { useState, useEffect, useMemo } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Ga4ApiService, Ga4DataRow } from "@/src/services/ga4Service"
import { useAuth } from "@/src/contexts/AuthContext"
import { Loader2, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from "lucide-react"
import { format } from "date-fns"
import { DateRange } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { Ga4Overview } from "./Ga4Overview"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip, Legend } from 'recharts'

const COLORS = ['#4285f4', '#5e35b1', '#00897b', '#e65100', '#c2185b', '#0288d1', '#fbc02d', '#7cb342'];

interface Ga4DataGridProps {
  siteUrl: string;
  dateRange?: DateRange;
  dimension?: 'date' | 'pagePath' | 'sessionSourceMedium' | 'country' | 'city' | 'region' | 'deviceCategory' | 'browser' | 'operatingSystem';
  isCompareMode?: boolean;
  compareDateRange?: DateRange;
}

type SortColumn = 'dimension' | 'sessions' | 'users' | 'pageviews' | 'bouncerate';

type ExtendedGa4DataRow = Ga4DataRow & {
  compareMetricValues?: { value: string }[];
};

export function Ga4DataGrid({ siteUrl, dateRange, dimension = 'date', isCompareMode, compareDateRange }: Ga4DataGridProps) {
  const { accessToken } = useAuth()
  const [data, setData] = useState<ExtendedGa4DataRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // Selected row for chart
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null)
  
  // Sort state
  const [sortColumn, setSortColumn] = useState<SortColumn>('sessions')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  
  // Pagination state
  const [pageIndex, setPageIndex] = useState(0)
  const pageSize = 100

  // Reset selected row when props change
  useEffect(() => {
    setSelectedRowKey(null)
  }, [siteUrl, dimension, dateRange, isCompareMode, compareDateRange])

  useEffect(() => {
    if (!accessToken || !siteUrl || !dateRange?.from || !dateRange?.to) return;

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const ga4Service = new Ga4ApiService(accessToken)
        const startDate = format(dateRange.from!, 'yyyy-MM-dd')
        const endDate = format(dateRange.to!, 'yyyy-MM-dd')
        
        const promises = [
          ga4Service.runReport(
            siteUrl, 
            startDate, 
            endDate, 
            [dimension], 
            ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate']
          )
        ];

        if (isCompareMode && compareDateRange?.from && compareDateRange?.to) {
           const compareStartDate = format(compareDateRange.from, 'yyyy-MM-dd')
           const compareEndDate = format(compareDateRange.to, 'yyyy-MM-dd')
           promises.push(
             ga4Service.runReport(
               siteUrl,
               compareStartDate,
               compareEndDate,
               [dimension],
               ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate']
             )
           )
        }
        
        const results = await Promise.all(promises);
        const primaryRows = results[0].rows || [];

        if (!isCompareMode || !results[1]) {
           setData(primaryRows);
        } else {
           const compareRows = results[1].rows || [];
           let mergedData = [];
           
           if (dimension === 'date') {
             // For dates, map by index after sorting chronologically, so day 1 matches compare day 1
             const sortedPrimary = [...primaryRows].sort((a: any, b: any) => a.dimensionValues[0].value.localeCompare(b.dimensionValues[0].value));
             const sortedCompare = [...compareRows].sort((a: any, b: any) => a.dimensionValues[0].value.localeCompare(b.dimensionValues[0].value));
             
             mergedData = sortedPrimary.map((row: any, index: number) => {
               const compareRow = sortedCompare[index];
               return {
                 ...row,
                 compareMetricValues: compareRow ? compareRow.metricValues : undefined
               };
             });
           } else {
             const compareMap = new Map(compareRows.map((row: any) => [row.dimensionValues[0].value, row]));
             
             mergedData = primaryRows.map((row: any) => {
               const compareRow: any = compareMap.get(row.dimensionValues[0].value);
               return {
                 ...row,
                 compareMetricValues: compareRow ? compareRow.metricValues : undefined
               };
             });
           }
           
           setData(mergedData);
        }
        
        setPageIndex(0) // Reset to first page
      } catch (err: any) {
        console.error("Error fetching GA4 stats:", err)
        if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token") || err.message.includes("insufficient authentication scopes")) {
          setError("Your Google session has expired or is missing permissions. Please sign out and sign back in to grant Google Analytics access.")
        } else if (err.message.includes("Google Analytics Data API has not been used in project") || err.message.includes("is disabled")) {
          setError(err.message)
        } else if (err.message === "Failed to fetch") {
          setError("Network error: Unable to connect to Google Analytics API. This could be due to an adblocker, privacy extension, or network connectivity issue.")
        } else {
          setError(err.message)
        }
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [accessToken, siteUrl, dateRange, dimension, isCompareMode, compareDateRange])

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column)
      setSortDirection('desc') // Default to desc for new columns
    }
  }

  const sortedData = useMemo(() => {
    let sortableData = [...data];

    sortableData.sort((a, b) => {
      let aVal: any;
      let bVal: any;

      if (sortColumn === 'dimension') {
        aVal = a.dimensionValues[0].value;
        bVal = b.dimensionValues[0].value;
      } else {
        const metricIndex = 
          sortColumn === 'sessions' ? 0 : 
          sortColumn === 'users' ? 1 : 
          sortColumn === 'pageviews' ? 2 : 3;
        aVal = parseFloat(a.metricValues[metricIndex].value);
        bVal = parseFloat(b.metricValues[metricIndex].value);
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return sortableData;
  }, [data, sortColumn, sortDirection]);

  const pieData = useMemo(() => {
    if (dimension === 'date' || dimension === 'pagePath' || sortedData.length === 0) return null;
    
    // Hide the generic pie charts if dimension is one of the demographics (since we have Ga4Demographics)
    const demographicDimensions = ['country', 'city', 'region', 'deviceCategory', 'browser', 'operatingSystem'];
    if (demographicDimensions.includes(dimension!)) return null;
    
    const sessionsSorted = [...data].sort((a, b) => parseFloat(b.metricValues[0].value) - parseFloat(a.metricValues[0].value));
    
    const topSessions = sessionsSorted.slice(0, 5).map(item => ({
      name: item.dimensionValues[0].value.replace(siteUrl, '') || item.dimensionValues[0].value,
      value: parseInt(item.metricValues[0].value)
    }));
    
    const topUsers = sessionsSorted.slice(0, 5).map(item => ({
      name: item.dimensionValues[0].value.replace(siteUrl, '') || item.dimensionValues[0].value,
      value: parseInt(item.metricValues[1].value)
    }));

    return { sessions: topSessions, users: topUsers };
  }, [data, dimension, siteUrl]);

  // Pagination logic
  const pageCount = Math.ceil(sortedData.length / pageSize)
  const currentData = sortedData.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)

  if (loading && data.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center h-64 text-destructive space-y-4">
          <div className="text-center">{error}</div>
          {error.includes("https://console.developers.google.com") && (
            <a 
              href={error.match(/https:\/\/console\.developers\.google\.com[^\s]*/)?.[0] || "#"} 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
            >
              Enable API in Google Cloud Console
            </a>
          )}
        </CardContent>
      </Card>
    )
  }

  const getDimensionHeader = () => {
    switch (dimension) {
      case 'date': return 'Date';
      case 'pagePath': return 'Page Path';
      case 'sessionSourceMedium': return 'Source / Medium';
      case 'country': return 'Country';
      case 'city': return 'City';
      case 'region': return 'Region';
      case 'deviceCategory': return 'Device';
      case 'browser': return 'Browser';
      case 'operatingSystem': return 'OS';
      default: return 'Dimension';
    }
  }

  const renderDifference = (current: number, previous: number | undefined, isPercentage: boolean = false, inverse: boolean = false) => {
    if (!isCompareMode || previous === undefined || isNaN(previous)) return null;
    
    const diff = current - previous;
    if (diff === 0) return null;

    let isPositive = diff > 0;
    if (inverse) isPositive = !isPositive;

    const formattedDiff = isPercentage 
      ? `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(2)}%`
      : `${diff > 0 ? '+' : ''}${Number.isInteger(diff) ? diff.toLocaleString() : diff.toFixed(1)}`;

    return (
      <span className={`text-xs ml-2 flex-shrink-0 ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
        {formattedDiff}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {selectedRowKey && dimension !== 'date' && (
        <Card className="border shadow-sm">
          <div className="p-4 border-b bg-muted/20 flex justify-between items-center">
            <div>
              <h3 className="font-semibold text-lg">Historic Trend</h3>
              <p className="text-sm text-muted-foreground">
                Performance over time for {dimension}: <span className="font-medium text-foreground">{selectedRowKey.replace(siteUrl, '') || '/'}</span>
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setSelectedRowKey(null)}>
              <X className="h-4 w-4 mr-2" />
              Close Chart
            </Button>
          </div>
          <div className="p-6">
            <Ga4Overview 
              siteUrl={siteUrl} 
              dateRange={dateRange} 
              isCompareMode={isCompareMode}
              compareDateRange={compareDateRange}
              filterDimension={dimension}
              filterValue={selectedRowKey}
            />
          </div>
        </Card>
      )}

      {pieData && !selectedRowKey && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl mx-auto">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Top Sessions Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart margin={{ top: 0, right: 0, bottom: 20, left: 0 }}>
                    <Pie
                      data={pieData.sessions}
                      cx="50%"
                      cy="45%"
                      innerRadius={55}
                      outerRadius={80}
                      paddingAngle={3}
                      stroke="none"
                      dataKey="value"
                    >
                      {pieData.sessions.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip 
                      formatter={(value: number) => value.toLocaleString()}
                      contentStyle={{ borderRadius: '8px', zIndex: 1000 }}
                    />
                    <Legend layout="horizontal" verticalAlign="bottom" align="center" wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Top Users Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart margin={{ top: 0, right: 0, bottom: 20, left: 0 }}>
                    <Pie
                      data={pieData.users}
                      cx="50%"
                      cy="45%"
                      innerRadius={55}
                      outerRadius={80}
                      paddingAngle={3}
                      stroke="none"
                      dataKey="value"
                    >
                      {pieData.users.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip 
                      formatter={(value: number) => value.toLocaleString()}
                      contentStyle={{ borderRadius: '8px', zIndex: 1000 }}
                    />
                    <Legend layout="horizontal" verticalAlign="bottom" align="center" wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className={dimension !== 'date' ? "flex flex-row items-center justify-between pb-2" : ""}>
          <div>
            <CardTitle>{dimension === 'date' ? 'Data Table' : `Detailed ${getDimensionHeader()} Data`}</CardTitle>
            {dimension !== 'date' && (
              <CardDescription>Click any row to view its historical trend.</CardDescription>
            )}
          </div>
        </CardHeader>
        <CardContent>
        {loading && data.length > 0 && (
          <div className="flex items-center space-x-2 text-sm text-muted-foreground mb-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Updating data...</span>
          </div>
        )}
        <div className="rounded-md border relative">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="cursor-pointer select-none" onClick={() => handleSort('dimension')}>
                  <div className="flex items-center">
                    {getDimensionHeader()}
                    {sortColumn === 'dimension' && <ArrowUpDown className="ml-2 h-4 w-4" />}
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer select-none text-right" onClick={() => handleSort('sessions')}>
                  <div className="flex items-center justify-end">
                    Sessions
                    {sortColumn === 'sessions' && <ArrowUpDown className="ml-2 h-4 w-4" />}
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer select-none text-right" onClick={() => handleSort('users')}>
                  <div className="flex items-center justify-end">
                    Users
                    {sortColumn === 'users' && <ArrowUpDown className="ml-2 h-4 w-4" />}
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer select-none text-right" onClick={() => handleSort('pageviews')}>
                  <div className="flex items-center justify-end">
                    Page Views
                    {sortColumn === 'pageviews' && <ArrowUpDown className="ml-2 h-4 w-4" />}
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer select-none text-right" onClick={() => handleSort('bouncerate')}>
                  <div className="flex items-center justify-end">
                    Bounce Rate
                    {sortColumn === 'bouncerate' && <ArrowUpDown className="ml-2 h-4 w-4" />}
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {currentData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No data available.
                  </TableCell>
                </TableRow>
              ) : (
                currentData.map((row, i) => {
                  const dimStr = row.dimensionValues[0].value;
                  let formattedDim = dimStr;
                  if (dimension === 'date' && dimStr.length === 8) {
                    formattedDim = format(new Date(parseInt(dimStr.substring(0, 4)), parseInt(dimStr.substring(4, 6)) - 1, parseInt(dimStr.substring(6, 8))), 'MMM d, yyyy');
                  } else if (dimStr === '(not set)') {
                    formattedDim = 'Unknown';
                  }

                  const sessions = parseInt(row.metricValues[0].value);
                  const compareSessions = row.compareMetricValues ? parseInt(row.compareMetricValues[0].value) : undefined;
                  
                  const users = parseInt(row.metricValues[1].value);
                  const compareUsers = row.compareMetricValues ? parseInt(row.compareMetricValues[1].value) : undefined;
                  
                  const pageViews = parseInt(row.metricValues[2].value);
                  const comparePageViews = row.compareMetricValues ? parseInt(row.compareMetricValues[2].value) : undefined;
                  
                  const bounceRate = parseFloat(row.metricValues[3].value);
                  const compareBounceRate = row.compareMetricValues ? parseFloat(row.compareMetricValues[3].value) : undefined;

                  return (
                    <TableRow 
                      key={i}
                      className={dimension !== 'date' ? `cursor-pointer hover:bg-muted/50 transition-colors ${selectedRowKey === dimStr ? 'bg-muted' : ''}` : ''}
                      onClick={() => {
                        if (dimension !== 'date') {
                          setSelectedRowKey(dimStr)
                          window.scrollTo({ top: 300, behavior: 'smooth' })
                        }
                      }}
                    >
                      <TableCell className="font-medium max-w-[300px] truncate" title={formattedDim}>{dimension === 'pagePath' && siteUrl ? formattedDim.replace(siteUrl, '') || '/' : formattedDim}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end">
                          {sessions.toLocaleString()}
                          {renderDifference(sessions, compareSessions)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end">
                          {users.toLocaleString()}
                          {renderDifference(users, compareUsers)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end">
                          {pageViews.toLocaleString()}
                          {renderDifference(pageViews, comparePageViews)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end">
                          {(bounceRate * 100).toFixed(2)}%
                          {renderDifference(bounceRate, compareBounceRate, true, true)}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination Controls */}
        {pageCount > 1 && (
          <div className="flex items-center justify-between px-2 py-4">
            <div className="flex-1 text-sm text-muted-foreground">
              Showing {pageIndex * pageSize + 1} to {Math.min((pageIndex + 1) * pageSize, sortedData.length)} of {sortedData.length} entries
            </div>
            <div className="flex items-center space-x-2">
              <Button
                variant="outline"
                className="hidden h-8 w-8 p-0 lg:flex"
                onClick={() => setPageIndex(0)}
                disabled={pageIndex === 0}
              >
                <span className="sr-only">Go to first page</span>
                <ChevronsLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                className="h-8 w-8 p-0"
                onClick={() => setPageIndex(pageIndex - 1)}
                disabled={pageIndex === 0}
              >
                <span className="sr-only">Go to previous page</span>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="flex w-[100px] items-center justify-center text-sm font-medium">
                Page {pageIndex + 1} of {pageCount}
              </div>
              <Button
                variant="outline"
                className="h-8 w-8 p-0"
                onClick={() => setPageIndex(pageIndex + 1)}
                disabled={pageIndex >= pageCount - 1}
              >
                <span className="sr-only">Go to next page</span>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                className="hidden h-8 w-8 p-0 lg:flex"
                onClick={() => setPageIndex(pageCount - 1)}
                disabled={pageIndex >= pageCount - 1}
              >
                <span className="sr-only">Go to last page</span>
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  )
}
