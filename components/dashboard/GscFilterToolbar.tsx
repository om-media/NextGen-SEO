import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Filter, Search } from "lucide-react";
import { GscSaveFilterDialog } from "./GscSaveFilterDialog";
import {
  getGridSearchPlaceholder,
  hasActiveGridFilters,
  type GridDimension,
  type GridFilters,
} from "./gscGridUtils";

type GscFilterToolbarProps = {
  dimension: GridDimension;
  filterName: string;
  filters: GridFilters;
  isAdvancedFiltersOpen: boolean;
  isSaveDialogOpen: boolean;
  isSavingFilter: boolean;
  onAdvancedFiltersOpenChange: (open: boolean) => void;
  onClearAll: () => void;
  onFilterNameChange: (value: string) => void;
  onIntentFilterChange: (value: string) => void;
  onIsQuestionOnlyChange: (value: boolean) => void;
  onMaxPositionChange: (value: number | "") => void;
  onMinClicksChange: (value: number | "") => void;
  onMinImpressionsChange: (value: number | "") => void;
  onMinWordsChange: (value: number | "") => void;
  onSaveDialogOpenChange: (open: boolean) => void;
  onSaveFilter: () => Promise<void>;
  onSearchTermChange: (value: string) => void;
};

function parseNumberInput(value: string) {
  return value ? Number(value) : "";
}

function getActiveFilterCount(dimension: GridDimension, filters: GridFilters) {
  let count = 0;

  if (filters.searchTerm.trim()) count += 1;
  if (dimension === "query" && filters.intentFilter !== "all") count += 1;
  if (dimension === "query" && filters.isQuestionOnly) count += 1;
  if (dimension === "query" && filters.minWords !== "") count += 1;
  if (filters.minClicks !== "") count += 1;
  if (filters.minImpressions !== "") count += 1;
  if (filters.maxPosition !== "") count += 1;

  return count;
}

export function GscFilterToolbar({
  dimension,
  filterName,
  filters,
  isAdvancedFiltersOpen,
  isSaveDialogOpen,
  isSavingFilter,
  onAdvancedFiltersOpenChange,
  onClearAll,
  onFilterNameChange,
  onIntentFilterChange,
  onIsQuestionOnlyChange,
  onMaxPositionChange,
  onMinClicksChange,
  onMinImpressionsChange,
  onMinWordsChange,
  onSaveDialogOpenChange,
  onSaveFilter,
  onSearchTermChange,
}: GscFilterToolbarProps) {
  const activeFilterCount = getActiveFilterCount(dimension, filters);

  return (
    <div className="flex flex-col gap-4 mb-5">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
        <div className="relative w-full sm:flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={getGridSearchPlaceholder(dimension)}
            className="h-9 rounded-lg border-[#E6ECE8] bg-white pl-8"
            value={filters.searchTerm}
            onChange={(event) => onSearchTermChange(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {dimension === "query" && (
            <Select value={filters.intentFilter} onValueChange={onIntentFilterChange}>
              <SelectTrigger className="h-9 w-[140px] rounded-lg border-[#E6ECE8] bg-white sm:w-[180px]">
                <SelectValue placeholder="Intent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Intents</SelectItem>
                <SelectItem value="commercial">Commercial</SelectItem>
                <SelectItem value="informational">Informational</SelectItem>
                <SelectItem value="navigational">Navigational</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Dialog open={isAdvancedFiltersOpen} onOpenChange={onAdvancedFiltersOpenChange}>
            <DialogTrigger render={<Button variant="secondary" className="h-9 shrink-0 rounded-lg bg-[#EEF3F0] text-[#0F172A]" />}>
              <Filter className="w-4 h-4 mr-2" />
              Filters
              {activeFilterCount > 0 && (
                <span className="ml-1 rounded-full bg-white px-1.5 py-0.5 text-xs text-[#647067]">
                  {activeFilterCount}
                </span>
              )}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Advanced Filters</DialogTitle>
                <DialogDescription>Filter your data by specific performance metrics.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                {dimension === "query" && (
                  <>
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium">Query Type</label>
                      <Select value={filters.isQuestionOnly ? "questions" : "all"} onValueChange={(value) => onIsQuestionOnlyChange(value === "questions")}>
                        <SelectTrigger>
                          <SelectValue placeholder="All Queries" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Queries</SelectItem>
                          <SelectItem value="questions">Questions Only</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium">Minimum Words</label>
                      <Input type="number" placeholder="e.g., 3" value={filters.minWords} onChange={(event) => onMinWordsChange(parseNumberInput(event.target.value))} />
                    </div>
                  </>
                )}
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Minimum Clicks</label>
                  <Input type="number" placeholder="e.g., 100" value={filters.minClicks} onChange={(event) => onMinClicksChange(parseNumberInput(event.target.value))} />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Minimum Impressions</label>
                  <Input type="number" placeholder="e.g., 1000" value={filters.minImpressions} onChange={(event) => onMinImpressionsChange(parseNumberInput(event.target.value))} />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Maximum Position</label>
                  <Input type="number" placeholder="e.g., 10" value={filters.maxPosition} onChange={(event) => onMaxPositionChange(parseNumberInput(event.target.value))} />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={() => onAdvancedFiltersOpenChange(false)}>Apply Filters</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <GscSaveFilterDialog
            dimension={dimension}
            filterName={filterName}
            filters={filters}
            isSaving={isSavingFilter}
            onFilterNameChange={onFilterNameChange}
            onOpenChange={onSaveDialogOpenChange}
            onSave={onSaveFilter}
            open={isSaveDialogOpen}
          />
        </div>
      </div>

      {hasActiveGridFilters(dimension, filters) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Active filters:</span>
          {filters.searchTerm && <Badge variant="secondary" className="font-normal">Search: {filters.searchTerm}</Badge>}
          {dimension === "query" && filters.intentFilter !== "all" && (
            <Badge variant="secondary" className="font-normal capitalize">
              Intent: {filters.intentFilter}
            </Badge>
          )}
          {dimension === "query" && filters.isQuestionOnly && <Badge variant="secondary" className="font-normal">Questions Only</Badge>}
          {dimension === "query" && filters.minWords !== "" && <Badge variant="secondary" className="font-normal">Words &ge; {filters.minWords}</Badge>}
          {filters.minClicks !== "" && <Badge variant="secondary" className="font-normal">Clicks &ge; {filters.minClicks}</Badge>}
          {filters.minImpressions !== "" && <Badge variant="secondary" className="font-normal">Impressions &ge; {filters.minImpressions}</Badge>}
          {filters.maxPosition !== "" && <Badge variant="secondary" className="font-normal">Position &le; {filters.maxPosition}</Badge>}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onClearAll}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
