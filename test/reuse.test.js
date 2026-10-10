import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reportInjectedReuse, reportReuseCorrection, reuseStatusOf } from '../lib/reuse.js';

function ledgers({ hub = { ok: true, data: {} }, local = true } = {}) {
  const posts = [];
  const locals = [];
  return {
    posts,
    locals,
    proxyFetch: async (method, path, body) => {
      posts.push({ method, path, body });
      return hub;
    },
    recordLocally: async (request) => {
      locals.push(request);
      if (local instanceof Error) throw local;
      return local;
    },
  };
}

test('an automatic report names the asset, a per-turn task id, and that it is unconfirmed', async () => {
  const sinks = ledgers();
  const reported = await reportInjectedReuse(sinks, {
    assetIds: ['sha256:a'],
    lastCheck: { command: 'npm test', failed: false },
    turn: 4,
    sessionId: 's1',
  });

  assert.deepEqual(reported, ['sha256:a']);
  assert.equal(sinks.posts[0].path, '/asset/reuse-result');
  assert.equal(sinks.posts[0].body.task_id, 'claude-code:s1:4');
  assert.match(sinks.posts[0].body.reason, /not confirmed as applied/);
  assert.deepEqual(sinks.locals, [{ assetId: 'sha256:a', outcome: 'success', sessionId: 's1' }]);
});

test('a verdict counts as delivered when either ledger takes it', async () => {
  const hubDown = ledgers({ hub: { ok: false, error: 'down' } });
  assert.deepEqual(
    await reportInjectedReuse(hubDown, { assetIds: ['sha256:a'], lastCheck: { command: 'npm test', failed: true }, turn: 1, sessionId: 's' }),
    ['sha256:a'],
  );

  const neither = ledgers({ hub: { ok: true, data: { recorded: false } }, local: new Error('no node') });
  assert.deepEqual(
    await reportInjectedReuse(neither, { assetIds: ['sha256:a'], lastCheck: { command: 'npm test', failed: true }, turn: 1, sessionId: 's' }),
    [],
  );
});

test('a correction is reported as failed under its own task id', async () => {
  const sinks = ledgers();
  await reportReuseCorrection(sinks, { assets: [{ assetId: 'sha256:a', turn: 2 }], sessionId: 's1' });

  assert.equal(sinks.posts[0].body.outcome, 'failed');
  assert.equal(sinks.posts[0].body.task_id, 'claude-code:s1:2:correction');
});

test('no assets sends nothing', async () => {
  const sinks = ledgers();
  assert.deepEqual(await reportInjectedReuse(sinks, { assetIds: [], turn: 1 }), []);
  assert.equal(sinks.posts.length, 0);
});

test('a reuse is judged only by a check the turn ran', async () => {
  assert.equal(reuseStatusOf(undefined), null);
  assert.equal(reuseStatusOf({ command: 'npm test', failed: false }), 'success');
  assert.equal(reuseStatusOf({ command: 'npm test', failed: true }), 'failed');

  const sinks = ledgers();
  await reportInjectedReuse(sinks, { assetIds: ['sha256:a'], lastCheck: { command: 'npm test', failed: true }, turn: 2, sessionId: 's' });
  assert.equal(sinks.posts[0].body.outcome, 'failed');
  assert.match(sinks.posts[0].body.reason, /last verification failed \(`npm test`\)/);
  assert.equal(sinks.locals[0].outcome, 'failed');
});

test('a turn that ran no check reports nothing to either ledger', async () => {
  const sinks = ledgers();
  assert.deepEqual(await reportInjectedReuse(sinks, { assetIds: ['sha256:a'], turn: 3, sessionId: 's' }), []);
  assert.equal(sinks.posts.length, 0);
  assert.equal(sinks.locals.length, 0);
});
