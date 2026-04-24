import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { UserProfile } from "../../contexts/AuthContext";
import { getPlanDisplayName, getPlanPropertyLimitLabel } from "../../../shared/plans";

type UnlockSiteDialogProps = {
  onClose: () => void;
  onConfirm: () => Promise<void>;
  onOpenPlan: () => void;
  open: boolean;
  siteToUnlock: string | null;
  unlockError: string | null;
  userProfile: UserProfile | null;
};

export function UnlockSiteDialog({
  onClose,
  onConfirm,
  onOpenPlan,
  open,
  siteToUnlock,
  unlockError,
  userProfile,
}: UnlockSiteDialogProps) {
  const unlockedCount = userProfile?.unlockedSites.length || 0;
  const propertyLimitLabel = getPlanPropertyLimitLabel(userProfile?.tier);
  const planName = getPlanDisplayName(userProfile?.tier);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlock Property</DialogTitle>
          <DialogDescription>
            {unlockError ? (
              <span className="text-destructive">{unlockError}</span>
            ) : (
              <span>
                You are about to unlock <strong>{siteToUnlock}</strong>. Your {planName} plan currently uses <strong>{unlockedCount}</strong>{propertyLimitLabel !== "Unlimited" ? ` of ${propertyLimitLabel}` : ""} property slots. Once unlocked, this becomes part of your active workspace.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {unlockError && (
            <Button variant="outline" onClick={onOpenPlan}>
              View Plan Options
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {!unlockError && <Button onClick={onConfirm}>Confirm Unlock</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
