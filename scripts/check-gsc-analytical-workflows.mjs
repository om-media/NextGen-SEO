import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const aiAuditor = read('components/dashboard/AIContentAuditorView.tsx');
assert(
  aiAuditor.includes('querySearchAnalytics(siteUrl, startDate, endDate, ["page"]);'),
  'AI content auditor must use the warehouse-backed page query path by default',
);
assert(
  !aiAuditor.includes('querySearchAnalytics(siteUrl, startDate, endDate, ["page"], undefined, useLiveData)'),
  'AI content auditor must not switch into live GSC fetch mode from the global toggle',
);

const rankTracker = read('src/components/dashboard/RankTrackerView.tsx');
assert(
  rankTracker.includes('getStoredQueryPositions('),
  'Rank tracker keyword add flow must seed positions from stored GSC query data',
);
assert(
  rankTracker.includes('initialPositions') && !rankTracker.includes('handleSync(true)'),
  'Rank tracker must avoid auto-triggering live rank refresh after keyword creation',
);
assert(
  rankTracker.includes("querySearchAnalytics(tryUrl, start, end, ['query', 'page', 'device', 'country'], filterGroups, true)"),
  'Rank tracker must keep the explicit live refresh path for deliberate fresh rank collection',
);
assert(
  rankTracker.includes('Collect fresh ranks'),
  'Rank tracker should label explicit fresh collection actions clearly',
);

const gscService = read('src/services/gscService.ts');
assert(
  gscService.includes('SUPPORTED_WAREHOUSE_FILTER_OPERATORS')
    && gscService.includes('getStoredQueryPositions('),
  'GSC service must guard warehouse-only operators and expose stored query position lookup',
);

console.log('GSC analytical workflow wiring check passed');
