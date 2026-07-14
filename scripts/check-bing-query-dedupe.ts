import { normalizeBingRows } from '../server/services/bingWarehouse.js';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const july1 = Date.UTC(2026, 6, 1);
const july8 = Date.UTC(2026, 6, 8);

const rows = normalizeBingRows(
  {
    d: [
      { Date: `/Date(${july1}+0000)/`, Query: 'altrient', Impressions: 10, Clicks: 2, AvgClickPosition: 3, AvgImpressionPosition: 6 },
      { Date: `/Date(${july1}+0000)/`, Query: 'altrient', Impressions: 30, Clicks: 6, AvgClickPosition: 5, AvgImpressionPosition: 8 },
      { Date: `/Date(${july8}+0000)/`, Query: 'altrient', Impressions: 20, Clicks: 4, AvgClickPosition: 4, AvgImpressionPosition: 10 },
      { Query: ' vitamin c ', Impressions: 5, Clicks: 0, AvgClickPosition: 0, AvgImpressionPosition: 12 },
      { Query: '', Impressions: 100, Clicks: 100 },
    ],
  },
  {
    fallbackDate: '2026-07-12',
    fallbackDateSource: 'compatibility-fetchedAt',
  },
);

const altrientJuly1 = rows.find((row) => row.Query === 'altrient' && row.Date === '2026-07-01');
const altrientJuly8 = rows.find((row) => row.Query === 'altrient' && row.Date === '2026-07-08');
const vitamin = rows.find((row) => row.Query === 'vitamin c');

assert(rows.length === 3, 'Bing rows should dedupe by date plus query and preserve distinct report dates');
assert(altrientJuly1?.Impressions === 40, 'Same-date duplicate query impressions are summed');
assert(altrientJuly1?.Clicks === 8, 'Same-date duplicate query clicks are summed');
assert(Math.abs((altrientJuly1?.Ctr || 0) - 0.2) < 0.000001, 'Same-date CTR is recomputed from summed clicks/impressions');
assert(Math.abs((altrientJuly1?.AvgClickPosition || 0) - 4.5) < 0.000001, 'Same-date average click position is click-weighted');
assert(Math.abs((altrientJuly1?.AvgImpressionPosition || 0) - 7.5) < 0.000001, 'Same-date average impression position is impression-weighted');
assert(altrientJuly8?.Impressions === 20, 'Different-date rows remain distinct facts');
assert(vitamin?.Date === '2026-07-12', 'Fallback-dated rows use the supplied compatibility date');
assert(vitamin?.DateSource === 'compatibility-fetchedAt', 'Fallback-dated rows are explicitly tagged as compatibility facts');
assert(vitamin?.Query === 'vitamin c', 'Queries are trimmed');

console.log('1 Bing query fact normalization check passed.');
