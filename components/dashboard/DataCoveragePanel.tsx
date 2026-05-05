import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { AlertCircle, CheckCircle2, Database, Loader2, RefreshCw } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchDataCoverage, queueMissingCoverageSync, retryFailedCoverageSync, type CoverageDataset, type DataCoverageResponse } from "@/src/services/dataCoverageService";
import { toast } from "sonner";

type DataCoveragePanelProps = {
  dateRange: DateRange;
  ga4PropertyId?: string | null;
  siteUrl: string;
};

const formatNumber = (value: number | null | undefined) => new Intl.NumberFormat("en-US").format(Number(value || 0));
const formatPercent = (value: number | null | undefined) => `${Math.round(Number(value || 0) * 100)}%`;

function toIsoDate(value: Date | undefined, fallback: Date) {
  return format(value || fallback, "yyyy-MM-dd");
}

function getTone(dataset: CoverageDataset) {
  if (dataset.expectedDateCount === 0) return "text-muted-foreground";
  if (dataset.coverageRatio >= 0.98) return "text-emerald-700";
  if (dataset.coverageRatio >= 0.75) return "text-amber-700";
  return "text-red-700";
}

function DatasetCard({ dataset, label }: { dataset: CoverageDataset; label: string }) {
  const tone = getTone(dataset);
  return (
    <div className="rounded-2xl border border-border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
          <p className={`mt-3 text-2xl font-semibold tracking-[-0.03em] ${tone}`}>{formatPercent(dataset.coverageRatio)}</p>
        </div>
        {dataset.coverageRatio >= 0.98 ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
        ) : (
          <AlertCircle className={`h-5 w-5 ${tone}`} />
        )}
      </div>
      <div className="mt-3 space-y-1 text-sm text-muted-foreground">
        <div>{formatNumber(dataset.totalRows)} rows</div>
        <div>
          {formatNumber(dataset.coveredDateCount)} of {formatNumber(dataset.expectedDateCount)} days covered
        </div>
        {dataset.missingDateCount > 0 && (
          <div title={dataset.missingDates.join(", ")}>
            {formatNumber(dataset.missingDateCount)} missing days
          </div>
        )}
      </div>
    </div>
  );
}

function JobStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2">
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{formatNumber(value)}</div>
    </div>
  );
}

