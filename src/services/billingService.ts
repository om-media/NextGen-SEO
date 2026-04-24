import { authFetch } from "../lib/authFetch";

export type BillingConfig = {
  checkoutConfigured: boolean;
  portalConfigured: boolean;
  webhookConfigured: boolean;
};

export async function getBillingConfig() {
  const response = await authFetch("/api/billing/config");
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Failed to load billing config");
  }

  return data as BillingConfig;
}

export async function startCheckout(targetPlan: "pro" | "enterprise") {
  const response = await authFetch("/api/billing/checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetPlan }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.url) {
    throw new Error(data?.error || "Failed to start checkout");
  }

  return data.url as string;
}

export async function openBillingPortal() {
  const response = await authFetch("/api/billing/portal", {
    method: "POST",
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.url) {
    throw new Error(data?.error || "Failed to open billing portal");
  }

  return data.url as string;
}
