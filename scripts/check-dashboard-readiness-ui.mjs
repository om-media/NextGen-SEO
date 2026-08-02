import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const app = read('src/App.tsx');
const readinessPanel = read('src/components/app/DataImportStatusPanel.tsx');

assert(
  /import\s+\{\s*DataImportStatusPanel\s*\}\s+from\s+["']\.\/components\/app\/DataImportStatusPanel["']/.test(app),
  'The primary app shell must import the full source-data readiness panel',
);

const mainStart = app.indexOf('<main ');
const mainEnd = mainStart >= 0 ? app.indexOf('</main>', mainStart) : -1;
assert(mainStart >= 0 && mainEnd > mainStart, 'The primary app shell must expose a main dashboard region');

const main = app.slice(mainStart, mainEnd);
const panelIndex = main.indexOf('<DataImportStatusPanel');
const contentIndex = main.indexOf('<AppContent');
assert(
  panelIndex >= 0,
  'The primary dashboard must render the full source-data readiness panel in the main content area',
);
assert(
  contentIndex < 0 || panelIndex < contentIndex,
  'Source-data readiness must appear before dashboard reports so users see status before scrolling through data',
);

for (const prop of [
  'dataSource={dataSource}',
  'dateRange={dateRange}',
  'ga4PropertyId={activeGa4PropertyId}',
  'refreshKey={gscSyncVersion}',
  'siteUrl={selectedSite}',
]) {
  assert(main.includes(prop), `Source-data readiness panel must receive ${prop}`);
}

assert(
  readinessPanel.includes('Source data readiness') && readinessPanel.includes('source-data-readiness-heading'),
  'Source-data readiness panel must have a visible, plain-language heading',
);
assert(
  readinessPanel.includes('format(parseISO(range.startDate), "MMM d, yyyy")') && readinessPanel.includes('format(parseISO(range.endDate), "MMM d, yyyy")'),
  'Source-data readiness panel must show the selected date range next to its status',
);
assert(
  readinessPanel.includes('{formatWholeNumber(stats.readyDateCount)} / {formatWholeNumber(stats.expectedDateCount)} days ready') && readinessPanel.includes('role="progressbar"'),
  'Source-data readiness panel must show explicit day coverage progress',
);

console.log('Dashboard readiness UI check passed');
