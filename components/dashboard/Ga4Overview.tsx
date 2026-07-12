import { useEffect, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/src/contexts/AuthContext"
import { Ga4ApiService, Ga4DataRow } from "@/src/services/ga4Service"
import { format, parseISO, startOfMonth, startOfWeek } from "date-fns"
import { DateRange } from "react-day-picker"
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Check, Download, Info, Loader2, MoreVertical } from "lucide-react"
import { cn } from "@/lib/utils"
import { Annotation } from "@/src/services/annotationsService"

type MetricKey = "sessions" | "users" | "pageViews" | "bounceRate" | "eventCount"

type ChartPoint = {
  date: string
  sessions: number
  users: number
  pageViews: number
  bounceRate: number
  eventCount: number
  compareSessions?: number
  compareUsers?: number
  comparePageViews?: number
  compareBounceRate?: number
  compareEventCount?: number
}

type WarehouseCoverage = {
  coveredDateCount?: number
  expectedDateCount?: number
  missingDateCount?: number
  activeDateCount?: number
  activeJobCount?: number
  queuedDateCount?: number
}

const formatCompactNumber = (number: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(number)

const CustomYAxisTick = (props: any) => {
  const { x, y, payload, fill, formatter, textAnchor } = props
  const text = formatter ? formatter(payload.value) : payload.value

  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={-10}
        textAnchor={textAnchor}
        fontSize={12}
        fontWeight="500"
        stroke="white"
        strokeWidth={4}
        strokeLinejoin="round"
        style={{ paintOrder: "stroke" }}
      >
        {text}
      </text>
      <text x={0} y={-10} textAnchor={textAnchor} fill={fill} fontSize={12} fontWeight="500">
        {text}
      </text>
    </g>
  )
}

const getGa4DimensionValue = (row: any, index = 0) => {
  const value = row?.dimensionValues?.[index]?.value
  return typeof value === "string" ? value : ""
}

