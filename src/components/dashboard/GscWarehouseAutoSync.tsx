import { useEffect, useRef } from "react";
import { format, subDays } from "date-fns";
import { useAuth } from "@/src/contexts/AuthContext";
import { queueMissingCoverageSync } from "@/src/services/dataCoverageService";
import type { DateRange } from "react-day-picker";

const GSC_REPORTING_LAG_DAYS = 2;
const MAX_BACKGROUND_AUTO_QUEUE_DAYS = 30;

function toIsoDate(date: Date) {
  return format(date, "yyyy-MM-dd");
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
        await queueMissingCoverageSync({
          endDate: requestedEndStr,
          maxDates: MAX_BACKGROUND_AUTO_QUEUE_DAYS,
          propertyId,
          siteUrl,
          startDate: requestedStartStr,
        });

        if (!cancelled) {
          onSyncComplete?.();
        }
      } catch (err) {
        queuedKeys.current.delete(queueKey);
        // This should never block the dashboard. The coverage panel and Sync Data
        // dialog expose manual recovery when Google throttles or auth needs repair.
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
