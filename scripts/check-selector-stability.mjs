import fs from 'node:fs';

const source = fs.readFileSync('src/App.tsx', 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(
  source.includes('import { findMatchingSite, getPreferredSiteUrl, mergeUniqueSites, type SiteLike } from "./lib/siteSelection"'),
  'App must import findMatchingSite for GA4 property-to-workspace matching',
);
assert(
  source.includes('const getWorkspaceSiteForGa4Property = (propertyId: string'),
  'App must resolve a workspace site from a selected GA4 property',
);
assert(
  source.includes('const workspaceSiteForProperty = getWorkspaceSiteForGa4Property(propertyId);'),
  'GA4 property selection must resolve the matching workspace site',
);
assert(
  source.includes('setSelectedSite(workspaceSiteForProperty);'),
  'GA4 property selection must update the active workspace site when the property belongs elsewhere',
);
assert(
  source.includes('setSelectedGa4PropertySite(workspaceSiteForProperty || selectedSite);'),
  'GA4 property selection must store the property against the resolved workspace site',
);

console.log('Selector stability check passed');