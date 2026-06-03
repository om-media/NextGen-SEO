import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowUpDown, ArrowUp, ArrowDown, Check, Plus, ExternalLink, Database, AlertCircle } from "lucide-react";
import { useAuth } from "@/src/contexts/AuthContext";
import { saveFilter } from "@/src/services/dbService";
import { generateGscInsights, isAiProviderUnavailableError } from "@/src/services/aiService";
import { DateRange } from "react-day-picker";
import { toast } from "sonner";
import { GscFilterToolbar } from "./GscFilterToolbar";
import { GscGridHeader } from "./GscGridHeader";
import { GscHistoricTrendCard } from "./GscHistoricTrendCard";
import { InsightsPanel } from "./InsightsPanel";
import { downloadGscCsv } from "./gscExport";
import {
  classifyIntent,
  filterGridData,
  getGridTitle,
  sortGridData,
  type GridFilters,
  type GridDimension,
  type GridRow,
  type SortColumn,
} from "./gscGridUtils";
import { useGscGridData } from "./useGscGridData";
import { useRankTrackerKeywords } from "./useRankTrackerKeywords";
import { cn } from "@/lib/utils";

const INITIAL_WAREHOUSE_GRID_ROW_LIMIT = 1000;
const FULL_WAREHOUSE_GRID_ROW_LIMIT = 50000;

