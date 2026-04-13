import { useState, useEffect } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Ga4ApiService, Ga4DataRow } from "../../services/ga4Service"
import { useAuth } from "../../contexts/AuthContext"
import { Loader2 } from "lucide-react"
import { format, subDays } from "date-fns"
import { DateRange } from "react-day-picker"

interface Ga4DataGridProps {
  siteUrl: string;
  dateRange?: DateRange;
}

export function Ga4DataGrid({ siteUrl, dateRange }: Ga4DataGridProps) {
  const { accessToken } = useAuth()
  const [data, setData] = useState<Ga4DataRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!accessToken || !siteUrl || !dateRange?.from || !dateRange?.to) return;

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const ga4Service = new Ga4ApiService(accessToken)
        const startDate = format(dateRange.from!, 'yyyy-MM-dd')
        const endDate = format(dateRange.to!, 'yyyy-MM-dd')
        
        const response = await ga4Service.runReport(
          siteUrl, 
          startDate, 
          endDate, 
          ['date'], 
          ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate']
        )
        
        setData(response.rows || [])
      } catch (err: any) {
        console.error("Error fetching GA4 stats:", err)
        if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token") || err.message.includes("insufficient authentication scopes")) {
          setError("Your Google session has expired or is missing permissions. Please sign out and sign back in to grant Google Analytics access.")
        } else if (err.message.includes("Google Analytics Data API has not been used in project") || err.message.includes("is disabled")) {
          setError(err.message)
        } else if (err.message === "Failed to fetch") {
          setError("Network error: Unable to connect to Google Analytics API. This could be due to an adblocker, privacy extension, or network connectivity issue.")
        } else {
          setError(err.message)
        }
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [accessToken, siteUrl, dateRange])

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
        <CardContent className="flex flex-col items-center justify-center h-64 text-destructive space-y-4">
          <div className="text-center">{error}</div>
          {error.includes("https://console.developers.google.com") && (
            <a 
              href={error.match(/https:\/\/console\.developers\.google\.com[^\s]*/)?.[0] || "#"} 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
            >
              Enable API in Google Cloud Console
            </a>
          )}
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
        <CardTitle>GA4 Overview</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Page Views</TableHead>
                <TableHead className="text-right">Bounce Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row, i) => {
                const dateStr = row.dimensionValues[0].value;
                const formattedDate = dateStr.length === 8 
                  ? format(new Date(parseInt(dateStr.substring(0, 4)), parseInt(dateStr.substring(4, 6)) - 1, parseInt(dateStr.substring(6, 8))), 'MMM d, yyyy')
                  : dateStr;
                return (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{formattedDate}</TableCell>
                    <TableCell className="text-right">{parseInt(row.metricValues[0].value).toLocaleString()}</TableCell>
                    <TableCell className="text-right">{parseInt(row.metricValues[1].value).toLocaleString()}</TableCell>
                    <TableCell className="text-right">{parseInt(row.metricValues[2].value).toLocaleString()}</TableCell>
                    <TableCell className="text-right">{(parseFloat(row.metricValues[3].value) * 100).toFixed(2)}%</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
