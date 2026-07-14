import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const warehouseJobs = read('server/services/warehouseJobs.ts');
for (const source of ['gsc', 'ga4-pages', 'ga4-dimensions', 'ga4-llm']) {
  assert(
    warehouseJobs.includes(`runWarehouseSyncPhase('${source}'`),
    `Warehouse jobs must attribute failures to ${source}`,
  );
}
assert(
  warehouseJobs.includes('metricsJson: JSON.stringify({ failedAt, failedSource, jobType: job.jobType })'),
  'Warehouse job failures must persist source attribution',
);

const warehouseRoute = read('server/routes/warehouse.ts');
assert(warehouseRoute.includes('sourceJobs: {'), 'Coverage API must expose source-specific job state');
assert(
  warehouseRoute.includes("const coreActiveJobs = relevantActiveJobs.filter((job) => ['daily-sync', 'core-range-sync'].includes(job.jobType))"),
  'Blended source activity must exclude unrelated dimension and LLM jobs',
);
assert(
  warehouseRoute.includes('ORDER BY updatedAt DESC'),
  'Coverage errors must return the latest source failure deterministically',
);

const coverageService = read('src/services/dataCoverageService.ts');
assert(coverageService.includes('sourceJobs?: {'), 'Coverage client must type source-specific job state');
for (const state of ['ga4Dimensions', 'ga4Llm', 'ga4Pages']) {
  assert(warehouseRoute.includes(`${state}: {`), `Coverage API must expose ${state} job state`);
  assert(coverageService.includes(`${state}: WarehouseSourceJobState;`), `Coverage client must type ${state} job state`);
}

const blendedView = read('components/dashboard/BlendedPagesView.tsx');
for (const state of ['gscJobState', 'ga4PageJobState', 'coreJobState']) {
  assert(blendedView.includes(state), `Blended view must consume ${state}`);
}
assert(blendedView.includes('retryFailedCoverageSync({'), 'Blended retry action must retry failed imports');
assert(
  blendedView.includes('errorMessage={gscJobState?.lastError}')
    && blendedView.includes('errorMessage={ga4PageJobState?.lastError}'),
  'Blended source cards must display their own stored import errors',
);

console.log('Warehouse source error attribution check passed');