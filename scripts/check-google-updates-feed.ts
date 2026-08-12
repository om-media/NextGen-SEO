import { parseGoogleSearchIncidents } from '../server/services/googleSearchUpdates.js';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const annotations = parseGoogleSearchIncidents([
  {
    id: 'ranking-incident',
    begin: '2026-06-24T16:00:00+00:00',
    created: '2026-06-24T16:03:11+00:00',
    external_desc: 'June 2026 spam update',
    service_name: 'Ranking',
    updates: [{ when: '2026-06-24T16:03:11+00:00', text: 'Released the June 2026 spam update.' }],
  },
  {
    id: 'serving-incident',
    begin: '2026-06-25T16:00:00+00:00',
    external_desc: 'Serving issue',
    service_name: 'Serving',
    updates: [{ when: '2026-06-25T16:00:00+00:00', text: 'Serving was experiencing an issue.' }],
  },
]);

assert(annotations.length === 1, 'Only Ranking incidents should become Google update annotations');
assert(annotations[0]?.id === 'sys-google-ranking-incident', 'Ranking incident IDs must remain stable and namespaced');
assert(annotations[0]?.date === '2026-06-24', 'Incident start time must become the chart annotation date');
assert(annotations[0]?.title === 'June 2026 Spam Update', 'Incident title should be readable in the chart');
assert(annotations[0]?.description === 'Released the June 2026 spam update.', 'Incident markup should be stripped from descriptions');

console.log('Google updates feed check passed');
