import { normalizeBingRows } from '../server/services/bingWarehouse.js';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const rows = normalizeBingRows({
  d: [
    { Query: 'altrient', Impressions: 10, Clicks: 2, AvgClickPosition: 3, AvgImpressionPosition: 6 },
    { Query: 'altrient', Impressions: 30, Clicks: 6, AvgClickPosition: 5, AvgImpressionPosition: 8 },
    { Query: ' vitamin c ', Impressions: 5, Clicks: 0, AvgClickPosition: 0, AvgImpressionPosition: 12 },
    { Query: '', Impressions: 100, Clicks: 100 },
  ],
});

const altrient = rows.find((row) => row.Query === 'altrient');
const vitamin = rows.find((row) => row.Query === 'vitamin c');

assert(rows.length === 2, 'Duplicate and empty Bing queries should be normalized to unique non-empty query rows');
assert(altrient?.Impressions === 40, 'Duplicate query impressions are summed');
assert(altrient?.Clicks === 8, 'Duplicate query clicks are summed');
assert(Math.abs((altrient?.Ctr || 0) - 0.2) < 0.000001, 'CTR is recomputed from summed clicks/impressions');
assert(Math.abs((altrient?.AvgClickPosition || 0) - 4.5) < 0.000001, 'Average click position is click-weighted');
assert(Math.abs((altrient?.AvgImpressionPosition || 0) - 7.5) < 0.000001, 'Average impression position is impression-weighted');
assert(vitamin?.Query === 'vitamin c', 'Queries are trimmed');

console.log('1 Bing query dedupe check passed.');
