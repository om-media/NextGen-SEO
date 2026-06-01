import { useEffect, useRef } from "react";
import { useAuth } from "@/src/contexts/AuthContext";
import { authFetch } from "@/src/lib/authFetch";

const BOOTSTRAP_DAYS = 720;

export function GscWarehouseAutoSync({
  siteUrl,
}: {
  siteUrl: string | null;
}) {
  const { userProfile } = useAuth();
  const queuedKeys = useRef(new Set<string>());

  useEffect(() => {
    const propertyId = userProfile?.activatedGa4PropertyId || null;
    if (!siteUrl || !userProfile?.googleConnected) {
      return;
    }

    const bootstrapKey = `${siteUrl}:${propertyId || "gsc"}:${BOOTSTRAP_DAYS}`;
    if (queuedKeys.current.has(bootstrapKey)) {
      return;
    }
    queuedKeys.current.add(bootstrapKey);

    let cancelled = false;

    const queueBootstrap = async () => {
      try {
        await authFetch("/api/warehouse/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            days: BOOTSTRAP_DAYS,
            propertyId: propertyId || undefined,
            siteUrl,
          }),
        });
      } catch (err) {
        if (!cancelled) {
          queuedKeys.current.delete(bootstrapKey);
          console.warn("Automatic warehouse bootstrap skipped:", err);
        }
      }
    };

    void queueBootstrap();

    return () => {
      cancelled = true;
    };
  }, [siteUrl, userProfile?.activatedGa4PropertyId, userProfile?.googleConnected]);

  return null;
}