const parseGa4DateStr = (value: string) => {
  if (!value) return null
  if (value.includes("-")) {
    const parsed = parseISO(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  if (value.length < 8) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  return new Date(year, month - 1, day)
}

const getBucketKey = (date: Date, timeframe: "Day" | "Week" | "Month") => {
  if (timeframe === "Week") return format(startOfWeek(date), "MMM d, yyyy")
  if (timeframe === "Month") return format(startOfMonth(date), "MMM yyyy")
  return format(date, "MMM d, yyyy")
}

const getChartXParam = (dateString: string, timeframe: "Day" | "Week" | "Month") => {
  try {
    const date = parseISO(dateString)
    return getBucketKey(date, timeframe)
  } catch {
    return ""
  }
}

const getAnnotationLabel = (annotation: Annotation) =>
  annotation.type === "system" ? "Google update" : annotation.title

const getAnnotationTooltip = (annotation: Annotation) => {
  const date = (() => {
    try {
      return format(parseISO(annotation.date), "MMM d, yyyy")
    } catch {
      return annotation.date
    }
  })()

  return [getAnnotationLabel(annotation), annotation.title, date, annotation.description]
    .filter(Boolean)
    .join("\n")
}

function AnnotationReferenceLabel(props: any) {
  const { annotation, fill, offsetIndex = 0, viewBox, x, y } = props
  const labelX = Number(x ?? viewBox?.x ?? 0) + 6
  const labelY = Math.max(12, Number(y ?? viewBox?.y ?? 0) + 12 + offsetIndex * 16)

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
      <text x={labelX} y={labelY} fill={fill} fontSize={11} fontWeight={700}>
        {getAnnotationLabel(annotation)}
      </text>
    </g>
  )
}

export function Ga4Overview({
  siteUrl,
  workspaceSiteUrl,
  dateRange,
  isCompareMode,
  compareDateRange,
  filterDimension,
  filterValue,
  annotations = [],
  refreshKey = 0,
}: {
  siteUrl: string
  workspaceSiteUrl?: string
  dateRange?: DateRange
  isCompareMode?: boolean
  compareDateRange?: DateRange
  filterDimension?: string
  filterValue?: string
  annotations?: Annotation[]
  refreshKey?: number
}) {
  const { userProfile } = useAuth()
  const [data, setData] = useState<Ga4DataRow[]>([])
  const [compareData, setCompareData] = useState<Ga4DataRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<WarehouseCoverage | null>(null)
  const [pollKey, setPollKey] = useState(0)

  const [activeMetrics, setActiveMetrics] = useState<Record<MetricKey, boolean>>({
    sessions: true,
    users: true,
    pageViews: false,
    bounceRate: false,
    eventCount: false,
  })
  const [timeframe, setTimeframe] = useState<"Day" | "Week" | "Month">("Day")

  const colors = {
    sessions: "#2F7DF6",
    users: "#7C3AED",
    pageViews: "#0891B2",
    bounceRate: "#F97316",
    eventCount: "#DB2777",
  }

  useEffect(() => {
    if (!userProfile?.googleConnected || !siteUrl || !dateRange?.from || !dateRange?.to) return
    const controller = new AbortController()
    let isCurrent = true

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const ga4Service = new Ga4ApiService()
        const startDate = format(dateRange.from!, "yyyy-MM-dd")
        const endDate = format(dateRange.to!, "yyyy-MM-dd")
        const dimensionFilter = filterDimension && filterValue ? { filterDimension, filterValue } : undefined
        const metrics = ["sessions", "totalUsers", "screenPageViews", "bounceRate", "eventCount"]

        const reportOptions = { signal: controller.signal, siteUrl: workspaceSiteUrl }
        const primaryResult = await ga4Service.runReport(siteUrl, startDate, endDate, ["date"], metrics, dimensionFilter, reportOptions)
        if (!isCurrent) return
        setData(primaryResult.rows || [])
        setCompareData([])
        setCoverage(primaryResult?.metadata?.coverage || null)

        if (isCompareMode && compareDateRange?.from && compareDateRange?.to) {
          try {
            const compareStartDate = format(compareDateRange.from, "yyyy-MM-dd")
            const compareEndDate = format(compareDateRange.to, "yyyy-MM-dd")
            const compareResult = await ga4Service.runReport(siteUrl, compareStartDate, compareEndDate, ["date"], metrics, dimensionFilter, reportOptions)
            if (!isCurrent) return
            setCompareData(compareResult.rows || [])
          } catch (compareError: any) {
            if (!isCurrent || compareError?.name === "AbortError") return
            console.warn("GA4 compare chart is not ready yet; showing primary chart data.", compareError)
          }
        }
      } catch (err: any) {
        if (!isCurrent || err?.name === "AbortError") return
        console.error("Error fetching GA4 stats:", err)
        if (err.message === "UNAUTHORIZED") {
          setError("Your session expired. Sign in again to load stored Analytics data.")
        } else if (err.message === "Failed to fetch") {
          setError("Network error: Unable to load the stored Analytics overview right now.")
        } else if (/not warehoused|being prepared|not ready|history import|stored warehouse/i.test(err.message)) {
          setError("Analytics data is still updating for this overview. Existing stored rows stay available while the background import catches up.")
        } else {
          setError(err.message)
        }
      } finally {
        if (isCurrent) setLoading(false)
      }
    }

    fetchData()
    return () => {
      isCurrent = false
      controller.abort()
    }
  }, [siteUrl, workspaceSiteUrl, dateRange, isCompareMode, compareDateRange, filterDimension, filterValue, userProfile?.googleConnected, pollKey, refreshKey])


  useEffect(() => {
    if (!coverage || loading) return
    const hasWarehouseWork =
      Number(coverage.activeJobCount || 0) > 0 ||
      Number(coverage.activeDateCount || 0) > 0 ||
      Number(coverage.queuedDateCount || 0) > 0 ||
      Number(coverage.missingDateCount || 0) > 0
    if (!hasWarehouseWork) return

    const timeout = window.setTimeout(() => setPollKey((value) => value + 1), 10000)
    return () => window.clearTimeout(timeout)
  }, [coverage, loading])
  const { chartData, summary, compareSummary } = useMemo(() => {
    if (!data.length || !dateRange?.from || !dateRange?.to) {
      return {
        chartData: [] as ChartPoint[],
        summary: { sessions: 0, users: 0, pageViews: 0, bounceRate: 0, eventCount: 0, count: 0 },
        compareSummary: null as null | { sessions: number; users: number; pageViews: number; bounceRate: number; eventCount: number; count: number },
      }
    }

    const aggregate = new Map<string, ChartPoint>()
    const startPrimaryExact = parseISO(format(dateRange.from, "yyyy-MM-dd"))
    const endPrimaryExact = parseISO(format(dateRange.to, "yyyy-MM-dd"))
    const allPrimaryDates: Date[] = []
    let cursor = startPrimaryExact
    while (cursor <= endPrimaryExact) {
      allPrimaryDates.push(cursor)
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
    }

    const keysArray: string[] = []
    allPrimaryDates.forEach((date) => {
      const key = getBucketKey(date, timeframe)
      keysArray.push(key)
      if (!aggregate.has(key)) {
        aggregate.set(key, {
          date: key,
          sessions: 0,
          users: 0,
          pageViews: 0,
          bounceRate: 0,
          eventCount: 0,
        })
      }
    })

    const sortRows = (rows: Ga4DataRow[]) =>
      rows
        .filter((row) => getGa4DimensionValue(row))
        .sort((a, b) => getGa4DimensionValue(a).localeCompare(getGa4DimensionValue(b)))

    let totalSessions = 0
    let totalUsers = 0
    let totalPageViews = 0
    let totalBounceRate = 0
    let totalEventCount = 0
    let count = 0

    let compareTotalSessions = 0
    let compareTotalUsers = 0
    let compareTotalPageViews = 0
    let compareTotalBounceRate = 0
    let compareTotalEventCount = 0
    let compareCount = 0

    const primaryRows = sortRows(data)

    primaryRows.forEach((row) => {
      const dateValue = getGa4DimensionValue(row)
      const parsedDate = parseGa4DateStr(dateValue)
      if (!parsedDate) return

      const key = getBucketKey(parsedDate, timeframe)
      const current = aggregate.get(key)
      if (!current) return

      const sessions = Number(row.metricValues[0]?.value || 0)
      const users = Number(row.metricValues[1]?.value || 0)
      const pageViews = Number(row.metricValues[2]?.value || 0)
      const bounceRate = Number(row.metricValues[3]?.value || 0) * 100
      const eventCount = Number(row.metricValues[4]?.value || 0)

      current.sessions += sessions
      current.users += users
      current.pageViews += pageViews
      current.bounceRate += bounceRate
      current.eventCount += eventCount

      totalSessions += sessions
      totalUsers += users
      totalPageViews += pageViews
      totalBounceRate += bounceRate
      totalEventCount += eventCount
      count += 1
    })

    if (isCompareMode && compareData.length > 0 && compareDateRange?.from) {
      const compareStartExact = parseISO(format(compareDateRange.from, "yyyy-MM-dd"))
      const compareRows = sortRows(compareData)

      compareRows.forEach((row) => {
        const dateValue = getGa4DimensionValue(row)
        const parsedDate = parseGa4DateStr(dateValue)
        if (!parsedDate) return

        const offset = Math.round((parsedDate.getTime() - compareStartExact.getTime()) / (24 * 60 * 60 * 1000))
        if (offset < 0 || offset >= keysArray.length) return

        const targetKey = keysArray[offset]
        const current = aggregate.get(targetKey)
        if (!current) return

        const sessions = Number(row.metricValues[0]?.value || 0)
        const users = Number(row.metricValues[1]?.value || 0)
        const pageViews = Number(row.metricValues[2]?.value || 0)
        const bounceRate = Number(row.metricValues[3]?.value || 0) * 100
        const eventCount = Number(row.metricValues[4]?.value || 0)

        current.compareSessions = (current.compareSessions || 0) + sessions
        current.compareUsers = (current.compareUsers || 0) + users
        current.comparePageViews = (current.comparePageViews || 0) + pageViews
        current.compareBounceRate = (current.compareBounceRate || 0) + bounceRate
        current.compareEventCount = (current.compareEventCount || 0) + eventCount

        compareTotalSessions += sessions
        compareTotalUsers += users
        compareTotalPageViews += pageViews
        compareTotalBounceRate += bounceRate
        compareTotalEventCount += eventCount
        compareCount += 1
      })
    }

    return {
      chartData: Array.from(aggregate.values()),
      summary: {
        sessions: totalSessions,
        users: totalUsers,
        pageViews: totalPageViews,
        bounceRate: count > 0 ? totalBounceRate / count : 0,
        eventCount: totalEventCount,
        count,
      },
      compareSummary: isCompareMode
        ? {
            sessions: compareTotalSessions,
            users: compareTotalUsers,
            pageViews: compareTotalPageViews,
            bounceRate: compareCount > 0 ? compareTotalBounceRate / compareCount : 0,
            eventCount: compareTotalEventCount,
            count: compareCount,
          }
        : null,
    }
  }, [data, compareData, dateRange, compareDateRange, isCompareMode, timeframe])

  const selectedDayCount = dateRange?.from && dateRange?.to
    ? Math.max(1, Math.round((dateRange.to.getTime() - dateRange.from.getTime()) / (24 * 60 * 60 * 1000)) + 1)
    : Math.max(1, chartData.length)

  const compareLabel = isCompareMode && compareDateRange?.from && compareDateRange?.to
    ? `vs ${format(compareDateRange.from, "MMM d")} - ${format(compareDateRange.to, "MMM d")}`
    : null

  const toggleMetric = (metric: MetricKey) => {
    setActiveMetrics((prev) => ({
      ...prev,
      [metric]: !prev[metric],
    }))
  }

  const activeCountMetrics = (["sessions", "users", "pageViews", "eventCount"] as MetricKey[]).filter(
    (metric) => activeMetrics[metric] && metric !== "bounceRate",
  )
  const showBounceRate = activeMetrics.bounceRate

  const getChange = (current: number, previous: number | undefined, inverse = false) => {
    if (!compareSummary || previous === undefined || previous === 0) return null
    const diff = current - previous
    if (diff === 0) return null
    let isPositive = diff > 0
    if (inverse) isPositive = !isPositive
    const percentChange = (diff / previous) * 100
    return {
      isPositive,
      label: `${diff > 0 ? "+" : ""}${percentChange.toFixed(1)}%`,
    }
  }

  const renderMetricCompare = (metric: {
    key: MetricKey
    change?: ReturnType<typeof getChange> | null
  }) => {
    if (!metric.change || !compareLabel) {
      return <span className="text-muted-foreground">Current period</span>
    }

    return (
      <>
        <span className={metric.change.isPositive ? "text-emerald-500" : "text-red-500"}>{metric.change.label}</span>
        <span className="text-muted-foreground">{compareLabel}</span>
      </>
    )
  }

  const metricCards = [
    {
      key: "sessions" as const,
      title: "Total Sessions",
      value: formatCompactNumber(summary.sessions),
      color: colors.sessions,
      suffix: `${formatCompactNumber(summary.sessions / selectedDayCount)}/day`,
      change: compareSummary ? getChange(summary.sessions, compareSummary.sessions) : null,
    },
    {
      key: "users" as const,
      title: "Total Users",
      value: formatCompactNumber(summary.users),
      color: colors.users,
      suffix: `${formatCompactNumber(summary.users / selectedDayCount)}/day`,
      change: compareSummary ? getChange(summary.users, compareSummary.users) : null,
    },
    {
      key: "pageViews" as const,
      title: "Page Views",
      value: formatCompactNumber(summary.pageViews),
      color: colors.pageViews,
      suffix: `${formatCompactNumber(summary.pageViews / selectedDayCount)}/day`,
      change: compareSummary ? getChange(summary.pageViews, compareSummary.pageViews) : null,
    },
    {
      key: "bounceRate" as const,
      title: "Bounce Rate",
      value: `${summary.bounceRate.toFixed(2)}%`,
      color: colors.bounceRate,
      suffix: "Rate",
      change: compareSummary ? getChange(summary.bounceRate, compareSummary.bounceRate, true) : null,
    },
    {
      key: "eventCount" as const,
      title: "Event Count",
      value: formatCompactNumber(summary.eventCount),
      color: colors.eventCount,
      suffix: `${formatCompactNumber(summary.eventCount / selectedDayCount)}/day`,
      change: compareSummary ? getChange(summary.eventCount, compareSummary.eventCount) : null,
    },
  ]

  const visibleAnnotations = useMemo(() => {
    const visibleDates = new Set(chartData.map((point) => point.date))
    return annotations.filter((annotation) => visibleDates.has(getChartXParam(annotation.date, timeframe)))
  }, [annotations, chartData, timeframe])

  const annotationOffsets = useMemo(() => {
    const offsets = new Map<string, number>()
    const sorted = [...visibleAnnotations].sort((a, b) => a.date.localeCompare(b.date))
    const recentDates: string[] = []

    sorted.forEach((annotation) => {
      const date = annotation.date
      const nearbyCount = recentDates.filter((existingDate) => {
        try {
          return Math.abs((parseISO(date).getTime() - parseISO(existingDate).getTime()) / (24 * 60 * 60 * 1000)) <= 4
        } catch {
          return false
        }
      }).length

      offsets.set(annotation.id, nearbyCount)
      recentDates.push(date)
      if (recentDates.length > 8) recentDates.shift()
    })

    return offsets
  }, [visibleAnnotations])

  const hasActiveWarehouseWork =
    Number(coverage?.activeJobCount || 0) > 0 ||
    Number(coverage?.activeDateCount || 0) > 0 ||
    Number(coverage?.queuedDateCount || 0) > 0

  if (loading && data.length === 0) {
    return (
      <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="flex h-[400px] flex-col items-center justify-center gap-3 px-6 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Loading Analytics report</h3>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Checking stored rows for this property and workspace site.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error && data.length === 0) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50/90 p-4 text-sm text-red-600 shadow-[0_10px_24px_rgba(127,29,29,0.05)] dark:border-red-900/50 dark:bg-red-950/35 dark:text-red-200">
        {error}
      </div>
    )
  }

  if (chartData.length === 0) {
    const missingDateCount = Number(coverage?.missingDateCount || 0)
    const expectedDateCount = Number(coverage?.expectedDateCount || 0)
    const coveredDateCount = Number(coverage?.coveredDateCount || 0)

    return (
      <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center">
          <div className="mb-4 rounded-full bg-secondary p-3 text-primary">
            <Info className="h-5 w-5" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">
            {missingDateCount > 0 ? "Analytics data is updating" : "No GA4 activity found for this range"}
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {missingDateCount > 0
              ? `${coveredDateCount.toLocaleString()} / ${expectedDateCount.toLocaleString()} days are ready for this property and workspace site. Missing days are queued in the background.`
              : "The selected GA4 property and workspace site have no stored Analytics rows for this date range."}
          </p>
          {hasActiveWarehouseWork && (
            <div className="mt-4 inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm font-medium text-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Updating Analytics history
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  const exportChartCsv = () => {
    const headers = ["date", "sessions", "users", "pageViews", "bounceRate", "eventCount"]
    const csvRows = chartData.map((row) =>
      headers.map((header) => {
        const value = row[header as keyof ChartPoint] ?? ""
        return `"${String(value).replace(/"/g, '""')}"`
      }).join(","),
    )
    const blob = new Blob([[headers.join(","), ...csvRows].join("\n")], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `ga4-overview-${format(new Date(), "yyyyMMdd-HHmm")}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      {loading && data.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-[0_12px_32px_rgba(15,61,46,0.035)] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="font-medium text-foreground">Refreshing Analytics overview</span>
          </div>
          <span>Current metrics stay visible while the selected property and site finish loading.</span>
        </div>
      )}

      {!error && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {metricCards.map((metric) => (
            <button
              key={metric.key}
              onClick={() => toggleMetric(metric.key)}
              className={cn(
                "rounded-2xl border border-border bg-card p-4 text-left shadow-[0_10px_24px_rgba(15,61,46,0.045)] transition hover:-translate-y-0.5 hover:border-border/80 hover:shadow-[0_14px_30px_rgba(15,61,46,0.065)]",
                activeMetrics[metric.key] && "border-border ring-1 ring-inset ring-secondary",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <span className="flex h-4 w-4 items-center justify-center rounded-[4px]" style={{ backgroundColor: metric.color }}>
                      {activeMetrics[metric.key] && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                    </span>
                    <span className="truncate">{metric.title}</span>
                    <Info className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="mt-4 text-3xl font-semibold text-foreground">
                    {loading ? <span className="block h-8 w-20 animate-pulse rounded-xl bg-muted" /> : metric.value}
                  </div>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs">
                {renderMetricCompare(metric)}
                <span
                  className="ml-auto rounded-md px-2 py-1 text-xs"
                  style={{ color: metric.color, backgroundColor: `${metric.color}12` }}
                >
                  {metric.suffix}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

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
                      {metric.title}
                    </span>
                  ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border border-border bg-background p-1">
                {(["Day", "Week", "Month"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTimeframe(t)}
                    className={cn(
                      "h-8 rounded-md px-5 text-xs font-medium transition-colors",
                      timeframe === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
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

          {loading ? (
            <div className="flex h-[360px] items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="h-[360px] min-w-0 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 18, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="color_sessions" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.sessions} stopOpacity={0.22} />
                      <stop offset="95%" stopColor={colors.sessions} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="color_users" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.users} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={colors.users} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="color_pageViews" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.pageViews} stopOpacity={0.18} />
                      <stop offset="95%" stopColor={colors.pageViews} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="color_eventCount" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.eventCount} stopOpacity={0.18} />
                      <stop offset="95%" stopColor={colors.eventCount} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="color_bounceRate" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors.bounceRate} stopOpacity={0.18} />
                      <stop offset="95%" stopColor={colors.bounceRate} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
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

                  {visibleAnnotations.map((ann) => (
                    <ReferenceLine
                      key={ann.id}
                      x={getChartXParam(ann.date, timeframe)}
                      stroke={ann.type === "system" ? "var(--primary)" : "#8b5cf6"}
                      strokeDasharray="4 4"
                      strokeWidth={2}
                      ifOverflow="extendDomain"
                      label={
                        <AnnotationReferenceLabel
                          annotation={ann}
                          fill={ann.type === "system" ? "var(--primary)" : "#8b5cf6"}
                          offsetIndex={annotationOffsets.get(ann.id) || 0}
                        />
                      }
                    />
                  ))}

                  {activeCountMetrics.map((metric) => {
                    const commonProps = {
                      yAxisId: "count",
                      type: "monotone" as const,
                      strokeWidth: 2,
                      activeDot: { r: 6 },
                    }

                    if (metric === "sessions") {
                      return (
                        <Area
                          key={metric}
                          dataKey="sessions"
                          name="Sessions"
                          stroke={colors.sessions}
                          fill="url(#color_sessions)"
                          fillOpacity={1}
                          {...commonProps}
                        />
                      )
                    }

                    if (metric === "users") {
                      return (
                        <Area
                          key={metric}
                          dataKey="users"
                          name="Users"
                          stroke={colors.users}
                          fill="url(#color_users)"
                          fillOpacity={1}
                          {...commonProps}
                        />
                      )
                    }

                    if (metric === "pageViews") {
                      return (
                        <Area
                          key={metric}
                          dataKey="pageViews"
                          name="Page Views"
                          stroke={colors.pageViews}
                          fill="url(#color_pageViews)"
                          fillOpacity={1}
                          {...commonProps}
                        />
                      )
                    }

                    return (
                      <Area
                        key={metric}
                        dataKey="eventCount"
                        name="Event Count"
                        stroke={colors.eventCount}
                        fill="url(#color_eventCount)"
                        fillOpacity={1}
                        {...commonProps}
                      />
                    )
                  })}

                  {showBounceRate && (
                    <>
                      <Line
                        yAxisId="bounceRate"
                        type="monotone"
                        dataKey="bounceRate"
                        name="Bounce Rate"
                        stroke={colors.bounceRate}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                      <YAxis
                        yAxisId="bounceRate"
                        orientation="right"
                        mirror={false}
                        hide={false}
                        tickFormatter={(v) => `${v.toFixed(1)}%`}
                        axisLine={false}
                        tickLine={false}
                        tickCount={5}
                        domain={[0, "auto"]}
                        tick={<CustomYAxisTick fill={colors.bounceRate} formatter={(v: number) => `${v.toFixed(1)}%`} />}
                      />
                    </>
                  )}

                  <YAxis
                    yAxisId="count"
                    orientation="left"
                    mirror={false}
                    hide={false}
                    tickFormatter={formatCompactNumber}
                    axisLine={false}
                    tickLine={false}
                    tickCount={5}
                    domain={[0, "auto"]}
                    tick={<CustomYAxisTick fill={colors.sessions} formatter={formatCompactNumber} />}
                  />

                  {isCompareMode && (
                    <>
                      {activeMetrics.sessions && (
                        <Line
                          yAxisId="count"
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
                      {activeMetrics.users && (
                        <Line
                          yAxisId="count"
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
                      {activeMetrics.pageViews && (
                        <Line
                          yAxisId="count"
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
                      {activeMetrics.eventCount && (
                        <Line
                          yAxisId="count"
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
                      {showBounceRate && (
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

                  <Tooltip
                    contentStyle={{
                      borderRadius: "8px",
                      border: "1px solid var(--border)",
                      background: "var(--popover)",
                      boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                    }}
                    labelStyle={{ fontWeight: "bold", marginBottom: "4px", color: "var(--foreground)" }}
                    formatter={(value: number, name: string) => {
                      if (name.includes("Bounce Rate")) return [`${value.toFixed(2)}%`, name]
                      return [value.toLocaleString(), name]
                    }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              className="w-fit text-primary hover:text-primary/80"
              onClick={exportChartCsv}
              disabled={chartData.length === 0}
            >
              View export
              <span className="ml-2">-&gt;</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
