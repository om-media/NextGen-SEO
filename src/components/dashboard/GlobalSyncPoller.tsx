import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useAuth } from "@/src/contexts/AuthContext"
import { authFetch } from "@/src/lib/authFetch"

export function GlobalSyncPoller({ siteUrl }: { siteUrl: string | null }) {
  const { accessToken } = useAuth()
  const lastState = useRef<Record<string, string>>({})

  useEffect(() => {
    if (!siteUrl || !accessToken) return;

    let mounted = true;
    let pollInterval: any = null;

    const pollStatus = async () => {
      try {
        const res = await authFetch(`/api/indexing/auto-sync/status?siteUrl=${encodeURIComponent(siteUrl)}`);
        const result = await res.json();
        
        if (!mounted) return;

        const previousState = lastState.current[siteUrl];

        // Only report if it transitioned from 'running' to 'completed' remotely
        if (result.status === 'completed' && previousState === 'running') {
           toast.success("URL indexing sync complete!", {
             description: `Successfully fetched inspection data for URLs on ${siteUrl}.`,
           });
        }
        
        if (result.status === 'error' && previousState === 'running') {
           toast.error("URL indexing sync failed", {
             description: result.message || `An error occurred during synchronization on ${siteUrl}.`,
           });
        }

        if (result.status) {
           lastState.current[siteUrl] = result.status;
        }

      } catch (err: any) {
        // Silently ignore "Failed to fetch" on polling as it's common on mobile connection drops
        if (err?.message !== "Failed to fetch") {
          console.error("Global sync poll err", err);
        }
      }
    };

    pollInterval = setInterval(pollStatus, 4000);
    pollStatus();

    return () => {
      mounted = false;
      if (pollInterval) clearInterval(pollInterval);
    }
  }, [siteUrl, accessToken]);

  return null;
}