export function DataCoveragePanel({ dateRange, ga4PropertyId, siteUrl }: DataCoveragePanelProps) {
  const [coverage, setCoverage] = useState<DataCoverageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [queueingMissing, setQueueingMissing] = useState(false);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startDate = useMemo(() => toIsoDate(dateRange?.from, new Date()), [dateRange?.from]);
  const endDate = useMemo(() => toIsoDate(dateRange?.to, new Date()), [dateRange?.to]);

  const load = async () => {
    if (!siteUrl) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDataCoverage({
        endDate,
        propertyId: ga4PropertyId || null,
        siteUrl,
        startDate,
      });
      setCoverage(result);
    } catch (err: any) {
      setError(err.message || "Failed to load data coverage");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endDate, ga4PropertyId, siteUrl, startDate]);

  const missingWarehouseDays = coverage
    ? Math.max(
      coverage.gsc.site.missingDateCount,
      coverage.gsc.query.missingDateCount,
      coverage.gsc.pageQuery.missingDateCount,
      coverage.ga4.enabled ? coverage.ga4.pages.missingDateCount : 0,
    )
    : 0;
  const failedWarehouseJobs = coverage?.warehouseJobs.error || 0;

  const handleQueueMissing = async () => {
    if (!siteUrl) return;
    setQueueingMissing(true);
    setError(null);
    try {
      const result = await queueMissingCoverageSync({
        endDate,
        maxDates: 60,
        propertyId: ga4PropertyId || null,
        siteUrl,
        startDate,
      });
      toast.success("Warehouse gap fill queued", {
        description: `${formatNumber(result.queued)} daily sync job${result.queued === 1 ? "" : "s"} queued${result.remainingMissingDates ? `, ${formatNumber(result.remainingMissingDates)} still pending` : ""}.`,
      });
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to queue missing sync jobs");
      toast.error("Gap fill failed", { description: err.message || "Unable to queue missing sync jobs." });
    } finally {
      setQueueingMissing(false);
    }
  };

  const handleRetryFailed = async () => {
    if (!siteUrl) return;
    setRetryingFailed(true);
    setError(null);
    try {
      const result = await retryFailedCoverageSync({
        endDate,
        maxJobs: 60,
        siteUrl,
        startDate,
      });
      toast.success("Failed sync jobs retried", {
        description: `${formatNumber(result.retried)} failed job${result.retried === 1 ? "" : "s"} returned to the queue${result.remainingFailedJobs ? `, ${formatNumber(result.remainingFailedJobs)} still failed` : ""}.`,
      });
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to retry failed sync jobs");
      toast.error("Retry failed", { description: err.message || "Unable to retry failed sync jobs." });
    } finally {
      setRetryingFailed(false);
    }
  };

  return (
    <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
      <CardHeader className="flex flex-col gap-4 border-b border-border lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <CardTitle>Data coverage</CardTitle>
          </div>
          <CardDescription className="mt-2 max-w-3xl">
            Coverage checks for the selected range. This is the trust layer for replacing spreadsheet exports.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          {coverage && missingWarehouseDays > 0 && (
            <Button className="rounded-xl" disabled={queueingMissing} onClick={handleQueueMissing}>
              {queueingMissing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Queue missing sync
            </Button>
          )}
          {coverage && failedWarehouseJobs > 0 && (
            <Button className="rounded-xl" variant="outline" disabled={retryingFailed} onClick={handleRetryFailed}>
              {retryingFailed ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Retry failed sync
            </Button>
          )}
          <Button className="rounded-xl" variant="outline" disabled={loading} onClick={load}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh coverage
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <AlertCircle className="mr-2 inline h-4 w-4" />
            {error}
          </div>
        )}

        {loading && !coverage ? (
          <div className="rounded-2xl border border-border bg-background p-6 text-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
            Checking warehouse coverage...
          </div>
        ) : coverage ? (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <DatasetCard label="GSC site/date" dataset={coverage.gsc.site} />
              <DatasetCard label="GSC query/date" dataset={coverage.gsc.query} />
              <DatasetCard label="GSC page+query/date" dataset={coverage.gsc.pageQuery} />
              <DatasetCard label={coverage.ga4.enabled ? "GA4 landing pages" : "GA4 not connected"} dataset={coverage.ga4.pages} />
            </div>
            <div className="rounded-2xl border border-border bg-background p-4">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-foreground">Warehouse sync jobs in this range</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Gap fills and scheduled daily syncs that are already queued, running, retried, failed, or completed.
                  </p>
                </div>
                {coverage.warehouseJobs.total > 0 && (
                  <div className="text-sm text-muted-foreground">{formatNumber(coverage.warehouseJobs.total)} total jobs</div>
                )}
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                <JobStat label="Queued" value={coverage.warehouseJobs.queued} />
                <JobStat label="Running" value={coverage.warehouseJobs.running} />
                <JobStat label="Retrying" value={coverage.warehouseJobs.retrying} />
                <JobStat label="Completed" value={coverage.warehouseJobs.completed} />
                <JobStat label="Failed" value={coverage.warehouseJobs.error} />
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-background p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-foreground">Latest crawl inventory</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {coverage.crawl
                      ? `${coverage.crawl.status} run with ${formatNumber(coverage.crawl.summary.totalPages)} pages`
                      : "No crawl inventory exists for this site yet."}
                  </p>
                </div>
                {coverage.crawl && (
                  <div className="text-sm text-muted-foreground">
                    {coverage.crawl.updatedAt || coverage.crawl.completedAt || coverage.crawl.startedAt || ""}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
