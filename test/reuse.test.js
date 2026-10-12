import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withQueued } from '../lib/report-outbox.js';
import {
  correctionReportOf,
  deliverPending,
  immediateReportOf,
  reportedReuseOf,
  retentionReportOf,
} from '../lib/reuse.js';

const ASSET = { assetId: 'sha256:a', serveToken: '1791800000.1.3.ab12', strategyText: '' };
const NOW = 1_800_000_000_000;

function ledgers({ hub = { ok: true, data: {} }, local = true } = {}) {
  const posts = [];
  const locals = [];
  return {
    posts,
    locals,
    proxyFetch: async (method, path, body) => {
      posts.push({ method, path, body });
      if (hub instanceof Error) throw hub;
      return hub;
    },
    recordLocally: async (request) => {
      locals.push(request);
      if (local instanceof Error) throw local;
      return local;
    },
  };
}

const immediate = (overrides = {}) => immediateReportOf({ asset: ASSET, sessionId: 's1', turn: 4, turnReason: 'answer', checks: [], applied: 'used', ...overrides });

test('a turn that ran no check still reports its injection, as tier none', () => {
  assert.deepEqual(immediate(), {
    asset_id: 'sha256:a',
    outcome: 'success',
    task_id: 'claude-code:s1:4',
    reason: 'Injected by Evolver into Claude Code turn 4; applied: used; no check ran.',
    serve_token: '1791800000.1.3.ab12',
    evidence: { tier: 'none', applied: 'used', aborted: false, stage: 'immediate' },
  });
  assert.equal(immediate({ turnReason: 'error' }).outcome, 'failed');
});

test('a check the turn ran makes the report L1 and decides its outcome', () => {
  const passed = immediate({ checks: [{ command: 'npm test', failed: false }] });
  assert.equal(passed.outcome, 'success');
  assert.deepEqual(passed.evidence.check, { kind: 'test', passed: true, fail_then_pass: false });
  assert.equal(passed.evidence.tier, 'L1');

  const failed = immediate({ checks: [{ command: 'npx tsc -p .', failed: true }], applied: 'partial' });
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.evidence.check, { kind: 'typecheck', passed: false, fail_then_pass: false });
  assert.equal(failed.evidence.applied, 'partial');
});

test('the same check failing and then passing is recorded as such', () => {
  const report = immediate({
    checks: [{ command: 'npm test', failed: true }, { command: 'npm run lint', failed: false }, { command: 'npm test', failed: false }],
  });
  assert.deepEqual(report.evidence.check, { kind: 'test', passed: true, fail_then_pass: true });
  assert.match(report.reason, /last test passed after failing earlier/);
});

test('an interrupted turn says so', () => {
  const report = immediate({ turnReason: 'aborted' });
  assert.equal(report.evidence.aborted, true);
  assert.equal(report.outcome, 'failed');
});

test('no serve token is sent when the recall carried none', () => {
  assert.equal('serve_token' in immediate({ asset: { assetId: 'sha256:a', strategyText: '' } }), false);
});

test('a report reveals no command, prompt or code', () => {
  const report = immediate({ checks: [{ command: 'API_KEY=hunter22 npm test -- secret/path.js', failed: false }] });
  assert.doesNotMatch(JSON.stringify(report), /hunter22|secret\/path|npm test/);
});

test('a correction or approval follow-up is L3 under the turn task id plus :correction', () => {
  const reuse = reportedReuseOf(immediate());
  assert.deepEqual(correctionReportOf(reuse, 'correction'), {
    asset_id: 'sha256:a',
    outcome: 'failed',
    task_id: 'claude-code:s1:4:correction',
    reason: "The person's next prompt read as correction of the turn that reused this strategy.",
    serve_token: '1791800000.1.3.ab12',
    evidence: { tier: 'L3', applied: 'used', stage: 'correction' },
  });
  assert.equal(correctionReportOf(reuse, 'praise').outcome, 'success');
  assert.equal(correctionReportOf(reuse, null), null);
});

test('kept or reverted edits are an L2 follow-up under :retention; anything else sends nothing', () => {
  const reuse = reportedReuseOf(immediate({ applied: 'partial' }));
  const kept = retentionReportOf(reuse, 'kept');
  assert.equal(kept.task_id, 'claude-code:s1:4:retention');
  assert.equal(kept.outcome, 'success');
  assert.deepEqual(kept.evidence, { tier: 'L2', applied: 'partial', stage: 'retention' });
  assert.equal(retentionReportOf(reuse, 'reverted').outcome, 'failed');
  assert.equal(retentionReportOf(reuse, 'rewritten'), null);
  assert.equal(retentionReportOf(reuse, 'no_change'), null);
});

test('queued reports go to the Hub until one is taken, then never again', async () => {
  const report = immediate({ checks: [{ command: 'npm test', failed: false }] });
  const down = ledgers({ hub: { ok: false, error: 'down' } });
  const outbox = withQueued({}, [{ report, sessionId: 's1' }], NOW);
  const retried = await deliverPending(down, outbox, NOW);
  assert.equal(down.posts[0].path, '/asset/reuse-result');
  assert.deepEqual(down.posts[0].body, report);
  assert.equal(Object.values(retried)[0].sentAt, undefined);

  const up = ledgers();
  const sent = await deliverPending(up, withQueued(retried, [{ report, sessionId: 's1' }], NOW + 1), NOW + 1);
  assert.equal(up.posts.length, 1);
  assert.equal(Object.values(sent)[0].sentAt, NOW + 1);

  const after = ledgers();
  await deliverPending(after, sent, NOW + 2);
  assert.equal(after.posts.length, 0);
});

test('a Proxy that answers without recording does not count as delivered', async () => {
  const sinks = ledgers({ hub: { ok: true, data: { recorded: false } } });
  const outbox = await deliverPending(sinks, withQueued({}, [{ report: immediate(), sessionId: 's1' }], NOW), NOW);
  assert.equal(Object.values(outbox)[0].sentAt, undefined);
  assert.equal(Object.values(outbox)[0].attempts, 1);
});

test('evidence-bearing reports are recorded locally once; tier none never is', async () => {
  const sinks = ledgers({ hub: new Error('down') });
  const verified = immediate({ checks: [{ command: 'npm test', failed: true }] });
  const outbox = withQueued({}, [{ report: verified, sessionId: 's1' }, { report: immediate({ turn: 5 }), sessionId: 's1' }], NOW);
  await deliverPending(sinks, await deliverPending(sinks, outbox, NOW), NOW);
  assert.deepEqual(sinks.locals, [{ assetId: 'sha256:a', outcome: 'failed', sessionId: 's1' }]);
  assert.equal(sinks.posts.length, 4);
});

test('a report the Hub already holds counts as delivered and is not retried', async () => {
  const sinks = ledgers({ hub: { ok: true, data: { recorded: false, reason: 'duplicate_report' } } });
  const outbox = await deliverPending(sinks, withQueued({}, [{ report: immediate(), sessionId: 's1' }], NOW), NOW);
  assert.equal(Object.values(outbox)[0].sentAt, NOW);
});

test('a report the Hub judged ineligible is still delivered', async () => {
  const sinks = ledgers({ hub: { ok: true, data: { recorded: true, eligible: false, reason: 'no_delivery_proof' } } });
  const outbox = await deliverPending(sinks, withQueued({}, [{ report: immediate(), sessionId: 's1' }], NOW), NOW);
  assert.equal(Object.values(outbox)[0].sentAt, NOW);
});
