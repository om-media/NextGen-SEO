import { useState, useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts"
import { useAuth } from "@/src/contexts/AuthContext"
import { GscApiService } from "@/src/services/gscService"
import { format, parseISO, startOfWeek, startOfMonth } from "date-fns"
import { DateRange } from "react-day-picker"
import { Loader2, Check } from "lucide-react"
import { cn } from "@/lib/utils"

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
  compareDateRange
}: { 
  siteUrl: string, 
  dateRange?: DateRange,
  filterDimension?: 'query' | 'page' | 'country',
  filterValue?: string,
  isCompareMode?: boolean,
  compareDateRange?: DateRange
}) {
  const { accessToken, clearAccessToken } = useAuth()
  const [rawData, setRawData] = useState<any[]>([])
  const [compareRawData, setCompareRawData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

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
    if (accessToken && siteUrl && dateRange?.from && dateRange?.to) {
      setLoading(true)
      const gscService = new GscApiService(accessToken)
      
      const endDate = format(dateRange.to, 'yyyy-MM-dd')
      const startDate = format(dateRange.from, 'yyyy-MM-dd')

      const filterGroups = filterDimension && filterValue ? [{
        filters: [{ dimension: filterDimension, expression: filterValue, operator: 'equals' }]
      }] : undefined;

      const promises = [
        gscService.querySearchAnalytics(siteUrl, startDate, endDate, ['date'], filterGroups)
      ];

      if (isCompareMode && compareDateRange?.from && compareDateRange?.to) {
        const compareEndDate = format(compareDateRange.to, 'yyyy-MM-dd')
        const compareStartDate = format(compareDateRange.from, 'yyyy-MM-dd')
        promises.push(
          gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, ['date'], filterGroups)
        )
      }

      Promise.all(promises)
        .then(([primaryRows, compareRows]) => {
          setRawData(primaryRows)
          if (compareRows) {
            setCompareRawData(compareRows)
          } else {
            setCompareRawData([])
          }
        })
        .catch(err => {
          if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token")) {
            console.warn("GSC Access token expired or invalid. Prompting re-authentication.");
            clearAccessToken()
          } else {
            console.error("Failed to fetch GSC overview data:", err)
          }
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [accessToken, siteUrl, dateRange, isCompareMode, compareDateRange, filterDimension, filterValue, clearAccessToken])

  const { chartData, summary, compareSummary } = useMemo(() => {
    if (!rawData.length) return { chartData: [], summary: { clicks: 0, impressions: 0, ctr: 0, position: 0 }, compareSummary: null };

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

    // Process primary data
    sortedRows.forEach((row, index) => {
      const date = parseISO(row.keys[0]);
      let key = '';
      
      if (timeframe === 'Day') {
        key = format(date, 'MMM d, yyyy');
      } else if (timeframe === 'Week') {
        key = format(startOfWeek(date), 'MMM d, yyyy');
      } else if (timeframe === 'Month') {
        key = format(startOfMonth(date), 'MMM yyyy');
      }

      if (!aggregatedData.has(key)) {
        aggregatedData.set(key, { clicks: 0, impressions: 0, sumPosition: 0, count: 0 });
      }

      const current = aggregatedData.get(key)!;
      current.clicks += row.clicks;
      current.impressions += row.impressions;
      current.sumPosition += (row.position * row.impressions);
      current.count += 1;

      totalClicks += row.clicks;
      totalImpressions += row.impressions;
      sumPositionTotal += (row.position * row.impressions);
    });

    // Process compare data and align by index
    if (isCompareMode && sortedCompareRows.length > 0) {
      const keys = Array.from(aggregatedData.keys());
      sortedCompareRows.forEach((row, index) => {
        // Align by index if possible, otherwise just add to totals
        const key = keys[index] || `Compare Day ${index + 1}`;
        
        if (!aggregatedData.has(key)) {
          aggregatedData.set(key, { clicks: 0, impressions: 0, sumPosition: 0, count: 0 });
        }

        const current = aggregatedData.get(key)!;
        current.compareClicks = (current.compareClicks || 0) + row.clicks;
        current.compareImpressions = (current.compareImpressions || 0) + row.impressions;
        current.compareSumPosition = (current.compareSumPosition || 0) + (row.position * row.impressions);
        current.compareCount = (current.compareCount || 0) + 1;

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
  }, [rawData, compareRawData, timeframe, isCompareMode]);

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
      {/* GSC Style Toggle Cards */}
      <div className="flex flex-col sm:flex-row border rounded-lg overflow-hidden shadow-sm bg-white">
        {/* Clicks Card */}
        <div 
          onClick={() => toggleMetric('clicks')}
          className={cn(
            "cursor-pointer flex-1 p-4 border-b sm:border-b-0 sm:border-r transition-colors",
            activeMetrics.clicks ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.clicks ? colors.clicks : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center",
              activeMetrics.clicks ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.clicks && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-sm font-medium", activeMetrics.clicks ? "text-white" : "text-gray-600")}>Total clicks</span>
          </div>
          <div className={cn("text-3xl font-normal", activeMetrics.clicks ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : formatCompactNumber(summary.clicks)}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex items-center gap-2 mt-1">
              <span className={cn("text-xs", activeMetrics.clicks ? "text-white/80" : "text-muted-foreground")}>
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
            "cursor-pointer flex-1 p-4 border-b sm:border-b-0 sm:border-r transition-colors",
            activeMetrics.impressions ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.impressions ? colors.impressions : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center",
              activeMetrics.impressions ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.impressions && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-sm font-medium", activeMetrics.impressions ? "text-white" : "text-gray-600")}>Total impressions</span>
          </div>
          <div className={cn("text-3xl font-normal", activeMetrics.impressions ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : formatCompactNumber(summary.impressions)}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex items-center gap-2 mt-1">
              <span className={cn("text-xs", activeMetrics.impressions ? "text-white/80" : "text-muted-foreground")}>
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
            "cursor-pointer flex-1 p-4 border-b sm:border-b-0 sm:border-r transition-colors",
            activeMetrics.ctr ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.ctr ? colors.ctr : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center",
              activeMetrics.ctr ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.ctr && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-sm font-medium", activeMetrics.ctr ? "text-white" : "text-gray-600")}>Average CTR</span>
          </div>
          <div className={cn("text-3xl font-normal", activeMetrics.ctr ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : `${summary.ctr.toFixed(1)}%`}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex items-center gap-2 mt-1">
              <span className={cn("text-xs", activeMetrics.ctr ? "text-white/80" : "text-muted-foreground")}>
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
            "cursor-pointer flex-1 p-4 transition-colors",
            activeMetrics.position ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.position ? colors.position : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center",
              activeMetrics.position ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.position && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-sm font-medium", activeMetrics.position ? "text-white" : "text-gray-600")}>Average position</span>
          </div>
          <div className={cn("text-3xl font-normal", activeMetrics.position ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : summary.position.toFixed(1)}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex items-center gap-2 mt-1">
              <span className={cn("text-xs", activeMetrics.position ? "text-white/80" : "text-muted-foreground")}>
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
                <LineChart data={chartData} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
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
                  
                  {/* Lines render first so they are underneath the axis labels */}
                  {activeMetrics.clicks && (
                    <>
                      <Line
                        yAxisId="clicks"
                        type="monotone"
                        dataKey="clicks"
                        name="Clicks"
                        stroke={colors.clicks}
                        strokeWidth={2}
                        dot={false}
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
                      <Line
                        yAxisId="impressions"
                        type="monotone"
                        dataKey="impressions"
                        name="Impressions"
                        stroke={colors.impressions}
                        strokeWidth={2}
                        dot={false}
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
                      <Line
                        yAxisId="ctr"
                        type="monotone"
                        dataKey="ctr"
                        name="CTR"
                        stroke={colors.ctr}
                        strokeWidth={2}
                        dot={false}
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
                      <Line
                        yAxisId="position"
                        type="monotone"
                        dataKey="position"
                        name="Position"
                        stroke={colors.position}
                        strokeWidth={2}
                        dot={false}
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
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
