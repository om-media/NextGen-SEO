import { useState, useEffect, useMemo, type ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { ComposedChart, Area, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts"
import { useAuth } from "@/src/contexts/AuthContext"
import { GscApiService } from "@/src/services/gscService"
import { addDays, differenceInCalendarDays, format, parseISO, startOfWeek, startOfMonth } from "date-fns"
import { DateRange } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { Check, Download, MoreVertical, Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { Annotation } from "@/src/services/annotationsService"
import { authFetch } from "@/src/lib/authFetch"

const formatCompactNumber = (number: number) => {
  return new Intl.NumberFormat('en-US', { 
    notation: "compact", 
    maximumFractionDigits: 2 
  }).format(number);
}

const getLatestStableGscDate = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - 2);
  return date;
};

const getEffectiveGscDateRange = (dateRange?: DateRange) => {
  if (!dateRange?.from || !dateRange.to) return null;
  const latestStableDate = getLatestStableGscDate();
  const endDate = dateRange.to > latestStableDate ? latestStableDate : dateRange.to;
  if (dateRange.from > endDate) return null;
  return { from: dateRange.from, to: endDate };
};

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

const getDateKey = (row: any) => {
  const key = row?.keys?.[0];
  return typeof key === "string" && key.length > 0 ? key : "";
};

const getQueryKey = (row: any) => {
  const explicitQuery = row?.query;
  if (typeof explicitQuery === "string" && explicitQuery.length > 0) return explicitQuery;

  const keyQuery = row?.keys?.[1];
  return typeof keyQuery === "string" && keyQuery.length > 0 ? keyQuery : "";
};

const toFiniteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

type MetricKey = "clicks" | "impressions" | "ctr" | "queries" | "position";

const getAnnotationLabel = (annotation: Annotation) =>
  annotation.type === "system" ? "Google update" : annotation.title;

const getAnnotationTooltip = (annotation: Annotation) => {
  const date = (() => {
    try {
      return format(parseISO(annotation.date), "MMM d, yyyy");
    } catch {
      return annotation.date;
    }
  })();

  return [
    getAnnotationLabel(annotation),
    annotation.title,
    date,
    annotation.description,
  ].filter(Boolean).join("\n");
};

function AnnotationReferenceLabel(props: any) {
  const { annotation, fill, offsetIndex = 0, viewBox, x, y } = props;
  const labelX = Number(x ?? viewBox?.x ?? 0) + 6;
  const labelY = Math.max(12, Number(y ?? viewBox?.y ?? 0) + 12 + offsetIndex * 16);

  return (
    <g className="cursor-help">
      <title>{getAnnotationTooltip(annotation)}</title>
      <rect
        x={labelX - 4}
        y={labelY - 11}
        width={Math.min(154, Math.max(82, getAnnotationLabel(annotation).length * 6.5 + 12))}
        height={15}
        rx={5}
        fill="white"
        fillOpacity={0.88}
      />
      <text
        x={labelX}
        y={labelY}
        fill={fill}
        fontSize={11}
        fontWeight={700}
      >
        {getAnnotationLabel(annotation)}
      </text>
    </g>
  );
}

export function Overview({ 
  siteUrl, 
  dateRange,
  filterDimension,
  filterValue,
  isCompareMode,
  compareDateRange,
  annotations = [],
  annotationControls,
  refreshKey = 0,
  useLiveData = true
}: { 
  siteUrl: string, 
  dateRange?: DateRange,
  filterDimension?: 'query' | 'page' | 'country',
  filterValue?: string,
  isCompareMode?: boolean,
  compareDateRange?: DateRange,
  annotations?: Annotation[],
  annotationControls?: ReactNode,
  refreshKey?: number,
  useLiveData?: boolean
}) {
  const { userProfile } = useAuth()
  const [rawData, setRawData] = useState<any[]>([])
  const [compareRawData, setCompareRawData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [activeMetrics, setActiveMetrics] = useState({
    clicks: true,
    impressions: true,
    ctr: false,
    queries: true,
    position: false
  })

  const [timeframe, setTimeframe] = useState<'Day' | 'Week' | 'Month'>('Day')

  const colors = {
    clicks: "#2F7DF6",
    impressions: "#7C3AED",
    ctr: "#0891B2",
    queries: "#0F3D2E",
    position: "#F97316"
  }
  const hasQueryMetric = filterDimension === "page" && Boolean(filterValue);
  const isConnectionIssue = error?.startsWith("Your Google data connection needs attention.") ?? false

  const getFriendlyOverviewError = (message: string) => {
    if (message === 'UNAUTHORIZED' || message.includes("invalid authentication credentials") || message.includes("OAuth 2 access token") || message.includes("GOOGLE_NOT_CONNECTED")) {
      return "Your Google data connection needs attention. Please click 'Reconnect Google Data' at the top to restore reporting access."
    }

    if (message.includes("sufficient permission")) {
      return "You do not have sufficient permission to view data for this property. Please select a different property or verify your access in Google Search Console."
    }

    return message
  }

  useEffect(() => {
    const effectiveDateRange = getEffectiveGscDateRange(dateRange);
    if (!siteUrl || !effectiveDateRange) {
      setRawData([]);
      setCompareRawData([]);
      setError(null);
      setLoading(false);
      return;
    }

      setLoading(true)
      const gscService = new GscApiService(null, userProfile?.tier || 'free')
      
      const endDate = format(effectiveDateRange.to, 'yyyy-MM-dd')
      const startDate = format(effectiveDateRange.from, 'yyyy-MM-dd')

      const filterGroups = filterDimension && filterValue ? [{
        filters: [{ dimension: filterDimension, expression: filterValue, operator: 'equals' }]
      }] : undefined;

      const getWarehouseDimensions = () => {
        if (filterDimension === "page") return ["date", "page"];
        if (filterDimension === "query") return ["date", "query"];
        return ["date"];
      };

      const mergeQueryCounts = (rows: any[], queryRows: any[]) => {
        if (!queryRows.length) return rows;

        const queriesByDate = new Map<string, Set<string>>();
        queryRows.forEach((row) => {
          const rowDate = getDateKey(row);
          const query = getQueryKey(row);
          if (!rowDate || !query) return;
          if (!queriesByDate.has(rowDate)) queriesByDate.set(rowDate, new Set());
          queriesByDate.get(rowDate)?.add(query);
        });

        return rows.map((row) => ({
          ...row,
          queryKeys: Array.from(queriesByDate.get(getDateKey(row)) || []),
          queryCount: queriesByDate.get(getDateKey(row))?.size || Number(row.queryCount) || 0,
        }));
      };

      const fetchWarehouseData = async (start: string, end: string) => {
        const res = await authFetch('/api/warehouse/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteUrl, startDate: start, endDate: end, dimensions: getWarehouseDimensions(), dimensionFilterGroups: filterGroups })
        })
        if (!res.ok) throw new Error("Failed to fetch warehouse data")
        const json = await res.json()
        return json.map((r: any) => ({
          keys: [r.date],
          clicks: toFiniteNumber(r.clicks),
          impressions: toFiniteNumber(r.impressions),
          ctr: toFiniteNumber(r.ctr),
          position: toFiniteNumber(r.position),
          queryCount: toFiniteNumber(r.queryCount)
        })).filter((row: any) => getDateKey(row))
      }

      const fetchWarehouseQueryRows = async (start: string, end: string) => {
        if (!hasQueryMetric) return [];

        const res = await authFetch('/api/warehouse/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            siteUrl,
            startDate: start,
            endDate: end,
            dimensions: ["date", "page", "query"],
            dimensionFilterGroups: filterGroups,
          })
        });
        if (!res.ok) throw new Error("Failed to fetch warehouse query data");

        const json = await res.json();
        return json.map((r: any) => ({
          keys: [r.date, r.query],
          query: r.query,
          queryCount: 1,
        })).filter((row: any) => getDateKey(row) && getQueryKey(row));
      };

      const fetchLiveQueryCounts = async (start: string, end: string) => {
        if (!hasQueryMetric) return [];

        const rows: any[] = [];
        let cursor = parseISO(start);
        const finalDate = parseISO(end);

        // Query-count charts need detail rows. Fetching a whole range in one
        // request can hit GSC row caps and create fake drops, so keep windows small.
        while (cursor <= finalDate) {
          const chunkEnd = addDays(cursor, 6) > finalDate ? finalDate : addDays(cursor, 6);
          const chunkRows = await gscService.querySearchAnalytics(
            siteUrl,
            format(cursor, "yyyy-MM-dd"),
            format(chunkEnd, "yyyy-MM-dd"),
            ['date', 'query'],
            filterGroups,
            true
          );
          rows.push(...chunkRows);
          cursor = addDays(chunkEnd, 1);
        }

        return rows.map((row: any) => {
          const date = row.keys?.[0];
          const query = row.keys?.[1];
          if (typeof date !== "string" || typeof query !== "string") return null;
          return {
            keys: [date],
            query,
            queryCount: 1,
          };
        }).filter(Boolean);
      };

      const fetchPreferredQueryRows = async (start: string, end: string) => {
        if (!hasQueryMetric) return [];

        if (useLiveData && userProfile?.googleConnected) {
          try {
            return await fetchLiveQueryCounts(start, end);
          } catch (err) {
            console.warn("Live page query-count fetch failed; falling back to warehouse query detail.", err);
          }
        }

        return fetchWarehouseQueryRows(start, end);
      };

      const shouldPreferLiveDrilldown = Boolean(useLiveData && filterDimension && filterValue && userProfile?.googleConnected);
      const fetchPrimaryMetricRows = (start: string, end: string) => {
        if (useLiveData || shouldPreferLiveDrilldown) {
          // Exact drilldowns are bounded to one row per day, so live GSC is safer
          // than potentially capped/stale warehouse detail for a selected query/page.
          return gscService.querySearchAnalytics(siteUrl, start, end, ['date'], filterGroups, true);
        }

        return fetchWarehouseData(start, end);
      };

      const fetchPreferredMetricRows = async (start: string, end: string) => {
        if (!shouldPreferLiveDrilldown) {
          return fetchPrimaryMetricRows(start, end);
        }

        try {
          return await fetchPrimaryMetricRows(start, end);
        } catch (err) {
          console.warn("Live exact GSC drilldown failed; falling back to warehouse metrics.", err);
          return fetchWarehouseData(start, end);
        }
      };

      const primaryPromise = fetchPreferredMetricRows(startDate, endDate)
      const primaryQueryCountPromise = fetchPreferredQueryRows(startDate, endDate)

      const effectiveCompareDateRange = getEffectiveGscDateRange(compareDateRange);
      const comparePromise =
        isCompareMode && effectiveCompareDateRange
          ? (() => {
              const compareEndDate = format(effectiveCompareDateRange.to, 'yyyy-MM-dd')
              const compareStartDate = format(effectiveCompareDateRange.from, 'yyyy-MM-dd')
              return fetchPreferredMetricRows(compareStartDate, compareEndDate)
            })()
          : null
      const compareQueryCountPromise =
        hasQueryMetric && isCompareMode && effectiveCompareDateRange
          ? fetchPreferredQueryRows(format(effectiveCompareDateRange.from, 'yyyy-MM-dd'), format(effectiveCompareDateRange.to, 'yyyy-MM-dd'))
          : Promise.resolve([])

      primaryPromise
        .then(async (primaryRows) => {
          const primaryQueryRows = await primaryQueryCountPromise.catch((err) => {
            console.warn("Failed to fetch query counts for GSC overview; continuing without the query metric.", err);
            return [];
          });
          setRawData(mergeQueryCounts(primaryRows, primaryQueryRows))
          setError(null)

          if (!comparePromise) {
            setCompareRawData([])
            return
          }

          const compareResult = await comparePromise
            .then((compareRows) => ({ ok: true as const, compareRows }))
            .catch((err) => {
              console.warn("Compare range failed for GSC overview; continuing with primary range only.", err)
              return { ok: false as const, error: err }
            })

          if (!compareResult.ok || !compareResult.compareRows) {
            setCompareRawData([])
            return
          }

          const compareQueryRows = await compareQueryCountPromise.catch((err) => {
            console.warn("Failed to fetch compare query counts for GSC overview; continuing without compare query counts.", err);
            return [];
          });

          setCompareRawData(mergeQueryCounts(compareResult.compareRows, compareQueryRows))
        })
        .catch(err => {
          const friendlyMessage = getFriendlyOverviewError(err.message)
          if (friendlyMessage === err.message) {
            console.error("Failed to fetch GSC overview data:", err)
          }
          setError(friendlyMessage)
        })
        .finally(() => {
          setLoading(false)
        })
  }, [siteUrl, dateRange, isCompareMode, compareDateRange, filterDimension, filterValue, refreshKey, userProfile?.googleConnected, userProfile?.tier, useLiveData])

  const { chartData, summary, compareSummary } = useMemo(() => {
    const effectiveDateRange = getEffectiveGscDateRange(dateRange);
    if (!rawData.length || !effectiveDateRange) {
      return { chartData: [], summary: { clicks: 0, impressions: 0, ctr: 0, queries: 0, position: 0 }, compareSummary: null };
    }

    // Sort ascending by date
    const sortedRows = rawData.filter(getDateKey).sort((a, b) => getDateKey(a).localeCompare(getDateKey(b)));
    const sortedCompareRows = compareRawData.filter(getDateKey).sort((a, b) => getDateKey(a).localeCompare(getDateKey(b)));

    const aggregatedData = new Map<string, { 
      clicks: number, impressions: number, queries: number, querySet: Set<string>, sumPosition: number, count: number,
      compareClicks?: number, compareImpressions?: number, compareQueries?: number, compareQuerySet?: Set<string>, compareSumPosition?: number, compareCount?: number
    }>();

    let totalClicks = 0;
    let totalImpressions = 0;
    let totalQueries = 0;
    const totalQuerySet = new Set<string>();
    let sumPositionTotal = 0;

    let compareTotalClicks = 0;
    let compareTotalImpressions = 0;
    let compareTotalQueries = 0;
    const compareTotalQuerySet = new Set<string>();
    let compareSumPositionTotal = 0;

    // Use exact daily boundaries from the date picker to avoid timezone shifting
    const startPrimaryExact = parseISO(format(effectiveDateRange.from, 'yyyy-MM-dd'));
    const endPrimaryExact = parseISO(format(effectiveDateRange.to, 'yyyy-MM-dd'));
    
    // Generate all exact days in the range to ensure continuous chart
    // We use eachDayOfInterval from date-fns since it creates exact day bumps
    const allPrimaryDates = [];
    let curr = startPrimaryExact;
    while (curr <= endPrimaryExact) {
      allPrimaryDates.push(curr);
      curr = new Date(curr.getTime() + 24 * 60 * 60 * 1000);
    }
    
    const keysArray: string[] = [];

    const getBucketKey = (date: Date) => {
      if (timeframe === 'Day') return format(date, 'MMM d, yyyy');
      if (timeframe === 'Week') return format(startOfWeek(date), 'MMM d, yyyy');
      return format(startOfMonth(date), 'MMM yyyy');
    };

    const ensureBucket = (key: string) => {
      if (!aggregatedData.has(key)) {
        aggregatedData.set(key, {
          clicks: 0,
          impressions: 0,
          queries: 0,
          querySet: new Set<string>(),
          sumPosition: 0,
          count: 0,
          compareClicks: 0,
          compareImpressions: 0,
          compareQueries: 0,
          compareQuerySet: new Set<string>(),
          compareSumPosition: 0,
          compareCount: 0,
        });
        keysArray.push(key);
      }

      return aggregatedData.get(key);
    };

    // Daily charts benefit from visible zero days. Weekly/monthly charts should not
    // manufacture empty edge buckets, because that creates false drops to zero.
    allPrimaryDates.forEach(date => {
      if (timeframe === 'Day') ensureBucket(getBucketKey(date));
    });

    // Process primary data
    sortedRows.forEach((row) => {
      const rowDate = getDateKey(row);
      if (!rowDate) return;

      const date = parseISO(rowDate);
      const key = getBucketKey(date);
      const queryKeys = Array.isArray(row.queryKeys) ? row.queryKeys.filter(Boolean) : [];

      const current = ensureBucket(key);
      if (current) {
        const clicks = toFiniteNumber(row.clicks);
        const impressions = toFiniteNumber(row.impressions);
        const position = toFiniteNumber(row.position);
        current.clicks += clicks;
        current.impressions += impressions;
        if (queryKeys.length > 0) {
          queryKeys.forEach((query: string) => current.querySet.add(query));
        } else {
          current.queries += Number(row.queryCount) || 0;
        }
        current.sumPosition += (position * impressions);
        current.count += 1;
      }

      const clicks = toFiniteNumber(row.clicks);
      const impressions = toFiniteNumber(row.impressions);
      const position = toFiniteNumber(row.position);
      totalClicks += clicks;
      totalImpressions += impressions;
      if (queryKeys.length > 0) {
        queryKeys.forEach((query: string) => totalQuerySet.add(query));
      } else {
        totalQueries += Number(row.queryCount) || 0;
      }
      sumPositionTotal += (position * impressions);
    });

    // Process compare data and align by precise logical day offset
    if (isCompareMode && sortedCompareRows.length > 0 && compareDateRange?.from) {
      const startCompareExact = parseISO(format(compareDateRange.from, 'yyyy-MM-dd'));
      
      sortedCompareRows.forEach((row) => {
        const rowDate = getDateKey(row);
        if (!rowDate) return;

        const date = parseISO(rowDate);
        // Difference measured in whole days
        const offset = Math.round((date.getTime() - startCompareExact.getTime()) / (24 * 60 * 60 * 1000));
        
        // If the offset falls cleanly into our chart array length, match it up
        if (offset >= 0 && offset < keysArray.length) {
          const targetDate = new Date(startPrimaryExact.getTime() + offset * 24 * 60 * 60 * 1000);
          const key = getBucketKey(targetDate);
          const current = aggregatedData.get(key);
          if (current) {
            const queryKeys = Array.isArray(row.queryKeys) ? row.queryKeys.filter(Boolean) : [];
            const clicks = toFiniteNumber(row.clicks);
            const impressions = toFiniteNumber(row.impressions);
            const position = toFiniteNumber(row.position);
            current.compareClicks = (current.compareClicks || 0) + clicks;
            current.compareImpressions = (current.compareImpressions || 0) + impressions;
            if (queryKeys.length > 0) {
              if (!current.compareQuerySet) current.compareQuerySet = new Set<string>();
              queryKeys.forEach((query: string) => current.compareQuerySet?.add(query));
            } else {
              current.compareQueries = (current.compareQueries || 0) + (Number(row.queryCount) || 0);
            }
            current.compareSumPosition = (current.compareSumPosition || 0) + (position * impressions);
            current.compareCount = (current.compareCount || 0) + 1;
          }
        }

        const clicks = toFiniteNumber(row.clicks);
        const impressions = toFiniteNumber(row.impressions);
        const position = toFiniteNumber(row.position);
        compareTotalClicks += clicks;
        compareTotalImpressions += impressions;
        const queryKeys = Array.isArray(row.queryKeys) ? row.queryKeys.filter(Boolean) : [];
        if (queryKeys.length > 0) {
          queryKeys.forEach((query: string) => compareTotalQuerySet.add(query));
        } else {
          compareTotalQueries += Number(row.queryCount) || 0;
        }
        compareSumPositionTotal += (position * impressions);
      });
    }

    const finalChartData = Array.from(aggregatedData.entries()).map(([date, data]) => ({
      date,
      clicks: data.clicks,
      impressions: data.impressions,
      ctr: data.impressions > 0 ? (data.clicks / data.impressions) * 100 : 0,
      queries: data.querySet.size > 0 ? data.querySet.size : data.queries,
      position: data.impressions > 0 ? data.sumPosition / data.impressions : 0,
      ...(isCompareMode ? {
        compareClicks: data.compareClicks || 0,
        compareImpressions: data.compareImpressions || 0,
        compareCtr: data.compareImpressions && data.compareImpressions > 0 ? ((data.compareClicks || 0) / data.compareImpressions) * 100 : 0,
        compareQueries: data.compareQuerySet && data.compareQuerySet.size > 0 ? data.compareQuerySet.size : data.compareQueries || 0,
        comparePosition: data.compareImpressions && data.compareImpressions > 0 ? (data.compareSumPosition || 0) / data.compareImpressions : 0,
      } : {})
    }));

    return {
      chartData: finalChartData,
      summary: {
        clicks: totalClicks,
        impressions: totalImpressions,
        ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
        queries: totalQuerySet.size > 0 ? totalQuerySet.size : totalQueries,
        position: totalImpressions > 0 ? sumPositionTotal / totalImpressions : 0
      },
      compareSummary: isCompareMode ? {
        clicks: compareTotalClicks,
        impressions: compareTotalImpressions,
        ctr: compareTotalImpressions > 0 ? (compareTotalClicks / compareTotalImpressions) * 100 : 0,
        queries: compareTotalQuerySet.size > 0 ? compareTotalQuerySet.size : compareTotalQueries,
        position: compareTotalImpressions > 0 ? compareSumPositionTotal / compareTotalImpressions : 0
      } : null
    };
  }, [rawData, compareRawData, timeframe, isCompareMode, dateRange, compareDateRange]);

  const toggleMetric = (metric: MetricKey) => {
    setActiveMetrics(prev => ({
      ...prev,
      [metric]: !prev[metric]
    }))
  }

  const exportChartCsv = () => {
    if (chartData.length === 0) return;

    const headers = ["date", "clicks", "impressions", "ctr", "queries", "position"];
    const csvRows = chartData.map((row) =>
      headers.map((header) => {
        const value = row[header as keyof typeof row] ?? "";
        return `"${String(value).replace(/"/g, '""')}"`;
      }).join(","),
    );
    const blob = new Blob([[headers.join(","), ...csvRows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `performance-over-time-${siteUrl.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const scrollToFullReport = () => {
    document.getElementById("gsc-data-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const metricOrder = (hasQueryMetric
    ? ['clicks', 'impressions', 'ctr', 'queries', 'position']
    : ['clicks', 'impressions', 'ctr', 'position']) as MetricKey[];
  const activeMetricsList = metricOrder.filter(m => activeMetrics[m]);

  const getAxisProps = (metric: MetricKey) => {
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

  const getChange = (current: number, previous: number, inverse: boolean = false) => {
    if (!isCompareMode || !compareSummary || previous === 0) return null;

    const diff = current - previous;
    const percentChange = (diff / previous) * 100;
    let isPositive = diff > 0;
    if (inverse) isPositive = !isPositive;

    return {
      diff,
      isPositive,
      label: `${diff > 0 ? "+" : ""}${percentChange.toFixed(1)}%`,
    };
  };

  const getMetricSeries = (metric: MetricKey) => chartData.map((point) => Number(point[metric]) || 0);

  const buildSparklinePath = (values: number[]) => {
    if (values.length < 2) return { line: "", area: "" };

    const width = 116;
    const height = 42;
    const padding = 3;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const spread = max - min || 1;

    const points = values.map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = padding + (1 - (value - min) / spread) * (height - padding * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });

    return {
      line: points.join(" "),
      area: `0,${height} ${points.join(" ")} ${width},${height}`,
    };
  };

  const miniSparkline = (metric: MetricKey, color: string) => {
    const { line, area } = buildSparklinePath(getMetricSeries(metric));
    if (!line) {
      return <div className="h-10 w-24 rounded-lg bg-[#F8FAF9]" />;
    }

    return (
      <svg viewBox="0 0 116 42" className="h-10 w-24" aria-hidden="true">
        <polygon points={area} fill={color} opacity="0.08" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  };

  const effectiveSummaryDateRange = getEffectiveGscDateRange(dateRange);
  const isInitialLoading = loading && rawData.length === 0;
  const selectedDayCount = effectiveSummaryDateRange
    ? Math.max(1, differenceInCalendarDays(effectiveSummaryDateRange.to, effectiveSummaryDateRange.from) + 1)
    : Math.max(1, chartData.length);
  const formatRate = (value: number) => `${formatCompactNumber(value)}/day`;

  const formatCompareRange = () => {
    if (!isCompareMode || !compareDateRange?.from || !compareDateRange?.to) {
      return null;
    }

    return `vs ${format(compareDateRange.from, "MMM d")} - ${format(compareDateRange.to, "MMM d")}`;
  };

  const compareLabel = formatCompareRange();

  const metricCards = [
    {
      key: "clicks" as const,
      title: "Total Clicks",
      value: formatCompactNumber(summary.clicks),
      color: colors.clicks,
      suffix: formatRate(summary.clicks / selectedDayCount),
      change: compareSummary ? getChange(summary.clicks, compareSummary.clicks) : null,
    },
    {
      key: "impressions" as const,
      title: "Total Impressions",
      value: formatCompactNumber(summary.impressions),
      color: colors.impressions,
      suffix: formatRate(summary.impressions / selectedDayCount),
      change: compareSummary ? getChange(summary.impressions, compareSummary.impressions) : null,
    },
    {
      key: "ctr" as const,
      title: "Average CTR",
      value: `${summary.ctr.toFixed(1)}%`,
      color: colors.ctr,
      suffix: compareSummary ? `vs ${compareSummary.ctr.toFixed(1)}%` : `${summary.ctr.toFixed(1)}%`,
      change: compareSummary ? getChange(summary.ctr, compareSummary.ctr) : null,
    },
    ...(hasQueryMetric ? [{
      key: "queries" as const,
      title: "Visible Queries",
      value: formatCompactNumber(summary.queries),
      color: colors.queries,
      suffix: formatRate(summary.queries / selectedDayCount),
      change: compareSummary ? getChange(summary.queries, compareSummary.queries) : null,
    }] : []),
    {
      key: "position" as const,
      title: "Average Position",
      value: summary.position.toFixed(1),
      color: colors.position,
      suffix: compareSummary ? `vs ${compareSummary.position.toFixed(1)}` : summary.position.toFixed(1),
      change: compareSummary ? getChange(summary.position, compareSummary.position, true) : null,
      inverse: true,
    },
  ];

  const getAnnotationXParam = (dateString: string) => {
    if (timeframe !== "Day") {
      return getChartXParam(dateString);
    }

    try {
      return format(parseISO(dateString), "MMM d, yyyy");
    } catch {
      return "";
    }
  };

  const getVisibleAnnotations = () => {
    const visibleDates = new Set(chartData.map((point) => point.date));
    return annotations.filter((annotation) => visibleDates.has(getAnnotationXParam(annotation.date)));
  };

  const visibleAnnotations = getVisibleAnnotations();
  const annotationOffsets = useMemo(() => {
    const offsets = new Map<string, number>();
    const sorted = [...visibleAnnotations].sort((a, b) => a.date.localeCompare(b.date));
    const recentDates: string[] = [];

    sorted.forEach((annotation) => {
      const date = annotation.date;
      const nearbyCount = recentDates.filter((existingDate) => {
        try {
          return Math.abs(differenceInCalendarDays(parseISO(date), parseISO(existingDate))) <= 4;
        } catch {
          return existingDate === date;
        }
      }).length;

      offsets.set(annotation.id, nearbyCount % 4);
      recentDates.push(date);
      if (recentDates.length > 8) recentDates.shift();
    });

    return offsets;
  }, [visibleAnnotations]);

  const getPrimaryAxisId = () => activeMetricsList[0] || "clicks";

  const renderMetricCompare = (metric: (typeof metricCards)[number]) => {
    if (!metric.change || !compareLabel) {
      return <span className="text-[#647067]">Current period</span>;
    }

    return (
      <>
        <span className={metric.change.isPositive ? "text-[#16A34A]" : "text-red-500"}>
          {metric.change.isPositive ? "↑" : "↓"} {metric.change.label.replace("+", "")}
        </span>
        <span className="text-[#647067]">{compareLabel}</span>
      </>
    );
  };

  return (
    <div className="space-y-6">
      {!isConnectionIssue && error && (
        <div className="rounded-2xl border border-red-200 bg-red-50/90 p-4 text-sm text-red-600 shadow-[0_10px_24px_rgba(127,29,29,0.05)] dark:border-red-900/50 dark:bg-red-950/35 dark:text-red-200">
          {error}
        </div>
      )}
      <div className={cn("grid gap-4 md:grid-cols-2", hasQueryMetric ? "xl:grid-cols-5" : "xl:grid-cols-4")}>
        {metricCards.map((metric) => (
          <button
            key={metric.key}
            onClick={() => toggleMetric(metric.key)}
            className={cn(
              "rounded-2xl border border-border bg-card p-4 text-left shadow-[0_10px_24px_rgba(15,61,46,0.045)] transition hover:-translate-y-0.5 hover:border-border/80 hover:shadow-[0_14px_30px_rgba(15,61,46,0.065)]",
              activeMetrics[metric.key] && "border-border ring-1 ring-inset ring-secondary"
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <span className="flex h-4 w-4 items-center justify-center rounded-[4px]" style={{ backgroundColor: metric.color }}>
                    {activeMetrics[metric.key] && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                  </span>
                  {metric.title}
                  <Info className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="mt-4 text-3xl font-semibold text-foreground">
                  {isInitialLoading ? <span className="block h-8 w-20 animate-pulse rounded-xl bg-muted" /> : metric.value}
                </div>
              </div>
              {miniSparkline(metric.key, metric.color)}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs">
              {renderMetricCompare(metric)}
              <span className="ml-auto rounded-md px-2 py-1 text-xs" style={{ color: metric.color, backgroundColor: `${metric.color}12` }}>
                {metric.suffix}
              </span>
            </div>
          </button>
        ))}
      </div>

      <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="p-5">
          <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-foreground">Performance Over Time</h3>
              <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                {metricCards
                  .filter((metric) => activeMetrics[metric.key])
                  .map((metric) => (
                    <span key={metric.key} className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: metric.color }} />
                      {metric.title.replace("Total ", "").replace("Average ", "")}
                    </span>
                  ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border border-border bg-background p-1">
              {(['Day', 'Week', 'Month'] as const).map((t) => (
                <button 
                  key={t}
                  onClick={() => setTimeframe(t)}
                  className={cn(
                    "h-8 px-5 text-xs font-medium rounded-md transition-colors",
                    timeframe === t ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t}
                </button>
              ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-9 rounded-lg border-border bg-card"
                disabled={chartData.length === 0}
                onClick={exportChartCsv}
              >
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
              <Button variant="outline" size="icon" className="h-9 w-9 rounded-lg border-border bg-card" disabled>
                <MoreVertical className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Chart */}
          {isInitialLoading ? (
            <div className="h-[320px] w-full rounded-2xl bg-background p-6">
              <div className="relative h-full overflow-hidden rounded-xl border border-border bg-card">
                <div className="absolute inset-x-0 top-[18%] h-px bg-border" />
                <div className="absolute inset-x-0 top-[42%] h-px bg-border" />
                <div className="absolute inset-x-0 top-[66%] h-px bg-border" />
                <div className="absolute bottom-8 left-8 right-8 h-24 animate-pulse rounded-[60%_42%_0_0] bg-gradient-to-t from-primary/15 to-transparent" />
                <div className="absolute bottom-12 left-16 right-16 h-28 animate-pulse rounded-[42%_60%_0_0] bg-gradient-to-t from-secondary/40 to-transparent [animation-delay:120ms]" />
                <div className="absolute left-6 top-6 h-4 w-16 animate-pulse rounded-full bg-muted" />
                <div className="absolute right-6 top-6 h-4 w-20 animate-pulse rounded-full bg-muted" />
              </div>
            </div>
          ) : (
            <div className="h-[320px] min-w-0 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 18, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="color_clicks" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.clicks} stopOpacity={0.26}/>
                      <stop offset="95%" stopColor={colors.clicks} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_impressions" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.impressions} stopOpacity={0.24}/>
                      <stop offset="95%" stopColor={colors.impressions} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_ctr" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.ctr} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.ctr} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_queries" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.queries} stopOpacity={0.14}/>
                      <stop offset="95%" stopColor={colors.queries} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="color_position" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.position} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={colors.position} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid 
                    vertical={false} 
                    stroke="var(--border)"
                    yAxisId={getPrimaryAxisId()}
                  />
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
                  {hasQueryMetric && activeMetrics.queries && (
                    <>
                      <Area
                        yAxisId="queries"
                        type="monotone"
                        dataKey="queries"
                        name="Visible Queries"
                        stroke={colors.queries}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#color_queries)"
                        activeDot={{ r: 6 }}
                      />
                      {isCompareMode && (
                        <Line
                          yAxisId="queries"
                          type="monotone"
                          dataKey="compareQueries"
                          name="Compare Visible Queries"
                          stroke={colors.queries}
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
                        baseValue="dataMax"
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
                  {hasQueryMetric && activeMetrics.queries && (
                    <YAxis
                      yAxisId="queries"
                      orientation={getAxisProps('queries').orientation}
                      mirror={getAxisProps('queries').mirror}
                      hide={getAxisProps('queries').hide}
                      tickFormatter={formatCompactNumber}
                      axisLine={false}
                      tickLine={false}
                      tickCount={5}
                      domain={[0, 'auto']}
                      tick={<CustomYAxisTick fill={colors.queries} formatter={formatCompactNumber} />}
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

                  {visibleAnnotations.map(ann => (
                    <ReferenceLine
                      key={ann.id}
                      yAxisId={getPrimaryAxisId()}
                      x={getAnnotationXParam(ann.date)}
                      stroke={ann.type === 'system' ? 'var(--primary)' : '#8b5cf6'}
                      strokeDasharray="4 4"
                      strokeWidth={2}
                      ifOverflow="extendDomain"
                      label={
                        <AnnotationReferenceLabel
                          annotation={ann}
                          fill={ann.type === 'system' ? 'var(--primary)' : '#8b5cf6'}
                          offsetIndex={annotationOffsets.get(ann.id) || 0}
                        />
                      }
                    />
                  ))}

                  <Tooltip 
                    contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--popover)', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    labelStyle={{ fontWeight: 'bold', marginBottom: '4px', color: 'var(--foreground)' }}
                    formatter={(value: number, name: string) => {
                      if (name === 'CTR') return [`${value.toFixed(2)}%`, name];
                      if (name === 'Position') return [value.toFixed(1), name];
                      if (name === 'Visible Queries') return [value.toLocaleString(), name];
                      return [value.toLocaleString(), name];
                    }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
          {annotationControls && (
            <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              {annotationControls}
              <Button variant="ghost" size="sm" className="w-fit text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300" onClick={scrollToFullReport}>
                View full report
                <span className="ml-2">-&gt;</span>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
