import { useEffect, useState } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { GscApiService } from "@/src/services/gscService";
import { authFetch } from "@/src/lib/authFetch";
import type { GridDimension, GridRow } from "./gscGridUtils";

type UseGscGridDataParams = {
  compareDateRange?: DateRange;
  dateRange?: DateRange;
  dimension: GridDimension;
  isCompareMode?: boolean;
  siteUrl: string;
  tier?: "free" | "pro" | "enterprise";
  useLiveData?: boolean;
};

async function fetchWarehouseData(siteUrl: string, dimension: GridDimension, startDate: string, endDate: string): Promise<GridRow[]> {
  const response = await authFetch("/api/warehouse/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteUrl, startDate, endDate, dimensions: [dimension] }),
  });

  if (!response.ok) {
    throw new Error("Failed to fetch warehouse data");
  }

  const rows = await response.json();
  return rows.map((row: any) => ({
    keys: [row[dimension]],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));
}

function mergeCompareRows(primaryRows: GridRow[], compareRows: GridRow[]) {
  const compareMap = new Map(compareRows.map((row) => [row.keys[0], row]));

  return primaryRows.map((row) => {
    const compareRow = compareMap.get(row.keys[0]);
    return {
      ...row,
      compareClicks: compareRow?.clicks || 0,
      compareImpressions: compareRow?.impressions || 0,
      compareCtr: compareRow?.ctr || 0,
      comparePosition: compareRow?.position || 0,
    };
  });
}

function isGoogleAuthError(message: string) {
  return message === "UNAUTHORIZED" || message.includes("invalid authentication credentials") || message.includes("OAuth 2 access token") || message.includes("GOOGLE_NOT_CONNECTED");
}

function getFriendlyGscError(message: string) {
  if (isGoogleAuthError(message)) {
    return "Your Google data connection needs attention. Please click 'Reconnect Google Data' at the top to restore live reporting.";
  }

  if (message.includes("sufficient permission")) {
    return "You do not have sufficient permission to view data for this property. Please select a different property or verify your access in Google Search Console.";
  }

  return message;
}

export function useGscGridData({
  compareDateRange,
  dateRange,
  dimension,
  isCompareMode,
  siteUrl,
  tier,
  useLiveData = true,
}: UseGscGridDataParams) {
  const [data, setData] = useState<GridRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!siteUrl || !dateRange?.from || !dateRange?.to) {
      return;
    }

    setLoading(true);
    setError(null);

    const gscService = new GscApiService(null, tier || "free");
    const startDate = format(dateRange.from, "yyyy-MM-dd");
    const endDate = format(dateRange.to, "yyyy-MM-dd");

    const primaryPromise = useLiveData
      ? gscService.querySearchAnalytics(siteUrl, startDate, endDate, [dimension])
      : fetchWarehouseData(siteUrl, dimension, startDate, endDate);

    const comparePromise =
      isCompareMode && compareDateRange?.from && compareDateRange?.to
        ? (() => {
            const compareStartDate = format(compareDateRange.from!, "yyyy-MM-dd");
            const compareEndDate = format(compareDateRange.to!, "yyyy-MM-dd");
            return useLiveData
              ? gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, [dimension])
              : fetchWarehouseData(siteUrl, dimension, compareStartDate, compareEndDate);
          })()
        : Promise.resolve(undefined);

    primaryPromise
      .then(async (primaryRows) => {
        if (!isCompareMode || !comparePromise) {
          setData(primaryRows);
          return;
        }

        const compareResult = await comparePromise
          .then((compareRows) => ({ ok: true as const, compareRows }))
          .catch((err: Error) => {
            console.warn("Compare range failed for GSC grid; continuing with primary data only.", err);
            return { ok: false as const, error: err };
          });

        if (!compareResult.ok || !compareResult.compareRows) {
          setData(primaryRows);
          return;
        }

        setData(mergeCompareRows(primaryRows, compareResult.compareRows));
      })
      .catch((err: Error) => {
        const friendlyMessage = getFriendlyGscError(err.message);
        if (friendlyMessage === err.message) {
          console.error("Failed to fetch GSC data:", err);
        }
        setError(friendlyMessage);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [compareDateRange, dateRange, dimension, isCompareMode, siteUrl, tier, useLiveData]);

  return { data, error, loading };
}
