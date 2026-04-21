import { useState, useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Ga4ApiService, Ga4DataRow } from "@/src/services/ga4Service"
import { useAuth } from "@/src/contexts/AuthContext"
import { Loader2, Check } from "lucide-react"
import { format, parseISO, startOfWeek, startOfMonth } from "date-fns"
import { DateRange } from "react-day-picker"
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine
} from 'recharts'
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

interface Ga4OverviewProps {
  siteUrl: string;
  dateRange?: DateRange;
  isCompareMode?: boolean;
  compareDateRange?: DateRange;
  filterDimension?: string;
  filterValue?: string;
  annotations?: Annotation[];
}

export function Ga4Overview({ siteUrl, dateRange, isCompareMode, compareDateRange, filterDimension, filterValue, annotations = [] }: Ga4OverviewProps) {
  const { accessToken } = useAuth()
  const [data, setData] = useState<Ga4DataRow[]>([])
  const [compareData, setCompareData] = useState<Ga4DataRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [activeMetrics, setActiveMetrics] = useState({
    sessions: true,
    users: true,
    pageViews: false,
    bounceRate: false,
    eventCount: false
  })

  const [timeframe, setTimeframe] = useState<'Day' | 'Week' | 'Month'>('Day')

  // GSC/GA4 exact colors matching aesthetic
  const colors = {
    sessions: "#4285f4",
    users: "#5e35b1",
    pageViews: "#00897b",
    bounceRate: "#e65100",
    eventCount: "#c2185b"
  }

  useEffect(() => {
    if (!accessToken || !siteUrl || !dateRange?.from || !dateRange?.to) return;

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const ga4Service = new Ga4ApiService(accessToken)
        const startDate = format(dateRange.from!, 'yyyy-MM-dd')
        const endDate = format(dateRange.to!, 'yyyy-MM-dd')
        
        const dimensionFilter = filterDimension && filterValue ? { filterDimension, filterValue } : undefined;

        const promises = [
          ga4Service.runReport(
            siteUrl, 
            startDate, 
            endDate, 
            ['date'], 
            ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
            dimensionFilter
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
              ['date'], 
              ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
              dimensionFilter
            )
          )
        }

        const results = await Promise.all(promises);
        
        setData(results[0].rows || [])
        if (results[1]) {
           setCompareData(results[1].rows || [])
        } else {
           setCompareData([])
        }
      } catch (err: any) {
        console.error("Error fetching GA4 stats:", err)
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [accessToken, siteUrl, dateRange, isCompareMode, compareDateRange, filterDimension, filterValue])


  const { chartData, summary, compareSummary } = useMemo(() => {
    if (!data.length || !dateRange?.from || !dateRange?.to) {
      return { chartData: [], summary: { sessions: 0, users: 0, pageViews: 0, bounceRateTotal: 0, eventCount: 0, count: 0 }, compareSummary: null };
    }

    const aggregatedData = new Map<string, any>();

    let totalSessions = 0;
    let totalUsers = 0;
    let totalPageViews = 0;
    let totalBounceRate = 0;
    let totalEventCount = 0;
    let count = 0;

    let compareTotalSessions = 0;
    let compareTotalUsers = 0;
    let compareTotalPageViews = 0;
    let compareTotalBounceRate = 0;
    let compareTotalEventCount = 0;
    let compareCount = 0;

    const startPrimaryExact = parseISO(format(dateRange.from, 'yyyy-MM-dd'));
    const endPrimaryExact = parseISO(format(dateRange.to, 'yyyy-MM-dd'));
    
    // Generate all exact days
    const allPrimaryDates = [];
    let curr = startPrimaryExact;
    while (curr <= endPrimaryExact) {
      allPrimaryDates.push(curr);
      curr = new Date(curr.getTime() + 24 * 60 * 60 * 1000);
    }
    
    const keysArray: string[] = [];

    // Initialize map
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
        aggregatedData.set(key, { sessions: 0, users: 0, pageViews: 0, bounceRateCount: 0, bounceRateTotal: 0, eventCount: 0 });
      }
    });

    const parseGa4DateStr = (dimStr: string) => {
      if (dimStr.length === 8) {
        return new Date(parseInt(dimStr.substring(0, 4)), parseInt(dimStr.substring(4, 6)) - 1, parseInt(dimStr.substring(6, 8)));
      }
      return new Date();
    }

    // Process primary
    [...data].sort((a,b) => a.dimensionValues[0].value.localeCompare(b.dimensionValues[0].value)).forEach((row) => {
      const date = parseGa4DateStr(row.dimensionValues[0].value);
      let key = '';
      
      if (timeframe === 'Day') {
        key = format(date, 'MMM d, yyyy');
      } else if (timeframe === 'Week') {
        key = format(startOfWeek(date), 'MMM d, yyyy');
      } else if (timeframe === 'Month') {
        key = format(startOfMonth(date), 'MMM yyyy');
      }

      const sessions = parseInt(row.metricValues[0].value);
      const users = parseInt(row.metricValues[1].value);
      const pageViews = parseInt(row.metricValues[2].value);
      const bounceRate = parseFloat(row.metricValues[3].value);
      const eventCount = parseInt(row.metricValues[4] ? row.metricValues[4].value : "0");

      const current = aggregatedData.get(key);
      if (current) {
        current.sessions += sessions;
        current.users += users;
        current.pageViews += pageViews;
        current.bounceRateTotal += bounceRate;
        current.bounceRateCount += 1;
        current.eventCount += eventCount;
      }

      totalSessions += sessions;
      totalUsers += users;
      totalPageViews += pageViews;
      totalBounceRate += bounceRate;
      totalEventCount += eventCount;
      count += 1;
    });

    // Process Compare
    if (isCompareMode && compareData.length > 0 && compareDateRange?.from) {
      const startCompareExact = parseISO(format(compareDateRange.from, 'yyyy-MM-dd'));
      
      [...compareData].sort((a,b) => a.dimensionValues[0].value.localeCompare(b.dimensionValues[0].value)).forEach((row) => {
        const date = parseGa4DateStr(row.dimensionValues[0].value);
        const offset = Math.round((date.getTime() - startCompareExact.getTime()) / (24 * 60 * 60 * 1000));
        
        const sessions = parseInt(row.metricValues[0].value);
        const users = parseInt(row.metricValues[1].value);
        const pageViews = parseInt(row.metricValues[2].value);
        const bounceRate = parseFloat(row.metricValues[3].value);
        const eventCount = parseInt(row.metricValues[4] ? row.metricValues[4].value : "0");

        if (offset >= 0 && offset < keysArray.length) {
          const key = keysArray[offset];
          const current = aggregatedData.get(key);
          if (current) {
            current.compareSessions = (current.compareSessions || 0) + sessions;
            current.compareUsers = (current.compareUsers || 0) + users;
            current.comparePageViews = (current.comparePageViews || 0) + pageViews;
            current.compareBounceRateTotal = (current.compareBounceRateTotal || 0) + bounceRate;
            current.compareBounceRateCount = (current.compareBounceRateCount || 0) + 1;
            current.compareEventCount = (current.compareEventCount || 0) + eventCount;
          }
        }

        compareTotalSessions += sessions;
        compareTotalUsers += users;
        compareTotalPageViews += pageViews;
        compareTotalBounceRate += bounceRate;
        compareTotalEventCount += eventCount;
        compareCount += 1;
      });
    }

    const finalChartData = Array.from(aggregatedData.entries()).map(([dateStr, d]) => ({
      date: dateStr,
      sessions: d.sessions,
      users: d.users,
      pageViews: d.pageViews,
      bounceRate: d.bounceRateCount > 0 ? (d.bounceRateTotal / d.bounceRateCount) * 100 : 0,
      eventCount: d.eventCount,
      
      compareSessions: isCompareMode ? (d.compareSessions || 0) : undefined,
      compareUsers: isCompareMode ? (d.compareUsers || 0) : undefined,
      comparePageViews: isCompareMode ? (d.comparePageViews || 0) : undefined,
      compareBounceRate: isCompareMode ? ((d.compareBounceRateCount || 0) > 0 ? (d.compareBounceRateTotal / d.compareBounceRateCount) * 100 : 0) : undefined,
      compareEventCount: isCompareMode ? (d.compareEventCount || 0) : undefined,
    }));

    return { 
      chartData: finalChartData, 
      summary: { sessions: totalSessions, users: totalUsers, pageViews: totalPageViews, bounceRateTotal: totalBounceRate, eventCount: totalEventCount, count },
      compareSummary: isCompareMode ? { sessions: compareTotalSessions, users: compareTotalUsers, pageViews: compareTotalPageViews, bounceRateTotal: compareTotalBounceRate, eventCount: compareTotalEventCount, count: compareCount } : null 
    };
  }, [data, compareData, dateRange, compareDateRange, isCompareMode, timeframe])


  const toggleMetric = (metric: keyof typeof activeMetrics) => {
    setActiveMetrics(prev => ({
      ...prev,
      [metric]: !prev[metric]
    }))
  }

  const activeMetricsList = Object.entries(activeMetrics).filter(([_, isActive]) => isActive).map(([key]) => key);

  // Dynamic axis positioning function matching overview
  const getAxisProps = (metricId: string) => {
    const activeCount = activeMetricsList.length;
    const index = activeMetricsList.indexOf(metricId);
    
    if (activeCount === 1) {
      return { orientation: 'left' as const, mirror: false, hide: false };
    }
    if (activeCount === 2) {
      if (index === 0) return { orientation: 'left' as const, mirror: false, hide: false };
      if (index === 1) return { orientation: 'right' as const, mirror: false, hide: false };
    }
    if (activeCount === 3) {
      if (index === 0) return { orientation: 'left' as const, mirror: false, hide: false };
      if (index === 1) return { orientation: 'left' as const, mirror: true, hide: false };
      if (index === 2) return { orientation: 'right' as const, mirror: false, hide: false };
    }
    if (activeCount >= 4) {
      if (index === 0) return { orientation: 'left' as const, mirror: false, hide: false };
      if (index === 1) return { orientation: 'left' as const, mirror: true, hide: false };
      if (index === 2) return { orientation: 'right' as const, mirror: true, hide: false };
      if (index === 3) return { orientation: 'right' as const, mirror: false, hide: false };
    }
    return { orientation: 'left' as const, mirror: false, hide: true };
  }

  const renderChange = (current: number, previous: number, isLowerBetter = false) => {
    if (previous === 0) return null;
    const diff = current - previous;
    const percentChange = (diff / previous) * 100;
    
    let isPositive = diff > 0;
    if (isLowerBetter) {
      isPositive = diff < 0; // if it lowered, it's good (positive styling)
    }

    if (Math.abs(percentChange) < 0.1) {
      return <span className="text-muted-foreground text-xs font-semibold px-2 py-0.5 bg-gray-100 rounded-sm">~0%</span>;
    }

    return (
      <span className={cn(
        "text-xs font-semibold px-2 py-0.5 rounded-sm",
        isPositive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
      )}>
        {diff > 0 ? '+' : ''}{percentChange.toFixed(1)}%
      </span>
    )
  }

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

  if (loading && data.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (error && data.length === 0) {
    return null; // Handled primarily by the table for now
  }

  if (data.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Scorecards */}
      <div className="grid grid-cols-2 md:flex rounded-lg border bg-white shadow-sm overflow-hidden">
        
        {/* Sessions Card */}
        <div 
          onClick={() => toggleMetric('sessions')}
          className={cn(
            "cursor-pointer flex-1 p-3 sm:p-4 border-b md:border-b-0 border-r transition-colors",
            activeMetrics.sessions ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.sessions ? colors.sessions : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
              activeMetrics.sessions ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.sessions && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-xs sm:text-sm font-medium line-clamp-1", activeMetrics.sessions ? "text-white" : "text-gray-600")}>Total sessions</span>
          </div>
          <div className={cn("text-2xl sm:text-3xl font-normal", activeMetrics.sessions ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : formatCompactNumber(summary.sessions)}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 mt-1">
              <span className={cn("text-[10px] sm:text-xs", activeMetrics.sessions ? "text-white/80" : "text-muted-foreground")}>
                vs {formatCompactNumber(compareSummary.sessions)}
              </span>
              {renderChange(summary.sessions, compareSummary.sessions)}
            </div>
          )}
        </div>

        {/* Users Card */}
        <div 
          onClick={() => toggleMetric('users')}
          className={cn(
            "cursor-pointer flex-1 p-3 sm:p-4 border-b md:border-b-0 md:border-r transition-colors",
            activeMetrics.users ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.users ? colors.users : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
              activeMetrics.users ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.users && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-xs sm:text-sm font-medium line-clamp-1", activeMetrics.users ? "text-white" : "text-gray-600")}>Total users</span>
          </div>
          <div className={cn("text-2xl sm:text-3xl font-normal", activeMetrics.users ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : formatCompactNumber(summary.users)}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 mt-1">
              <span className={cn("text-[10px] sm:text-xs", activeMetrics.users ? "text-white/80" : "text-muted-foreground")}>
                vs {formatCompactNumber(compareSummary.users)}
              </span>
              {renderChange(summary.users, compareSummary.users)}
            </div>
          )}
        </div>

        {/* Page Views Card */}
        <div 
          onClick={() => toggleMetric('pageViews')}
          className={cn(
            "cursor-pointer flex-1 p-3 sm:p-4 border-b md:border-b-0 border-r transition-colors",
            activeMetrics.pageViews ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.pageViews ? colors.pageViews : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
              activeMetrics.pageViews ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.pageViews && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-xs sm:text-sm font-medium line-clamp-1", activeMetrics.pageViews ? "text-white" : "text-gray-600")}>Page Views</span>
          </div>
          <div className={cn("text-2xl sm:text-3xl font-normal", activeMetrics.pageViews ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : formatCompactNumber(summary.pageViews)}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 mt-1">
              <span className={cn("text-[10px] sm:text-xs", activeMetrics.pageViews ? "text-white/80" : "text-muted-foreground")}>
                vs {formatCompactNumber(compareSummary.pageViews)}
              </span>
              {renderChange(summary.pageViews, compareSummary.pageViews)}
            </div>
          )}
        </div>

        {/* Bounce Rate Card */}
        <div 
          onClick={() => toggleMetric('bounceRate')}
          className={cn(
            "cursor-pointer flex-1 p-3 sm:p-4 border-b md:border-b-0 md:border-r transition-colors",
             activeMetrics.bounceRate ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.bounceRate ? colors.bounceRate : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
              activeMetrics.bounceRate ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.bounceRate && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-xs sm:text-sm font-medium line-clamp-1", activeMetrics.bounceRate ? "text-white" : "text-gray-600")}>Bounce Rate</span>
          </div>
          <div className={cn("text-2xl sm:text-3xl font-normal", activeMetrics.bounceRate ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : `${summary.count > 0 ? ((summary.bounceRateTotal / summary.count) * 100).toFixed(2) : 0}%`}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 mt-1">
              <span className={cn("text-[10px] sm:text-xs", activeMetrics.bounceRate ? "text-white/80" : "text-muted-foreground")}>
                vs {compareSummary.count > 0 ? ((compareSummary.bounceRateTotal / compareSummary.count) * 100).toFixed(2) : 0}%
              </span>
              {renderChange(summary.count > 0 ? (summary.bounceRateTotal / summary.count) * 100 : 0, compareSummary.count > 0 ? (compareSummary.bounceRateTotal / compareSummary.count) * 100 : 0, true)}
            </div>
          )}
        </div>

        {/* Event Count Card */}
        <div 
          onClick={() => toggleMetric('eventCount')}
          className={cn(
            "cursor-pointer flex-1 p-3 sm:p-4 col-span-2 md:col-span-1 transition-colors",
            activeMetrics.eventCount ? "text-white" : "bg-white text-muted-foreground hover:bg-gray-50"
          )}
          style={{ backgroundColor: activeMetrics.eventCount ? colors.eventCount : undefined }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={cn(
              "w-4 h-4 rounded-sm border flex items-center justify-center",
              activeMetrics.eventCount ? "border-white bg-transparent" : "border-gray-400"
            )}>
              {activeMetrics.eventCount && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
            <span className={cn("text-sm font-medium", activeMetrics.eventCount ? "text-white" : "text-gray-600")}>Event Count</span>
          </div>
          <div className={cn("text-3xl font-normal", activeMetrics.eventCount ? "text-white" : "text-gray-900")}>
            {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : formatCompactNumber(summary.eventCount)}
          </div>
          {isCompareMode && compareSummary && !loading && (
            <div className="flex items-center gap-2 mt-1">
              <span className={cn("text-xs", activeMetrics.eventCount ? "text-white/80" : "text-muted-foreground")}>
                vs {formatCompactNumber(compareSummary.eventCount)}
              </span>
              {renderChange(summary.eventCount, compareSummary.eventCount)}
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
                    <linearGradient id="color_sessions" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.sessions} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.sessions} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_users" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.users} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.users} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_pageViews" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.pageViews} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.pageViews} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_bounceRate" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.bounceRate} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.bounceRate} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_eventCount" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.eventCount} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.eventCount} stopOpacity={0}/>
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
                  
                  {activeMetrics.sessions && (
                    <>
                      <Area
                        yAxisId="sessions"
                        type="monotone"
                        dataKey="sessions"
                        name="Sessions"
                        stroke={colors.sessions}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#color_sessions)"
                        activeDot={{ r: 6 }}
                      />
                      {isCompareMode && (
                        <Line
                          yAxisId="sessions"
                          type="monotone"
                          dataKey="compareSessions"
                          name="Compare Sessions"
                          stroke={colors.sessions}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      )}
                    </>
                  )}
                  {activeMetrics.users && (
                    <>
                      <Area
                        yAxisId="users"
                        type="monotone"
                        dataKey="users"
                        name="Users"
                        stroke={colors.users}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#color_users)"
                        activeDot={{ r: 6 }}
                      />
                      {isCompareMode && (
                        <Line
                          yAxisId="users"
                          type="monotone"
                          dataKey="compareUsers"
                          name="Compare Users"
                          stroke={colors.users}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      )}
                    </>
                  )}
                  {activeMetrics.pageViews && (
                    <>
                      <Area
                        yAxisId="pageViews"
                        type="monotone"
                        dataKey="pageViews"
                        name="Page Views"
                        stroke={colors.pageViews}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#color_pageViews)"
                        activeDot={{ r: 6 }}
                      />
                      {isCompareMode && (
                        <Line
                          yAxisId="pageViews"
                          type="monotone"
                          dataKey="comparePageViews"
                          name="Compare Page Views"
                          stroke={colors.pageViews}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      )}
                    </>
                  )}
                  {activeMetrics.bounceRate && (
                    <>
                      <Area
                        yAxisId="bounceRate"
                        type="monotone"
                        dataKey="bounceRate"
                        name="Bounce Rate"
                        stroke={colors.bounceRate}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#color_bounceRate)"
                        activeDot={{ r: 6 }}
                      />
                      {isCompareMode && (
                        <Line
                          yAxisId="bounceRate"
                          type="monotone"
                          dataKey="compareBounceRate"
                          name="Compare Bounce Rate"
                          stroke={colors.bounceRate}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      )}
                    </>
                  )}
                  {activeMetrics.eventCount && (
                    <>
                      <Area
                        yAxisId="eventCount"
                        type="monotone"
                        dataKey="eventCount"
                        name="Event Count"
                        stroke={colors.eventCount}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#color_eventCount)"
                        activeDot={{ r: 6 }}
                      />
                      {isCompareMode && (
                        <Line
                          yAxisId="eventCount"
                          type="monotone"
                          dataKey="compareEventCount"
                          name="Compare Event Count"
                          stroke={colors.eventCount}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      )}
                    </>
                  )}

                  {activeMetrics.sessions && (
                    <YAxis
                      yAxisId="sessions"
                      orientation={getAxisProps('sessions').orientation}
                      mirror={getAxisProps('sessions').mirror}
                      hide={getAxisProps('sessions').hide}
                      tickFormatter={formatCompactNumber}
                      axisLine={false}
                      tickLine={false}
                      tickCount={5}
                      domain={[0, 'auto']}
                      tick={<CustomYAxisTick fill={colors.sessions} formatter={formatCompactNumber} />}
                    />
                  )}
                  {activeMetrics.users && (
                    <YAxis
                      yAxisId="users"
                      orientation={getAxisProps('users').orientation}
                      mirror={getAxisProps('users').mirror}
                      hide={getAxisProps('users').hide}
                      tickFormatter={formatCompactNumber}
                      axisLine={false}
                      tickLine={false}
                      tickCount={5}
                      domain={[0, 'auto']}
                      tick={<CustomYAxisTick fill={colors.users} formatter={formatCompactNumber} />}
                    />
                  )}
                  {activeMetrics.pageViews && (
                    <YAxis
                      yAxisId="pageViews"
                      orientation={getAxisProps('pageViews').orientation}
                      mirror={getAxisProps('pageViews').mirror}
                      hide={getAxisProps('pageViews').hide}
                      tickFormatter={formatCompactNumber}
                      axisLine={false}
                      tickLine={false}
                      tickCount={5}
                      domain={[0, 'auto']}
                      tick={<CustomYAxisTick fill={colors.pageViews} formatter={formatCompactNumber} />}
                    />
                  )}
                  {activeMetrics.bounceRate && (
                    <YAxis
                      yAxisId="bounceRate"
                      orientation={getAxisProps('bounceRate').orientation}
                      mirror={getAxisProps('bounceRate').mirror}
                      hide={getAxisProps('bounceRate').hide}
                      tickFormatter={(v) => `${v.toFixed(1)}%`}
                      axisLine={false}
                      tickLine={false}
                      tickCount={5}
                      domain={[0, 'auto']}
                      tick={<CustomYAxisTick fill={colors.bounceRate} formatter={(v: number) => `${v.toFixed(1)}%`} />}
                    />
                  )}
                  {activeMetrics.eventCount && (
                    <YAxis
                      yAxisId="eventCount"
                      orientation={getAxisProps('eventCount').orientation}
                      mirror={getAxisProps('eventCount').mirror}
                      hide={getAxisProps('eventCount').hide}
                      tickFormatter={formatCompactNumber}
                      axisLine={false}
                      tickLine={false}
                      tickCount={5}
                      domain={[0, 'auto']}
                      tick={<CustomYAxisTick fill={colors.eventCount} formatter={formatCompactNumber} />}
                    />
                  )}

                  <Tooltip 
                    contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    labelStyle={{ fontWeight: 'bold', marginBottom: '4px', color: '#0f172a' }}
                    formatter={(value: number, name: string) => {
                      if (name.includes('Bounce Rate')) return [`${value.toFixed(2)}%`, name];
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

