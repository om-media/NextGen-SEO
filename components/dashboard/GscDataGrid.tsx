import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowUpDown, ArrowUp, ArrowDown, Check, Plus } from "lucide-react";
import { useAuth } from "@/src/contexts/AuthContext";
import { saveFilter } from "@/src/services/dbService";
import { generateGscInsights } from "@/src/services/aiService";
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

export function GscDataGrid({
  siteUrl,
  dimension = "query",
  dateRange,
  isCompareMode,
  compareDateRange,
  useLiveData = true,
  hideTrackerButton = false,
}: {
  siteUrl: string;
  dimension?: "query" | "page" | "country";
  dateRange?: DateRange;
  isCompareMode?: boolean;
  compareDateRange?: DateRange;
  useLiveData?: boolean;
  hideTrackerButton?: boolean;
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

  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 100;

  const { addKeywordToTracker, addedKeywords, addingKeywords } = useRankTrackerKeywords({
    dimension,
    hideTrackerButton,
    siteUrl,
  });
  const { data, error, loading } = useGscGridData({
    compareDateRange,
    dateRange,
    dimension,
    isCompareMode,
    siteUrl,
    tier: userProfile?.tier,
    useLiveData,
  });

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, intentFilter, minClicks, minImpressions, maxPosition, isQuestionOnly, minWords, sortColumn, sortDirection, dimension, dateRange, compareDateRange, isCompareMode]);

  useEffect(() => {
    setAiInsights(null);
    setAiError(null);
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
  const exportableRows = sortedData.map((row) => ({
    ...row,
    intentLabel: dimension === "query" ? classifyIntent(row.keys[0], siteUrl) : undefined,
  }));

  const totalPages = Math.ceil(filteredData.length / pageSize);
  const isConnectionIssue = error?.startsWith("Your Google data connection needs attention.") ?? false;

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
    try {
      const insights = await generateGscInsights(sortedData, dimension, searchTerm, intentFilter);
      setAiInsights(insights);
    } catch (err: any) {
      setAiError(err.message);
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const handleExport = () => {
    if (exportableRows.length === 0) {
      toast.error("Nothing to export", {
        description: "Adjust the current filters or date range so the view contains data first.",
      });
      return;
    }

    downloadGscCsv({
      dimension,
      includeCompare: Boolean(isCompareMode),
      includeIntent: dimension === "query",
      rows: exportableRows,
    });

    toast.success("CSV exported", {
      description: `Downloaded ${exportableRows.length.toLocaleString()} rows from the current ${dimension} view.`,
    });
  };

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

  return (
    <div className="space-y-6">
      {!isConnectionIssue && error && (
        <div className="rounded-2xl border border-red-200 bg-red-50/90 p-4 text-sm text-red-600 shadow-[0_10px_24px_rgba(127,29,29,0.05)]">
          {error}
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
        />
      )}

      <div className={dimension === "query" ? "grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]" : ""}>
      <Card id="gsc-data-grid" className="mt-0 rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardHeader className="border-b border-[#E6ECE8] bg-white px-5 py-4">
          <GscGridHeader
            aiError={aiError}
            aiInsights={aiInsights}
            dimension={dimension}
            isAiDialogOpen={isAiDialogOpen}
            isGeneratingAi={isGeneratingAi}
            onAiDialogOpenChange={setIsAiDialogOpen}
            onExport={handleExport}
            onGenerateInsights={handleGenerateInsights}
            rowCount={sortedData.length}
          />
        </CardHeader>
        <CardContent className="px-5 pt-5">
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

          <div className="overflow-hidden rounded-2xl border border-[#E6ECE8] bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[300px] cursor-pointer select-none hover:bg-[#F6FAF7]" onClick={() => handleSort("key")}>
                    <div className="flex items-center">
                      {dimension === "query" ? "Search Query" : getGridTitle(dimension)}
                      {renderSortIcon("key")}
                    </div>
                  </TableHead>
                  {dimension === "query" && (
                    <TableHead className="cursor-pointer select-none hover:bg-[#F6FAF7]" onClick={() => handleSort("intent")}>
                      <div className="flex items-center">
                        Intent
                        {renderSortIcon("intent")}
                      </div>
                    </TableHead>
                  )}
                  <TableHead className="cursor-pointer select-none text-right hover:bg-[#F6FAF7]" onClick={() => handleSort("clicks")}>
                    <div className="flex items-center justify-end">
                      Clicks
                      {renderSortIcon("clicks")}
                    </div>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none text-right hover:bg-[#F6FAF7]" onClick={() => handleSort("impressions")}>
                    <div className="flex items-center justify-end">
                      Impressions
                      {renderSortIcon("impressions")}
                    </div>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none text-right hover:bg-[#F6FAF7]" onClick={() => handleSort("ctr")}>
                    <div className="flex items-center justify-end">
                      CTR
                      {renderSortIcon("ctr")}
                    </div>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none text-right hover:bg-[#F6FAF7]" onClick={() => handleSort("position")}>
                    <div className="flex items-center justify-end">
                      Position
                      {renderSortIcon("position")}
                    </div>
                  </TableHead>
                  {dimension === "query" && <TableHead className="text-right">Trend</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, index) => (
                    <TableRow key={`loading-${index}`}>
                      <TableCell className="py-4">
                        <div className="h-4 w-[82%] animate-pulse rounded-full bg-[#EEF3F0]" />
                      </TableCell>
                      {dimension === "query" && (
                        <TableCell className="py-4">
                          <div className="h-5 w-24 animate-pulse rounded-full bg-[#EAF2FF]" />
                        </TableCell>
                      )}
                      <TableCell className="py-4">
                        <div className="ml-auto h-4 w-12 animate-pulse rounded-full bg-[#EEF3F0]" />
                      </TableCell>
                      <TableCell className="py-4">
                        <div className="ml-auto h-4 w-16 animate-pulse rounded-full bg-[#EEF3F0]" />
                      </TableCell>
                      <TableCell className="py-4">
                        <div className="ml-auto h-4 w-12 animate-pulse rounded-full bg-[#EEF3F0]" />
                      </TableCell>
                      <TableCell className="py-4">
                        <div className="ml-auto h-4 w-10 animate-pulse rounded-full bg-[#EEF3F0]" />
                      </TableCell>
                      {dimension === "query" && (
                        <TableCell className="py-4">
                          <div className="ml-auto h-4 w-16 animate-pulse rounded-full bg-[#F1E8FF]" />
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                ) : error ? (
                  <TableRow>
                    <TableCell colSpan={dimension === "query" ? 7 : 5} className="h-24 text-center text-destructive">
                      {error}
                    </TableCell>
                  </TableRow>
                ) : sortedData.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={dimension === "query" ? 7 : 5} className="h-24 text-center text-muted-foreground">
                      No data found.
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedData.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((row, i) => {
                    const key = row.keys[0];
                    const intent = dimension === "query" ? classifyIntent(key, siteUrl) : null;

                    return (
                      <TableRow
                        key={i}
                        className={`cursor-pointer hover:bg-[#F6FAF7] ${selectedRowKey === key ? "bg-[#EAF4EC]" : ""}`}
                        onClick={() => setSelectedRowKey(key)}
                      >
                        <TableCell className="max-w-[300px] font-medium truncate" title={key}>
                          {dimension === "page" ? (
                            <a href={key} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                              {key.replace(siteUrl, "/")}
                            </a>
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

          {!loading && !error && sortedData.length > 0 && (
            <div className="mt-4 flex flex-col gap-3 border-t border-[#E6ECE8] pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-muted-foreground">
                Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, sortedData.length)} of {sortedData.length} entries
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
                  Page {currentPage} of {totalPages}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {dimension === "query" && <InsightsPanel rows={sortedData} />}
      </div>
    </div>
  );
}
