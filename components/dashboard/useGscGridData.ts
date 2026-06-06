import { useEffect, useState } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { GscApiService } from "@/src/services/gscService";
import { fetchDataCoverage, type CoverageDataset } from "@/src/services/dataCoverageService";
import { fetchCachedWarehouseQuery } from "@/src/services/warehouseQueryClient";
import type { GridDimension, GridRow } from "./gscGridUtils";

type UseGscGridDataParams = {
  compareDateRange?: DateRange;
  dateRange?: DateRange;
  dimension: GridDimension;
  dimensionFilterGroups?: any[];
  includeTotalRowCount?: boolean;
  isCompareMode?: boolean;
  refreshKey?: number;
  rowLimit?: number;
  siteUrl: string;
  tier?: "free" | "pro" | "enterprise";
  useLiveData?: boolean;
};

const INITIAL_WAREHOUSE_GRID_ROW_LIMIT = 1000;

function toFiniteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toOptionalFiniteNumber(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

async function fetchWarehouseData(
  siteUrl: string,
  dimension: GridDimension,
  startDate: string,
  endDate: string,
  rowLimit: number,
  cacheKeyExtra: string,
  dimensionFilterGroups?: any[],
  signal?: AbortSignal,
  includeTotal = true,
  totalOnly = false,
): Promise<{ rows: GridRow[]; totalRowCount?: number }> {
  const payload = await fetchCachedWarehouseQuery<any>(
    {
      siteUrl,
      startDate,
      endDate,
      dimensions: [dimension],
      dimensionFilterGroups,
      includeTotal,
      rowLimit,
      startRow: 0,
      totalOnly,
    },
    cacheKeyExtra,
    { signal },
  );
  const allRows = Array.isArray(payload) ? payload : Array.isArray(payload?.rows) ? payload.rows : [];

  return {
    rows: allRows.map((row: any) => ({
    keys: [row[dimension]],
    clicks: toFiniteNumber(row.clicks),
    impressions: toFiniteNumber(row.impressions),
    ctr: toFiniteNumber(row.ctr),
    position: toFiniteNumber(row.position),
    queryCount: row.queryCount === undefined ? undefined : toFiniteNumber(row.queryCount),
    })).filter((row: GridRow) => typeof row.keys?.[0] === "string" && row.keys[0].length > 0),
    totalRowCount: Array.isArray(payload) ? undefined : toOptionalFiniteNumber(payload?.totalRowCount),
  };
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

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isWarehouseTotalPending(
  useLiveData: boolean,
  includeTotalRowCount: boolean,
  dimensionFilterGroups?: any[],
) {
  return !useLiveData && includeTotalRowCount && !dimensionFilterGroups?.length;
}

function getFriendlyGscError(message: string) {
  if (message === "WAREHOUSE_UNSUPPORTED_DIMENSION") {
    return "This Search Console breakdown is not available from stored reporting data yet.";
  }

  if (isGoogleAuthError(message)) {
    return "Your Google data connection needs attention. Please click 'Reconnect Google Data' at the top to restore reporting access.";
  }

  if (message.includes("sufficient permission")) {
    return "You do not have sufficient permission to view data for this property. Please select a different property or verify your access in Google Search Console.";
  }

  return message;
}

type GscGridCoverage = CoverageDataset & {
  activeDateCount: number;
  activeJobCount: number;
  errorJobCount: number;
  queuedDateCount: number;
};

export function useGscGridData({
  compareDateRange,
  dateRange,
  dimension,
  dimensionFilterGroups,
  includeTotalRowCount = true,
  isCompareMode,
  refreshKey = 0,
  rowLimit = INITIAL_WAREHOUSE_GRID_ROW_LIMIT,
  siteUrl,
  tier,
  useLiveData = true,
}: UseGscGridDataParams) {
  const [data, setData] = useState<GridRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<GscGridCoverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedRowLimit, setLoadedRowLimit] = useState<number | null>(null);
  const [totalRowCount, setTotalRowCount] = useState<number | null>(null);

  useEffect(() => {
    if (!siteUrl || !dateRange?.from || !dateRange?.to) {
      setData([]);
      setError(null);
      setCoverage(null);
      setLoadedRowLimit(null);
      setTotalRowCount(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    setLoading(true);
    setError(null);

    const gscService = new GscApiService(null, tier || "free");
    const startDate = format(dateRange.from, "yyyy-MM-dd");
    const endDate = format(dateRange.to, "yyyy-MM-dd");

    const canUseWarehouse = dimension === "query" || dimension === "page" || dimension === "country";
    if (!useLiveData && !canUseWarehouse) {
      setData([]);
      setError(getFriendlyGscError("WAREHOUSE_UNSUPPORTED_DIMENSION"));
      setLoadedRowLimit(null);
      setTotalRowCount(null);
      setLoading(false);
      return;
    }

    const shouldUseLiveApi = Boolean(useLiveData);
    if (shouldUseLiveApi) {
      setCoverage(null);
    }

    const coveragePromise = shouldUseLiveApi
      ? Promise.resolve(null)
      : fetchDataCoverage({ siteUrl, startDate, endDate })
          .then((result) => {
            const dataset = result.gsc[dimension];
            return {
              ...dataset,
              activeDateCount: Number(result.warehouseJobs.activeDateCount || 0),
              activeJobCount: Number(result.warehouseJobs.running || 0) + Number(result.warehouseJobs.queued || 0) + Number(result.warehouseJobs.retrying || 0),
              errorJobCount: Number(result.warehouseJobs.error || 0),
              queuedDateCount: Number(result.warehouseJobs.queued || 0) + Number(result.warehouseJobs.retrying || 0),
            };
          })
          .catch((err: Error) => {
            console.warn("Failed to load GSC warehouse coverage:", err);
            return null;
          });

    coveragePromise.then((nextCoverage) => {
      if (!cancelled) {
        setCoverage(nextCoverage);
      }
    });

    const shouldDeferWarehouseTotal = isWarehouseTotalPending(shouldUseLiveApi, includeTotalRowCount, dimensionFilterGroups);

    const primaryPromise = shouldUseLiveApi
      ? gscService.querySearchAnalytics(siteUrl, startDate, endDate, [dimension], dimensionFilterGroups, true)
          .then((rows) => ({ rows, totalRowCount: rows.length }))
      : fetchWarehouseData(siteUrl, dimension, startDate, endDate, rowLimit, `gsc-grid:${refreshKey}`, dimensionFilterGroups, abortController.signal, !shouldDeferWarehouseTotal);

    const comparePromise =
      isCompareMode && compareDateRange?.from && compareDateRange?.to
        ? (() => {
            const compareStartDate = format(compareDateRange.from!, "yyyy-MM-dd");
            const compareEndDate = format(compareDateRange.to!, "yyyy-MM-dd");
            return shouldUseLiveApi
              ? gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, [dimension], dimensionFilterGroups, true)
                  .then((rows) => ({ rows, totalRowCount: rows.length }))
              : fetchWarehouseData(siteUrl, dimension, compareStartDate, compareEndDate, rowLimit, `gsc-grid-compare:${refreshKey}`, dimensionFilterGroups, abortController.signal, !shouldDeferWarehouseTotal);
          })()
        : Promise.resolve(undefined);

    const pageQueryCountPromise =
      dimension === "page"
        ? (shouldUseLiveApi
            ? gscService.querySearchAnalytics(siteUrl, startDate, endDate, ["page", "query"], undefined, true)
            : Promise.resolve(undefined))
        : Promise.resolve(undefined);

    const comparePageQueryCountPromise =
      dimension === "page" && isCompareMode && compareDateRange?.from && compareDateRange?.to
        ? (() => {
            const compareStartDate = format(compareDateRange.from!, "yyyy-MM-dd");
            const compareEndDate = format(compareDateRange.to!, "yyyy-MM-dd");
            return shouldUseLiveApi
              ? gscService.querySearchAnalytics(siteUrl, compareStartDate, compareEndDate, ["page", "query"], undefined, true)
              : Promise.resolve(undefined);
          })()
        : Promise.resolve(undefined);

    primaryPromise
      .then(async (primaryResult) => {
        if (cancelled) return;
        const primaryRows = primaryResult.rows;
        const primaryTotalRowCount = primaryResult.totalRowCount ?? primaryRows.length;
        setLoadedRowLimit(shouldUseLiveApi ? null : rowLimit);
        setTotalRowCount(primaryTotalRowCount);

        if (shouldDeferWarehouseTotal) {
          void fetchWarehouseData(
            siteUrl,
            dimension,
            startDate,
            endDate,
            1,
            `gsc-grid-total:${refreshKey}`,
            dimensionFilterGroups,
            abortController.signal,
            true,
            true,
          )
            .then((result) => {
              if (!cancelled && typeof result.totalRowCount === "number") {
                setTotalRowCount(result.totalRowCount);
              }
            })
            .catch((err: Error) => {
              if (!cancelled && !isAbortError(err)) {
                console.warn("GSC warehouse total count failed; continuing with loaded rows.", err);
              }
            });
        }
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
          if (!cancelled) {
            setData(rowsWithPageQueryCounts);
          }
          return;
        }

        const compareResult = await comparePromise
          .then((compareRows) => ({ ok: true as const, compareRows: compareRows.rows }))
          .catch((err: Error) => {
            console.warn("Compare range failed for GSC grid; continuing with primary data only.", err);
            return { ok: false as const, error: err };
          });

        if (!compareResult.ok || !compareResult.compareRows) {
          if (!cancelled) {
            setData(primaryRows);
          }
          return;
        }

        if (!cancelled) {
          setData(mergeCompareRows(rowsWithPageQueryCounts, compareResult.compareRows));
        }
      })
      .catch((err: Error) => {
        if (cancelled || isAbortError(err)) return;
        const friendlyMessage = getFriendlyGscError(err.message);
        if (friendlyMessage === err.message) {
          console.error("Failed to fetch GSC data:", err);
        }
        setError(friendlyMessage);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [compareDateRange, dateRange, dimension, dimensionFilterGroups, includeTotalRowCount, isCompareMode, refreshKey, rowLimit, siteUrl, tier, useLiveData]);

  return {
    coverage,
    data,
    error,
    isRowLimited: Boolean(loadedRowLimit && totalRowCount !== null && totalRowCount > data.length),
    loading,
    rowLimit: loadedRowLimit,
    totalRowCount,
  };
}
