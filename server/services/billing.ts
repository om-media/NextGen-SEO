import type { AppDatabase } from '../database.js';

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
  db: AppDatabase,
  userId: string,
  update: BillingUpdate,
) {
  return db.run(`
    UPDATE users
    SET billingStatus = ?, subscriptionId = ?, trialEndsAt = ?, currentPeriodEnd = ?
    WHERE id = ?
  `, [
    update.billingStatus,
    update.subscriptionId || null,
    update.trialEndsAt || null,
    update.currentPeriodEnd || null,
    userId,
  ]);
}

export async function updateUserBillingStateByEmail(
  db: AppDatabase,
  email: string,
  update: BillingUpdate,
) {
  const user = await db.get<{ id?: string }>('SELECT id FROM users WHERE email = ?', [email]);
  if (!user?.id) {
    return false;
  }

  await updateUserBillingState(db, user.id, update);
  return true;
}
