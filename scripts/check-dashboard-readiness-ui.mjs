import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const app = read('src/App.tsx');
const header = read('src/components/app/AppHeader.tsx');
const readinessPanel = read('src/components/app/DataImportStatusPanel.tsx');
const warehouseRoute = read('server/routes/warehouse.ts');
const llmTraffic = read('components/dashboard/Ga4LlmTraffic.tsx');
const appStatusPanels = read('src/components/app/AppStatusPanels.tsx');

assert(header.includes('import { DataImportStatusPanel }'), 'The app header must own the compact source-data readiness control');
assert(header.includes('<DataImportStatusPanel') && header.includes('compact'), 'The app header must render the compact readiness control');
for (const prop of [
  'dateRange={dateRange}',
  'ga4PropertyId={ga4PropertyId}',
  'refreshKey={gscSyncVersion}',
  'siteUrl={selectedWorkspaceSite}',
]) {
  assert(header.includes(prop), `Compact readiness control must receive ${prop}`);
}
assert(app.includes('dateRange={dateRange}') && app.includes('gscSyncVersion={gscSyncVersion}'), 'The app shell must pass live readiness inputs to the header');
assert(readinessPanel.includes('Data readiness: ${statusCopy.label}'), 'The readiness control must expose an accessible status label');
assert(readinessPanel.includes('Source data readiness'), 'Readiness details must have a visible, plain-language heading');
assert(readinessPanel.includes('format(parseISO(range.startDate), "MMM d, yyyy")') && readinessPanel.includes('format(parseISO(range.endDate), "MMM d, yyyy")'), 'Readiness details must show the selected date range');
assert(readinessPanel.includes('{formatWholeNumber(stats.readyDateCount)} / {formatWholeNumber(stats.expectedDateCount)} days ready') && readinessPanel.includes('role="progressbar"'), 'Readiness details must show explicit day coverage progress');
assert(readinessPanel.includes('Import appears stalled') && readinessPanel.includes('staleActiveCount') && warehouseRoute.includes('staleSince'), 'Stale warehouse jobs must be surfaced as an explicit stalled state with heartbeat metadata');
assert(readinessPanel.includes('activeDateCount') && readinessPanel.includes('unscheduledMissingDateCount'), 'Import progress must distinguish active jobs from missing dates that are not scheduled');
assert(readinessPanel.includes('queuedJobCount') && readinessPanel.includes('runningJobCount'), 'Readiness metrics must report queue and running counts for the selected source, not unrelated warehouse jobs');
assert(readinessPanel.includes('source.staleActiveCount') && readinessPanel.includes('source.activeDateCount'), 'Readiness stalled state must use source-scoped heartbeat and active-date metadata');
assert(warehouseRoute.includes('activeDateCount: countActiveDates(ga4PageSourceJobs, missingGa4PageDates)') && warehouseRoute.includes('staleActiveCount: ga4PageSourceStaleCount'), 'Coverage API must expose source-scoped queue activity metadata');
assert(readinessPanel.includes('Retrying ${formatWholeNumber(result.retried)} failed import') && readinessPanel.includes('Completed days and successful jobs were left untouched'), 'Retry actions must explain that only failed jobs are requeued');
assert(readinessPanel.includes('width: \"min(720px, calc(100vw - 1rem))\"') && readinessPanel.includes('maxWidth: \"calc(100vw - 1rem)\"'), 'Compact readiness details must keep a usable responsive width');
assert(readinessPanel.includes('compact ? \"flex flex-col gap-4\"') && readinessPanel.includes('compact ? \"grid min-w-0 w-full gap-2 sm:grid-cols-5\"'), 'Compact readiness details must stack before the desktop metrics width can squeeze the copy');
assert(llmTraffic.includes('activeDateCount') && llmTraffic.includes('unscheduledMissingDateCount') && llmTraffic.includes('Analytics import needs attention'), 'LLM traffic readiness must expose the same queue and failure states as other Analytics pages');
assert(llmTraffic.includes('rounded-2xl border border-border bg-card px-4 py-3') && llmTraffic.includes('coverageStatusDescription'), 'LLM traffic readiness must use the shared dashboard status-strip treatment');
assert(appStatusPanels.includes('Reporting connection failed') && appStatusPanels.includes('onRetry') && appStatusPanels.includes('not proof that the Google API is disabled'), 'Network reporting failures must be distinguished from Google API configuration failures and be retryable');

const appToolbar = read('src/components/app/AppToolbar.tsx');
const ga4ReportPaths = [
  'components/dashboard/Ga4DataGrid.tsx',
  'components/dashboard/Ga4Demographics.tsx',
  'components/dashboard/Ga4LlmTraffic.tsx',
  'components/dashboard/Ga4Overview.tsx',
];
const tenSecondTimeoutPattern = /(?:window\.)?setTimeout\(\s*\(\)\s*=>[\s\S]{0,180}?\b(?:10_000|10000)\b/;
for (const reportPath of ga4ReportPaths) {
  const report = read(reportPath);
  assert(!tenSecondTimeoutPattern.test(report), `${reportPath} must not schedule a 10-second full-report poll while warehouse imports run; status pollers own that cadence`);
  assert(!/\bsetPollKey\s*\(/.test(report), `${reportPath} must not trigger repeated full-report fetches through a poll key`);
}
assert(tenSecondTimeoutPattern.test(appToolbar) && /\bsetPollKey\s*\(/.test(appToolbar), 'AppToolbar must remain the 10-second warehouse-status poller');
assert(tenSecondTimeoutPattern.test(readinessPanel) && /\bsetPollKey\s*\(/.test(readinessPanel), 'DataImportStatusPanel must remain the 10-second source-data status poller');

console.log('Dashboard readiness UI check passed');
