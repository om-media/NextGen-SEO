import type { Express } from 'express';
import type { AppDatabase } from '../database.js';
import { requireAuth } from '../auth.js';
import { isNonEmptyString } from '../validation.js';
import { getBillingConfig, updateUserBillingState, updateUserBillingStateByEmail, type BillingStatus } from '../services/billing.js';

function getCheckoutUrl(targetPlan: string) {
  if (targetPlan === 'pro') {
    return process.env.BILLING_CHECKOUT_URL_PRO || process.env.BILLING_CHECKOUT_URL || null;
  }

  if (targetPlan === 'enterprise') {
    return process.env.BILLING_CHECKOUT_URL_ENTERPRISE || process.env.BILLING_CHECKOUT_URL || null;
  }

  return null;
}

const allowedBillingStatuses = new Set<BillingStatus>(['trialing', 'active', 'past_due', 'canceled', 'incomplete']);

export function registerBillingRoutes(app: Express, db: AppDatabase) {
  const authRequired = requireAuth(db);
  app.get('/api/billing/config', authRequired, (_req, res) => {
    return res.json(getBillingConfig());
  });

  app.post('/api/billing/checkout-session', authRequired, (req, res) => {
    const { targetPlan } = req.body;

    if (targetPlan !== 'pro' && targetPlan !== 'enterprise') {
      return res.status(400).json({ error: 'Invalid targetPlan' });
    }

    const url = getCheckoutUrl(targetPlan);
    if (!url) {
      return res.status(501).json({
        error: 'Billing checkout is not configured yet. Add BILLING_CHECKOUT_URL_PRO or BILLING_CHECKOUT_URL_ENTERPRISE to enable upgrades.',
      });
    }

    return res.json({ url });
  });

  app.post('/api/billing/portal', authRequired, (_req, res) => {
    const url = process.env.BILLING_PORTAL_URL || null;
    if (!url) {
      return res.status(501).json({
        error: 'Billing portal is not configured yet. Add BILLING_PORTAL_URL to enable self-serve billing management.',
      });
    }

    return res.json({ url });
  });

  app.post('/api/billing/webhook', async (req, res) => {
    const configuredSecret = process.env.BILLING_WEBHOOK_SECRET;
    if (!configuredSecret) {
      return res.status(501).json({ error: 'Billing webhook is not configured yet.' });
    }

    const requestSecret = req.header('x-billing-webhook-secret');
    if (requestSecret !== configuredSecret) {
      return res.status(401).json({ error: 'Invalid billing webhook secret' });
    }

    const { userId, email, billingStatus, subscriptionId, trialEndsAt, currentPeriodEnd } = req.body || {};

    if (!isNonEmptyString(billingStatus) || !allowedBillingStatuses.has(billingStatus as BillingStatus)) {
      return res.status(400).json({ error: 'Invalid billingStatus' });
    }
    if (subscriptionId !== undefined && subscriptionId !== null && typeof subscriptionId !== 'string') {
      return res.status(400).json({ error: 'Invalid subscriptionId' });
    }
    if (trialEndsAt !== undefined && trialEndsAt !== null && typeof trialEndsAt !== 'string') {
      return res.status(400).json({ error: 'Invalid trialEndsAt' });
    }
    if (currentPeriodEnd !== undefined && currentPeriodEnd !== null && typeof currentPeriodEnd !== 'string') {
      return res.status(400).json({ error: 'Invalid currentPeriodEnd' });
    }
    if (!isNonEmptyString(userId) && !isNonEmptyString(email)) {
      return res.status(400).json({ error: 'Webhook must include userId or email' });
    }

    const update = {
      billingStatus: billingStatus as BillingStatus,
      subscriptionId: subscriptionId || null,
      trialEndsAt: trialEndsAt || null,
      currentPeriodEnd: currentPeriodEnd || null,
    };

    try {
      if (isNonEmptyString(userId)) {
        await updateUserBillingState(db, userId, update);
        return res.json({ success: true, matchedBy: 'userId' });
      }

      const updated = await updateUserBillingStateByEmail(db, email, update);
      if (!updated) {
        return res.status(404).json({ error: 'No matching user found for billing webhook' });
      }

      return res.json({ success: true, matchedBy: 'email' });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });
}
