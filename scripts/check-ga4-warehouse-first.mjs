import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const ga4Service = read('src/services/ga4Service.ts');
assert(ga4Service.includes('autoQueue?: boolean'), 'Ga4RunReportOptions must expose autoQueue');
assert(ga4Service.includes('autoQueue: options.autoQueue !== false'), 'GA4 report requests must queue missing warehouse data by default');
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
assert(llmTraffic.includes('autoQueue: true'), 'LLM traffic report requests must queue missing warehouse data');
const appContent = read('src/components/app/AppContent.tsx');
for (const dimension of ['date', 'eventName', 'pagePath', 'sessionSourceMedium', 'country', 'city', 'region', 'deviceCategory', 'browser', 'operatingSystem']) {
  assert(appContent.includes(`dimension="${dimension}"`) || appContent.includes(`value="${dimension}"`), `GA4 app surface must keep ${dimension} warehouse-backed`);
}

const eventGridLine = appContent.split('\n').find((line) => line.includes('dimension="eventName"')) || '';
assert(eventGridLine, 'Events tab must render the eventName GA4 grid');
assert(!eventGridLine.includes('metrics={'), 'Events tab must use the standard GA4 warehouse metric set');

const warehouseRoute = read('server/routes/warehouse.ts');
assert(
  warehouseRoute.includes('const GA4_DIMENSION_WAREHOUSE_METRICS: Record<string, Set<string>> = {};'),
  'eventName must not be restricted to a reduced GA4 warehouse metric set',
);

const warehouseJobs = read('server/services/warehouseJobs.ts');
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