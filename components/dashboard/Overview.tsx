import { useState, useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { ComposedChart, Area, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts"
import { useAuth } from "@/src/contexts/AuthContext"
import { GscApiService } from "@/src/services/gscService"
import { format, parseISO, startOfWeek, startOfMonth } from "date-fns"
import { DateRange } from "react-day-picker"
import { Loader2, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Annotation } from "@/src/services/annotationsService"

const formatCompactNumber = (number: number) => {
  return new Intl.NumberFormat('en-US', { 
    notation: "compact", 
    maximumFractionDigits: 2 
  }).format(number);
}

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

export function Overview({ 
  siteUrl, 
  dateRange,
  filterDimension,
  filterValue,
  isCompareMode,
  compareDateRange,
  annotations = [],
  useLiveData = true
}: { 
  siteUrl: string, 
  dateRange?: DateRange,
  filterDimension?: 'query' | 'page' | 'country',
  filterValue?: string,
  isCompareMode?: boolean,
  compareDateRange?: DateRange,
  annotations?: Annotation[],
  useLiveData?: boolean
}) {
  const { accessToken, userProfile, clearAccessToken } = useAuth()
  const [rawData, setRawData] = useState<any[]>([])
  const [compareRawData, setCompareRawData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [activeMetrics, setActiveMetrics] = useState({
    clicks: true,
    impressions: true,
    ctr: false,
    position: false
  })

  const [timeframe, setTimeframe] = useState<'Day' | 'Week' | 'Month'>('Day')

  // GSC exact colors
  const colors = {
    clicks: "#4285f4",
    impressions: "#5e35b1",
    ctr: "#00897b",
    position: "#e65100"
  }

  useEffect(() => {
    if (siteUrl && dateRange?.from && dateRange?.to) {
      setLoading(true)
      const gscService = new GscApiService(accessToken, userProfile?.tier || 'free')
      
      const endDate = format(dateRange.to, 'yyyy-MM-dd')
      const startDate = format(dateRange.from, 'yyyy-MM-dd')

      const filterGroups = filterDimension && filterValue ? [{
        filters: [{ dimension: filterDimension, expression: filterValue, operator: 'equals' }]
      }] : undefined;

      const fetchWarehouseData = async (start: string, end: string) => {
        const res = await fetch('/api/warehouse/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteUrl, startDate: start, endDate: end, dimensions: ['date'], dimensionFilterGroups: filterGroups })
        })
        if (!res.ok) throw new Error("Failed to fetch warehouse data")
        const json = await res.json()
        return json.map((r: any) => ({
          keys: [r.date],
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position
        }))
      }

      const promises = [
        useLiveData 
          ? gscService.querySearchAnalytics(siteUrl, startDate, endDate, ['date'], filterGroups)
          : fetchWarehouseData(startDate, endDate)
      ];

      if (isCompareMode && compareDateRange?.from && compareDateRange?.to) {
        const compareEndDate = format(compareDateRange.to, 'yyyy-MM-dd')
        const compareStartDate = format(compareDateRange.from, 'yyyy-MM-dd')
        promises.push(
          useLiveData
            ? gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, ['date'], filterGroups)
            : fetchWarehouseData(compareStartDate, compareEndDate)
        )
      }

      Promise.all(promises)
        .then(([primaryRows, compareRows]) => {
          setRawData(primaryRows)
          setError(null)
          if (compareRows) {
            setCompareRawData(compareRows)
          } else {
            setCompareRawData([])
          }
        })
        .catch(err => {
          if (err.message === 'UNAUTHORIZED' || err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token")) {
            console.warn("GSC Access token expired or invalid. Prompting re-authentication.");
            clearAccessToken()
            setError("Your Google session has expired. Please click 'Reconnect Google' at the top to restore live data.")
          } else if (err.message.includes("sufficient permission")) {
            setError("You do not have sufficient permission to view data for this property. Please select a different property or verify your access in Google Search Console.")
          } else {
            console.error("Failed to fetch GSC overview data:", err)
            setError(err.message)
          }
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [accessToken, siteUrl, dateRange, isCompareMode, compareDateRange, filterDimension, filterValue, clearAccessToken, useLiveData])

  const { chartData, summary, compareSummary } = useMemo(() => {
    if (!rawData.length || !dateRange?.from || !dateRange?.to) {
      return { chartData: [], summary: { clicks: 0, impressions: 0, ctr: 0, position: 0 }, compareSummary: null };
    }

    // Sort ascending by date
    const sortedRows = [...rawData].sort((a, b) => a.keys[0].localeCompare(b.keys[0]));
    const sortedCompareRows = [...compareRawData].sort((a, b) => a.keys[0].localeCompare(b.keys[0]));

    const aggregatedData = new Map<string, { 
      clicks: number, impressions: number, sumPosition: number, count: number,
      compareClicks?: number, compareImpressions?: number, compareSumPosition?: number, compareCount?: number
    }>();

    let totalClicks = 0;
    let totalImpressions = 0;
    let sumPositionTotal = 0;

    let compareTotalClicks = 0;
    let compareTotalImpressions = 0;
    let compareSumPositionTotal = 0;

    // Use exact daily boundaries from the date picker to avoid timezone shifting
    const startPrimaryExact = parseISO(format(dateRange.from, 'yyyy-MM-dd'));
    const endPrimaryExact = parseISO(format(dateRange.to, 'yyyy-MM-dd'));
    
    // Generate all exact days in the range to ensure continuous chart
    // We use eachDayOfInterval from date-fns since it creates exact day bumps
    const allPrimaryDates = [];
    let curr = startPrimaryExact;
    while (curr <= endPrimaryExact) {
      allPrimaryDates.push(curr);
      curr = new Date(curr.getTime() + 24 * 60 * 60 * 1000);
    }
    
    const keysArray: string[] = [];

    // Initialize all chart buckets so there are no visual gaps
    allPrimaryDates.forEach(date => {
      let key = '';
      if (timeframe === 'Day') {
        key = format(date, 'MMM d, yyyy');
      } else if (timeframe === 'Week') {
        key = format(startOfWeek(date), 'MMM d, yyyy');
      } else if (timeframe === 'Month') {
        key = format(startOfMonth(date), 'MMM yyyy');
      }
      keysArray.push(key);

      if (!aggregatedData.has(key)) {
        aggregatedData.set(key, { clicks: 0, impressions: 0, sumPosition: 0, count: 0, compareClicks: 0, compareImpressions: 0, compareSumPosition: 0, compareCount: 0 });
      }
    });

    // Process primary data
    sortedRows.forEach((row) => {
      const date = parseISO(row.keys[0]);
      let key = '';
      
      if (timeframe === 'Day') {
        key = format(date, 'MMM d, yyyy');
      } else if (timeframe === 'Week') {
        key = format(startOfWeek(date), 'MMM d, yyyy');
      } else if (timeframe === 'Month') {
        key = format(startOfMonth(date), 'MMM yyyy');
      }

      // If outside bounds, skip buckets but add to totals
      const current = aggregatedData.get(key);
      if (current) {
        current.clicks += row.clicks;
        current.impressions += row.impressions;
        current.sumPosition += (row.position * row.impressions);
        current.count += 1;
      }

      totalClicks += row.clicks;
      totalImpressions += row.impressions;
      sumPositionTotal += (row.position * row.impressions);
    });

    // Process compare data and align by precise logical day offset
    if (isCompareMode && sortedCompareRows.length > 0 && compareDateRange?.from) {
      const startCompareExact = parseISO(format(compareDateRange.from, 'yyyy-MM-dd'));
      
      sortedCompareRows.forEach((row) => {
        const date = parseISO(row.keys[0]);
        // Difference measured in whole days
        const offset = Math.round((date.getTime() - startCompareExact.getTime()) / (24 * 60 * 60 * 1000));
        
        // If the offset falls cleanly into our chart array length, match it up
        if (offset >= 0 && offset < keysArray.length) {
          const key = keysArray[offset];
          const current = aggregatedData.get(key);
          if (current) {
            current.compareClicks = (current.compareClicks || 0) + row.clicks;
            current.compareImpressions = (current.compareImpressions || 0) + row.impressions;
            current.compareSumPosition = (current.compareSumPosition || 0) + (row.position * row.impressions);
            current.compareCount = (current.compareCount || 0) + 1;
          }
        }

        compareTotalClicks += row.clicks;
        compareTotalImpressions += row.impressions;
        compareSumPositionTotal += (row.position * row.impressions);
      });
    }

    const finalChartData = Array.from(aggregatedData.entries()).map(([date, data]) => ({
      date,
      clicks: data.clicks,
      impressions: data.impressions,
      ctr: data.impressions > 0 ? (data.clicks / data.impressions) * 100 : 0,
      position: data.impressions > 0 ? data.sumPosition / data.impressions : 0,
      ...(isCompareMode ? {
        compareClicks: data.compareClicks || 0,
        compareImpressions: data.compareImpressions || 0,
        compareCtr: data.compareImpressions && data.compareImpressions > 0 ? ((data.compareClicks || 0) / data.compareImpressions) * 100 : 0,
        comparePosition: data.compareImpressions && data.compareImpressions > 0 ? (data.compareSumPosition || 0) / data.compareImpressions : 0,
      } : {})
    }));

    return {
      chartData: finalChartData,
      summary: {
        clicks: totalClicks,
        impressions: totalImpressions,
        ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
        position: totalImpressions > 0 ? sumPositionTotal / totalImpressions : 0
      },
      compareSummary: isCompareMode ? {
        clicks: compareTotalClicks,
        impressions: compareTotalImpressions,
        ctr: compareTotalImpressions > 0 ? (compareTotalClicks / compareTotalImpressions) * 100 : 0,
        position: compareTotalImpressions > 0 ? compareSumPositionTotal / compareTotalImpressions : 0
      } : null
    };
  }, [rawData, compareRawData, timeframe, isCompareMode, dateRange, compareDateRange]);

  const toggleMetric = (metric: keyof typeof activeMetrics) => {
    setActiveMetrics(prev => ({
      ...prev,
      [metric]: !prev[metric]
    }))
  }

  const activeMetricsList = (['clicks', 'impressions', 'ctr', 'position'] as const).filter(m => activeMetrics[m]);

  const getAxisProps = (metric: 'clicks' | 'impressions' | 'ctr' | 'position') => {
    const index = activeMetricsList.indexOf(metric);
    const isRight = index === 1;
    return {
      hide: index > 1 || index === -1,
      orientation: (isRight ? 'right' : 'left') as 'left' | 'right',
      mirror: true,
    };
  };

  const getChartXParam = (dateString: string) => {
    try {
      const date = parseISO(dateString)
      if (timeframe === 'Day') return format(date, 'MMM d, yyyy')
      if (timeframe === 'Week') return format(startOfWeek(date), 'MMM d, yyyy')
      if (timeframe === 'Month') return format(startOfMonth(date), 'MMM yyyy')
    } catch {
      return ""
    }
    return ""
  }

  const renderChange = (current: number, previous: number, inverse: boolean = false) => {
    if (!isCompareMode || !compareSummary) return null;
    if (previous === 0) return null;
    
    const diff = current - previous;
    const percentChange = (diff / previous) * 100;
    
    let isPositive = diff > 0;
    if (inverse) isPositive = !isPositive; // For position, lower is better
    
    return (
      <div className={cn("text-xs font-medium mt-1", isPositive ? "text-green-500" : "text-red-500")}>
        {diff > 0 ? '+' : ''}{percentChange.toFixed(1)}%
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-4 border border-destructive/50 bg-destructive/10 rounded-lg text-destructive text-sm">
          {error}
        </div>
      )}
      {/* GSC Style Toggle Cards */}
      <div className="grid grid-cols-2 sm:flex border rounded-lg overflow-hidden shadow-sm bg-white">
        {/* Clicks Card */}
        <div 
          onClick={() => toggleMetric('clicks')}
          className={cn(
            "cursor-pointer flex-1 p-3 sm:p-4 border-b sm:border-b-0 border-r transition-colors",
            activeMetrics.clicks ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.clicks ? colors.clicks : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
              activeMetrics.clicks ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.clicks && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-xs sm:text-sm font-medium line-clamp-1", activeMetrics.clicks ? "text-white" : "text-gray-600")}>Total clicks</span>
          </div>
          <div className={cn("text-2xl sm:text-3xl font-normal", activeMetrics.clicks ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : formatCompactNumber(summary.clicks)}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 mt-1">
              <span className={cn("text-[10px] sm:text-xs", activeMetrics.clicks ? "text-white/80" : "text-muted-foreground")}>
                vs {formatCompactNumber(compareSummary.clicks)}
              </span>
              {renderChange(summary.clicks, compareSummary.clicks)}
            </div>
          )}
        </div>

        {/* Impressions Card */}
        <div 
          onClick={() => toggleMetric('impressions')}
          className={cn(
            "cursor-pointer flex-1 p-3 sm:p-4 border-b sm:border-b-0 sm:border-r transition-colors",
            activeMetrics.impressions ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.impressions ? colors.impressions : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
              activeMetrics.impressions ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.impressions && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-xs sm:text-sm font-medium line-clamp-1", activeMetrics.impressions ? "text-white" : "text-gray-600")}>Total impressions</span>
          </div>
          <div className={cn("text-2xl sm:text-3xl font-normal", activeMetrics.impressions ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : formatCompactNumber(summary.impressions)}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 mt-1">
              <span className={cn("text-[10px] sm:text-xs", activeMetrics.impressions ? "text-white/80" : "text-muted-foreground")}>
                vs {formatCompactNumber(compareSummary.impressions)}
              </span>
              {renderChange(summary.impressions, compareSummary.impressions)}
            </div>
          )}
        </div>

        {/* CTR Card */}
        <div 
          onClick={() => toggleMetric('ctr')}
          className={cn(
            "cursor-pointer flex-1 p-3 sm:p-4 border-r sm:border-r transition-colors",
            activeMetrics.ctr ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.ctr ? colors.ctr : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
              activeMetrics.ctr ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.ctr && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-xs sm:text-sm font-medium line-clamp-1", activeMetrics.ctr ? "text-white" : "text-gray-600")}>Average CTR</span>
          </div>
          <div className={cn("text-2xl sm:text-3xl font-normal", activeMetrics.ctr ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : `${summary.ctr.toFixed(1)}%`}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 mt-1">
              <span className={cn("text-[10px] sm:text-xs", activeMetrics.ctr ? "text-white/80" : "text-muted-foreground")}>
                vs {compareSummary.ctr.toFixed(1)}%
              </span>
              {renderChange(summary.ctr, compareSummary.ctr)}
            </div>
          )}
        </div>

        {/* Position Card */}
        <div 
          onClick={() => toggleMetric('position')}
          className={cn(
            "cursor-pointer flex-1 p-3 sm:p-4 transition-colors",
            activeMetrics.position ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.position ? colors.position : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
              activeMetrics.position ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.position && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-xs sm:text-sm font-medium line-clamp-1", activeMetrics.position ? "text-white" : "text-gray-600")}>Average position</span>
          </div>
          <div className={cn("text-2xl sm:text-3xl font-normal", activeMetrics.position ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : summary.position.toFixed(1)}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 mt-1">
              <span className={cn("text-[10px] sm:text-xs", activeMetrics.position ? "text-white/80" : "text-muted-foreground")}>
                vs {compareSummary.position.toFixed(1)}
              </span>
              {renderChange(summary.position, compareSummary.position, true)}
            </div>
          )}
        </div>
      </div>

      <Card className="overflow-hidden border shadow-sm">
        <CardContent className="p-6">
          {/* Timeframe Toggles */}
          <div className="flex justify-end mb-6">
            <div className="flex bg-muted/50 rounded-md p-1 border">
              {(['Day', 'Week', 'Month'] as const).map((t) => (
                <button 
                  key={t}
                  onClick={() => setTimeframe(t)}
                  className={cn(
                    "px-4 py-1.5 text-xs font-medium rounded transition-colors",
                    timeframe === t ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Chart */}
          {loading ? (
            <div className="h-[400px] flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="h-[400px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="color_clicks" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.clicks} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.clicks} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_impressions" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.impressions} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.impressions} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_ctr" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.ctr} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.ctr} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_position" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.position} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.position} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid 
                    vertical={false} 
                    stroke="#e2e8f0"
                    yAxisId={activeMetricsList[0]}
                  />
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
                  
                  {annotations.map(ann => (
                    <ReferenceLine 
                      key={ann.id}
                      x={getChartXParam(ann.date)} 
                      stroke={ann.type === 'system' ? '#3b82f6' : '#a855f7'}
                      strokeDasharray="3 3"
                      strokeWidth={1.5}
                      label={{ 
                        position: 'insideTopLeft', 
                        value: ann.title, 
                        fill: ann.type === 'system' ? '#3b82f6' : '#a855f7',
                        fontSize: 10,
                        fontWeight: 'bold',
                      }}
                    />
                  ))}
                  
                  {/* Lines render first so they are underneath the axis labels */}
                  {activeMetrics.clicks && (
                    <>
                      <Area
                        yAxisId="clicks"
                        type="monotone"
                        dataKey="clicks"
                        name="Clicks"
                        stroke={colors.clicks}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#color_clicks)"
                        activeDot={{ r: 6 }}
                      />
                      {isCompareMode && (
                        <Line
                          yAxisId="clicks"
                          type="monotone"
                          dataKey="compareClicks"
                          name="Compare Clicks"
                          stroke={colors.clicks}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      )}
                    </>
                  )}
                  {activeMetrics.impressions && (
                    <>
                      <Area
                        yAxisId="impressions"
                        type="monotone"
                        dataKey="impressions"
                        name="Impressions"
                        stroke={colors.impressions}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#color_impressions)"
                        activeDot={{ r: 6 }}
                      />
                      {isCompareMode && (
                        <Line
                          yAxisId="impressions"
                          type="monotone"
                          dataKey="compareImpressions"
                          name="Compare Impressions"
                          stroke={colors.impressions}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      )}
                    </>
                  )}
                  {activeMetrics.ctr && (
                    <>
                      <Area
                        yAxisId="ctr"
                        type="monotone"
                        dataKey="ctr"
                        name="CTR"
                        stroke={colors.ctr}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#color_ctr)"
                        activeDot={{ r: 6 }}
                      />
                      {isCompareMode && (
                        <Line
                          yAxisId="ctr"
                          type="monotone"
                          dataKey="compareCtr"
                          name="Compare CTR"
                          stroke={colors.ctr}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      )}
                    </>
                  )}
                  {activeMetrics.position && (
                    <>
                      <Area
                        yAxisId="position"
                        type="monotone"
                        dataKey="position"
                        name="Position"
                        stroke={colors.position}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#color_position)"
                        activeDot={{ r: 6 }}
                      />
                      {isCompareMode && (
                        <Line
                          yAxisId="position"
                          type="monotone"
                          dataKey="comparePosition"
                          name="Compare Position"
                          stroke={colors.position}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      )}
                    </>
                  )}

                  {/* Independent Y-Axes for each metric render last so they are on top */}
                  {activeMetrics.clicks && (
                    <YAxis
                      yAxisId="clicks"
                      orientation={getAxisProps('clicks').orientation}
                      mirror={getAxisProps('clicks').mirror}
                      hide={getAxisProps('clicks').hide}
                      tickFormatter={formatCompactNumber}
                      axisLine={false}
                      tickLine={false}
                      tickCount={5}
                      domain={[0, 'auto']}
                      tick={<CustomYAxisTick fill={colors.clicks} formatter={formatCompactNumber} />}
                    />
                  )}
                  {activeMetrics.impressions && (
                    <YAxis
                      yAxisId="impressions"
                      orientation={getAxisProps('impressions').orientation}
                      mirror={getAxisProps('impressions').mirror}
                      hide={getAxisProps('impressions').hide}
                      tickFormatter={formatCompactNumber}
                      axisLine={false}
                      tickLine={false}
                      tickCount={5}
                      domain={[0, 'auto']}
                      tick={<CustomYAxisTick fill={colors.impressions} formatter={formatCompactNumber} />}
                    />
                  )}
                  {activeMetrics.ctr && (
                    <YAxis
                      yAxisId="ctr"
                      orientation={getAxisProps('ctr').orientation}
                      mirror={getAxisProps('ctr').mirror}
                      hide={getAxisProps('ctr').hide}
                      tickFormatter={(v) => `${v.toFixed(1)}%`}
                      axisLine={false}
                      tickLine={false}
                      tickCount={5}
                      domain={[0, 'auto']}
                      tick={<CustomYAxisTick fill={colors.ctr} formatter={(v: number) => `${v.toFixed(1)}%`} />}
                    />
                  )}
                  {activeMetrics.position && (
                    <YAxis
                      yAxisId="position"
                      orientation={getAxisProps('position').orientation}
                      mirror={getAxisProps('position').mirror}
                      hide={getAxisProps('position').hide}
                      reversed={true}
                      tickFormatter={(v) => v.toFixed(1)}
                      axisLine={false}
                      tickLine={false}
                      tickCount={5}
                      domain={[1, 'auto']}
                      tick={<CustomYAxisTick fill={colors.position} formatter={(v: number) => v.toFixed(1)} />}
                    />
                  )}

                  <Tooltip 
                    contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    labelStyle={{ fontWeight: 'bold', marginBottom: '4px', color: '#0f172a' }}
                    formatter={(value: number, name: string) => {
                      if (name === 'CTR') return [`${value.toFixed(2)}%`, name];
                      if (name === 'Position') return [value.toFixed(1), name];
                      return [value.toLocaleString(), name];
                    }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
