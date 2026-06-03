import { CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { GscAiInsightsDialog } from "./GscAiInsightsDialog";
import { getGridTitle, type GridDimension } from "./gscGridUtils";

type GscGridHeaderProps = {
  aiError: string | null;
  aiInsights: string | null;
  descriptionOverride?: string;
  dimension: GridDimension;
  isAiDialogOpen: boolean;
  isGeneratingAi: boolean;
  isAiProviderUnavailable: boolean;
  onAiDialogOpenChange: (open: boolean) => void;
  onExport: () => void;
  onGenerateInsights: () => Promise<void>;
  rowCount: number;
  rowLimit?: number | null;
  showActions?: boolean;
  totalRowCount?: number | null;
  titleOverride?: string;
};

export function GscGridHeader({
  aiError,
  aiInsights,
  descriptionOverride,
  dimension,
  isAiDialogOpen,
  isGeneratingAi,
  isAiProviderUnavailable,
  onAiDialogOpenChange,
  onExport,
  onGenerateInsights,
  rowCount,
  rowLimit,
  showActions = true,
  totalRowCount,
  titleOverride,
}: GscGridHeaderProps) {
  const hasWarehouseTotal = typeof totalRowCount === "number" && Number.isFinite(totalRowCount);
  const isLimitedPreview = Boolean(rowLimit && hasWarehouseTotal && totalRowCount > rowCount);
  const titleCount = hasWarehouseTotal ? totalRowCount : rowCount;
  const titleCountSuffix = hasWarehouseTotal ? " total" : "";
  const dimensionLabel = dimension === "query" ? "queries" : getGridTitle(dimension).toLowerCase().replace(/^top\s+/, "");
  const description = descriptionOverride || `Analyze your top performing ${dimensionLabel} and discover new opportunities.`;

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="space-y-1">
        <CardTitle className="text-lg leading-tight text-[#0F172A]">
          {titleOverride || `${getGridTitle(dimension)} (${titleCount.toLocaleString()}${titleCountSuffix})`}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {description}
          {isLimitedPreview && (
            <span className="ml-1">
              Showing the top {rowCount.toLocaleString()} rows in this table for fast loading.
            </span>
          )}
        </p>
      </div>

      {showActions && (
        <div className="flex flex-wrap items-center gap-2">
          <GscAiInsightsDialog
            description={`Analysis based on your current filters and sorting for ${getGridTitle(dimension).toLowerCase()}.`}
            error={aiError}
            insights={aiInsights}
            isGenerating={isGeneratingAi}
            isProviderUnavailable={isAiProviderUnavailable}
            onGenerate={onGenerateInsights}
            onOpenChange={onAiDialogOpenChange}
            open={isAiDialogOpen}
            title="AI SEO Insights"
          />
          <Button variant="outline" size="sm" onClick={onExport} className="h-9 rounded-lg border-[#E6ECE8] bg-white">
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      )}
    </div>
  );
}
