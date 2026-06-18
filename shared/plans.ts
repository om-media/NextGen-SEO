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

const WORKSPACE_ACCESS_DEFINITION: PlanDefinition = {
  displayName: 'Workspace',
  monthlyPriceLabel: 'Included',
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
    'Unlimited workspace properties',
    'Automatic history import',
    'Full crawl inventory',
    'Rank tracking and reports',
  ],
};

export const PLAN_DEFINITIONS: Record<PlanTier, PlanDefinition> = {
  free: WORKSPACE_ACCESS_DEFINITION,
  pro: WORKSPACE_ACCESS_DEFINITION,
  enterprise: WORKSPACE_ACCESS_DEFINITION,
};

export function getPlanDefinition(tier: PlanTier | null | undefined) {
  void tier;
  return WORKSPACE_ACCESS_DEFINITION;
}

export function getPlanDisplayName(tier: PlanTier | null | undefined) {
  return getPlanDefinition(tier).displayName;
}

export function getPlanPropertyLimit(tier: PlanTier | null | undefined) {
  void tier;
  return null;
}

export function getPlanPropertyLimitLabel(tier: PlanTier | null | undefined) {
  const limit = getPlanPropertyLimit(tier);
  return limit === null ? 'Unlimited' : String(limit);
}

export function getRemainingPropertySlots(tier: PlanTier | null | undefined, unlockedCount: number) {
  void tier;
  void unlockedCount;
  return null;
}

export function isMultiSitePlan(tier: PlanTier | null | undefined) {
  void tier;
  return true;
}

export function getPlanCrawlLimits(tier: PlanTier | null | undefined) {
  return getPlanDefinition(tier).crawl;
}

export function canUseRawExports(tier: PlanTier | null | undefined) {
  void tier;
  return true;
}

export function canUseReconciliation(tier: PlanTier | null | undefined) {
  void tier;
  return true;
}
