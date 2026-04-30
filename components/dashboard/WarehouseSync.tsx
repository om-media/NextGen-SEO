import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Database, Loader2, ArrowRight, RefreshCw } from "lucide-react"
import { useAuth } from "@/src/contexts/AuthContext"
import { GscApiService, type GscSearchAnalyticsRow } from "@/src/services/gscService"
import { Ga4ApiService, type Ga4DataRow } from "@/src/services/ga4Service"
import { addDays, differenceInCalendarDays, subDays, format } from "date-fns"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { authFetch } from "@/src/lib/authFetch"

export function WarehouseSync({ onSyncComplete, siteUrl }: { onSyncComplete?: () => void; siteUrl: string }) {
  const { userProfile } = useAuth()
  const googleConnected = Boolean(userProfile?.googleConnected)
  const ga4PropertyId = userProfile?.activatedGa4PropertyId || null
  const [isOpen, setIsOpen] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState("")
  const [syncStatus, setSyncStatus] = useState<any>(null)
  const gscHistoryStart = format(subDays(new Date(), 480), 'yyyy-MM-dd')
  const earliestStoredDate = syncStatus?.earliestMetricDate || syncStatus?.earliestSyncDate || null
  const syncedThroughDate = syncStatus?.lastMetricDate || syncStatus?.lastSyncDate || null
  const storedDayCount = Number(syncStatus?.metricDayCount || 0)
  const hasFullBackfill = Boolean(earliestStoredDate && earliestStoredDate <= gscHistoryStart)
  
  useEffect(() => {
    if (siteUrl && isOpen) {
      fetchStatus()
    }
  }, [siteUrl, isOpen])

  const fetchStatus = async () => {
    try {
      const res = await authFetch(`/api/warehouse/status?siteUrl=${encodeURIComponent(siteUrl)}`)
      const data = await res.json()
      setSyncStatus(data)
    } catch (err) {
      console.error("Failed to fetch warehouse status", err)
    }
  }

  const ingestRows = async (
    endpoint: string,
    rows: GscSearchAnalyticsRow[],
    options: { replaceDates?: string[] } = {},
  ) => {
    if (rows.length === 0 && !options.replaceDates?.length) return

    await authFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteUrl, rows, ...options })
    })
  }

  const ingestGa4PageRows = async (rows: Ga4DataRow[], replaceDates: string[] = []) => {
    if (!ga4PropertyId || (rows.length === 0 && replaceDates.length === 0)) return

    await authFetch('/api/warehouse/ingest/ga4-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        propertyId: ga4PropertyId,
        siteUrl,
        replaceDates,
        rows: rows.map((row) => ({
          date: row.dimensionValues?.[0]?.value?.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
          pagePath: row.dimensionValues?.[1]?.value || '/',
          sessions: row.metricValues?.[0]?.value || 0,
          totalUsers: row.metricValues?.[1]?.value || 0,
          pageViews: row.metricValues?.[2]?.value || 0,
          bounceRate: row.metricValues?.[3]?.value || 0,
          eventCount: row.metricValues?.[4]?.value || 0,
        })),
      })
    })
  }

  const eachDateInRange = (start: Date, end: Date) => {
    const dates: string[] = []
    let current = start
    while (current <= end) {
      dates.push(format(current, 'yyyy-MM-dd'))
      current = addDays(current, 1)
    }
    return dates
  }

  const handleSync = async () => {
    if (!googleConnected) return;
    
    setIsSyncing(true)
    setProgress(0)
    setStatusText("Initializing...")
    
    try {
      const gscService = new GscApiService(null, 'enterprise')
      const ga4Service = ga4PropertyId ? new Ga4ApiService() : null
      const today = new Date()
      // GSC keeps 16 months of data (approx 480 days). Two days is the normal
      // reporting lag, and Search Console often has that date before day three.
      const maxHistory = subDays(today, 480) 
      const startOfData = subDays(today, 2) 
      
      const totalDays = 480
      let currentDate = startOfData
      let completeDays = 0
      let latestMetricDateSynced: string | null = null

      // Process in 5-day chunks to prevent hitting the 25,000 row API limit per request
      while (currentDate >= maxHistory) {
        const chunkStart = subDays(currentDate, 4)
        const effectiveStart = chunkStart < maxHistory ? maxHistory : chunkStart
        
        const startDateStr = format(effectiveStart, 'yyyy-MM-dd')
        const endDateStr = format(currentDate, 'yyyy-MM-dd')

        setStatusText(`Fetching ${startDateStr} to ${endDateStr}...`)

        // 1. Site-level metrics can be fetched safely in chunks because it is one row per day.
        const siteRows = await gscService.querySearchAnalytics(siteUrl, startDateStr, endDateStr, ['date'], undefined, true)
        if (siteRows && siteRows.length > 0) {
          latestMetricDateSynced = siteRows.reduce((latest, row) => {
            const date = row.keys[0]
            return !latest || date > latest ? date : latest
          }, latestMetricDateSynced)
          await ingestRows('/api/warehouse/ingest/site', siteRows)
        }

        if (ga4Service && ga4PropertyId) {
          setStatusText(`Fetching GA4 landing pages for ${startDateStr} to ${endDateStr}...`)
          const ga4PageRows = await ga4Service.runReport(
            ga4PropertyId,
            startDateStr,
            endDateStr,
            ['date', 'landingPagePlusQueryString'],
            ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount'],
          )
          await ingestGa4PageRows(ga4PageRows.rows || [], eachDateInRange(effectiveStart, currentDate))
        }

        // Query-level datasets must be fetched one day at a time. Multi-day
        // date+query/page+query requests are capped by GSC and create fake spikes.
        for (const date of eachDateInRange(effectiveStart, currentDate)) {
          setStatusText(`Fetching complete query data for ${date}...`)
          const [queryRows, pageQueryRows] = await Promise.all([
            gscService.querySearchAnalytics(siteUrl, date, date, ['date', 'query'], undefined, true),
            gscService.querySearchAnalytics(siteUrl, date, date, ['date', 'page', 'query'], undefined, true),
          ])

          await ingestRows('/api/warehouse/ingest/query', queryRows, { replaceDates: [date] })
          await ingestRows('/api/warehouse/ingest/page_query', pageQueryRows, { replaceDates: [date] })
        }

        const exactDaysProcessed = Math.round((currentDate.getTime() - effectiveStart.getTime()) / (24 * 60 * 60 * 1000)) + 1
        completeDays += exactDaysProcessed
        setProgress(Math.min(100, Math.round((completeDays / totalDays) * 100)))

        currentDate = subDays(effectiveStart, 1)
      }

      // Update sync status
      const completedStatus = {
        siteUrl,
        lastMetricDate: latestMetricDateSynced,
        lastSyncDate: latestMetricDateSynced || format(startOfData, 'yyyy-MM-dd'),
        earliestSyncDate: format(maxHistory, 'yyyy-MM-dd'),
        status: 'synced'
      }
      
      await authFetch('/api/warehouse/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(completedStatus)
      })
      
      setSyncStatus(completedStatus)
      await fetchStatus()
      onSyncComplete?.()
      setStatusText("Sync Complete!")
      
      setTimeout(() => {
        setIsOpen(false)
        setIsSyncing(false)
      }, 2000)

    } catch (err: any) {
      console.error(err)
      setStatusText('Error: ' + err.message)
      setIsSyncing(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="gap-2 whitespace-nowrap" />}>
        <Database className="h-4 w-4" />
        Sync Data
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Data Warehouse Sync</DialogTitle>
          <DialogDescription>
            Download up to 16 months of historical data from Google Search Console directly to your local database. This enables lifetime data retention.
          </DialogDescription>
        </DialogHeader>
        
        <div className="py-4 space-y-4">
          <div className="bg-muted p-4 rounded-lg space-y-2">
            <div className="flex justify-between items-center text-sm">
              <span className="font-medium">Current Status:</span>
              <span className={syncStatus?.status === 'synced' ? 'text-green-600 font-semibold' : 'text-amber-600 font-semibold'}>
                {syncStatus?.status === 'synced' ? 'Synced' : 'Uninitialized'}
              </span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-muted-foreground">GSC available from:</span>
              <span>{gscHistoryStart}</span>
            </div>
            {earliestStoredDate && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Earliest stored date:</span>
                <span>{earliestStoredDate}</span>
              </div>
            )}
            {storedDayCount > 0 && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Stored days:</span>
                <span>{storedDayCount}</span>
              </div>
            )}
            {syncedThroughDate && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Synced Through:</span>
                <span>{format(new Date(syncedThroughDate), 'MMM d, yyyy')}</span>
              </div>
            )}
            {syncStatus?.lastUpdated && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Last Updated:</span>
                <span>{format(new Date(syncStatus.lastUpdated), 'MMM d, yyyy h:mm a')}</span>
              </div>
            )}
          </div>

          {!hasFullBackfill && earliestStoredDate && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Your dashboard has {storedDayCount || differenceInCalendarDays(new Date(), new Date(earliestStoredDate))} stored days right now. Run the 16-month backfill to import the rest of the Search Console history into the warehouse.
            </div>
          )}

          {isSyncing ? (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>{statusText}</span>
                <span className="font-medium">{progress}%</span>
              </div>
              <Progress value={progress} />
            </div>
          ) : (
            <Button onClick={handleSync} className="w-full gap-2">
              <RefreshCw className="h-4 w-4" />
              {hasFullBackfill ? 'Re-sync 16 months' : 'Backfill 16 months'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
