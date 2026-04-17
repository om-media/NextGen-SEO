import { useState, useEffect } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { BingApiService, BingQueryStat } from "@/src/services/bingService"
import { useAuth } from "@/src/contexts/AuthContext"
import { Loader2 } from "lucide-react"

interface BingDataGridProps {
  siteUrl: string;
}

export function BingDataGrid({ siteUrl }: BingDataGridProps) {
  const { user, userProfile } = useAuth()
  const [data, setData] = useState<BingQueryStat[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user || !siteUrl || !userProfile?.bingApiKey) return;

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const bingService = new BingApiService(user.uid)
        const stats = await bingService.getQueryStats(siteUrl)
        setData(stats)
      } catch (err: any) {
        console.error("Error fetching Bing stats:", err)
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [user, siteUrl])

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
    <Card>
      <CardHeader>
        <CardTitle>Query Stats</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
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
              {data.map((row, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{row.Query}</TableCell>
                  <TableCell className="text-right">{row.Clicks}</TableCell>
                  <TableCell className="text-right">{row.Impressions}</TableCell>
                  <TableCell className="text-right">{(row.Ctr * 100).toFixed(2)}%</TableCell>
                  <TableCell className="text-right">{row.AvgClickPosition.toFixed(1)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
