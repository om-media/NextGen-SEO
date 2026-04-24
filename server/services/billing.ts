import type Database from 'better-sqlite3';

export type BillingStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';

export type BillingUpdate = {
  billingStatus: BillingStatus;
  currentPeriodEnd?: string | null;
  subscriptionId?: string | null;
  trialEndsAt?: string | null;
};

export function getBillingConfig() {
  return {
    checkoutConfigured: Boolean(
      process.env.BILLING_CHECKOUT_URL
      || process.env.BILLING_CHECKOUT_URL_PRO
      || process.env.BILLING_CHECKOUT_URL_ENTERPRISE,
    ),
    portalConfigured: Boolean(process.env.BILLING_PORTAL_URL),
    webhookConfigured: Boolean(process.env.BILLING_WEBHOOK_SECRET),
  };
}

export function updateUserBillingState(
  db: Database.Database,
  userId: string,
  update: BillingUpdate,
) {
  db.prepare(`
    UPDATE users
    SET billingStatus = ?, subscriptionId = ?, trialEndsAt = ?, currentPeriodEnd = ?
    WHERE id = ?
  `).run(
    update.billingStatus,
    update.subscriptionId || null,
    update.trialEndsAt || null,
    update.currentPeriodEnd || null,
    userId,
  );
}

export function updateUserBillingStateByEmail(
  db: Database.Database,
  email: string,
  update: BillingUpdate,
) {
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id?: string } | undefined;
  if (!user?.id) {
    return false;
  }

  updateUserBillingState(db, user.id, update);
  return true;
}
