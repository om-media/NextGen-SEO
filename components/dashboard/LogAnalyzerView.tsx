import { useState, useEffect, useRef } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from "recharts"
import { Upload, Server, AlertCircle, Loader2, Bot } from "lucide-react"
import { authFetch } from "@/src/lib/authFetch"
import { toast } from "sonner"

interface LogAnalyzerViewProps {
  siteUrl: string | undefined
  dateRange: { from: Date; to?: Date }
}

export function LogAnalyzerView({ siteUrl, dateRange }: LogAnalyzerViewProps) {
  const [stats, setStats] = useState<any[]>([])
  const [errors, setErrors] = useState<any[]>([])
  const [insights, setInsights] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchData = async () => {
    if (!siteUrl || !dateRange.from) return
    setLoading(true)
    
    // Format dates to YYYY-MM-DD
    const startDate = dateRange.from.toISOString().split('T')[0];
    const endDate = dateRange.to ? dateRange.to.toISOString().split('T')[0] : startDate;
    
    try {
      const statsRes = await authFetch(`/api/logs/stats?siteUrl=${encodeURIComponent(siteUrl)}&startDate=${startDate}&endDate=${endDate}`)
      const errorsRes = await authFetch(`/api/logs/errors?siteUrl=${encodeURIComponent(siteUrl)}&startDate=${startDate}&endDate=${endDate}`)
      const insightsRes = await authFetch(`/api/logs/insights?siteUrl=${encodeURIComponent(siteUrl)}&startDate=${startDate}&endDate=${endDate}`)
      
      if (statsRes.ok) {
        const statsData = await statsRes.json()
        setStats(statsData)
      }
      
      if (errorsRes.ok) {
        const errorsData = await errorsRes.json()
        setErrors(errorsData)
      }

      if (insightsRes.ok) {
        setInsights(await insightsRes.json())
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [siteUrl, dateRange])

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !siteUrl) return

    setUploading(true)
    const formData = new FormData()
    formData.append('logfile', file)
    formData.append('siteUrl', siteUrl)

    try {
      const res = await authFetch('/api/logs/upload', {
        method: 'POST',
        body: formData
      })
      if (res.ok) {
        const json = await res.json()
        if (json.count === 0) {
           toast.error("No log lines were parsed", {
             description: "Please make sure the file uses a standard combined access log format.",
           });
        }
        await fetchData()
      } else {
        console.error("Upload failed")
      }
    } catch (err) {
      console.error(err)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // Aggregate stats payload for the chart
  const processChartData = () => {
    const dataByDate: Record<string, any> = {}
    
    // Zero-fill the selected date range
    if (dateRange.from) {
      let currentDate = new Date(dateRange.from);
      const endDate = dateRange.to ? new Date(dateRange.to) : new Date(dateRange.from);
      
      while (currentDate <= endDate) {
        const dStr = currentDate.toISOString().split('T')[0];
        dataByDate[dStr] = { date: dStr, Human: 0, Googlebot: 0, Bingbot: 0, 'Generic Bot': 0 };
        currentDate.setDate(currentDate.getDate() + 1);
      }
    }
    
    stats.forEach(s => {
      if (!dataByDate[s.date]) {
        dataByDate[s.date] = { date: s.date, Human: 0, Googlebot: 0, Bingbot: 0, 'Generic Bot': 0 }
      }
      if (dataByDate[s.date][s.botType] !== undefined) {
        dataByDate[s.date][s.botType] = s.hits
      } else {
        dataByDate[s.date][s.botType] = (dataByDate[s.date][s.botType] || 0) + s.hits
      }
    })
    
    return Object.values(dataByDate).sort((a,b) => a.date.localeCompare(b.date))
  }

  const chartData = processChartData()

  const totalHumans = stats.filter(s => s.botType === 'Human').reduce((sum, s) => sum + s.hits, 0)
  const totalGooglebot = stats.filter(s => s.botType === 'Googlebot').reduce((sum, s) => sum + s.hits, 0)
  const totalErrors = errors.reduce((sum, e) => sum + e.count, 0)

  if (!siteUrl) {
    return <div className="p-8 text-center text-muted-foreground">Select a site to view Server Logs.</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-[#E9F0EB] bg-white/90 p-5 shadow-[0_12px_32px_rgba(15,61,46,0.045)] sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.01em] text-[#0F172A]">Server Log Analysis</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[#647067]">Monitor real 100% accurate human traffic and Googlebot crawl budget.</p>
        </div>
        <div className="rounded-xl border border-[#E6ECE8] bg-[#FBFCFB] p-1.5">
          <input 
            type="file" 
            ref={fileInputRef}
            className="hidden" 
            onChange={handleFileUpload} 
          />
          <Button variant="outline" className="bg-background" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
            {uploading ? "Parsing Logs..." : "Upload Server Logs"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_10px_24px_rgba(15,61,46,0.045)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 text-muted-foreground pb-2">
            <CardTitle className="text-sm font-medium">True Human Pageviews</CardTitle>
            <Server className="h-4 w-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalHumans.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">Excludes all known bots and scrapers</p>
          </CardContent>
        </Card>
        
        <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_10px_24px_rgba(15,61,46,0.045)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 text-muted-foreground pb-2">
            <CardTitle className="text-sm font-medium">Googlebot Hits</CardTitle>
            <Bot className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalGooglebot.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">Crawl budget consumption</p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_10px_24px_rgba(15,61,46,0.045)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 text-muted-foreground pb-2">
            <CardTitle className="text-sm font-medium">Bot Encountered Errors</CardTitle>
            <AlertCircle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalErrors.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">4xx & 5xx statuses degrading SEO</p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_10px_24px_rgba(15,61,46,0.045)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 text-muted-foreground pb-2">
            <CardTitle className="text-sm font-medium">Crawl Efficiency</CardTitle>
            <Bot className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {insights?.efficiency ? 
                (() => {
                  const good = insights.efficiency.filter((x:any) => x.statusCode === 200).reduce((sum:number, x:any) => sum + x.count, 0);
                  const all = insights.efficiency.reduce((sum:number, x:any) => sum + x.count, 0);
                  return all > 0 ? `${Math.round((good / all) * 100)}%` : '0%';
                })()
                : '0%'
              }
            </div>
            <p className="text-xs text-muted-foreground mt-1">% of Googlebot hits returning 200 OK</p>
          </CardContent>
        </Card>
      </div>

      {chartData.length > 0 ? (
        <Card className="col-span-4 relative rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
          {loading && (
            <div className="absolute inset-0 bg-background/50 backdrop-blur-sm z-10 flex items-center justify-center rounded-xl">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          )}
          <CardHeader className="border-b border-[#E6ECE8] bg-white">
            <CardTitle>Traffic Composition (Bots vs Humans)</CardTitle>
            <CardDescription>Use this view to spot crawl spikes, real traffic trends, and wasted bot activity over time.</CardDescription>
          </CardHeader>
          <CardContent className="h-[350px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="Human" stroke="#3b82f6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Googlebot" stroke="#22c55e" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Bingbot" stroke="#eab308" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Generic Bot" stroke="#ef4444" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      ) : loading ? (
        <Card className="col-span-4 rounded-2xl border border-dashed border-[#D9E5DE] bg-[#FBFCFB] shadow-[0_12px_32px_rgba(15,61,46,0.035)]">
          <CardContent className="flex flex-col items-center justify-center h-[350px] text-muted-foreground text-center px-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p>Fetching log data...</p>
          </CardContent>
        </Card>
      ) : (
         <Card className="col-span-4 rounded-2xl border border-dashed border-[#D9E5DE] bg-[#FBFCFB] shadow-[0_12px_32px_rgba(15,61,46,0.035)]">
          <CardContent className="flex flex-col items-center justify-center h-[350px] text-muted-foreground text-center px-4">
            <Server className="h-12 w-12 opacity-20 mb-4" />
            <p>Upload a server log file (e.g. access.log or .gz archive)</p>
            <p className="mt-2 text-sm text-muted-foreground">to visualize your crawl budget and true human traffic.</p>
          </CardContent>
        </Card>
      )}

      {errors.length > 0 && (
         <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
           <CardHeader className="border-b border-[#E6ECE8] bg-white">
             <CardTitle className="text-red-600 flex items-center gap-2"><AlertCircle className="w-5 h-5" /> Bot Error Log (4xx / 5xx)</CardTitle>
             <CardDescription>Critical technical SEO issues that bots are wasting crawl budget on.</CardDescription>
           </CardHeader>
           <CardContent className="overflow-x-auto">
             <Table>
               <TableHeader>
                 <TableRow>
                   <TableHead>URL Path</TableHead>
                   <TableHead>Status Code</TableHead>
                   <TableHead>Crawler</TableHead>
                   <TableHead className="text-right">Hits</TableHead>
                 </TableRow>
               </TableHeader>
               <TableBody>
                 {errors.map((err, i) => (
                   <TableRow key={i}>
                     <TableCell className="font-mono text-sm max-w-[250px] truncate">{err.urlPath}</TableCell>
                     <TableCell>
                        <span className={`px-2 py-1 rounded text-xs ${err.statusCode >= 500 ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' : 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400'}`}>
                          {err.statusCode}
                        </span>
                     </TableCell>
                     <TableCell>{err.botType}</TableCell>
                     <TableCell className="text-right font-medium">{err.count}</TableCell>
                   </TableRow>
                 ))}
               </TableBody>
             </Table>
           </CardContent>
         </Card>
      )}

      {insights && (
        <div className="grid gap-4 md:grid-cols-2">
          {/* Most Crawled Pages */}
          <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
            <CardHeader className="border-b border-[#E6ECE8] bg-white">
              <CardTitle>Most Crawled Pages</CardTitle>
              <CardDescription>Where Googlebot & Bingbot spend their budget.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>URL Path</TableHead>
                    <TableHead>Crawler</TableHead>
                    <TableHead className="text-right">Hits</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {insights.mostCrawled.slice(0, 15).map((row: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-sm max-w-[200px] truncate" title={row.urlPath}>{row.urlPath}</TableCell>
                      <TableCell>{row.botType}</TableCell>
                      <TableCell className="text-right">{row.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* LLM Activity */}
          <Card className="rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
            <CardHeader className="border-b border-[#E6ECE8] bg-white">
              <CardTitle>AI / LLM Bot Traffic</CardTitle>
              <CardDescription>Pages being scraped by AI training and search bots.</CardDescription>
            </CardHeader>
            <CardContent>
              {insights.llmTraffic.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">No AI bot traffic detected in this timeframe.</div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                      <TableHead>AI Bot</TableHead>
                      <TableHead>URL Path</TableHead>
                      <TableHead className="text-right">Hits</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {insights.llmTraffic.map((row: any, i: number) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium text-purple-600 dark:text-purple-400">{row.botType}</TableCell>
                        <TableCell className="font-mono text-sm max-w-[150px] truncate">{row.urlPath}</TableCell>
                        <TableCell className="text-right">{row.count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
