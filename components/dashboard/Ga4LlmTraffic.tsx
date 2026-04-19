import { useEffect, useState, useMemo } from "react"
import { useAuth } from "@/src/contexts/AuthContext"
import { Ga4ApiService } from "@/src/services/ga4Service"
import { format, parseISO } from "date-fns"
import { ArrowDownIcon, ArrowUpIcon, Info } from "lucide-react"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

import { DateRange } from "react-day-picker"

interface Ga4LlmTrafficProps {
  siteUrl: string;
  dateRange: DateRange;
  isCompareMode: boolean;
  compareDateRange: DateRange;
}

function classifyLlmSource(source: string): string {
  const s = source.toLowerCase()
  if (s.includes('chatgpt') || s.includes('openai')) return 'ChatGPT'
  if (s.includes('claude') || s.includes('anthropic')) return 'Claude'
  if (s.includes('gemini') || s.includes('bard')) return 'Gemini'
  if (s.includes('perplexity')) return 'Perplexity'
  if (s.includes('copilot') || s.includes('bing.com/chat')) return 'Copilot'
  return source
}

export function Ga4LlmTraffic({ siteUrl, dateRange, isCompareMode, compareDateRange }: Ga4LlmTrafficProps) {
  const { accessToken } = useAuth()
  const [data, setData] = useState<any>(null)
  const [compareData, setCompareData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const llmFilter = {
    filter: {
      fieldName: "sessionSource",
      stringFilter: {
        value: "chatgpt|openai|claude|anthropic|gemini|bard|perplexity|copilot|bing.com/chat",
        matchType: "PARTIAL_REGEXP"
      }
    }
  }

  useEffect(() => {
    if (!accessToken || !siteUrl || !dateRange.from || !dateRange.to) return
    let isMounted = true

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const ga4Service = new Ga4ApiService(accessToken)
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
  }, [siteUrl, dateRange, compareDateRange, isCompareMode, accessToken])


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
      <Card className="bg-card">
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
    return <div className="text-red-500 p-4 border rounded bg-red-50">{error}</div>
  }

  if (!data?.totals?.rows || data.totals.rows.length === 0) {
    return <div className="text-muted-foreground p-8 text-center border rounded">No LLM referral traffic recorded for this period.</div>
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
  const sortedPrimary = [...(data.daily?.rows || [])].sort((a,b) => a.dimensionValues[0].value.localeCompare(b.dimensionValues[0].value))
  const sortedCompare = [...(compareData?.daily?.rows || [])].sort((a,b) => a.dimensionValues[0].value.localeCompare(b.dimensionValues[0].value))

  sortedPrimary.forEach((r: any, index: number) => {
    const rawDate = r.dimensionValues[0].value
    let dateStr = rawDate
    try {
      dateStr = format(parseISO(rawDate), 'MMM d')
    } catch(e) {}
    
    let compSessions = 0
    if (sortedCompare[index]) {
      compSessions = Number(sortedCompare[index].metricValues[0].value)
    }

    dailyMap.set(dateStr, { 
      date: dateStr, 
      sessions: Number(r.metricValues[0].value),
      previousSessions: compSessions
    })
  })

  const chartData = Array.from(dailyMap.values())

  // Source Table Data
  const sourceTableMap = new Map()
  data.source?.rows?.forEach((r: any) => {
    const rawSource = r.dimensionValues[0].value
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
    const sessions = Number(r.metricValues[0].value)
    
    entry.sessions += sessions
    entry.engagedSessions += Number(r.metricValues[1].value)
    entry.keyEvents += Number(r.metricValues[2].value)
    entry.avgDurationTotal += Number(r.metricValues[3].value) * sessions
  })

  // Compare Source Table Data
  compareData?.source?.rows?.forEach((r: any) => {
    const rawSource = r.dimensionValues[0].value
    const sourceClass = classifyLlmSource(rawSource)
    if (!sourceTableMap.has(sourceClass)) return; // Only show changes for sources active in current period or we could add them. It's usually better to just show current period items.
    
    const entry = sourceTableMap.get(sourceClass)
    const sessions = Number(r.metricValues[0].value)
    entry.prevSessions += sessions
    entry.prevEngagedSessions += Number(r.metricValues[1].value)
    entry.prevKeyEvents += Number(r.metricValues[2].value)
    entry.prevAvgDurationTotal += Number(r.metricValues[3].value) * sessions
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
    const lp = r.dimensionValues[0].value
    const rawSource = r.dimensionValues[1].value
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
    entry.sessions = Number(r.metricValues[0].value)
    entry.engagedSessions = Number(r.metricValues[1].value)
    entry.keyEvents = Number(r.metricValues[2].value)
    entry.averageSessionDuration = Number(r.metricValues[3].value)
  })

  compareData?.landingPage?.rows?.forEach((r: any) => {
    const lp = r.dimensionValues[0].value
    const rawSource = r.dimensionValues[1].value
    const sourceClass = classifyLlmSource(rawSource)
    const key = `${lp}-${sourceClass}`
    
    if (lpTableMap.has(key)) {
      const entry = lpTableMap.get(key)
      entry.prevSessions = Number(r.metricValues[0].value)
      entry.prevEngagedSessions = Number(r.metricValues[1].value)
      entry.prevKeyEvents = Number(r.metricValues[2].value)
      entry.prevAverageSessionDuration = Number(r.metricValues[3].value)
    }
  })

  const lpTableData = Array.from(lpTableMap.values()).sort((a: any, b: any) => b.sessions - a.sessions).slice(0, 50) || []

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
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Traffic metrics by LLM referrer</CardTitle>
            <CardDescription>Displays traffic metrics by LLM referrer.</CardDescription>
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

        <Card className="col-span-1 border rounded-lg p-6">
          <CardHeader className="p-0 mb-4">
            <CardTitle>LLM Session trend over time</CardTitle>
            <CardDescription>Shows the daily trend of LLM sessions over the selected time period.</CardDescription>
          </CardHeader>
          <div className="h-[300px]">
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
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Landing pages by LLM referrer</CardTitle>
          <CardDescription>Displays landing page performance by LLM referrer.</CardDescription>
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
