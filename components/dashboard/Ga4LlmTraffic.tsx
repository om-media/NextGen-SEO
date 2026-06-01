import { useEffect, useState, useMemo } from "react"
import { useAuth } from "@/src/contexts/AuthContext"
import { Ga4ApiService } from "@/src/services/ga4Service"
import { format, parseISO } from "date-fns"
import { ArrowDownIcon, ArrowUpIcon, Download, Info } from "lucide-react"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"

import { DateRange } from "react-day-picker"

interface Ga4LlmTrafficProps {
  siteUrl: string;
  dateRange: DateRange;
  isCompareMode: boolean;
  compareDateRange: DateRange;
}

function classifyLlmSource(source: string): string {
  const s = String(source || "").toLowerCase()
  if (s.includes('chatgpt') || s.includes('openai')) return 'ChatGPT'
  if (s.includes('claude') || s.includes('anthropic')) return 'Claude'
  if (s.includes('perplexity')) return 'Perplexity'
  if (s.includes('copilot') || s.includes('bing.com/chat')) return 'Copilot'
  return source
}

const getGa4DimensionValue = (row: any, index = 0) => {
  const value = row?.dimensionValues?.[index]?.value
  return typeof value === "string" ? value : ""
}

function exportCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return
  const headers = Object.keys(rows[0])
  const escape = (value: unknown) => {
    const text = String(value ?? "")
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const csv = [headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((line) => line.map(escape).join(","))
    .join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(url)
}

export function Ga4LlmTraffic({ siteUrl, dateRange, isCompareMode, compareDateRange }: Ga4LlmTrafficProps) {
  const { userProfile } = useAuth()
  const [data, setData] = useState<any>(null)
  const [compareData, setCompareData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const llmFilter = {
    filter: {
      fieldName: "sessionSource",
      stringFilter: {
        value: "chatgpt|openai|claude|anthropic|perplexity|copilot|bing.com/chat",
        matchType: "PARTIAL_REGEXP"
      }
    }
  }

  useEffect(() => {
    if (!userProfile?.googleConnected || !siteUrl || !dateRange.from || !dateRange.to) return
    let isMounted = true

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const ga4Service = new Ga4ApiService()
        const metrics = ['sessions', 'engagedSessions', 'keyEvents', 'averageSessionDuration']

        // Fetch totals
        const totalsData = await ga4Service.runReport(
          siteUrl,
          format(dateRange.from, 'yyyy-MM-dd'),
          format(dateRange.to, 'yyyy-MM-dd'),
          [], // no dimensions for totals
          metrics,
          llmFilter
        )

        // Fetch daily trend
        const dailyData = await ga4Service.runReport(
          siteUrl,
          format(dateRange.from, 'yyyy-MM-dd'),
          format(dateRange.to, 'yyyy-MM-dd'),
          ['date'],
          ['sessions'],
          llmFilter
        )

        // Fetch by source
        const sourceData = await ga4Service.runReport(
          siteUrl,
          format(dateRange.from, 'yyyy-MM-dd'),
          format(dateRange.to, 'yyyy-MM-dd'),
          ['sessionSource'],
          metrics,
          llmFilter
        )

        // Fetch by landing page + source
        const landingPageData = await ga4Service.runReport(
          siteUrl,
          format(dateRange.from, 'yyyy-MM-dd'),
          format(dateRange.to, 'yyyy-MM-dd'),
          ['landingPagePlusQueryString', 'sessionSource'],
          metrics,
          llmFilter
        )

        let compTotalsData = null
        let compDailyData = null
        let compSourceData = null
        let compLandingPageData = null

        if (isCompareMode && compareDateRange.from && compareDateRange.to) {
          compTotalsData = await ga4Service.runReport(
            siteUrl,
            format(compareDateRange.from, 'yyyy-MM-dd'),
            format(compareDateRange.to, 'yyyy-MM-dd'),
            [],
            metrics,
            llmFilter
          )
          compDailyData = await ga4Service.runReport(
            siteUrl,
            format(compareDateRange.from, 'yyyy-MM-dd'),
            format(compareDateRange.to, 'yyyy-MM-dd'),
            ['date'],
            ['sessions'],
            llmFilter
          )
          compSourceData = await ga4Service.runReport(
            siteUrl,
            format(compareDateRange.from, 'yyyy-MM-dd'),
            format(compareDateRange.to, 'yyyy-MM-dd'),
            ['sessionSource'],
            metrics,
            llmFilter
          )
          compLandingPageData = await ga4Service.runReport(
            siteUrl,
            format(compareDateRange.from, 'yyyy-MM-dd'),
            format(compareDateRange.to, 'yyyy-MM-dd'),
            ['landingPagePlusQueryString', 'sessionSource'],
            metrics,
            llmFilter
          )
        }

        if (isMounted) {
          setData({ totals: totalsData, daily: dailyData, source: sourceData, landingPage: landingPageData })
          setCompareData(isCompareMode ? { totals: compTotalsData, daily: compDailyData, source: compSourceData, landingPage: compLandingPageData } : null)
        }
      } catch (err: any) {
        if (isMounted) setError(err.message)
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    fetchData()
    return () => { isMounted = false }
  }, [siteUrl, dateRange, compareDateRange, isCompareMode, userProfile?.googleConnected])


  const formatValue = (metric: string, value: string) => {
    const num = Number(value)
    if (metric === 'averageSessionDuration') {
      const minutes = Math.floor(num / 60)
      const seconds = Math.floor(num % 60)
      return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    }
    return num.toLocaleString()
  }

  const renderMetricCard = (title: string, current: string | undefined, previous: string | undefined, metricType: string) => {
    const curVal = current ? Number(current) : 0
    const prevVal = previous ? Number(previous) : undefined
    
    let isPositive = false
    let diffPercent = null

    if (prevVal !== undefined && prevVal > 0) {
      const diff = curVal - prevVal
      diffPercent = (diff / prevVal) * 100
      isPositive = diffPercent > 0
    }

    return (
      <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_10px_24px_rgba(15,61,46,0.045)]">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{formatValue(metricType, current || '0')}</div>
          {diffPercent !== null && (
            <div className={`text-xs mt-1 flex items-center ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
              {isPositive ? <ArrowUpIcon className="w-3 h-3 mr-1" /> : <ArrowDownIcon className="w-3 h-3 mr-1" />}
              {Math.abs(diffPercent).toFixed(1)}% vs previous
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  if (loading) {
    return <div className="flex justify-center p-12"><div className="animate-pulse">Loading LLM Traffic...</div></div>
  }

  if (error) {
    return <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">{error}</div>
  }

  if (!data?.totals?.rows || data.totals.rows.length === 0) {
    return <div className="rounded-2xl border border-dashed border-[#D9E5DE] bg-white p-8 text-center text-muted-foreground shadow-[0_12px_32px_rgba(15,61,46,0.035)]">No LLM referral traffic recorded for this period.</div>
  }

  const totalsRow = data.totals.rows[0].metricValues
  const compTotalsRow = compareData?.totals?.rows?.[0]?.metricValues || []

  // Top Cards Data
  const curSessions = totalsRow[0]?.value || '0'
  const prevSessions = compTotalsRow[0]?.value

  const curEngaged = totalsRow[1]?.value || '0'
  const prevEngaged = compTotalsRow[1]?.value

  const curKeyEvents = totalsRow[2]?.value || '0'
  const prevKeyEvents = compTotalsRow[2]?.value

  const curDuration = totalsRow[3]?.value || '0'
  const prevDuration = compTotalsRow[3]?.value

  const curSessionKeyEventRate = Number(curSessions) > 0 ? ((Number(curKeyEvents) / Number(curSessions)) * 100).toFixed(2) : '0'
  const prevSessionKeyEventRate = Number(prevSessions) > 0 ? ((Number(prevKeyEvents) / Number(prevSessions)) * 100).toFixed(2) : undefined

  // Daily Trend Chart Data
  const dailyMap = new Map()
  
  // Sort primary rows by date so we map them properly if out of order
  const sortedPrimary = [...(data.daily?.rows || [])].filter((row) => getGa4DimensionValue(row)).sort((a,b) => getGa4DimensionValue(a).localeCompare(getGa4DimensionValue(b)))
  const sortedCompare = [...(compareData?.daily?.rows || [])].filter((row) => getGa4DimensionValue(row)).sort((a,b) => getGa4DimensionValue(a).localeCompare(getGa4DimensionValue(b)))

  sortedPrimary.forEach((r: any, index: number) => {
    const rawDate = getGa4DimensionValue(r)
    let dateStr = rawDate
    try {
      dateStr = format(parseISO(rawDate), 'MMM d')
    } catch(e) {}
    
    let compSessions = 0
    if (sortedCompare[index]) {
      compSessions = Number(sortedCompare[index].metricValues?.[0]?.value || 0)
    }

    dailyMap.set(dateStr, { 
      date: dateStr, 
      sessions: Number(r.metricValues?.[0]?.value || 0),
      previousSessions: compSessions
    })
  })

  const chartData = Array.from(dailyMap.values())

  // Source Table Data
  const sourceTableMap = new Map()
  data.source?.rows?.forEach((r: any) => {
    const rawSource = getGa4DimensionValue(r)
    if (!rawSource) return
    const sourceClass = classifyLlmSource(rawSource)
    
    if (!sourceTableMap.has(sourceClass)) {
      sourceTableMap.set(sourceClass, {
        referrer: sourceClass,
        sessions: 0,
        engagedSessions: 0,
        keyEvents: 0,
        avgDurationTotal: 0,
        prevSessions: 0,
        prevEngagedSessions: 0,
        prevKeyEvents: 0,
        prevAvgDurationTotal: 0
      })
    }
    
    const entry = sourceTableMap.get(sourceClass)
    const sessions = Number(r.metricValues?.[0]?.value || 0)
    
    entry.sessions += sessions
    entry.engagedSessions += Number(r.metricValues?.[1]?.value || 0)
    entry.keyEvents += Number(r.metricValues?.[2]?.value || 0)
    entry.avgDurationTotal += Number(r.metricValues?.[3]?.value || 0) * sessions
  })

  // Compare Source Table Data
  compareData?.source?.rows?.forEach((r: any) => {
    const rawSource = getGa4DimensionValue(r)
    if (!rawSource) return
    const sourceClass = classifyLlmSource(rawSource)
    if (!sourceTableMap.has(sourceClass)) return; // Only show changes for sources active in current period or we could add them. It's usually better to just show current period items.
    
    const entry = sourceTableMap.get(sourceClass)
    const sessions = Number(r.metricValues?.[0]?.value || 0)
    entry.prevSessions += sessions
    entry.prevEngagedSessions += Number(r.metricValues?.[1]?.value || 0)
    entry.prevKeyEvents += Number(r.metricValues?.[2]?.value || 0)
    entry.prevAvgDurationTotal += Number(r.metricValues?.[3]?.value || 0) * sessions
  })

  // Calculate final aggregated rates for Source table
  const sourceTableData = Array.from(sourceTableMap.values()).map(r => {
    r.sessionKeyEventRate = r.sessions > 0 ? (r.keyEvents / r.sessions) * 100 : 0
    r.averageSessionDuration = r.sessions > 0 ? r.avgDurationTotal / r.sessions : 0
    r.prevSessionKeyEventRate = r.prevSessions > 0 ? (r.prevKeyEvents / r.prevSessions) * 100 : 0
    r.prevAverageSessionDuration = r.prevSessions > 0 ? r.prevAvgDurationTotal / r.prevSessions : 0
    return r
  }).sort((a, b) => b.sessions - a.sessions)


  // Landing Page Table Data
  const lpTableMap = new Map()
  data.landingPage?.rows?.forEach((r: any) => {
    const lp = getGa4DimensionValue(r, 0)
    const rawSource = getGa4DimensionValue(r, 1)
    if (!lp || !rawSource) return
    const sourceClass = classifyLlmSource(rawSource)
    const key = `${lp}-${sourceClass}`

    if (!lpTableMap.has(key)) {
      lpTableMap.set(key, {
        landingPage: lp,
        referrer: sourceClass,
        sessions: 0,
        engagedSessions: 0,
        keyEvents: 0,
        averageSessionDuration: 0,
        prevSessions: 0,
        prevEngagedSessions: 0,
        prevKeyEvents: 0,
        prevAverageSessionDuration: 0
      })
    }
    const entry = lpTableMap.get(key)
    entry.sessions = Number(r.metricValues?.[0]?.value || 0)
    entry.engagedSessions = Number(r.metricValues?.[1]?.value || 0)
    entry.keyEvents = Number(r.metricValues?.[2]?.value || 0)
    entry.averageSessionDuration = Number(r.metricValues?.[3]?.value || 0)
  })

  compareData?.landingPage?.rows?.forEach((r: any) => {
    const lp = getGa4DimensionValue(r, 0)
    const rawSource = getGa4DimensionValue(r, 1)
    if (!lp || !rawSource) return
    const sourceClass = classifyLlmSource(rawSource)
    const key = `${lp}-${sourceClass}`
    
    if (lpTableMap.has(key)) {
      const entry = lpTableMap.get(key)
      entry.prevSessions = Number(r.metricValues?.[0]?.value || 0)
      entry.prevEngagedSessions = Number(r.metricValues?.[1]?.value || 0)
      entry.prevKeyEvents = Number(r.metricValues?.[2]?.value || 0)
      entry.prevAverageSessionDuration = Number(r.metricValues?.[3]?.value || 0)
    }
  })

  const lpTableData = Array.from(lpTableMap.values()).sort((a: any, b: any) => b.sessions - a.sessions).slice(0, 50) || []

  const startDate = format(dateRange.from, "yyyy-MM-dd")
  const endDate = format(dateRange.to, "yyyy-MM-dd")
  const exportSourceRows = () => {
    exportCsv(`ga4-llm-referrers-${startDate}-${endDate}.csv`, sourceTableData.map((row: any) => ({
      referrer: row.referrer,
      sessions: row.sessions,
      engagedSessions: row.engagedSessions,
      keyEvents: row.keyEvents,
      sessionKeyEventRate: row.sessionKeyEventRate,
      averageSessionDuration: row.averageSessionDuration,
      compareSessions: row.prevSessions,
      compareEngagedSessions: row.prevEngagedSessions,
      compareKeyEvents: row.prevKeyEvents,
      compareSessionKeyEventRate: row.prevSessionKeyEventRate,
      compareAverageSessionDuration: row.prevAverageSessionDuration,
    })))
  }

  const exportLandingPageRows = () => {
    exportCsv(`ga4-llm-landing-pages-${startDate}-${endDate}.csv`, lpTableData.map((row: any) => ({
      landingPage: row.landingPage,
      referrer: row.referrer,
      sessions: row.sessions,
      engagedSessions: row.engagedSessions,
      keyEvents: row.keyEvents,
      averageSessionDuration: row.averageSessionDuration,
      compareSessions: row.prevSessions,
      compareEngagedSessions: row.prevEngagedSessions,
      compareKeyEvents: row.prevKeyEvents,
      compareAverageSessionDuration: row.prevAverageSessionDuration,
    })))
  }

  const renderPercentDiff = (current: number, previous: number) => {
    if (!isCompareMode) return null;
    if (!previous || previous === 0) return <span className="text-muted-foreground text-xs ml-1 flex items-center">&mdash;</span>;
    const diff = ((current - previous) / previous) * 100;
    const isPositive = diff > 0;
    return (
      <span className={`text-xs ml-1 flex items-center ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
        {isPositive ? <ArrowUpIcon className="w-3 h-3 mr-0.5" /> : <ArrowDownIcon className="w-3 h-3 mr-0.5" />}
        {Math.abs(diff).toFixed(1)}%
      </span>
    )
  }


  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {renderMetricCard("LLM Sessions", curSessions, prevSessions, 'sessions')}
        {renderMetricCard("LLM Engaged sessions", curEngaged, prevEngaged, 'engagedSessions')}
        {renderMetricCard("Key events from LLMs", curKeyEvents, prevKeyEvents, 'keyEvents')}
        {renderMetricCard("Session key event rate", curSessionKeyEventRate, prevSessionKeyEventRate ? prevSessionKeyEventRate.toString() : undefined, 'sessionKeyEventRate')}
        {renderMetricCard("Average session duration", curDuration, prevDuration, 'averageSessionDuration')}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="col-span-1 overflow-hidden rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
          <CardHeader className="flex flex-col gap-3 border-b border-[#E6ECE8] bg-white sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Traffic metrics by LLM referrer</CardTitle>
              <CardDescription>Displays traffic metrics by LLM referrer.</CardDescription>
            </div>
            <Button variant="outline" size="sm" className="rounded-xl bg-background" onClick={exportSourceRows} disabled={sourceTableData.length === 0}>
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>LLM Referrer</TableHead>
                    <TableHead className="text-right">Sessions</TableHead>
                    <TableHead className="text-right">Engaged sessions</TableHead>
                    <TableHead className="text-right">Key events</TableHead>
                    <TableHead className="text-right">Session key event rate</TableHead>
                    <TableHead className="text-right">Average session duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sourceTableData.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{row.referrer}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="flex items-center justify-end">
                          {formatValue('sessions', row.sessions.toString())}
                          {renderPercentDiff(row.sessions, row.prevSessions)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="flex items-center justify-end">
                          {formatValue('engagedSessions', row.engagedSessions.toString())}
                          {renderPercentDiff(row.engagedSessions, row.prevEngagedSessions)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="flex items-center justify-end">
                          {formatValue('keyEvents', row.keyEvents.toString())}
                          {renderPercentDiff(row.keyEvents, row.prevKeyEvents)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="flex items-center justify-end">
                          {row.sessionKeyEventRate.toFixed(2)}%
                          {renderPercentDiff(row.sessionKeyEventRate, row.prevSessionKeyEventRate)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="flex items-center justify-end">
                          {formatValue('averageSessionDuration', row.averageSessionDuration.toString())}
                          {renderPercentDiff(row.averageSessionDuration, row.prevAverageSessionDuration)}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-1 overflow-hidden rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
          <CardHeader className="border-b border-[#E6ECE8] bg-white">
            <CardTitle>LLM Session trend over time</CardTitle>
            <CardDescription>Shows the daily trend of LLM sessions over the selected time period.</CardDescription>
          </CardHeader>
          <CardContent className="h-[340px] pt-6">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis fontSize={12} tickLine={false} axisLine={false} />
                <RechartsTooltip 
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)' }}
                />
                <Legend />
                <Line type="monotone" dataKey="sessions" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 6 }} name="Sessions" />
                {isCompareMode && (
                  <Line type="monotone" dataKey="previousSessions" stroke="#9ca3af" strokeWidth={2} strokeDasharray="4 4" dot={false} name="Sessions (previous period)" />
                )}
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardHeader className="flex flex-col gap-3 border-b border-[#E6ECE8] bg-white sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Landing pages by LLM referrer</CardTitle>
            <CardDescription>Displays landing page performance by LLM referrer.</CardDescription>
          </div>
          <Button variant="outline" size="sm" className="rounded-xl bg-background" onClick={exportLandingPageRows} disabled={lpTableData.length === 0}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Landing page</TableHead>
                  <TableHead>LLM Referrer</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Engaged sessions</TableHead>
                  <TableHead className="text-right">Key events</TableHead>
                  <TableHead className="text-right">Average session duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lpTableData.map((row: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="max-w-[300px] truncate" title={row.landingPage}>{row.landingPage}</TableCell>
                    <TableCell className="font-medium">{row.referrer}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex items-center justify-end">
                        {formatValue('sessions', row.sessions.toString())}
                        {renderPercentDiff(row.sessions, row.prevSessions)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex items-center justify-end">
                        {formatValue('engagedSessions', row.engagedSessions.toString())}
                        {renderPercentDiff(row.engagedSessions, row.prevEngagedSessions)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex items-center justify-end">
                        {formatValue('keyEvents', row.keyEvents.toString())}
                        {renderPercentDiff(row.keyEvents, row.prevKeyEvents)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex items-center justify-end">
                        {formatValue('averageSessionDuration', row.averageSessionDuration.toString())}
                        {renderPercentDiff(row.averageSessionDuration, row.prevAverageSessionDuration)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

    </div>
  )
}
