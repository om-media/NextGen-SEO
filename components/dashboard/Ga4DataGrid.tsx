import { useState, useEffect, useMemo } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Ga4ApiService, Ga4DataRow } from "@/src/services/ga4Service"
import { useAuth } from "@/src/contexts/AuthContext"
import { Loader2, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X, Download, Database } from "lucide-react"
import { format } from "date-fns"
import { DateRange } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { Ga4Overview } from "./Ga4Overview"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip, Legend } from 'recharts'

const COLORS = ['#4285f4', '#5e35b1', '#00897b', '#e65100', '#c2185b', '#0288d1', '#fbc02d', '#7cb342'];
const WAREHOUSED_GA4_DIMENSIONS = new Set([
  'browser',
  'city',
  'country',
  'date',
  'deviceCategory',
  'eventName',
  'operatingSystem',
  'pagePath',
  'region',
  'sessionSourceMedium',
]);

interface Ga4DataGridProps {
  siteUrl: string;
  workspaceSiteUrl?: string;
  dateRange?: DateRange;
  dimension?: 'date' | 'pagePath' | 'sessionSourceMedium' | 'country' | 'city' | 'region' | 'deviceCategory' | 'browser' | 'operatingSystem' | 'eventName';
  isCompareMode?: boolean;
  compareDateRange?: DateRange;
  metrics?: string[];
}

type SortColumn = 'dimension' | 'sessions' | 'users' | 'pageviews' | 'bouncerate' | 'eventCount';

type ExtendedGa4DataRow = Ga4DataRow & {
  compareMetricValues?: { value: string }[];
};

type WarehouseCoverage = {
  activeDateCount?: number;
  activeJobCount?: number;
  coveredDateCount?: number;
  dimension?: string;
  expectedDateCount?: number;
  missingDateCount?: number;
  queuedDateCount?: number;
};