export function GscDataGrid({
  siteUrl,
  dimension = "query",
  dateRange,
  isCompareMode,
  compareDateRange,
  useLiveData = true,
  refreshKey = 0,
  hideTrackerButton = false,
  dimensionFilterGroups,
  showHeaderActions = true,
  showInsights = true,
  titleOverride,
  descriptionOverride,
}: {
  siteUrl: string;
  dimension?: "query" | "page" | "country";
  dateRange?: DateRange;
  isCompareMode?: boolean;
  compareDateRange?: DateRange;
  useLiveData?: boolean;
  refreshKey?: number;
  hideTrackerButton?: boolean;
  dimensionFilterGroups?: any[];
  showHeaderActions?: boolean;
  showInsights?: boolean;
  titleOverride?: string;
  descriptionOverride?: string;
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [intentFilter, setIntentFilter] = useState("all");
  const { userProfile } = useAuth();

  const [sortColumn, setSortColumn] = useState<SortColumn>("clicks");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const [minClicks, setMinClicks] = useState<number | "">("");
  const [minImpressions, setMinImpressions] = useState<number | "">("");
  const [maxPosition, setMaxPosition] = useState<number | "">("");
  const [isQuestionOnly, setIsQuestionOnly] = useState(false);
  const [minWords, setMinWords] = useState<number | "">("");
  const [isAdvancedFiltersOpen, setIsAdvancedFiltersOpen] = useState(false);

  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [filterName, setFilterName] = useState("");
  const [isSavingFilter, setIsSavingFilter] = useState(false);

  const [isAiDialogOpen, setIsAiDialogOpen] = useState(false);
  const [aiInsights, setAiInsights] = useState<string | null>(null);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [isAiProviderUnavailable, setIsAiProviderUnavailable] = useState(false);

  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [selectedQueryPage, setSelectedQueryPage] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pendingNextPageAfterLoad, setPendingNextPageAfterLoad] = useState(false);
  const [pendingExportAfterLoad, setPendingExportAfterLoad] = useState(false);
  const [requestedWarehouseRowLimit, setRequestedWarehouseRowLimit] = useState(INITIAL_WAREHOUSE_GRID_ROW_LIMIT);
  const pageSize = 100;
  const stableDimensionFilterGroups = useMemo(
    () => dimensionFilterGroups,
    [JSON.stringify(dimensionFilterGroups || [])],
  );

  const { addKeywordToTracker, addedKeywords, addingKeywords } = useRankTrackerKeywords({
    dimension,
    hideTrackerButton,
    siteUrl,
  });
  const { coverage, data, error, isRowLimited, loading, rowLimit, totalRowCount } = useGscGridData({
    compareDateRange,
    dateRange,
    dimension,
    dimensionFilterGroups: stableDimensionFilterGroups,
    isCompareMode,
    refreshKey,
    rowLimit: requestedWarehouseRowLimit,
    siteUrl,
    tier: userProfile?.tier,
    useLiveData,
  });

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, intentFilter, minClicks, minImpressions, maxPosition, isQuestionOnly, minWords, sortColumn, sortDirection, dimension, dateRange, compareDateRange, isCompareMode]);

  useEffect(() => {
    setRequestedWarehouseRowLimit(INITIAL_WAREHOUSE_GRID_ROW_LIMIT);
    setPendingNextPageAfterLoad(false);
    setPendingExportAfterLoad(false);
  }, [siteUrl, dimension, stableDimensionFilterGroups, dateRange, compareDateRange, isCompareMode, refreshKey, useLiveData]);

  useEffect(() => {
    setSelectedRowKey(null);
    setSelectedQueryPage(null);
  }, [siteUrl, dimension, stableDimensionFilterGroups, dateRange, compareDateRange]);

  useEffect(() => {
    setAiInsights(null);
    setAiError(null);
    setIsAiProviderUnavailable(false);
  }, [siteUrl, dimension, dateRange, searchTerm, intentFilter, minClicks, minImpressions, maxPosition, isQuestionOnly, minWords, sortColumn, sortDirection]);

  const gridFilters: GridFilters = {
    intentFilter,
    isQuestionOnly,
    maxPosition,
    minClicks,
    minImpressions,
    minWords,
    searchTerm,
  };

  const filteredData = filterGridData(data, dimension, gridFilters, siteUrl);
  const sortedData = sortGridData(filteredData, sortColumn, sortDirection, siteUrl);
  const hasActiveFilters = Boolean(
    gridFilters.searchTerm ||
      intentFilter !== "all" ||
      minClicks !== "" ||
      minImpressions !== "" ||
      maxPosition !== "" ||
      isQuestionOnly ||
      minWords !== "",
  );
  const shouldShowTotalRowCount = !hasActiveFilters && typeof totalRowCount === "number" && Number.isFinite(totalRowCount);
  const loadedRowCountLabel = `${sortedData.length.toLocaleString()}${isRowLimited ? " loaded" : ""}`;
  const canLoadMoreWarehouseRows = Boolean(!useLiveData && isRowLimited && shouldShowTotalRowCount && totalRowCount > data.length);
  const isAppendingRows = loading && data.length > 0;
  const fullWarehouseExportLimit = typeof totalRowCount === "number"
    ? Math.min(totalRowCount, FULL_WAREHOUSE_GRID_ROW_LIMIT)
    : FULL_WAREHOUSE_GRID_ROW_LIMIT;
  const canPrepareFullWarehouseExport = Boolean(
    !useLiveData &&
      typeof totalRowCount === "number" &&
      totalRowCount > data.length &&
      requestedWarehouseRowLimit < fullWarehouseExportLimit
  );
  const exportableRows = sortedData.map((row) => ({
    ...row,
    intentLabel: dimension === "query" ? classifyIntent(row.keys[0], siteUrl) : undefined,
  }));

  const totalPages = Math.ceil(filteredData.length / pageSize);
  const totalAvailablePages = shouldShowTotalRowCount && totalRowCount
    ? Math.max(1, Math.ceil(totalRowCount / pageSize))
    : totalPages;
  const loadedPageLabel = isRowLimited && totalAvailablePages > totalPages
    ? `${totalPages.toLocaleString()} loaded`
    : "";
  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage((p) => Math.min(totalPages, p + 1));
      return;
    }

    if (canLoadMoreWarehouseRows) {
      setPendingNextPageAfterLoad(true);
      setRequestedWarehouseRowLimit((limit) => Math.min(limit + 1000, totalRowCount || limit + 1000));
    }
  };

  useEffect(() => {
    if (!pendingNextPageAfterLoad || loading) {
      return;
    }

    const nextPage = currentPage + 1;
    if (nextPage <= totalPages) {
      setCurrentPage(nextPage);
    }
    setPendingNextPageAfterLoad(false);
  }, [currentPage, loading, pendingNextPageAfterLoad, totalPages]);

  useEffect(() => {
    if (useLiveData || totalRowCount === null) {
      return;
    }

    if (hasActiveFilters) {
      const targetLimit = Math.min(totalRowCount, FULL_WAREHOUSE_GRID_ROW_LIMIT);
      if (requestedWarehouseRowLimit < targetLimit) {
        setRequestedWarehouseRowLimit(targetLimit);
      }
      return;
    }

    if (currentPage === 1 && requestedWarehouseRowLimit > INITIAL_WAREHOUSE_GRID_ROW_LIMIT) {
      setRequestedWarehouseRowLimit(INITIAL_WAREHOUSE_GRID_ROW_LIMIT);
    }
  }, [currentPage, hasActiveFilters, requestedWarehouseRowLimit, totalRowCount, useLiveData]);

  const isConnectionIssue = error?.startsWith("Your Google data connection needs attention.") ?? false;
  const isWarehousePreparationMessage = Boolean(error && /stored reporting data|breakdown is not available|being prepared/i.test(error));
  const hasCoverage = Boolean(coverage && Number(coverage.expectedDateCount || 0) > 0);
  const hasActiveWarehouseWork = Boolean(
    coverage &&
    (Number(coverage.activeJobCount || 0) > 0 ||
      Number(coverage.activeDateCount || 0) > 0 ||
      Number(coverage.queuedDateCount || 0) > 0)
  );
  const hasCoverageGap = Boolean(
    coverage &&
    Number(coverage.expectedDateCount || 0) > 0 &&
    Number(coverage.coveredDateCount || 0) < Number(coverage.expectedDateCount || 0)
  );
  const hasWarehouseErrors = Boolean(coverage && Number(coverage.errorJobCount || 0) > 0);
  const shouldShowCoverageStatus = !useLiveData && hasCoverage && (hasActiveWarehouseWork || hasCoverageGap || hasWarehouseErrors || sortedData.length === 0);
  const coverageLabel = coverage
    ? `${Number(coverage.coveredDateCount || 0).toLocaleString()} / ${Number(coverage.expectedDateCount || 0).toLocaleString()} days ready`
    : "";
  const coverageStatusTitle = hasWarehouseErrors
    ? "Search Console import needs attention"
    : hasActiveWarehouseWork
      ? "Importing Search Console history"
      : hasCoverageGap
        ? "Search Console history import available"
        : "Stored Search Console data is ready";
  const coverageStatusDescription = hasWarehouseErrors
    ? "Some import jobs failed. Use the import status panel above to retry failed jobs."
    : hasActiveWarehouseWork
      ? "Existing rows stay visible while the app prepares the missing days for this breakdown."
      : hasCoverageGap
        ? "Use the import status panel above to queue the remaining missing days for this date range."
        : "This breakdown is loaded from the app warehouse for the selected range.";

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  const renderSortIcon = (column: SortColumn) => {
    if (sortColumn !== column) return <ArrowUpDown className="ml-2 h-4 w-4 text-muted-foreground opacity-50" />;
    return sortDirection === "asc" ? <ArrowUp className="ml-2 h-4 w-4" /> : <ArrowDown className="ml-2 h-4 w-4" />;
  };

  const handleSaveFilter = async () => {
    if (!filterName.trim()) return;

    setIsSavingFilter(true);
    try {
      const configuration = JSON.stringify({
        searchTerm,
        intentFilter: dimension === "query" ? intentFilter : "all",
        dimension,
        minClicks,
        minImpressions,
        maxPosition,
        isQuestionOnly: dimension === "query" ? isQuestionOnly : false,
        minWords: dimension === "query" ? minWords : "",
      });

      await saveFilter({
        name: filterName,
        projectId: siteUrl,
        configuration,
      });

      setIsSaveDialogOpen(false);
      setFilterName("");
    } catch (err) {
      console.error("Failed to save filter:", err);
    } finally {
      setIsSavingFilter(false);
    }
  };

  const handleGenerateInsights = async () => {
    setIsGeneratingAi(true);
    setAiError(null);
    setIsAiProviderUnavailable(false);
    try {
      const insights = await generateGscInsights(sortedData, dimension, searchTerm, intentFilter);
      setAiInsights(insights);
    } catch (err: any) {
      if (isAiProviderUnavailableError(err)) {
        setIsAiProviderUnavailable(true);
      }
      setAiError(err.message);
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const runCsvExport = (rows = exportableRows) => {
    if (rows.length === 0) {
      toast.error("Nothing to export", {
        description: "Adjust the current filters or date range so the view contains data first.",
      });
      return;
    }

    downloadGscCsv({
      dimension,
      includeCompare: Boolean(isCompareMode),
      includeIntent: dimension === "query",
      rows,
    });

    const cappedExport = !hasActiveFilters && typeof totalRowCount === "number" && rows.length < totalRowCount;
    toast.success("CSV exported", {
      description: cappedExport
        ? `Downloaded ${rows.length.toLocaleString()} rows from the current ${dimension} view. ${totalRowCount.toLocaleString()} rows are stored; export is capped at ${FULL_WAREHOUSE_GRID_ROW_LIMIT.toLocaleString()} rows.`
        : `Downloaded ${rows.length.toLocaleString()} rows from the current ${dimension} view.`,
    });
  };

  const handleExport = () => {
    if (canPrepareFullWarehouseExport) {
      setPendingExportAfterLoad(true);
      setRequestedWarehouseRowLimit(fullWarehouseExportLimit);
      toast.info("Preparing CSV", {
        description: `Loading ${fullWarehouseExportLimit.toLocaleString()} stored rows before exporting.`,
      });
      return;
    }

    runCsvExport();
  };

  useEffect(() => {
    if (!pendingExportAfterLoad || loading) {
      return;
    }

    setPendingExportAfterLoad(false);
    runCsvExport();
  }, [loading, pendingExportAfterLoad, exportableRows]);

  const renderDifference = (current: number, previous: number | undefined, isPercentage = false, inverse = false) => {
    if (!isCompareMode || previous === undefined) return null;

    const diff = current - previous;
    if (diff === 0) return null;

    let isPositive = diff > 0;
    if (inverse) isPositive = !isPositive;

    const formattedDiff = isPercentage
      ? `${diff > 0 ? "+" : ""}${(diff * 100).toFixed(2)}%`
      : `${diff > 0 ? "+" : ""}${Number.isInteger(diff) ? diff.toLocaleString() : diff.toFixed(1)}`;

    return (
      <span className={`ml-2 text-xs ${isPositive ? "text-green-500" : "text-red-500"}`}>
        {formattedDiff}
      </span>
    );
  };

  const clearAllFilters = () => {
    setSearchTerm("");
    setIntentFilter("all");
    setMinClicks("");
    setMinImpressions("");
    setMaxPosition("");
    setIsQuestionOnly(false);
    setMinWords("");
  };

  const renderTrendIndicator = (row: GridRow) => {
    if (!isCompareMode || row.compareClicks === undefined) {
      return <span className="text-xs text-muted-foreground">No compare</span>;
    }

    const diff = row.clicks - row.compareClicks;
    if (row.compareClicks === 0 && diff === 0) {
      return <span className="text-xs text-muted-foreground">0</span>;
    }

    const isPositive = diff >= 0;
    const label = row.compareClicks > 0
      ? `${isPositive ? "+" : ""}${((diff / row.compareClicks) * 100).toFixed(1)}%`
      : `+${row.clicks.toLocaleString()}`;

    return (
      <span className={`text-xs font-medium ${isPositive ? "text-[#15803D]" : "text-red-500"}`}>
        {isPositive ? "↑" : "↓"} {label}
      </span>
    );
  };

  const getIntentClassName = (intent: string | null) => {
    if (intent === "Navigational") return "bg-[#EAF4EC] text-[#0F3D2E] hover:bg-[#EAF4EC]";
    if (intent === "Commercial" || intent === "Transactional") return "bg-[#FFF2E8] text-[#C2410C] hover:bg-[#FFF2E8]";
    return "bg-[#EAF2FF] text-[#2563EB] hover:bg-[#EAF2FF]";
  };

  const formatPageCell = (pageUrl: string) => {
    try {
      const parsed = new URL(pageUrl);
      const cleanPath = parsed.pathname.replace(/\/+$/, "") || "/";
      const segments = cleanPath.split("/").filter(Boolean);
      const lastSegment = segments[segments.length - 1] || "";
      const decodedSegment = decodeURIComponent(lastSegment.replace(/\+/g, " "));
      const title = cleanPath === "/"
        ? `Home - ${parsed.hostname.replace(/^www\./, "")}`
        : decodedSegment
            .replace(/[-_]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/\b\w/g, (char) => char.toUpperCase()) || parsed.hostname.replace(/^www\./, "");

      return {
        title,
        path: `${parsed.hostname.replace(/^www\./, "")}${cleanPath === "/" ? "/" : `${cleanPath}/`}`,
      };
    } catch {
      const clean = pageUrl.replace(/^https?:\/\//, "").replace(/^www\./, "");
      return {
        title: clean.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ") || clean,
        path: clean,
      };
    }
  };

  return (
    <div className="space-y-6">
      {!isConnectionIssue && error && !isWarehousePreparationMessage && (
        <div className="rounded-2xl border border-red-200 bg-red-50/90 p-4 text-sm text-red-600 shadow-[0_10px_24px_rgba(127,29,29,0.05)] dark:border-red-900/50 dark:bg-red-950/35 dark:text-red-200">
          {error}
        </div>
      )}

      {!isConnectionIssue && (shouldShowCoverageStatus || isWarehousePreparationMessage) && (
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-[0_12px_32px_rgba(15,61,46,0.035)] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            {hasActiveWarehouseWork ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : hasWarehouseErrors ? (
              <AlertCircle className="h-4 w-4 text-destructive" />
            ) : (
              <Database className="h-4 w-4 text-primary" />
            )}
            <span className="font-medium text-foreground">{coverageStatusTitle}</span>
            {coverageLabel && <span>{coverageLabel}</span>}
          </div>
          <span>{coverageStatusDescription}</span>
        </div>
      )}

      {selectedRowKey && (
        <GscHistoricTrendCard
          compareDateRange={compareDateRange}
          dateRange={dateRange}
          dimension={dimension as GridDimension}
          isCompareMode={isCompareMode}
          onClose={() => setSelectedRowKey(null)}
          selectedRowKey={selectedRowKey}
          siteUrl={siteUrl}
          useLiveData={useLiveData}
        />
      )}

      <div className={dimension === "query" && showInsights ? "grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]" : ""}>
      <Card id="gsc-data-grid" className="mt-0 rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardHeader className="border-b border-border bg-card px-5 py-4">
          <GscGridHeader
            aiError={aiError}
            aiInsights={aiInsights}
            isAiProviderUnavailable={isAiProviderUnavailable}
            descriptionOverride={descriptionOverride}
            dimension={dimension}
            isAiDialogOpen={isAiDialogOpen}
            isExporting={pendingExportAfterLoad}
            isGeneratingAi={isGeneratingAi}
            onAiDialogOpenChange={setIsAiDialogOpen}
            onExport={handleExport}
            onGenerateInsights={handleGenerateInsights}
            rowLimit={isRowLimited ? rowLimit : null}
            rowCount={sortedData.length}
            showActions={showHeaderActions}
            totalRowCount={shouldShowTotalRowCount ? totalRowCount : null}
            titleOverride={titleOverride}
          />
        </CardHeader>
        <CardContent className="px-5 pt-5">
          {dimension === "page" && selectedQueryPage && (
            <div className="mb-5 rounded-2xl border border-border bg-background p-3 shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
              <div className="mb-3 flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Page query drilldown</p>
                  <h3 className="mt-1 text-lg font-semibold text-foreground">
                    Visible queries for this page
                  </h3>
                  <p className="mt-1 max-w-3xl truncate text-sm text-muted-foreground" title={selectedQueryPage}>
                    {selectedQueryPage}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setSelectedQueryPage(null)} className="rounded-lg border-border bg-card">
                  Close queries
                </Button>
              </div>
              <GscDataGrid
                compareDateRange={compareDateRange}
                dateRange={dateRange}
                descriptionOverride="These are the visible Search Console queries that drove this selected page in the current date range."
                dimension="query"
                dimensionFilterGroups={[{
                  filters: [{ dimension: "page", expression: selectedQueryPage, operator: "equals" }],
                }]}
                hideTrackerButton={hideTrackerButton}
                isCompareMode={isCompareMode}
                showHeaderActions={false}
                showInsights={false}
                siteUrl={siteUrl}
                titleOverride="Queries for selected page"
                useLiveData={useLiveData}
              />
            </div>
          )}

          <GscFilterToolbar
            dimension={dimension}
            filterName={filterName}
            filters={gridFilters}
            isAdvancedFiltersOpen={isAdvancedFiltersOpen}
            isSaveDialogOpen={isSaveDialogOpen}
            isSavingFilter={isSavingFilter}
            onAdvancedFiltersOpenChange={setIsAdvancedFiltersOpen}
            onClearAll={clearAllFilters}
            onFilterNameChange={setFilterName}
            onIntentFilterChange={setIntentFilter}
            onIsQuestionOnlyChange={setIsQuestionOnly}
            onMaxPositionChange={setMaxPosition}
            onMinClicksChange={setMinClicks}
            onMinImpressionsChange={setMinImpressions}
            onMinWordsChange={setMinWords}
            onSaveDialogOpenChange={setIsSaveDialogOpen}
            onSaveFilter={handleSaveFilter}
            onSearchTermChange={setSearchTerm}
          />

          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={cn("cursor-pointer select-none hover:bg-muted/60", dimension === "page" ? "w-[48%] min-w-[420px]" : "w-[300px]")} onClick={() => handleSort("key")}>
                    <div className="flex items-center">
                      {dimension === "query" ? "Search Query" : getGridTitle(dimension)}
                      {renderSortIcon("key")}
                    </div>
                  </TableHead>
                  {dimension === "query" && (
                    <TableHead className="cursor-pointer select-none hover:bg-muted/60" onClick={() => handleSort("intent")}>
                      <div className="flex items-center">
                        Intent
                        {renderSortIcon("intent")}
                      </div>
                    </TableHead>
                  )}
                  <TableHead className="cursor-pointer select-none text-right hover:bg-muted/60" onClick={() => handleSort("clicks")}>
                    <div className="flex items-center justify-end">
                      Clicks
                      {renderSortIcon("clicks")}
                    </div>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none text-right hover:bg-muted/60" onClick={() => handleSort("impressions")}>
                    <div className="flex items-center justify-end">
                      Impressions
                      {renderSortIcon("impressions")}
                    </div>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none text-right hover:bg-muted/60" onClick={() => handleSort("ctr")}>
                    <div className="flex items-center justify-end">
                      CTR
                      {renderSortIcon("ctr")}
                    </div>
                  </TableHead>
                  {dimension === "page" && (
                    <TableHead className="cursor-pointer select-none text-right hover:bg-muted/60" onClick={() => handleSort("queryCount")}>
                      <div className="flex items-center justify-end">
                        Visible Queries
                        {renderSortIcon("queryCount")}
                      </div>
                    </TableHead>
                  )}
                  <TableHead className="cursor-pointer select-none text-right hover:bg-muted/60" onClick={() => handleSort("position")}>
                    <div className="flex items-center justify-end">
                      Position
                      {renderSortIcon("position")}
                    </div>
                  </TableHead>
                  {dimension === "query" && <TableHead className="text-right">Trend</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && data.length === 0 ? (
                  Array.from({ length: 8 }).map((_, index) => (
                    <TableRow key={`loading-${index}`}>
                      <TableCell className="py-4">
                        <div className="h-4 w-[82%] animate-pulse rounded-full bg-muted" />
                      </TableCell>
                      {dimension === "query" && (
                        <TableCell className="py-4">
                          <div className="h-5 w-24 animate-pulse rounded-full bg-blue-100 dark:bg-blue-950/40" />
                        </TableCell>
                      )}
                      {dimension === "page" && (
                        <TableCell className="py-4">
                          <div className="ml-auto h-4 w-12 animate-pulse rounded-full bg-muted" />
                        </TableCell>
                      )}
                      <TableCell className="py-4">
                        <div className="ml-auto h-4 w-12 animate-pulse rounded-full bg-muted" />
                      </TableCell>
                      <TableCell className="py-4">
                        <div className="ml-auto h-4 w-16 animate-pulse rounded-full bg-muted" />
                      </TableCell>
                      <TableCell className="py-4">
                        <div className="ml-auto h-4 w-12 animate-pulse rounded-full bg-muted" />
                      </TableCell>
                      <TableCell className="py-4">
                        <div className="ml-auto h-4 w-10 animate-pulse rounded-full bg-muted" />
                      </TableCell>
                      {dimension === "query" && (
                        <TableCell className="py-4">
                          <div className="ml-auto h-4 w-16 animate-pulse rounded-full bg-purple-100 dark:bg-purple-950/40" />
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                ) : error && !isWarehousePreparationMessage ? (
                  <TableRow>
                    <TableCell colSpan={dimension === "query" ? 7 : dimension === "page" ? 6 : 5} className="h-24 text-center text-destructive">
                      {error}
                    </TableCell>
                  </TableRow>
                ) : sortedData.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={dimension === "query" ? 7 : dimension === "page" ? 6 : 5} className="h-24 text-center text-muted-foreground">
                      {shouldShowCoverageStatus || isWarehousePreparationMessage
                        ? "This breakdown will populate as the stored Search Console import catches up."
                        : "No data found."}
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedData.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((row, i) => {
                    const key = row.keys[0];
                    const intent = dimension === "query" ? classifyIntent(key, siteUrl) : null;
                    const pageDisplay = dimension === "page" ? formatPageCell(key) : null;

                    return (
                      <TableRow
                        key={i}
                        className={`cursor-pointer hover:bg-muted/60 ${selectedRowKey === key ? "bg-secondary/60" : ""}`}
                        onClick={() => setSelectedRowKey(key)}
                      >
                        <TableCell className={cn("font-medium", dimension === "page" ? "max-w-[560px] py-3" : "max-w-[300px] truncate")} title={key}>
                          {dimension === "page" ? (
                            <div className="group/page flex min-w-0 items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-foreground">
                                  {pageDisplay?.title}
                                </div>
                                <div className="mt-1 truncate text-xs font-medium text-muted-foreground">
                                  {pageDisplay?.path}
                                </div>
                              </div>
                              <a
                                href={key}
                                target="_blank"
                                rel="noreferrer"
                                className="shrink-0 rounded-full border border-border bg-card p-1.5 text-muted-foreground opacity-0 shadow-sm transition hover:border-primary hover:text-primary group-hover/page:opacity-100"
                                title="Open page"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            </div>
                          ) : dimension === "country" ? (
                            <span className="uppercase">{key}</span>
                          ) : dimension === "query" ? (
                            <div className="flex items-center justify-between">
                              <span className="truncate">{key}</span>
                              {!hideTrackerButton && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={`ml-2 h-6 w-6 z-10 ${addedKeywords.has(key) ? "cursor-default text-green-500 opacity-100" : "text-muted-foreground opacity-50 hover:text-primary hover:opacity-100"}`}
                                  title={addedKeywords.has(key) ? "Added to Rank Tracker" : "Add to Rank Tracker"}
                                  disabled={addedKeywords.has(key) || addingKeywords.has(key)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!addedKeywords.has(key) && !addingKeywords.has(key)) {
                                      addKeywordToTracker(key, row.position);
                                    }
                                  }}
                                >
                                  {addingKeywords.has(key) ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : addedKeywords.has(key) ? (
                                    <Check className="h-4 w-4" />
                                  ) : (
                                    <Plus className="h-4 w-4" />
                                  )}
                                </Button>
                              )}
                            </div>
                          ) : (
                            <span className="truncate">{key}</span>
                          )}
                        </TableCell>

                        {dimension === "query" && (
                          <TableCell>
                            <Badge variant="secondary" className={`font-normal ${getIntentClassName(intent)}`}>
                              {intent === "Commercial" ? "Transactional" : intent}
                            </Badge>
                          </TableCell>
                        )}

                        <TableCell className="text-right">
                          {row.clicks.toLocaleString()}
                          {renderDifference(row.clicks, row.compareClicks)}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.impressions.toLocaleString()}
                          {renderDifference(row.impressions, row.compareImpressions)}
                        </TableCell>
                        <TableCell className="text-right">
                          {(row.ctr * 100).toFixed(2)}%
                          {renderDifference(row.ctr, row.compareCtr, true)}
                        </TableCell>
                        {dimension === "page" && (
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              className="h-8 rounded-full px-3 text-sm font-semibold text-primary hover:bg-secondary hover:text-primary"
                              title={`Open visible queries for ${pageDisplay?.title || key}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedQueryPage(key);
                                setSelectedRowKey(null);
                              }}
                            >
                              {(row.queryCount || 0).toLocaleString()}
                            </Button>
                            {renderDifference(row.queryCount || 0, row.compareQueryCount)}
                          </TableCell>
                        )}
                        <TableCell className="text-right">
                          {row.position.toFixed(1)}
                          {renderDifference(row.position, row.comparePosition, false, true)}
                        </TableCell>
                        {dimension === "query" && (
                          <TableCell className="text-right">
                            {renderTrendIndicator(row)}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {!error && sortedData.length > 0 && (
            <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-muted-foreground">
                Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, sortedData.length)} of {loadedRowCountLabel} rows
                {shouldShowTotalRowCount && totalRowCount > sortedData.length && (
                  <span className="ml-1">({totalRowCount.toLocaleString()} total available)</span>
                )}
                {isAppendingRows && <span className="ml-1">Loading more rows...</span>}
              </div>
              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </Button>
                <div className="text-sm font-medium">
                  Page {currentPage} of {totalAvailablePages.toLocaleString()}
                  {loadedPageLabel && <span className="ml-1 font-normal text-muted-foreground">({loadedPageLabel})</span>}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNextPage}
                  disabled={loading || (currentPage === totalPages && !canLoadMoreWarehouseRows)}
                >
                  {loading && pendingNextPageAfterLoad ? "Loading..." : "Next"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {dimension === "query" && showInsights && <InsightsPanel rows={sortedData} />}
      </div>
    </div>
  );
}
