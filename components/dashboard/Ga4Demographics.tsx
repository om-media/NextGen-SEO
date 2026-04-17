import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Ga4ApiService } from "@/src/services/ga4Service"
import { useAuth } from "@/src/contexts/AuthContext"
import { Loader2 } from "lucide-react"
import { format } from "date-fns"
import { DateRange } from "react-day-picker"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip, Legend } from 'recharts'

interface Ga4DemographicsProps {
  siteUrl: string;
  dateRange?: DateRange;
}

const COLORS = ['#4285f4', '#fbbc04', '#34a853', '#ea4335', '#ff6d00', '#46bdc6'];

const DIMENSIONS = [
  { key: 'deviceCategory', label: 'Devices' },
  { key: 'browser', label: 'Browsers' },
  { key: 'operatingSystem', label: 'Operating Systems' },
  { key: 'country', label: 'Countries' },
];

export function Ga4Demographics({ siteUrl, dateRange }: Ga4DemographicsProps) {
  const { accessToken } = useAuth()
  const [data, setData] = useState<Record<string, any[]>>({})
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
        
        const promises = DIMENSIONS.map(dim => 
          ga4Service.runReport(
            siteUrl, 
            startDate, 
            endDate, 
            [dim.key], 
            ['sessions']
          )
        )

        const results = await Promise.all(promises)
        
        const newData: Record<string, any[]> = {}
        
        results.forEach((res, index) => {
          const dim = DIMENSIONS[index].key
          if (res.rows) {
            const sorted = [...res.rows].sort((a, b) => parseFloat(b.metricValues[0].value) - parseFloat(a.metricValues[0].value))
            newData[dim] = sorted.slice(0, 5).map(item => ({
              name: item.dimensionValues[0].value === '(not set)' ? 'Unknown' : item.dimensionValues[0].value,
              value: parseInt(item.metricValues[0].value)
            }))
          } else {
             newData[dim] = []
          }
        })

        setData(newData)
      } catch (err: any) {
        setError(err.message || 'Failed to fetch breakdown data')
        console.error(err)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [siteUrl, dateRange, accessToken])

  if (loading && Object.keys(data).length === 0) {
    return (
      <Card className="mb-4">
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="mb-4">
        <CardContent className="flex flex-col items-center justify-center h-48 text-destructive space-y-4">
          <div className="text-center">{error}</div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
      {DIMENSIONS.map((dim) => (
        <Card key={dim.key} className="flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Sessions by {dim.label}</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col">
            <div className="h-[200px] w-full">
              {data[dim.key] && data[dim.key].length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart margin={{ top: 0, right: 0, bottom: 20, left: 0 }}>
                    <Pie
                      data={data[dim.key]}
                      cx="50%"
                      cy="45%"
                      innerRadius={40}
                      outerRadius={65}
                      paddingAngle={3}
                      stroke="none"
                      dataKey="value"
                    >
                      {data[dim.key].map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip 
                      formatter={(value: number) => value.toLocaleString()}
                      contentStyle={{ borderRadius: '8px', zIndex: 1000, fontSize: '12px' }}
                    />
                    <Legend layout="horizontal" verticalAlign="bottom" align="center" wrapperStyle={{ fontSize: '10px', paddingTop: '5px' }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "No data"}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
