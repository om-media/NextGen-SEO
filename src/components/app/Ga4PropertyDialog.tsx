import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";

type Ga4PropertyDialogProps = {
  open: boolean;
  properties: Array<{ siteUrl: string; displayName: string }>;
  selectedProperty: string;
  saving: boolean;
  onClose: () => void;
  onSelect: (value: string) => void;
  onSave: () => Promise<void>;
};

export function Ga4PropertyDialog({
  open,
  properties,
  selectedProperty,
  saving,
  onClose,
  onSave,
  onSelect,
}: Ga4PropertyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-[#E6ECE8] bg-white px-6 py-5">
          <DialogTitle>Choose GA4 property</DialogTitle>
          <DialogDescription>
            Select the Google Analytics 4 property this workspace should use by default. You can change it later from Settings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 bg-[#FBFCFB] px-6 py-5">
          <Label htmlFor="ga4-property-select">GA4 property</Label>
          <Select value={selectedProperty} onValueChange={onSelect}>
            <SelectTrigger id="ga4-property-select" className="h-11 rounded-xl border-[#E6ECE8] bg-white shadow-sm">
              <SelectValue placeholder="Select a GA4 property" />
            </SelectTrigger>
            <SelectContent>
              {properties.map((property) => (
                <SelectItem key={property.siteUrl} value={property.siteUrl}>
                  {property.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter className="border-t border-[#E6ECE8] bg-white px-6 py-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!selectedProperty || saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {saving ? "Saving..." : "Use this property"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
