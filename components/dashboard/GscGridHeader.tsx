import { CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { GscAiInsightsDialog } from "./GscAiInsightsDialog";
import { getGridTitle, getGridTitleWithCount, type GridDimension } from "./gscGridUtils";

type GscGridHeaderProps = {
  aiError: string | null;
  aiInsights: string | null;
  dimension: GridDimension;
  isAiDialogOpen: boolean;
  isGeneratingAi: boolean;
  onAiDialogOpenChange: (open: boolean) => void;
  onExport: () => void;
  onGenerateInsights: () => Promise<void>;
  rowCount: number;
};

export function GscGridHeader({
  aiError,
  aiInsights,
  dimension,
  isAiDialogOpen,
  isGeneratingAi,
  onAiDialogOpenChange,
  onExport,
  onGenerateInsights,
  rowCount,
}: GscGridHeaderProps) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="space-y-1">
        <CardTitle className="text-lg leading-tight text-[#0F172A]">{getGridTitleWithCount(dimension, rowCount)}</CardTitle>
        <p className="text-sm text-muted-foreground">
          Analyze your top performing {getGridTitle(dimension).toLowerCase()} and discover new opportunities.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <GscAiInsightsDialog
          description={`Analysis based on your current filters and sorting for ${getGridTitle(dimension).toLowerCase()}.`}
          error={aiError}
          insights={aiInsights}
          isGenerating={isGeneratingAi}
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
    </div>
  );
}
