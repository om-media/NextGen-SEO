import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const ga4Service = read('src/services/ga4Service.ts');
assert(ga4Service.includes('autoQueue?: boolean'), 'Ga4RunReportOptions must expose autoQueue');
assert(ga4Service.includes('autoQueue: options.autoQueue !== false'), 'GA4 report requests must queue missing warehouse data by default');

const llmTraffic = read('components/dashboard/Ga4LlmTraffic.tsx');
assert(llmTraffic.includes('autoQueue: true'), 'LLM traffic report requests must queue missing warehouse data');

const appContent = read('src/components/app/AppContent.tsx');
const eventGridLine = appContent.split('\n').find((line) => line.includes('dimension="eventName"')) || '';
assert(eventGridLine, 'Events tab must render the eventName GA4 grid');
assert(!eventGridLine.includes('metrics={'), 'Events tab must use the standard GA4 warehouse metric set');

const warehouseRoute = read('server/routes/warehouse.ts');
assert(
  warehouseRoute.includes('const GA4_DIMENSION_WAREHOUSE_METRICS: Record<string, Set<string>> = {};'),
  'eventName must not be restricted to a reduced GA4 warehouse metric set',
);

const warehouseJobs = read('server/services/warehouseJobs.ts');
const eventConfigMatch = /dimension: 'eventName',[\s\S]*?metrics: \[([^\]]+)\]/.exec(warehouseJobs);
assert(eventConfigMatch, 'GA4 dimension sync must include eventName');
for (const metric of ['sessions', 'totalUsers', 'screenPageViews', 'bounceRate', 'eventCount']) {
  assert(eventConfigMatch[1].includes(`'${metric}'`), `eventName sync must include ${metric}`);
}

console.log('GA4 warehouse-first wiring check passed');