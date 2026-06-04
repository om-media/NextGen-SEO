import { authFetch } from "./authFetch";
import type { GscSite } from "../services/gscService";

type SiteProfile = {
  unlockedSites?: string[];
  knownSites?: string[];
};

function addUniqueSite(target: GscSite[], siteUrl: string) {
  if (!siteUrl || target.some((site) => site.siteUrl === siteUrl)) {
    return;
  }

  target.push({ siteUrl, permissionLevel: "warehouse" });
}

export function isGoogleAuthError(message: string) {
  return (
    message === "UNAUTHORIZED" ||
    message.includes("invalid authentication credentials") ||
    message.includes("OAuth 2 access token") ||
    message.includes("cannot reach Google APIs") ||
    message.includes("ECONNRESET") ||
    message.includes("EACCES") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ENOTFOUND")
  );
}

export function isGa4ScopeError(message: string) {
  return message.includes("insufficient authentication scopes");
}

export function buildOfflineGscSites(statuses: Array<{ siteUrl: string }>, profile?: SiteProfile | null) {
  const offlineSites: GscSite[] = statuses.map((status) => ({
    siteUrl: status.siteUrl,
    permissionLevel: "warehouse",
  }));

  for (const siteUrl of profile?.unlockedSites || []) {
    addUniqueSite(offlineSites, siteUrl);
  }

  for (const siteUrl of profile?.knownSites || []) {
    addUniqueSite(offlineSites, siteUrl);
  }

  return offlineSites;
}

export async function fetchOfflineGscSites(profile?: SiteProfile | null) {
  const response = await authFetch("/api/warehouse/status");
  const statuses = await response.json();
  const normalizedStatuses = Array.isArray(statuses) ? statuses : [];
  return buildOfflineGscSites(normalizedStatuses, profile);
}

export async function persistKnownSites(userId: string, knownSites: string[]) {
  await authFetch(`/api/users/${userId}/known-sites`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ knownSites }),
  });
}
