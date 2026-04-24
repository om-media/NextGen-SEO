import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2, Plus } from "lucide-react";
import { getGridFilterSummary, type GridDimension, type GridFilters } from "./gscGridUtils";

type GscSaveFilterDialogProps = {
  dimension: GridDimension;
  filterName: string;
  filters: GridFilters;
  isSaving: boolean;
  onFilterNameChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSave: () => Promise<void>;
  open: boolean;
};

export function GscSaveFilterDialog({
  dimension,
  filterName,
  filters,
  isSaving,
  onFilterNameChange,
  onOpenChange,
  onSave,
  open,
}: GscSaveFilterDialogProps) {
  const filterSummary = getGridFilterSummary(dimension, filters);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm" className="h-9 rounded-lg bg-[#0F3D2E] px-3 text-white hover:bg-[#0B2F23]" />}>
        <Plus className="w-4 h-4 mr-2" />
        Save Filter
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save Custom Filter</DialogTitle>
          <DialogDescription>
            Save your current search and intent filters to quickly access them later from the sidebar.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="name" className="text-sm font-medium">
              Filter Name
            </label>
            <Input
              id="name"
              placeholder="e.g., High Intent Commercial Queries"
              value={filterName}
              onChange={(event) => onFilterNameChange(event.target.value)}
            />
          </div>
          <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
            <p className="font-medium mb-1">Current Configuration:</p>
            <ul className="list-disc pl-4 space-y-1">
              {filterSummary.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void onSave()} disabled={!filterName.trim() || isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Filter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
