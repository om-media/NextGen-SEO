import assert from 'node:assert/strict';
import { classifyWarehouseStorageRange } from '../server/services/warehouseStorage.js';

const common = { hotStartDate: '2026-02-12' };
assert.equal(classifyWarehouseStorageRange({ ...common, startDate: '2026-03-01', endDate: '2026-08-01' }), 'hot');
assert.equal(classifyWarehouseStorageRange({ ...common, startDate: '2025-01-01', endDate: '2026-01-31', archiveBeforeDate: '2026-02-12' }), 'cold');
assert.equal(classifyWarehouseStorageRange({ ...common, startDate: '2026-01-01', endDate: '2026-03-01', archiveBeforeDate: '2026-02-12' }), 'mixed');
assert.equal(classifyWarehouseStorageRange({ ...common, startDate: '2025-01-01', endDate: '2026-01-31' }), 'unavailable');
assert.throws(() => classifyWarehouseStorageRange({ ...common, startDate: '2026-03-01', endDate: '2026-02-01' }));
console.log('warehouse storage route checks passed');
