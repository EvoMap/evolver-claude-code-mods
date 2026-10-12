import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OUTBOX_TTL_MS, withDelivery, withQueued } from '../lib/report-outbox.js';

const report = (taskId, assetId = 'sha256:a') => ({ asset_id: assetId, task_id: taskId, outcome: 'success', evidence: { tier: 'L3' } });

test('the same report is queued once, keyed by task id and asset', () => {
  const once = withQueued({}, [{ report: report('t:1:correction'), sessionId: 's' }], 0);
  const twice = withQueued(withDelivery(once, Object.keys(once)[0], true, 1), [{ report: report('t:1:correction'), sessionId: 's' }], 2);
  assert.equal(Object.keys(twice).length, 1);
  assert.equal(Object.values(twice)[0].sentAt, 1);
  assert.equal(Object.keys(withQueued(twice, [{ report: report('t:1:correction', 'sha256:b'), sessionId: 's' }], 3)).length, 2);
});

test('reports older than a serve token lives are dropped', () => {
  const queued = withQueued({}, [{ report: report('t:1'), sessionId: 's' }], 0);
  assert.deepEqual(withQueued(queued, [], OUTBOX_TTL_MS + 1), {});
});

test('each delivery attempt is counted', () => {
  const queued = withQueued({}, [{ report: report('t:1'), sessionId: 's' }], 0);
  const key = Object.keys(queued)[0];
  assert.equal(withDelivery(withDelivery(queued, key, false, 1), key, false, 2)[key].attempts, 2);
  assert.equal(withDelivery(queued, 'missing', true, 1), queued);
});