const getGa4DimensionValue = (row: any, index = 0) => {
  const value = row?.dimensionValues?.[index]?.value;
  return typeof value === "string" ? value : "";
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

export function Ga4DataGrid({ siteUrl, workspaceSiteUrl, dateRange, dimension = 'date', isCompareMode, compareDateRange, metrics = ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'] }: Ga4DataGridProps) {
  const { userProfile } = useAuth()
  const [data, setData] = useState<ExtendedGa4DataRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<WarehouseCoverage | null>(null)
  const [pollKey, setPollKey] = useState(0)
  
  // Selected row for chart
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null)
  
  // Sort state
  const [sortColumn, setSortColumn] = useState<SortColumn>(metrics[0] === 'eventCount' ? 'eventCount' : 'sessions')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  
  // Pagination state
  const [pageIndex, setPageIndex] = useState(0)
  const pageSize = 100
  const isWarehouseDimension = WAREHOUSED_GA4_DIMENSIONS.has(dimension)

  // Keep an opened historic trend visible while users adjust date and compare controls.
  useEffect(() => {
    setSelectedRowKey(null)
  }, [siteUrl, dimension])

  useEffect(() => {
    if (!isWarehouseDimension) {
      setData([])
      setError(null)
      setLoading(false)
      setCoverage(null)
      return
    }
    if (!userProfile?.googleConnected || !siteUrl || !dateRange?.from || !dateRange?.to) return;

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const ga4Service = new Ga4ApiService()
        const startDate = format(dateRange.from!, 'yyyy-MM-dd')
        const endDate = format(dateRange.to!, 'yyyy-MM-dd')
        const reportOptions = { siteUrl: workspaceSiteUrl }
        
        const promises = [
          ga4Service.runReport(
            siteUrl, 
            startDate, 
            endDate, 
            [dimension], 
            metrics,
            undefined,
            reportOptions
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
               metrics,
               undefined,
               reportOptions
             )
           )
        }
        
        const results = await Promise.all(promises);
        const primaryRows = (results[0].rows || []).filter((row: any) => getGa4DimensionValue(row));
        setCoverage(results[0]?.metadata?.coverage || null)

        if (!isCompareMode || !results[1]) {
           setData(primaryRows);
        } else {
           const compareRows = (results[1].rows || []).filter((row: any) => getGa4DimensionValue(row));
           let mergedData = [];
           
           if (dimension === 'date') {
             // For dates, map by index after sorting chronologically, so day 1 matches compare day 1
             const sortedPrimary = [...primaryRows].sort((a: any, b: any) => getGa4DimensionValue(a).localeCompare(getGa4DimensionValue(b)));
             const sortedCompare = [...compareRows].sort((a: any, b: any) => getGa4DimensionValue(a).localeCompare(getGa4DimensionValue(b)));
             
             mergedData = sortedPrimary.map((row: any, index: number) => {
               const compareRow = sortedCompare[index];
               return {
                 ...row,
                 compareMetricValues: compareRow ? compareRow.metricValues : undefined
               };
             });
           } else {
             const compareMap = new Map(compareRows.map((row: any) => [getGa4DimensionValue(row), row]));
             
             mergedData = primaryRows.map((row: any) => {
               const compareRow: any = compareMap.get(getGa4DimensionValue(row));
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
        } else if (/not warehoused|being prepared|not ready|history import/i.test(err.message)) {
          setError("This Analytics report needs stored history for the selected range. Existing Overview and Pages data stays available while the import completes.")
        } else {
          setError(err.message)
        }
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [siteUrl, workspaceSiteUrl, dateRange, dimension, isCompareMode, compareDateRange, userProfile?.googleConnected, isWarehouseDimension, pollKey])

  useEffect(() => {
    if (!coverage || loading) return;
    if (data.length > 0) return;
    const hasWarehouseWork =
      Number(coverage.activeJobCount || 0) > 0 ||
      Number(coverage.activeDateCount || 0) > 0 ||
      Number(coverage.queuedDateCount || 0) > 0;
    if (!hasWarehouseWork) return;

    const timeout = window.setTimeout(() => setPollKey((value) => value + 1), 10000);
    return () => window.clearTimeout(timeout);
  }, [coverage, loading, data.length])

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
        aVal = getGa4DimensionValue(a);
        bVal = getGa4DimensionValue(b);
      } else {
        let metricName = "";
        if (sortColumn === 'sessions') metricName = 'sessions';
        else if (sortColumn === 'users') metricName = 'totalUsers';
        else if (sortColumn === 'pageviews') metricName = 'screenPageViews';
        else if (sortColumn === 'bouncerate') metricName = 'bounceRate';
        else if (sortColumn === 'eventCount') metricName = 'eventCount';

        const metricIndex = metrics.indexOf(metricName);
        if (metricIndex !== -1) {
          aVal = parseFloat(a.metricValues[metricIndex].value);
          bVal = parseFloat(b.metricValues[metricIndex].value);
        } else {
          // Fallback if metric not requested
          aVal = 0;
          bVal = 0;
        }
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return sortableData;
  }, [data, sortColumn, sortDirection]);

  const pieData = useMemo(() => {
    if (dimension === 'date' || dimension === 'pagePath' || dimension === 'sessionSourceMedium' || sortedData.length === 0) return null;
    
    // Hide the generic pie charts if dimension is one of the demographics (since we have Ga4Demographics)
    const demographicDimensions = ['country', 'city', 'region', 'deviceCategory', 'browser', 'operatingSystem'];
    if (demographicDimensions.includes(dimension!)) return null;
    
    const sessionsSorted = [...data].sort((a, b) => parseFloat(b.metricValues?.[0]?.value || "0") - parseFloat(a.metricValues?.[0]?.value || "0"));
    
    const topSessions = sessionsSorted.slice(0, 5).map(item => ({
      name: getGa4DimensionValue(item).replace(siteUrl, '') || getGa4DimensionValue(item),
      value: parseInt(item.metricValues?.[0]?.value || "0")
    }));
    
    const topUsers = sessionsSorted.slice(0, 5).map(item => ({
      name: getGa4DimensionValue(item).replace(siteUrl, '') || getGa4DimensionValue(item),
      value: parseInt(item.metricValues?.[1]?.value || "0")
    }));

    return { sessions: topSessions, users: topUsers };
  }, [data, dimension, siteUrl]);

  // Pagination logic
  const pageCount = Math.ceil(sortedData.length / pageSize)
  const currentData = sortedData.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
  const shouldShowCoverage =
    coverage &&
    Number(coverage.expectedDateCount || 0) > 0 &&
    (
      Number(coverage.activeJobCount || 0) > 0 ||
      Number(coverage.activeDateCount || 0) > 0 ||
      Number(coverage.queuedDateCount || 0) > 0 ||
      Number(coverage.missingDateCount || 0) > 0
    );
  const hasActiveWarehouseWork =
    Number(coverage?.activeJobCount || 0) > 0 ||
    Number(coverage?.activeDateCount || 0) > 0 ||
    Number(coverage?.queuedDateCount || 0) > 0;
  const dimensionLabel = (() => {
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
      case 'eventName': return 'Event Name';
      default: return 'Dimension';
    }
  })();
  const isPreparationError = Boolean(error && /stored history|being prepared|not ready|not available in the stored warehouse/i.test(error));

  if (loading && data.length === 0) {
    return (
      <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center">
          <div className="mb-4 rounded-full bg-secondary p-3 text-primary">
            <Database className="h-5 w-5" />
          </div>
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Loading stored Analytics data
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Reading the app warehouse for {dimensionLabel.toLowerCase()} metrics on this site and date range.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className={`rounded-2xl border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)] ${isPreparationError ? 'border-border' : 'border-destructive/30'}`}>
        <CardContent className={`flex min-h-[260px] flex-col items-center justify-center px-6 text-center ${isPreparationError ? 'text-muted-foreground' : 'text-destructive'} space-y-4`}>
          <div className={`rounded-full p-3 ${isPreparationError ? 'bg-secondary text-primary' : 'bg-destructive/10 text-destructive'}`}>
            {isPreparationError ? <Database className="h-5 w-5" /> : <X className="h-5 w-5" />}
          </div>
          <div>
            <h3 className={`text-lg font-semibold ${isPreparationError ? 'text-foreground' : 'text-destructive'}`}>
              {isPreparationError ? `Preparing GA4 ${dimensionLabel} report` : 'Could not load Analytics report'}
            </h3>
            <p className="mt-2 max-w-2xl text-sm leading-6">{error}</p>
          </div>
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
    return dimensionLabel
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

  const exportRows = () => {
    const startDate = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : "start";
    const endDate = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : "end";
    exportCsv(
      `ga4-${dimension}-${startDate}-${endDate}.csv`,
      sortedData.map((row) => {
        const output: Record<string, unknown> = {
          dimension: getGa4DimensionValue(row),
        };

        metrics.forEach((metric, index) => {
          const current = Number(row.metricValues?.[index]?.value || 0);
          const compare = row.compareMetricValues ? Number(row.compareMetricValues[index]?.value || 0) : "";
          output[metric] = current;
          if (metric === "bounceRate") output.bounceRatePercent = `${(current * 100).toFixed(2)}%`;
          if (isCompareMode) {
            output[`compare_${metric}`] = compare;
            if (metric === "bounceRate" && compare !== "") {
              output.compareBounceRatePercent = `${(Number(compare) * 100).toFixed(2)}%`;
            }
          }
        });

        return output;
      }),
    );
  };

  if (!isWarehouseDimension) {
    return (
      <Card className="rounded-2xl border border-dashed border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.035)]">
        <CardContent className="flex min-h-[220px] flex-col items-center justify-center px-6 text-center">
          <div className="mb-4 rounded-full bg-secondary p-3 text-primary">
            <Database className="h-5 w-5" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">GA4 {getDimensionHeader()} report is being prepared</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            The app is storing this Analytics breakdown in the background. Page and date reports are available now; this report will appear once its historical import is ready.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6" aria-busy={loading}>
      {loading && data.length > 0 && !shouldShowCoverage && (
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-[0_12px_32px_rgba(15,61,46,0.035)] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="font-medium text-foreground">Refreshing Analytics report</span>
          </div>
          <span>Existing rows stay visible while the latest stored data loads.</span>
        </div>
      )}

      {shouldShowCoverage && (
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-[0_12px_32px_rgba(15,61,46,0.035)] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            {hasActiveWarehouseWork ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              <Database className="h-4 w-4 text-primary" />
            )}
            <span className="font-medium text-foreground">
              {hasActiveWarehouseWork ? "Importing Analytics history" : "Analytics breakdown import available"}
            </span>
            <span>
              {Number(coverage.coveredDateCount || 0).toLocaleString()} / {Number(coverage.expectedDateCount || 0).toLocaleString()} days ready
            </span>
          </div>
          <span>{hasActiveWarehouseWork ? "Existing rows stay visible while the import catches up." : "The import status panel will prepare this breakdown automatically."}</span>
        </div>
      )}

      {selectedRowKey && dimension !== 'date' && (
        <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
          <div className="flex flex-col items-start justify-between gap-3 border-b border-border bg-card p-5 sm:flex-row sm:items-center">
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
          <div className="p-5">
            <Ga4Overview 
              siteUrl={siteUrl} 
              workspaceSiteUrl={workspaceSiteUrl}
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
          <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
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

          <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
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

      <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardHeader className="flex flex-col gap-3 border-b border-border bg-card px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{dimension === 'date' ? 'Data Table' : `Detailed ${getDimensionHeader()} Data`}</CardTitle>
            {dimension !== 'date' && (
              <CardDescription>Click any row to view its historical trend.</CardDescription>
            )}
          </div>
          <Button variant="outline" size="sm" className="rounded-xl bg-background" onClick={exportRows} disabled={loading || sortedData.length === 0}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent className="px-5 pt-5">
        {loading && data.length > 0 && (
          <div className="flex items-center space-x-2 text-sm text-muted-foreground mb-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Updating data...</span>
          </div>
        )}
        <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="cursor-pointer select-none" onClick={() => handleSort('dimension')}>
                  <div className="flex items-center">
                    {getDimensionHeader()}
                    {sortColumn === 'dimension' && <ArrowUpDown className="ml-2 h-4 w-4" />}
                  </div>
                </TableHead>
                {metrics.map((metric) => {
                  let headerName = metric;
                  if (metric === 'sessions') headerName = 'Sessions';
                  else if (metric === 'totalUsers') headerName = 'Users';
                  else if (metric === 'screenPageViews') headerName = 'Page Views';
                  else if (metric === 'bounceRate') headerName = 'Bounce Rate';
                  else if (metric === 'eventCount') headerName = 'Event Count';

                  let sortKey = metric;
                  if (metric === 'totalUsers') sortKey = 'users';
                  else if (metric === 'screenPageViews') sortKey = 'pageviews';
                  else if (metric === 'bounceRate') sortKey = 'bouncerate';

                  return (
                    <TableHead key={metric} className="cursor-pointer select-none text-right" onClick={() => handleSort(sortKey as SortColumn)}>
                      <div className="flex items-center justify-end">
                        {headerName}
                        {sortColumn === sortKey && <ArrowUpDown className="ml-2 h-4 w-4" />}
                      </div>
                    </TableHead>
                  )
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {currentData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={metrics.length + 1} className="h-24 text-center text-muted-foreground">
                    {Number(coverage?.missingDateCount || 0) > 0
                      ? `GA4 ${dimensionLabel.toLowerCase()} history is not stored for this property, site, and date range yet. Open Source data to import the missing days.`
                      : "No data available."}
                  </TableCell>
                </TableRow>
              ) : (
                currentData.map((row, i) => {
                  const dimStr = getGa4DimensionValue(row);
                  let formattedDim = dimStr || '(not set)';
                  if (dimension === 'date' && dimStr.length === 8) {
                    formattedDim = format(new Date(parseInt(dimStr.substring(0, 4)), parseInt(dimStr.substring(4, 6)) - 1, parseInt(dimStr.substring(6, 8))), 'MMM d, yyyy');
                  } else if (!dimStr || dimStr === '(not set)') {
                    formattedDim = '(not set)';
                  }

                  return (
                    <TableRow 
                      key={i}
                      className={dimension !== 'date' ? `cursor-pointer transition-colors hover:bg-muted/60 ${selectedRowKey === dimStr ? 'bg-secondary/60' : ''}` : ''}
                      onClick={() => {
                        if (dimension !== 'date') {
                          setSelectedRowKey(dimStr)
                          window.scrollTo({ top: 300, behavior: 'smooth' })
                        }
                      }}
                    >
                      <TableCell className="font-medium max-w-[300px] truncate" title={formattedDim}>{dimension === 'pagePath' && siteUrl ? formattedDim.replace(siteUrl, '') || '/' : formattedDim}</TableCell>
                      {metrics.map((metric, idx) => {
                        const val = parseFloat(row.metricValues[idx]?.value || "0");
                        const compareVal = row.compareMetricValues ? parseFloat(row.compareMetricValues[idx]?.value || "0") : undefined;

                        if (metric === 'bounceRate') {
                          return (
                            <TableCell key={metric} className="text-right">
                              <div className="flex items-center justify-end">
                                {(val * 100).toFixed(2)}%
                                {renderDifference(val, compareVal, true, true)}
                              </div>
                            </TableCell>
                          )
                        }

                        return (
                          <TableCell key={metric} className="text-right">
                            <div className="flex items-center justify-end">
                              {val.toLocaleString()}
                              {renderDifference(val, compareVal)}
                            </div>
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination Controls */}
        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-border px-2 py-4">
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
