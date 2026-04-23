import { DatePicker } from "@/components/ui/date-picker";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { AnnotationsSettings } from "@/components/dashboard/AnnotationsSettings";
import { WarehouseSync } from "@/components/dashboard/WarehouseSync";
import type { DateRange } from "react-day-picker";
import type { Annotation } from "../../services/annotationsService";

type DataSource = "gsc" | "bing" | "ga4";

type AppToolbarProps = {
  annotations: Annotation[];
  compareDateRange: DateRange;
  currentSiteUrl: string;
  dataSource: DataSource;
  dateRange: DateRange;
  firstName?: string;
  isCompareMode: boolean;
  onAnnotationsChange: () => Promise<void>;
  onCompareFromDateChange: (date: Date | undefined) => void;
  onCompareToDateChange: (date: Date | undefined) => void;
  onFromDateChange: (date: Date | undefined) => void;
  onToDateChange: (date: Date | undefined) => void;
  setIsCompareMode: (value: boolean) => void;
  setShowSystemAnnotations: (value: boolean) => void;
  setShowUserAnnotations: (value: boolean) => void;
  setUseLiveData: (value: boolean) => void;
  showSystemAnnotations: boolean;
  showUserAnnotations: boolean;
  useLiveData: boolean;
};

export function AppToolbar({
  annotations,
  compareDateRange,
  currentSiteUrl,
  dataSource,
  dateRange,
  firstName,
  isCompareMode,
  onAnnotationsChange,
  onCompareFromDateChange,
  onCompareToDateChange,
  onFromDateChange,
  onToDateChange,
  setIsCompareMode,
  setShowSystemAnnotations,
  setShowUserAnnotations,
  setUseLiveData,
  showSystemAnnotations,
  showUserAnnotations,
  useLiveData,
}: AppToolbarProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Welcome back, {firstName || "there"}!</h2>
        <p className="text-muted-foreground">Here's an overview of your search performance.</p>
      </div>
      <div className="flex flex-col items-start sm:items-end gap-2 w-full mt-4 sm:mt-0 sm:w-auto">
        <div className="flex flex-wrap items-center gap-3 w-full sm:justify-end">
          <AnnotationsSettings
            currentSiteUrl={currentSiteUrl}
            annotations={annotations}
            onAnnotationsChange={onAnnotationsChange}
            showSystemAnnotations={showSystemAnnotations}
            setShowSystemAnnotations={setShowSystemAnnotations}
            showUserAnnotations={showUserAnnotations}
            setShowUserAnnotations={setShowUserAnnotations}
          />
          {dataSource === "gsc" && (
            <div className="flex items-center gap-3">
              <WarehouseSync siteUrl={currentSiteUrl} />
              <div className="flex items-center space-x-2">
                <Switch id="warehouse-mode" checked={useLiveData} onCheckedChange={setUseLiveData} />
                <Label htmlFor="warehouse-mode" className="text-sm font-medium cursor-pointer whitespace-nowrap">
                  Live Data
                </Label>
              </div>
            </div>
          )}
          <div className="flex items-center space-x-2">
            <Switch id="compare-mode" checked={isCompareMode} onCheckedChange={setIsCompareMode} />
            <Label htmlFor="compare-mode" className="text-sm font-medium cursor-pointer">
              Compare
            </Label>
          </div>
          <div className="flex flex-wrap items-center gap-1 sm:gap-2 bg-card border rounded-md p-1">
            <DatePicker date={dateRange.from} setDate={onFromDateChange} label="From" />
            <span className="text-muted-foreground text-sm font-medium px-1 sm:px-2">to</span>
            <DatePicker date={dateRange.to} setDate={onToDateChange} label="To" />
          </div>
        </div>
        {isCompareMode && (
          <div className="flex flex-wrap items-center gap-1 sm:gap-2 bg-muted/30 border border-dashed rounded-md p-1 self-start sm:self-end">
            <span className="text-muted-foreground text-sm font-medium px-1 sm:px-2">vs</span>
            <DatePicker date={compareDateRange.from} setDate={onCompareFromDateChange} label="Compare From" />
            <span className="text-muted-foreground text-sm font-medium px-1 sm:px-2">to</span>
            <DatePicker date={compareDateRange.to} setDate={onCompareToDateChange} label="Compare To" />
          </div>
        )}
      </div>
    </div>
  );
}
