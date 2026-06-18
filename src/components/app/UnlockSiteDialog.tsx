import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { UserProfile } from "../../contexts/AuthContext";

type UnlockSiteDialogProps = {
  onClose: () => void;
  onConfirm: () => Promise<void>;
  onOpenWorkspace: () => void;
  open: boolean;
  siteToUnlock: string | null;
  unlockError: string | null;
  userProfile: UserProfile | null;
};

export function UnlockSiteDialog({
  onClose,
  onConfirm,
  onOpenWorkspace,
  open,
  siteToUnlock,
  unlockError,
  userProfile,
}: UnlockSiteDialogProps) {
  const unlockedCount = userProfile?.unlockedSites.length || 0;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Activate Property</DialogTitle>
          <DialogDescription>
            {unlockError ? (
              <span className="text-destructive">{unlockError}</span>
            ) : (
              <span>
                You are about to activate <strong>{siteToUnlock}</strong>. Your workspace currently has <strong>{unlockedCount}</strong> active propert{unlockedCount === 1 ? "y" : "ies"}. Once activated, this property becomes part of your workspace.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {unlockError && (
            <Button variant="outline" onClick={onOpenWorkspace}>
              View Workspace
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {!unlockError && <Button onClick={onConfirm}>Activate Property</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
