import assert from 'node:assert/strict';
import { compareWatermarkValues, normalizeTimestampWatermark, resolveWatermark } from '../src/services/syncEngine.js';

assert.deepEqual(
  resolveWatermark({}, 'id', { rowversion: [], timestamp: ['created_at', 'updated_at'], auto_pk: ['id'] }),
  { type: 'timestamp', col: 'updated_at', description: '时间戳增量 (updated_at)' },
);

assert.deepEqual(
  resolveWatermark({ watermarkType: 'auto_pk' }, 'id', { rowversion: [], timestamp: [], auto_pk: [] }),
  { type: 'auto_pk', col: 'id', description: '自增主键增量 (id)' },
);

assert.deepEqual(
  resolveWatermark({ sourceTimestampColumn: 'modified_at' }, 'id', { rowversion: [], timestamp: [], auto_pk: ['id'] }),
  { type: 'timestamp', col: 'modified_at', description: '时间戳增量 (modified_at)' },
);

assert.equal(compareWatermarkValues('2026-05-08T01:00:00.000Z', new Date('2026-05-08T00:59:59.000Z')) > 0, true);
assert.equal(normalizeTimestampWatermark(new Date('2026-05-08T01:00:00.000Z')), '2026-05-08T01:00:00.000Z');

console.log('sync-engine self-test passed');
process.exit(0);
