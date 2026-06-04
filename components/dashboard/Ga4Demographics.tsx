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
  workspaceSiteUrl?: string;
  dateRange?: DateRange;
}

const COLORS = ['#4285f4', '#fbbc04', '#34a853', '#ea4335', '#ff6d00', '#46bdc6'];

const DIMENSIONS = [
  { key: 'deviceCategory', label: 'Devices' },
  { key: 'browser', label: 'Browsers' },
  { key: 'operatingSystem', label: 'Operating Systems' },
  { key: 'country', label: 'Countries' },
];

type WarehouseCoverage = {
  activeDateCount?: number;
  activeJobCount?: number;
  coveredDateCount?: number;
  expectedDateCount?: number;
  missingDateCount?: number;
  queuedDateCount?: number;
};

export function Ga4Demographics({ siteUrl, workspaceSiteUrl, dateRange }: Ga4DemographicsProps) {
  const { userProfile } = useAuth()
  const [data, setData] = useState<Record<string, any[]>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<WarehouseCoverage | null>(null)
  const [pollKey, setPollKey] = useState(0)

  useEffect(() => {
    if (!userProfile?.googleConnected || !siteUrl || !dateRange?.from || !dateRange?.to) return;

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const ga4Service = new Ga4ApiService()
        const startDate = format(dateRange.from!, 'yyyy-MM-dd')
        const endDate = format(dateRange.to!, 'yyyy-MM-dd')
        
        const promises = DIMENSIONS.map(dim => 
          ga4Service.runReport(
            siteUrl, 
            startDate, 
            endDate, 
            [dim.key], 
            ['sessions'],
            undefined,
            { siteUrl: workspaceSiteUrl }
          )
        )

        const results = await Promise.all(promises)
        setCoverage(results.map((result) => result?.metadata?.coverage).find(Boolean) || null)
        
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
  }, [siteUrl, workspaceSiteUrl, dateRange, userProfile?.googleConnected, pollKey])

  useEffect(() => {
    if (!coverage || loading) return;
    if (Object.values(data).some((rows) => Array.isArray(rows) && rows.length > 0)) return;
    const hasWarehouseWork =
      Number(coverage.activeJobCount || 0) > 0 ||
      Number(coverage.activeDateCount || 0) > 0 ||
      Number(coverage.queuedDateCount || 0) > 0;
    if (!hasWarehouseWork) return;

    const timeout = window.setTimeout(() => setPollKey((value) => value + 1), 10000);
    return () => window.clearTimeout(timeout);
  }, [coverage, loading, data])

  if (loading && Object.keys(data).length === 0) {
    return (
      <Card className="mb-4 rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="mb-4 rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="flex flex-col items-center justify-center h-48 text-destructive space-y-4">
          <div className="text-center">{error}</div>
        </CardContent>
      </Card>
    )
  }

  const shouldShowCoverage =
    coverage &&
    Number(coverage.expectedDateCount || 0) > 0 &&
    (
      Number(coverage.activeJobCount || 0) > 0 ||
      Number(coverage.activeDateCount || 0) > 0 ||
      Number(coverage.queuedDateCount || 0) > 0 ||
      Number(coverage.missingDateCount || 0) > 0
    );
  const hasActiveWarehouseWork =
    Number(coverage?.activeJobCount || 0) > 0 ||
    Number(coverage?.activeDateCount || 0) > 0 ||
    Number(coverage?.queuedDateCount || 0) > 0;

  return (
    <div className="mb-4 space-y-4">
      {shouldShowCoverage && (
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-[0_12px_32px_rgba(15,61,46,0.035)] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            {hasActiveWarehouseWork ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              <span className="h-2 w-2 rounded-full bg-primary" />
            )}
            <span className="font-medium text-foreground">
              {hasActiveWarehouseWork ? "Importing Analytics history" : "Analytics breakdown import available"}
            </span>
            <span>
              {Number(coverage.coveredDateCount || 0).toLocaleString()} / {Number(coverage.expectedDateCount || 0).toLocaleString()} days ready
            </span>
          </div>
          <span>{hasActiveWarehouseWork ? "Existing rows stay visible while the import catches up." : "The import status panel will prepare these breakdowns automatically."}</span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {DIMENSIONS.map((dim) => (
          <Card key={dim.key} className="flex flex-col rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
            <CardHeader className="border-b border-[#E6ECE8] bg-white pb-2">
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
    </div>
  )
}
