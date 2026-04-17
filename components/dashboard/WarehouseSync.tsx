import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Database, Loader2, ArrowRight, RefreshCw } from "lucide-react"
import { useAuth } from "@/src/contexts/AuthContext"
import { GscApiService } from "@/src/services/gscService"
import { subDays, format } from "date-fns"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"

export function WarehouseSync({ siteUrl }: { siteUrl: string }) {
  const { accessToken, userProfile } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState("")
  const [syncStatus, setSyncStatus] = useState<any>(null)
  
  useEffect(() => {
    if (siteUrl && isOpen) {
      fetchStatus()
    }
  }, [siteUrl, isOpen])

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/warehouse/status?siteUrl=${encodeURIComponent(siteUrl)}`)
      const data = await res.json()
      setSyncStatus(data)
    } catch (err) {
      console.error("Failed to fetch warehouse status", err)
    }
  }

  const handleSync = async () => {
    if (!accessToken) return;
    
    setIsSyncing(true)
    setProgress(0)
    setStatusText("Initializing...")
    
    try {
      const gscService = new GscApiService(accessToken, userProfile?.tier || 'free')
      const today = new Date()
      // GSC keeps 16 months of data (approx 480 days). We subtract 3 days for their reporting lag
      const maxHistory = subDays(today, 480) 
      const startOfData = subDays(today, 3) 
      
      const totalDays = 480
      let currentDate = startOfData
      let completeDays = 0

      // Process in 5-day chunks to prevent hitting the 25,000 row API limit per request
      while (currentDate >= maxHistory) {
        const chunkStart = subDays(currentDate, 4)
        const effectiveStart = chunkStart < maxHistory ? maxHistory : chunkStart
        
        const startDateStr = format(effectiveStart, 'yyyy-MM-dd')
        const endDateStr = format(currentDate, 'yyyy-MM-dd')

        setStatusText(`Fetching ${startDateStr} to ${endDateStr}...`)

        // 1. Site-level metrics
        const siteRows = await gscService.querySearchAnalytics(siteUrl, startDateStr, endDateStr, ['date'], undefined, true)
        if (siteRows && siteRows.length > 0) {
          await fetch('/api/warehouse/ingest/site', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteUrl, rows: siteRows })
          })
        }

        // 2. Query-level metrics
        const queryRows = await gscService.querySearchAnalytics(siteUrl, startDateStr, endDateStr, ['date', 'query'], undefined, true)
        if (queryRows && queryRows.length > 0) {
          await fetch('/api/warehouse/ingest/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteUrl, rows: queryRows })
          })
        }

        // 3. Page+Query-level metrics
        const pageQueryRows = await gscService.querySearchAnalytics(siteUrl, startDateStr, endDateStr, ['date', 'page', 'query'], undefined, true)
        if (pageQueryRows && pageQueryRows.length > 0) {
          await fetch('/api/warehouse/ingest/page_query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteUrl, rows: pageQueryRows })
          })
        }

        const exactDaysProcessed = Math.round((currentDate.getTime() - effectiveStart.getTime()) / (24 * 60 * 60 * 1000)) + 1
        completeDays += exactDaysProcessed
        setProgress(Math.min(100, Math.round((completeDays / totalDays) * 100)))

        currentDate = subDays(effectiveStart, 1)
      }

      // Update sync status
      const completedStatus = {
        siteUrl,
        lastSyncDate: format(today, 'yyyy-MM-dd'),
        earliestSyncDate: format(maxHistory, 'yyyy-MM-dd'),
        status: 'synced'
      }
      
      await fetch('/api/warehouse/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(completedStatus)
      })
      
      setSyncStatus(completedStatus)
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
            {syncStatus?.earliestSyncDate && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Historical Limit:</span>
                <span>{syncStatus.earliestSyncDate}</span>
              </div>
            )}
            {syncStatus?.lastUpdated && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Last Updated:</span>
                <span>{format(new Date(syncStatus.lastUpdated), 'MMM d, yyyy h:mm a')}</span>
              </div>
            )}
          </div>

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
              {syncStatus?.status === 'synced' ? 'Re-sync Data' : 'Start Initial Sync'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
