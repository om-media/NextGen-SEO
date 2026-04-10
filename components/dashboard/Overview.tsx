import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { useAuth } from "@/src/contexts/AuthContext"
import { GscApiService, GscSearchAnalyticsRow } from "@/src/services/gscService"
import { format, subDays, parseISO } from "date-fns"
import { DateRange } from "react-day-picker"
import { Loader2 } from "lucide-react"

export function Overview({ siteUrl, dateRange }: { siteUrl: string, dateRange?: DateRange }) {
  const { accessToken, clearAccessToken } = useAuth()
  const [data, setData] = useState<any[]>([])
  const [summary, setSummary] = useState({ clicks: 0, impressions: 0, ctr: 0, position: 0 })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (accessToken && siteUrl && dateRange?.from && dateRange?.to) {
      setLoading(true)
      const gscService = new GscApiService(accessToken)
      
      const endDate = format(dateRange.to, 'yyyy-MM-dd')
      const startDate = format(dateRange.from, 'yyyy-MM-dd')

      gscService.querySearchAnalytics(siteUrl, startDate, endDate, ['date'])
        .then(rows => {
          // Calculate summary
          let totalClicks = 0
          let totalImpressions = 0
          let sumPosition = 0

          const chartData = rows.map(row => {
            totalClicks += row.clicks
            totalImpressions += row.impressions
            sumPosition += (row.position * row.impressions) // Weighted average

            return {
              date: format(parseISO(row.keys[0]), 'MMM d'),
              clicks: row.clicks,
              impressions: row.impressions,
            }
          }).reverse() // Reverse to show chronological order

          setData(chartData)
          setSummary({
            clicks: totalClicks,
            impressions: totalImpressions,
            ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
            position: totalImpressions > 0 ? sumPosition / totalImpressions : 0
          })
        })
        .catch(err => {
          console.error("Failed to fetch GSC overview data:", err)
          if (err.message.includes("invalid authentication credentials") || err.message.includes("OAuth 2 access token")) {
            clearAccessToken()
          }
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [accessToken, siteUrl, dateRange, clearAccessToken])

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Clicks</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : summary.clicks.toLocaleString()}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Impressions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : summary.impressions.toLocaleString()}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Average CTR</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : `${summary.ctr.toFixed(2)}%`}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Average Position</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : summary.position.toFixed(1)}
          </div>
        </CardContent>
      </Card>

      <Card className="col-span-4">
        <CardHeader>
          <CardTitle>Performance Overview</CardTitle>
        </CardHeader>
        <CardContent className="pl-2">
          {loading ? (
            <div className="h-[350px] flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={data}>
                <XAxis
                  dataKey="date"
                  stroke="#888888"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  yAxisId="left"
                  stroke="#888888"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `${value}`}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="#888888"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `${value}`}
                />
                <Tooltip />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="clicks"
                  stroke="var(--color-chart-1)"
                  strokeWidth={2}
                  activeDot={{ r: 8 }}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="impressions"
                  stroke="var(--color-chart-2)"
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
