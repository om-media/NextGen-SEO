import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { DateRange } from "react-day-picker";
import { Overview } from "./Overview";
import type { GridDimension } from "./gscGridUtils";

type GscHistoricTrendCardProps = {
  compareDateRange?: DateRange;
  dateRange?: DateRange;
  dimension: GridDimension;
  isCompareMode?: boolean;
  onClose: () => void;
  selectedRowKey: string;
  siteUrl: string;
  useLiveData?: boolean;
};

export function GscHistoricTrendCard({
  compareDateRange,
  dateRange,
  dimension,
  isCompareMode,
  onClose,
  selectedRowKey,
  siteUrl,
  useLiveData,
}: GscHistoricTrendCardProps) {
  return (
    <Card className="overflow-hidden rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
      <div className="flex flex-col items-start justify-between gap-3 border-b border-[#E6ECE8] bg-white p-5 sm:flex-row sm:items-center">
        <div>
          <h3 className="text-lg font-semibold tracking-[-0.01em] text-[#0F172A]">Historic trend</h3>
          <p className="text-sm text-[#647067]">
            Performance over time for {dimension}: <span className="font-medium text-foreground">{selectedRowKey}</span>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close Chart
        </Button>
      </div>
      <div className="p-6">
        <Overview
          siteUrl={siteUrl}
          dateRange={dateRange}
          filterDimension={dimension}
          filterValue={selectedRowKey}
          isCompareMode={isCompareMode}
          compareDateRange={compareDateRange}
          useLiveData={useLiveData}
        />
      </div>
    </Card>
  );
}
