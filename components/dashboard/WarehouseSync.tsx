import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Database, Loader2, ArrowRight, RefreshCw } from "lucide-react"
import { useAuth } from "@/src/contexts/AuthContext"
import { addDays, differenceInCalendarDays, subDays, format } from "date-fns"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { authFetch } from "@/src/lib/authFetch"
import { queueMissingCoverageSync } from "@/src/services/dataCoverageService"

const MAX_QUEUE_DAYS_PER_REQUEST = 120

export function WarehouseSync({ onSyncComplete, siteUrl }: { onSyncComplete?: () => void; siteUrl: string }) {
  const { userProfile } = useAuth()
  const googleConnected = Boolean(userProfile?.googleConnected)
  const ga4PropertyId = userProfile?.activatedGa4PropertyId || null
  const [isOpen, setIsOpen] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState("")
  const [syncStatus, setSyncStatus] = useState<any>(null)
  const [warehouseJobs, setWarehouseJobs] = useState<any[]>([])
  const [isQueueingDailySync, setIsQueueingDailySync] = useState(false)
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

  useEffect(() => {
    if (!isOpen || warehouseJobs.every((job) => !['queued', 'retrying', 'running'].includes(String(job.status)))) {
      return
    }

    const timer = window.setInterval(() => {
      fetchStatus()
      onSyncComplete?.()
    }, 5000)

    return () => window.clearInterval(timer)
  }, [isOpen, warehouseJobs, onSyncComplete])

  const fetchStatus = async () => {
    try {
      const res = await authFetch(`/api/warehouse/status?siteUrl=${encodeURIComponent(siteUrl)}`)
      const data = await res.json()
      setSyncStatus(data)
      const jobsRes = await authFetch(`/api/warehouse/jobs?siteUrl=${encodeURIComponent(siteUrl)}&limit=5`)
      const jobsData = await jobsRes.json().catch(() => null)
      if (jobsRes.ok) setWarehouseJobs(Array.isArray(jobsData?.jobs) ? jobsData.jobs : [])
    } catch (err) {
      console.error("Failed to fetch warehouse status", err)
    }
  }

  const handleQueueDailySync = async () => {
    if (!googleConnected) return
    setIsQueueingDailySync(true)
    try {
      const targetDate = format(subDays(new Date(), 2), 'yyyy-MM-dd')
      await queueMissingCoverageSync({
        endDate: targetDate,
        maxDates: 1,
        propertyId: ga4PropertyId,
        siteUrl,
        startDate: targetDate,
      })
      await fetchStatus()
      onSyncComplete?.()
    } catch (err: any) {
      setStatusText('Error: ' + (err.message || 'Failed to queue sync job'))
    } finally {
      setIsQueueingDailySync(false)
    }
  }

  const handleSync = async () => {
    if (!googleConnected) return;
    
    setIsSyncing(true)
    setProgress(0)
    setStatusText("Queueing historical sync jobs...")
    
    try {
      const today = new Date()
      const oldestAvailable = subDays(today, 480)
      const latestAvailable = subDays(today, 2)
      const totalDays = differenceInCalendarDays(latestAvailable, oldestAvailable) + 1
      let cursor = oldestAvailable
      let completeDays = 0
      let queuedJobs = 0

      while (cursor <= latestAvailable) {
        const chunkEnd = addDays(cursor, MAX_QUEUE_DAYS_PER_REQUEST - 1)
        const effectiveEnd = chunkEnd > latestAvailable ? latestAvailable : chunkEnd
        const startDate = format(cursor, 'yyyy-MM-dd')
        const endDate = format(effectiveEnd, 'yyyy-MM-dd')
        setStatusText(`Queueing missing warehouse data for ${startDate} to ${endDate}...`)

        const result = await queueMissingCoverageSync({
          endDate,
          maxDates: MAX_QUEUE_DAYS_PER_REQUEST,
          propertyId: ga4PropertyId,
          siteUrl,
          startDate,
        })
        queuedJobs += result.queued || 0

        const exactDaysProcessed = differenceInCalendarDays(effectiveEnd, cursor) + 1
        completeDays += exactDaysProcessed
        setProgress(Math.min(100, Math.round((completeDays / totalDays) * 100)))
        cursor = addDays(effectiveEnd, 1)
      }

      await fetchStatus()
      onSyncComplete?.()
      setStatusText(queuedJobs > 0 ? `Queued ${queuedJobs} sync jobs.` : "Warehouse coverage is already queued or complete.")
      
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
            Queue durable server jobs for GSC and GA4 warehouse data. The app stores raw rows so reports, exports, and reconciliation do not depend on browser exports.
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
            <div className="space-y-2">
              <Button onClick={handleQueueDailySync} variant="outline" className="w-full gap-2" disabled={isQueueingDailySync || !googleConnected}>
                {isQueueingDailySync ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Queue latest daily sync
              </Button>
              <Button onClick={handleSync} className="w-full gap-2">
                <RefreshCw className="h-4 w-4" />
                {hasFullBackfill ? 'Check 16-month coverage' : 'Fill 16-month gaps'}
              </Button>
            </div>
          )}

          {warehouseJobs.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-3 text-sm">
              <div className="mb-2 font-medium">Recent sync jobs</div>
              <div className="space-y-1.5 text-xs text-muted-foreground">
                {warehouseJobs.map((job) => (
                  <div key={job.id} className="flex items-center justify-between gap-3">
                    <span>{job.targetDate}</span>
                    <span>{job.status} {job.rowsSynced ? `(${job.rowsSynced} rows)` : ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
