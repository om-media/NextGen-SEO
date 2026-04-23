import { useState, useEffect, useMemo } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ChevronLeft, ChevronRight, MousePointerClick, Eye, Percent, ArrowUpRight } from "lucide-react"
import { BingApiService, BingQueryStat } from "@/src/services/bingService"
import { useAuth } from "@/src/contexts/AuthContext"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface BingDataGridProps {
  siteUrl: string;
}

export function BingDataGrid({ siteUrl }: BingDataGridProps) {
  const { user, userProfile } = useAuth()
  const [data, setData] = useState<BingQueryStat[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 25

  useEffect(() => {
    if (!user || !siteUrl || !userProfile?.bingApiKey) return;

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const bingService = new BingApiService()
        const stats = await bingService.getQueryStats(siteUrl)
        setData(stats)
        setCurrentPage(1)
      } catch (err: any) {
        console.error("Error fetching Bing stats:", err)
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [user, siteUrl, userProfile?.bingApiKey])

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

  if (loading) {
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
        <CardContent className="flex items-center justify-center h-64 text-destructive">
          {error}
        </CardContent>
      </Card>
    )
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64 text-muted-foreground">
          No data available for this property.
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
          <Card key={metric.title}>
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

      <Card>
        <CardHeader>
          <CardTitle>Top Queries</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-x-auto">
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
            <div className="flex items-center justify-between space-x-2 py-4">
              <div className="text-sm text-muted-foreground">
                Showing {((currentPage - 1) * pageSize) + 1} to {Math.min(currentPage * pageSize, data.length)} of {data.length} entries
              </div>
              <div className="flex space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
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
