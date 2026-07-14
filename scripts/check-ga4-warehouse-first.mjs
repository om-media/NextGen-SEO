import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const ga4Service = read('src/services/ga4Service.ts');
assert(ga4Service.includes('autoQueue?: boolean'), 'Ga4RunReportOptions must expose autoQueue');
assert(!ga4Service.includes('allowLive?: boolean'), 'GA4 dashboard client must not expose a live report fallback option');
assert(!ga4Service.includes('allowLive:'), 'GA4 dashboard client must not send live GA4 report requests');
assert(ga4Service.includes('autoQueue: options.autoQueue === true'), 'GA4 report reads must not queue imports unless explicitly requested');
assert(ga4Service.includes('getLlmTrafficReport('), 'GA4 service must expose the stored LLM traffic report helper');
assert(ga4Service.includes("'/api/warehouse/ga4/llm/report'") || ga4Service.includes('"/api/warehouse/ga4/llm/report"'), 'GA4 service must call the stored LLM traffic endpoint');
for (const sourcePath of [
  'components/dashboard/Ga4DataGrid.tsx',
  'components/dashboard/Ga4Demographics.tsx',
  'components/dashboard/Ga4Overview.tsx',
  'components/dashboard/Ga4LlmTraffic.tsx',
]) {
  const source = read(sourcePath);
  assert(!source.includes('allowLive: true'), `${sourcePath} must not live-fetch GA4 dashboard reports`);
}

const llmTraffic = read('components/dashboard/Ga4LlmTraffic.tsx');
assert(!llmTraffic.includes('authFetch('), 'LLM traffic view must use the shared GA4 service instead of a direct fetch');
assert(llmTraffic.includes('getLlmTrafficReport('), 'LLM traffic view must read through the stored GA4 service helper');
assert(!llmTraffic.includes('autoQueue: true'), 'LLM traffic navigation must not queue warehouse imports');
assert(llmTraffic.includes('propertyId: string;'), 'LLM traffic view must require an explicit propertyId prop');
assert(!llmTraffic.includes('userProfile?.activatedGa4PropertyId'), 'LLM traffic view must not fall back to the profile GA4 property');
assert(!llmTraffic.includes('userProfile?.activatedSiteUrl'), 'LLM traffic view must not fall back to the profile workspace site');
assert(llmTraffic.includes('Stored LLM traffic requires both a GA4 property and workspace site.'), 'LLM traffic view must fail closed when scope is missing');
assert(llmTraffic.includes('Referral source'), 'LLM traffic tables must show the exact referral source');
assert(llmTraffic.includes('source: row.source'), 'LLM traffic exports must include the exact referral source');

for (const sourcePath of [
  'components/dashboard/Ga4DataGrid.tsx',
  'components/dashboard/Ga4Demographics.tsx',
  'components/dashboard/Ga4Overview.tsx',
]) {
  const source = read(sourcePath);
  assert(source.includes('propertyId: string'), `${sourcePath} must require an explicit propertyId prop`);
}

const appContent = read('src/components/app/AppContent.tsx');
assert(appContent.includes('const selectedGa4PropertyId = dataSource === "ga4" ? selectedSite : "";'), 'AppContent must derive the selected GA4 property ID explicitly');
assert(appContent.includes('<Ga4Overview propertyId={selectedGa4PropertyId} workspaceSiteUrl={workspaceSiteUrl}'), 'GA4 overview must receive explicit propertyId and workspaceSiteUrl props');
assert(appContent.includes('<Ga4DataGrid propertyId={selectedGa4PropertyId} workspaceSiteUrl={workspaceSiteUrl}'), 'GA4 data grids must receive explicit propertyId and workspaceSiteUrl props');
assert(appContent.includes('<Ga4Demographics propertyId={selectedGa4PropertyId} workspaceSiteUrl={workspaceSiteUrl}'), 'GA4 demographics must receive explicit propertyId and workspaceSiteUrl props');
assert(appContent.includes('<Ga4LlmTraffic propertyId={selectedGa4PropertyId} workspaceSiteUrl={workspaceSiteUrl}'), 'GA4 LLM traffic must receive explicit propertyId and workspaceSiteUrl props');
for (const dimension of ['date', 'eventName', 'pagePath', 'sessionSourceMedium', 'country', 'city', 'region', 'deviceCategory', 'browser', 'operatingSystem']) {
  assert(appContent.includes(`dimension="${dimension}"`) || appContent.includes(`value="${dimension}"`), `GA4 app surface must keep ${dimension} warehouse-backed`);
}

const eventGridLine = appContent.split('\n').find((line) => line.includes('dimension="eventName"')) || '';
assert(eventGridLine, 'Events tab must render the eventName GA4 grid');
assert(!eventGridLine.includes('metrics={'), 'Events tab must use the standard GA4 warehouse metric set');

const googleRoute = read('server/routes/google.ts');
assert(
  googleRoute.includes('Stored workspace data') && googleRoute.includes('workspace_ga4_mappings'),
  'GA4 property selection must fall back to stored workspace mappings when Google is unavailable',
);

const warehouseRoute = read('server/routes/warehouse.ts');
assert(
  warehouseRoute.includes('const GA4_DIMENSION_WAREHOUSE_METRICS: Record<string, Set<string>> = {};'),
  'eventName must not be restricted to a reduced GA4 warehouse metric set',
);

assert(warehouseRoute.includes('ga4CoverageFromLedger'), 'GA4 coverage must read explicit dataset completion states');
assert(warehouseRoute.includes('FROM warehouse_dataset_coverage'), 'GA4 coverage must query the dataset completeness ledger');
assert(warehouseRoute.includes('GROUP BY source, sourceClass'), 'LLM source reporting must preserve raw source and provider class');

const database = read('server/database.ts');
assert(database.includes('CREATE TABLE IF NOT EXISTS warehouse_dataset_coverage'), 'Database schema must include the GA4 dataset completeness ledger');

const warehouseJobs = read('server/services/warehouseJobs.ts');
assert(warehouseJobs.includes('upsertGa4DatasetCoverage'), 'GA4 workers must persist dataset completeness');
for (const llmSource of ['gemini', 'you', 'mistral', 'meta.*ai', 'grok']) {
  assert(warehouseJobs.includes(llmSource), `LLM warehouse import must include ${llmSource}`);
}
for (const llmClass of ['Gemini', 'You.com', 'Mistral', 'Meta AI', 'Grok']) {
  assert(warehouseJobs.includes(`return '${llmClass}'`), `LLM classifier must label ${llmClass}`);
}
const eventConfigMatch = /dimension: 'eventName',[\s\S]*?metrics: \[([^\]]+)\]/.exec(warehouseJobs);
assert(eventConfigMatch, 'GA4 dimension sync must include eventName');
for (const metric of ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount']) {
  assert(eventConfigMatch[1].includes(`'${metric}'`), `eventName sync must include ${metric}`);
}

console.log('GA4 warehouse-first wiring check passed');
