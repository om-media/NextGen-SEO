import { useEffect, useRef } from "react";
import { addDays, differenceInCalendarDays, format, parseISO, subDays } from "date-fns";
import { useAuth } from "@/src/contexts/AuthContext";
import { authFetch } from "@/src/lib/authFetch";
import { GscApiService, type GscSearchAnalyticsRow } from "@/src/services/gscService";
import type { DateRange } from "react-day-picker";

const GSC_REPORTING_LAG_DAYS = 2;
const MAX_BACKGROUND_AUTO_SYNC_DAYS = 90;

function toIsoDate(date: Date) {
  return format(date, "yyyy-MM-dd");
}

async function ingestRows(
  endpoint: string,
  siteUrl: string,
  rows: GscSearchAnalyticsRow[],
  options: { replaceDates?: string[] } = {},
) {
  if (rows.length === 0 && !options.replaceDates?.length) {
    return;
  }

  await authFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteUrl, rows, ...options }),
  });
}

function eachDateInRange(start: Date, end: Date) {
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    dates.push(toIsoDate(cursor));
    cursor = addDays(cursor, 1);
  }
  return dates;
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
  const syncedKeys = useRef(new Set<string>());

  useEffect(() => {
    if (!siteUrl || !userProfile?.googleConnected) {
      return;
    }

    let cancelled = false;

    const syncMissingRecentDays = async () => {
      const latestAvailableDate = subDays(new Date(), GSC_REPORTING_LAG_DAYS);
      const requestedStart = dateRange?.from || subDays(latestAvailableDate, 27);
      const requestedEnd = dateRange?.to && dateRange.to < latestAvailableDate ? dateRange.to : latestAvailableDate;
      const requestedStartStr = toIsoDate(requestedStart);
      const requestedEndStr = toIsoDate(requestedEnd);
      const syncKey = `${siteUrl}:${requestedStartStr}:${requestedEndStr}`;

      if (syncedKeys.current.has(syncKey)) {
        return;
      }

      try {
        const statusResponse = await authFetch(`/api/warehouse/status?siteUrl=${encodeURIComponent(siteUrl)}`);
        if (!statusResponse.ok) {
          return;
        }

        const status = await statusResponse.json();
        const latestCachedDate = status.lastMetricDate || null;
        const earliestCachedDate = status.earliestMetricDate || status.earliestSyncDate || null;

        const visibleRangeIsCached =
          earliestCachedDate &&
          latestCachedDate &&
          earliestCachedDate <= requestedStartStr &&
          latestCachedDate >= requestedEndStr;

        if (visibleRangeIsCached) {
          syncedKeys.current.add(syncKey);
          return;
        }

        const missingStartsBeforeCache = !earliestCachedDate || earliestCachedDate > requestedStartStr;
        const uncappedStart = missingStartsBeforeCache
          ? requestedStart
          : latestCachedDate
            ? addDays(parseISO(latestCachedDate), 1)
            : requestedStart;
        const daysToSync = Math.max(1, differenceInCalendarDays(requestedEnd, uncappedStart) + 1);
        const startDate = daysToSync > MAX_BACKGROUND_AUTO_SYNC_DAYS
          ? subDays(requestedEnd, MAX_BACKGROUND_AUTO_SYNC_DAYS - 1)
          : uncappedStart;

        if (startDate > requestedEnd) {
          syncedKeys.current.add(syncKey);
          return;
        }

        const startDateStr = toIsoDate(startDate);
        const gscService = new GscApiService(null, "enterprise");

        const siteRows = await gscService.querySearchAnalytics(siteUrl, startDateStr, requestedEndStr, ["date"], undefined, true);

        if (cancelled) {
          return;
        }

        await ingestRows("/api/warehouse/ingest/site", siteUrl, siteRows);

        for (const date of eachDateInRange(startDate, requestedEnd)) {
          if (cancelled) {
            return;
          }

          const [queryRows, pageQueryRows] = await Promise.all([
            gscService.querySearchAnalytics(siteUrl, date, date, ["date", "query"], undefined, true),
            gscService.querySearchAnalytics(siteUrl, date, date, ["date", "page", "query"], undefined, true),
          ]);

          await ingestRows("/api/warehouse/ingest/query", siteUrl, queryRows, { replaceDates: [date] });
          await ingestRows("/api/warehouse/ingest/page_query", siteUrl, pageQueryRows, { replaceDates: [date] });
        }

        const latestMetricDateSynced = siteRows.reduce<string | null>((latest, row) => {
          const date = row.keys[0];
          return !latest || date > latest ? date : latest;
        }, status.lastMetricDate || null);

        if (latestMetricDateSynced) {
          await authFetch("/api/warehouse/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              siteUrl,
              lastSyncDate: latestMetricDateSynced,
              status: "synced",
            }),
          });
        }

        syncedKeys.current.add(syncKey);
        onSyncComplete?.();
      } catch (err) {
        // This should never block the dashboard. Live data still works, and manual
        // Sync Data remains available if Google throttles a background refresh.
        console.warn("Automatic GSC warehouse refresh skipped:", err);
      }
    };

    void syncMissingRecentDays();

    return () => {
      cancelled = true;
    };
  }, [dateRange?.from, dateRange?.to, onSyncComplete, siteUrl, userProfile?.googleConnected, userProfile?.tier]);

  return null;
}
