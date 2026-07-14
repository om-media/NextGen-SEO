import { useState, useEffect, useMemo, useRef } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ChevronLeft, ChevronRight, MousePointerClick, Eye, Percent, ArrowUpRight, Download, RefreshCw } from "lucide-react"
import { BingApiService, BingQueryStat, type BingQueryStatsMeta } from "@/src/services/bingService"
import { useAuth } from "@/src/contexts/AuthContext"
import { format } from "date-fns"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { DateRange } from "react-day-picker"

interface BingDataGridProps {
  dateRange: DateRange;
  siteUrl: string;
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

export function BingDataGrid({ dateRange, siteUrl }: BingDataGridProps) {
  const { user, userProfile } = useAuth()
  const [data, setData] = useState<BingQueryStat[]>([])
  const [cacheMeta, setCacheMeta] = useState<BingQueryStatsMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const startDate = dateRange.from ? format(dateRange.from, "yyyy-MM-dd") : ""
  const endDate = dateRange.to ? format(dateRange.to, "yyyy-MM-dd") : ""
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 25

  useEffect(() => {
    const requestId = ++requestSequence.current
    setData([])
    setCacheMeta(null)
    setCurrentPage(1)
    setError(null)
    setSyncing(false)

    if (!user || !siteUrl || !userProfile?.bingConnected || !startDate || !endDate) {
      setLoading(false)
      return
    }

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const bingService = new BingApiService()
        const result = await bingService.getQueryStats(siteUrl, startDate, endDate)
        if (requestSequence.current !== requestId) return
        setData(result.rows)
        setCacheMeta(result.meta)
        setCurrentPage(1)
      } catch (err: any) {
        if (requestSequence.current !== requestId) return
        console.error("Error fetching Bing stats:", err)
        setError(err.message)
      } finally {
        if (requestSequence.current === requestId) setLoading(false)
      }
    }

    void fetchData()
  }, [endDate, siteUrl, startDate, user, userProfile?.bingConnected])

  const handleRefreshBing = async () => {
    if (!siteUrl || !startDate || !endDate) return

    const requestId = ++requestSequence.current
    setSyncing(true)
    setError(null)
    try {
      const bingService = new BingApiService()
      const result = await bingService.syncQueryStats(siteUrl, startDate, endDate)
      if (requestSequence.current !== requestId) return
      setData(result.rows)
      setCacheMeta(result.meta)
      setCurrentPage(1)
    } catch (err: any) {
      if (requestSequence.current !== requestId) return
      console.error("Error refreshing Bing stats:", err)
      setError(err.message)
    } finally {
      if (requestSequence.current === requestId) setSyncing(false)
    }
  }

  const cacheLabel = useMemo(() => {
    const availableStartDate = cacheMeta?.range?.availableStartDate
    const availableEndDate = cacheMeta?.range?.availableEndDate
    if (availableStartDate && availableEndDate) {
      if (availableStartDate === availableEndDate) return `Stored Bing data for ${availableStartDate}`
      return `Stored Bing data from ${availableStartDate} through ${availableEndDate}`
    }

    const fetchedAt = cacheMeta?.cache?.latestFetchedAt || cacheMeta?.range?.latestFetchedAt
    if (!fetchedAt) return "No stored Bing data for this range"
    const date = new Date(fetchedAt)
    if (Number.isNaN(date.getTime())) return `Stored ${fetchedAt}`
    return `Stored ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
  }, [cacheMeta])

  const totals = useMemo(() => {
    if (!data.length) return { clicks: 0, impressions: 0, ctr: 0, position: 0 }
    
    let totalClicks = 0
    let totalImpressions = 0
    let posWeightedSum = 0

    data.forEach(item => {
      totalClicks += item.Clicks
      totalImpressions += item.Impressions
      posWeightedSum += (item.AvgClickPosition * item.Impressions)
    })

    return {
      clicks: totalClicks,
      impressions: totalImpressions,
      ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
      position: totalImpressions > 0 ? posWeightedSum / totalImpressions : 0
    }
  }, [data])

  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return data.slice(start, start + pageSize)
  }, [data, currentPage, pageSize])

  const totalPages = Math.ceil(data.length / pageSize)

  const exportRows = () => {
    exportCsv(
      `bing-queries-${siteUrl.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-${startDate}-${endDate}.csv`,
      data.map((row) => ({
        query: row.Query,
        clicks: row.Clicks,
        impressions: row.Impressions,
        ctr: row.Ctr,
        ctrPercent: `${(row.Ctr * 100).toFixed(2)}%`,
        avgClickPosition: row.AvgClickPosition,
      })),
    )
  }

  if (loading) {
    return (
      <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="flex items-center justify-center h-64 text-destructive">
          {error}
        </CardContent>
      </Card>
    )
  }

  if (data.length === 0) {
    return (
      <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="flex h-64 flex-col items-center justify-center gap-4 text-center text-muted-foreground">
          <div>
            <div className="font-medium text-foreground">No Bing query data for this date range.</div>
            <div className="mt-1 text-sm">{cacheLabel}</div>
          </div>
          <Button className="rounded-xl" onClick={handleRefreshBing} disabled={syncing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Refreshing..." : "Refresh Bing data"}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Total Clicks", value: totals.clicks.toLocaleString(), icon: MousePointerClick },
          { title: "Total Impressions", value: totals.impressions.toLocaleString(), icon: Eye },
          { title: "Average CTR", value: `${totals.ctr.toFixed(2)}%`, icon: Percent },
          { title: "Average Position", value: totals.position.toFixed(1), icon: ArrowUpRight },
        ].map((metric) => (
          <Card key={metric.title} className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_10px_24px_rgba(15,61,46,0.045)]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{metric.title}</CardTitle>
              <metric.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{metric.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardHeader className="border-b border-[#E6ECE8] bg-white px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Top Queries</CardTitle>
              <CardDescription>
                Bing query performance from the app warehouse. {cacheLabel}.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="rounded-xl bg-background" onClick={handleRefreshBing} disabled={syncing}>
                <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Refreshing..." : "Refresh Bing data"}
              </Button>
              <Button variant="outline" className="rounded-xl bg-background" onClick={exportRows} disabled={data.length === 0}>
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-2xl border border-[#E6ECE8] bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Query</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Impressions</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">Avg. Position</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedData.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{row.Query}</TableCell>
                    <TableCell className="text-right">{row.Clicks.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{row.Impressions.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{(row.Ctr * 100).toFixed(2)}%</TableCell>
                    <TableCell className="text-right">{row.AvgClickPosition.toFixed(1)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          
          {totalPages > 1 && (
            <div className="flex items-center justify-between space-x-2 border-t border-[#E6ECE8] py-4">
              <div className="text-sm text-muted-foreground">
                Showing {((currentPage - 1) * pageSize) + 1} to {Math.min(currentPage * pageSize, data.length)} of {data.length} entries
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-[#E6ECE8] bg-[#FBFCFB] p-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-background"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-background"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
