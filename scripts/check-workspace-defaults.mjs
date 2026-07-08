import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const registrationTier = read('server/services/registrationTier.ts');
assert(
  /return ['"]enterprise['"]/.test(registrationTier),
  'New registrations must receive the full workspace default tier',
);

const authRoutes = read('server/routes/auth.ts');
assert(
  authRoutes.includes("tier: (user.tier as 'free' | 'pro' | 'enterprise') || 'enterprise'"),
  'Profiles with no stored tier must normalize to the full workspace default tier',
);

const queryCountView = read('components/dashboard/QueryCountView.tsx');
const overviewView = read('components/dashboard/Overview.tsx');
const dataImportStatusPanel = read('src/components/app/DataImportStatusPanel.tsx');
assert(
  !dataImportStatusPanel.includes('autoImportKeys'),
  'Date-range readiness UI must not silently auto-queue missing history imports',
);
assert(
  !dataImportStatusPanel.includes('Failed to start automatic import'),
  'Missing range imports should be lifecycle-driven, not triggered by the visible report panel',
);

assert(
  !queryCountView.includes("['page', 'query'], undefined, true")
    && !queryCountView.includes('fetchLiveDateQueryRows'),
  'Visible Queries must use stored warehouse counts instead of forced live page-query reads',
);
assert(
  !overviewView.includes('querySearchAnalytics(')
    && !overviewView.includes('fetchLiveQueryCounts')
    && !overviewView.includes('shouldPreferLiveDrilldown'),
  'GSC overview must use stored warehouse reads instead of hidden live drilldowns',
);
const manualImportCount = (dataImportStatusPanel.match(/queueMissingCoverageSync\(/g) || []).length;
assert(
  manualImportCount === 1,
  'The source-data panel may keep one explicit manual import action, but no hidden auto-import effect',
);

const accountRoutes = read('server/routes/accountData.ts');
assert(
  accountRoutes.includes('void queueKnownSiteDataIfPossible(user.id, uniqueSites(['),
  'Connected profile loads must prime full-history imports for saved workspace sites',
);
assert(
  accountRoutes.includes('user.activatedSiteUrl ||')
    && accountRoutes.includes('...user.unlockedSites')
    && accountRoutes.includes('...user.knownSites'),
  'Profile priming must include the active, unlocked, and known workspace sites',
);

const warehouseRoutes = read('server/routes/warehouse.ts');
assert(
  !warehouseRoutes.includes('ensureGscMonthlySummariesForRange'),
  'Warehouse report reads must not synchronously build monthly GSC summaries',
);
assert(
  /const hasSummaryCoverage = await hasGscMonthlySummariesForRange/.test(warehouseRoutes),
  'Warehouse report reads should only use monthly summaries when coverage already exists',
);
assert(
  (warehouseRoutes.match(/SUM\(queryCount\) AS queryCount/g) || []).length >= 2,
  'Warehouse page-summary reads must expose stored visible-query counts',
);

const warehouseJobs = read('server/services/warehouseJobs.ts');
const alreadyStoredBranch = warehouseJobs.slice(
  warehouseJobs.indexOf('const alreadyStored = await hasRequiredCoreWarehouseRows'),
  warehouseJobs.indexOf('const gscResult = await syncGscRange'),
);
assert(
  alreadyStoredBranch.includes('await refreshGscMonthlySummariesForRange'),
  'Already-warehoused GSC jobs must refresh reporting summaries before being superseded',
);
assert(
  /FROM gsc_page_metrics/.test(warehouseJobs.slice(
    warehouseJobs.indexOf('async function hasRequiredCoreWarehouseRows'),
    warehouseJobs.indexOf('async function executeWarehouseJob'),
  )),
  'Core warehouse completion must require page-level GSC summaries for fast Pages reports',
);

assert(
  warehouseRoutes.includes('LONG_GSC_DETAIL_COVERAGE_DAY_THRESHOLD = 45'),
  'Long-range coverage checks should avoid heavyweight GSC detail table scans',
);
assert(
  warehouseRoutes.includes('const gscQueryCoverageRows = useLightweightGscDetailCoverage ? gscSiteRows : gscQueryRows')
    && warehouseRoutes.includes('const gscPageQueryCoverageRows = useLightweightGscDetailCoverage ? gscSiteRows : gscPageQueryRows')
    && warehouseRoutes.includes('const gscCountryCoverageRows = useLightweightGscDetailCoverage ? gscSiteRows : gscCountryRows'),
  'Long-range GSC coverage should reuse lightweight site-day coverage for detail readiness',
);
const gscMonthlySummaries = read('server/services/gscMonthlySummaries.ts');
assert(
  gscMonthlySummaries.includes('GSC_MONTHLY_SUMMARY_BACKFILL_INITIAL_DELAY_MS, 5_000'),
  'GSC monthly summary warmup should start shortly after the app boots',
);
assert(
  gscMonthlySummaries.includes('GSC_MONTHLY_SUMMARY_BACKFILL_MAX_SITES, 10'),
  'GSC monthly summary warmup should process enough sites per pass for real workspaces',
);
console.log('Workspace defaults check passed');
