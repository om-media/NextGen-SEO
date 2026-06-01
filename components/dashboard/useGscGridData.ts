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
  dimensionFilterGroups?: any[];
  isCompareMode?: boolean;
  refreshKey?: number;
  siteUrl: string;
  tier?: "free" | "pro" | "enterprise";
  useLiveData?: boolean;
};

function toFiniteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function fetchWarehouseData(
  siteUrl: string,
  dimension: GridDimension,
  startDate: string,
  endDate: string,
  dimensionFilterGroups?: any[],
): Promise<GridRow[]> {
  const allRows: any[] = [];
  const rowLimit = 50000;
  let startRow = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await authFetch("/api/warehouse/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteUrl, startDate, endDate, dimensions: [dimension], dimensionFilterGroups, rowLimit, startRow }),
    });

    if (!response.ok) {
      throw new Error("Failed to fetch warehouse data");
    }

    const rows = await response.json();
    const pageRows = Array.isArray(rows) ? rows : [];
    allRows.push(...pageRows);
    hasMore = pageRows.length === rowLimit;
    startRow += rowLimit;
  }

  return allRows.map((row: any) => ({
    keys: [row[dimension]],
    clicks: toFiniteNumber(row.clicks),
    impressions: toFiniteNumber(row.impressions),
    ctr: toFiniteNumber(row.ctr),
    position: toFiniteNumber(row.position),
    queryCount: row.queryCount === undefined ? undefined : toFiniteNumber(row.queryCount),
  })).filter((row: GridRow) => typeof row.keys?.[0] === "string" && row.keys[0].length > 0);
}

async function fetchWarehousePageQueryRows(siteUrl: string, startDate: string, endDate: string): Promise<GridRow[]> {
  const allRows: any[] = [];
  const rowLimit = 50000;
  let startRow = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await authFetch("/api/warehouse/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteUrl, startDate, endDate, dimensions: ["page", "query"], rowLimit, startRow }),
    });

    if (!response.ok) {
      throw new Error("Failed to fetch warehouse page query data");
    }

    const rows = await response.json();
    const pageRows = Array.isArray(rows) ? rows : [];
    allRows.push(...pageRows);
    hasMore = pageRows.length === rowLimit;
    startRow += rowLimit;
  }

  return allRows.map((row: any) => ({
    keys: [row.page, row.query],
    clicks: toFiniteNumber(row.clicks),
    impressions: toFiniteNumber(row.impressions),
    ctr: toFiniteNumber(row.ctr),
    position: toFiniteNumber(row.position),
  })).filter((row: GridRow) => typeof row.keys?.[0] === "string" && typeof row.keys?.[1] === "string");
}

function getPageQueryCounts(rows: GridRow[]) {
  const pageQueries = new Map<string, Set<string>>();

  rows.forEach((row) => {
    const page = row.keys?.[0];
    const query = row.keys?.[1];
    if (!page || !query) return;
    if (!pageQueries.has(page)) pageQueries.set(page, new Set());
    pageQueries.get(page)!.add(query);
  });

  return new Map(Array.from(pageQueries.entries()).map(([page, queries]) => [page, queries.size]));
}

function mergePageQueryCounts(primaryRows: GridRow[], queryCounts: Map<string, number>, compareQueryCounts?: Map<string, number>) {
  return primaryRows.map((row) => {
    const page = row.keys[0];
    return {
      ...row,
      queryCount: row.queryCount ?? queryCounts.get(page) ?? 0,
      compareQueryCount: compareQueryCounts?.get(page) ?? 0,
    };
  });
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
  if (message === "WAREHOUSE_UNSUPPORTED_DIMENSION") {
    return "This Search Console breakdown is not warehoused yet. Use the Queries and Pages tabs for stored dashboard data.";
  }

  if (isGoogleAuthError(message)) {
    return "Your Google data connection needs attention. Please click 'Reconnect Google Data' at the top to restore reporting access.";
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
  dimensionFilterGroups,
  isCompareMode,
  refreshKey = 0,
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

    const canUseWarehouse = dimension === "query" || dimension === "page";
    if (!useLiveData && !canUseWarehouse) {
      setData([]);
      setError(getFriendlyGscError("WAREHOUSE_UNSUPPORTED_DIMENSION"));
      setLoading(false);
      return;
    }

    const shouldUseLiveApi = Boolean(useLiveData);

    const primaryPromise = shouldUseLiveApi
      ? gscService.querySearchAnalytics(siteUrl, startDate, endDate, [dimension], dimensionFilterGroups, true)
      : fetchWarehouseData(siteUrl, dimension, startDate, endDate, dimensionFilterGroups);

    const comparePromise =
      isCompareMode && compareDateRange?.from && compareDateRange?.to
        ? (() => {
            const compareStartDate = format(compareDateRange.from!, "yyyy-MM-dd");
            const compareEndDate = format(compareDateRange.to!, "yyyy-MM-dd");
            return shouldUseLiveApi
              ? gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, [dimension], dimensionFilterGroups, true)
              : fetchWarehouseData(siteUrl, dimension, compareStartDate, compareEndDate, dimensionFilterGroups);
          })()
        : Promise.resolve(undefined);

    const pageQueryCountPromise =
      dimension === "page"
        ? (shouldUseLiveApi
            ? gscService.querySearchAnalytics(siteUrl, startDate, endDate, ["page", "query"], undefined, true)
            : fetchWarehousePageQueryRows(siteUrl, startDate, endDate))
        : Promise.resolve(undefined);

    const comparePageQueryCountPromise =
      dimension === "page" && isCompareMode && compareDateRange?.from && compareDateRange?.to
        ? (() => {
            const compareStartDate = format(compareDateRange.from!, "yyyy-MM-dd");
            const compareEndDate = format(compareDateRange.to!, "yyyy-MM-dd");
            return shouldUseLiveApi
              ? gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, ["page", "query"], undefined, true)
              : fetchWarehousePageQueryRows(siteUrl, compareStartDate, compareEndDate);
          })()
        : Promise.resolve(undefined);

    primaryPromise
      .then(async (primaryRows) => {
        let rowsWithPageQueryCounts = primaryRows;

        if (dimension === "page") {
          const [pageQueryRows, comparePageQueryRows] = await Promise.all([
            pageQueryCountPromise.catch((err: Error) => {
              console.warn("Page query counts failed; continuing with page metrics only.", err);
              return undefined;
            }),
            comparePageQueryCountPromise.catch((err: Error) => {
              console.warn("Compare page query counts failed; continuing without compare query counts.", err);
              return undefined;
            }),
          ]);

          rowsWithPageQueryCounts = mergePageQueryCounts(
            primaryRows,
            pageQueryRows ? getPageQueryCounts(pageQueryRows) : new Map(),
            comparePageQueryRows ? getPageQueryCounts(comparePageQueryRows) : undefined,
          );
        }

        if (!isCompareMode || !comparePromise) {
          setData(rowsWithPageQueryCounts);
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

        setData(mergeCompareRows(rowsWithPageQueryCounts, compareResult.compareRows));
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
  }, [compareDateRange, dateRange, dimension, dimensionFilterGroups, isCompareMode, refreshKey, siteUrl, tier, useLiveData]);

  return { data, error, loading };
}
