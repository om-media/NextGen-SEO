import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WarehouseSync } from "@/components/dashboard/WarehouseSync";

type DataSource = "gsc" | "bing" | "ga4";

type SettingsDialogProps = {
  dataSource: DataSource;
  onClose: () => void;
  onSave: () => Promise<void>;
  onTempBingKeyChange: (value: string) => void;
  open: boolean;
  selectedSite: string;
  tempBingKey: string;
};

export function SettingsDialog({
  dataSource,
  onClose,
  onSave,
  onTempBingKeyChange,
  open,
  selectedSite,
  tempBingKey,
}: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure your API keys and integrations.</DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <Label htmlFor="bing-key">Bing Webmaster Tools API Key</Label>
            <Input id="bing-key" value={tempBingKey} onChange={(e) => onTempBingKeyChange(e.target.value)} placeholder="Enter your Bing API Key" />
            <p className="text-xs text-muted-foreground">You can generate this key in the Bing Webmaster Tools portal under Settings &gt; API Access.</p>
          </div>
          {selectedSite && dataSource === "gsc" && (
            <div className="space-y-2 pt-4 border-t">
              <Label>Data Warehouse Sync</Label>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground text-balance">
                  Download historical data from Google Search Console directly to your local database for current selected site.
                </p>
                <WarehouseSync siteUrl={selectedSite} />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
