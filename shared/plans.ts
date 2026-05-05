export type PlanTier = 'free' | 'pro' | 'enterprise';

export type PlanDefinition = {
  displayName: string;
  monthlyPriceLabel: string;
  propertyLimit: number | null;
  aiInsights: 'limited' | 'expanded' | 'priority';
  warehouseSync: 'basic' | 'extended' | 'unlimited';
  rankTracking: 'starter' | 'growth' | 'scale';
  crawl: {
    allowJavaScriptRendering: boolean;
    allowRawExports: boolean;
    allowReconciliation: boolean;
    maxDepth: number;
    maxPages: number;
  };
  featureHighlights: string[];
};

export const PLAN_DEFINITIONS: Record<PlanTier, PlanDefinition> = {
  free: {
    displayName: 'Free',
    monthlyPriceLabel: '$0',
    propertyLimit: 1,
    aiInsights: 'limited',
    warehouseSync: 'basic',
    rankTracking: 'starter',
    crawl: {
      allowJavaScriptRendering: false,
      allowRawExports: false,
      allowReconciliation: false,
      maxDepth: 2,
      maxPages: 1000,
    },
    featureHighlights: [
      '1 active property',
      'Core Search Console dashboard',
      'Basic warehouse sync',
      'Starter rank tracking',
    ],
  },
  pro: {
    displayName: 'Pro',
    monthlyPriceLabel: '$49',
    propertyLimit: 3,
    aiInsights: 'expanded',
    warehouseSync: 'extended',
    rankTracking: 'growth',
    crawl: {
      allowJavaScriptRendering: true,
      allowRawExports: true,
      allowReconciliation: true,
      maxDepth: 6,
      maxPages: 25000,
    },
    featureHighlights: [
      '3 active properties',
      'Expanded AI workflows',
      'Extended warehouse sync',
      'Growth rank tracking',
    ],
  },
  enterprise: {
    displayName: 'Enterprise',
    monthlyPriceLabel: 'Custom',
    propertyLimit: null,
    aiInsights: 'priority',
    warehouseSync: 'unlimited',
    rankTracking: 'scale',
    crawl: {
      allowJavaScriptRendering: true,
      allowRawExports: true,
      allowReconciliation: true,
      maxDepth: 10,
      maxPages: 100000,
    },
    featureHighlights: [
      'Unlimited active properties',
      'Priority AI workflows',
      'Unlimited warehouse sync',
      'Scale rank tracking',
    ],
  },
};

export function getPlanDefinition(tier: PlanTier | null | undefined) {
  return PLAN_DEFINITIONS[tier || 'free'];
}

export function getPlanDisplayName(tier: PlanTier | null | undefined) {
  return getPlanDefinition(tier).displayName;
}

export function getPlanPropertyLimit(tier: PlanTier | null | undefined) {
  return getPlanDefinition(tier).propertyLimit;
}

export function getPlanPropertyLimitLabel(tier: PlanTier | null | undefined) {
  const limit = getPlanPropertyLimit(tier);
  return limit === null ? 'Unlimited' : String(limit);
}

export function getRemainingPropertySlots(tier: PlanTier | null | undefined, unlockedCount: number) {
  const limit = getPlanPropertyLimit(tier);
  if (limit === null) {
    return null;
  }

  return Math.max(limit - unlockedCount, 0);
}

export function isMultiSitePlan(tier: PlanTier | null | undefined) {
  const limit = getPlanPropertyLimit(tier);
  return limit === null || limit > 1;
}

export function getPlanCrawlLimits(tier: PlanTier | null | undefined) {
  return getPlanDefinition(tier).crawl;
}

export function canUseRawExports(tier: PlanTier | null | undefined) {
  return getPlanDefinition(tier).crawl.allowRawExports;
}

export function canUseReconciliation(tier: PlanTier | null | undefined) {
  return getPlanDefinition(tier).crawl.allowReconciliation;
}
