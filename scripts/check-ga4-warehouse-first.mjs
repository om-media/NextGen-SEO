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
const appContent = read('src/components/app/AppContent.tsx');
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
