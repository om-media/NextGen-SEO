import { useEffect, useRef } from "react";
import { addDays, format, subDays } from "date-fns";
import { useAuth } from "@/src/contexts/AuthContext";
import { fetchDataCoverage, queueMissingCoverageSync, type DataCoverageResponse } from "@/src/services/dataCoverageService";
import type { DateRange } from "react-day-picker";

const GSC_REPORTING_LAG_DAYS = 2;
const MAX_BACKGROUND_AUTO_QUEUE_DAYS = 30;
const HISTORICAL_BACKFILL_DAYS = 480;
const HISTORICAL_QUEUE_CHUNK_DAYS = 120;
const VISIBLE_SYNC_POLL_MS = 5_000;
const VISIBLE_SYNC_MAX_POLLS = 180;

function toIsoDate(date: Date) {
  return format(date, "yyyy-MM-dd");
}

function getActiveWarehouseJobCount(coverage: DataCoverageResponse) {
  return coverage.warehouseJobs.queued + coverage.warehouseJobs.running + coverage.warehouseJobs.retrying;
}

export function GscWarehouseAutoSync({
  dateRange,
  onSyncComplete,
  siteUrl,
}: {
  dateRange?: DateRange;
  onSyncComplete?: () => void;
  siteUrl: string | null;
}) {
  const { userProfile } = useAuth();
  const queuedKeys = useRef(new Set<string>());
  const historicalQueuedKeys = useRef(new Set<string>());

  useEffect(() => {
    if (!siteUrl || !userProfile?.googleConnected) {
      return;
    }

    let cancelled = false;

    const queueMissingVisibleDays = async () => {
      const latestAvailableDate = subDays(new Date(), GSC_REPORTING_LAG_DAYS);
      const requestedStart = dateRange?.from || subDays(latestAvailableDate, 27);
      const requestedEnd = dateRange?.to && dateRange.to < latestAvailableDate ? dateRange.to : latestAvailableDate;
      const requestedStartStr = toIsoDate(requestedStart);
      const requestedEndStr = toIsoDate(requestedEnd);
      const propertyId = userProfile?.activatedGa4PropertyId || null;
      const queueKey = `${siteUrl}:${propertyId || "gsc"}:${requestedStartStr}:${requestedEndStr}`;

      if (queuedKeys.current.has(queueKey)) {
        return;
      }
      queuedKeys.current.add(queueKey);

      try {
        const queueResult = await queueMissingCoverageSync({
          endDate: requestedEndStr,
          maxDates: MAX_BACKGROUND_AUTO_QUEUE_DAYS,
          propertyId,
          siteUrl,
          startDate: requestedStartStr,
        });

        let shouldRefreshDashboardWhenSettled = queueResult.queued > 0;
        for (let pollCount = 0; pollCount < VISIBLE_SYNC_MAX_POLLS && !cancelled; pollCount += 1) {
          const coverage = await fetchDataCoverage({
            endDate: requestedEndStr,
            propertyId,
            siteUrl,
            startDate: requestedStartStr,
          });

          if (cancelled) {
            return;
          }

          const activeJobCount = getActiveWarehouseJobCount(coverage);
          if (activeJobCount > 0) {
            shouldRefreshDashboardWhenSettled = true;
          }

          if (activeJobCount === 0) {
            if (shouldRefreshDashboardWhenSettled) {
              onSyncComplete?.();
            }
            break;
          }

          await new Promise((resolve) => window.setTimeout(resolve, VISIBLE_SYNC_POLL_MS));
        }

        const historicalKey = `${siteUrl}:${propertyId || "gsc"}:historical`;
        if (historicalQueuedKeys.current.has(historicalKey)) {
          return;
        }
        historicalQueuedKeys.current.add(historicalKey);

        const oldestAvailableDate = subDays(latestAvailableDate, HISTORICAL_BACKFILL_DAYS - 1);
        for (
          let cursor = oldestAvailableDate;
          cursor <= latestAvailableDate && !cancelled;
          cursor = addDays(cursor, HISTORICAL_QUEUE_CHUNK_DAYS)
        ) {
          const chunkEnd = addDays(cursor, HISTORICAL_QUEUE_CHUNK_DAYS - 1);
          await queueMissingCoverageSync({
            endDate: toIsoDate(chunkEnd > latestAvailableDate ? latestAvailableDate : chunkEnd),
            maxDates: HISTORICAL_QUEUE_CHUNK_DAYS,
            propertyId,
            siteUrl,
            startDate: toIsoDate(cursor),
          });
        }
      } catch (err) {
        queuedKeys.current.delete(queueKey);
        historicalQueuedKeys.current.delete(`${siteUrl}:${propertyId || "gsc"}:historical`);
        // This should never block the dashboard. The visible reports still fall
        // back to live fetches when Google throttles or auth needs repair.
        console.warn("Automatic warehouse gap-fill queue skipped:", err);
      }
    };

    void queueMissingVisibleDays();

    return () => {
      cancelled = true;
    };
  }, [dateRange?.from, dateRange?.to, onSyncComplete, siteUrl, userProfile?.activatedGa4PropertyId, userProfile?.googleConnected]);

  return null;
}
