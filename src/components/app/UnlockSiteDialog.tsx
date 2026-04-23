import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { UserProfile } from "../../contexts/AuthContext";

type UnlockSiteDialogProps = {
  onClose: () => void;
  onConfirm: () => Promise<void>;
  open: boolean;
  siteToUnlock: string | null;
  unlockError: string | null;
  userProfile: UserProfile | null;
};

export function UnlockSiteDialog({
  onClose,
  onConfirm,
  open,
  siteToUnlock,
  unlockError,
  userProfile,
}: UnlockSiteDialogProps) {
  const tierLimit = userProfile?.tier === "free" ? 1 : userProfile?.tier === "pro" ? 3 : "unlimited";

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
                You are about to unlock <strong>{siteToUnlock}</strong>. Your current tier ({userProfile?.tier}) allows you to unlock up to {tierLimit} properties. Once unlocked, you cannot remove it.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {!unlockError && <Button onClick={onConfirm}>Confirm Unlock</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
