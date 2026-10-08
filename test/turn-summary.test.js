import assert from 'node:assert/strict';
import { test } from 'node:test';

import { changedLinesOf } from '../lib/edited-content.js';
import { referenceReuseSavings } from '../lib/savings.js';
import { turnSummaryOf } from '../lib/turn-summary.js';

const USAGE = { input_tokens: 1_200, output_tokens: 800, cache_creation_input_tokens: 4_000, cache_read_input_tokens: 25_000 };

test('savings follow evolver-core savingsCore 0.3.0 for a reference reuse', () => {
  assert.deepEqual(referenceReuseSavings(30), { tokens: 57_600, usd: 0.52, basis: 'estimated_blast_radius' });
  assert.deepEqual(referenceReuseSavings(0), { tokens: 72_000, usd: 0.65, basis: 'estimated_default' });
  assert.equal(referenceReuseSavings(10_000).tokens, 240_000);
});

test('changed lines count what an edit removed and wrote', () => {
  assert.equal(changedLinesOf({ old_string: 'a\nb', new_string: 'c\nd\ne' }), 5);
  assert.equal(changedLinesOf({ content: 'one\ntwo' }), 2);
  assert.equal(changedLinesOf({ edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q\nr' }] }), 5);
});

test('a turn that reused nothing shows nothing', () => {
  assert.equal(turnSummaryOf({ reusedNames: [], lastCheck: { command: 'npm test', failed: false } }), null);
});

test('a reached goal shows the check it rests on and the estimated saving', () => {
  assert.equal(
    turnSummaryOf({ reusedNames: ['Redis connection pool tuning'], lastCheck: { command: 'npm test', failed: false }, changedLines: 30, usage: USAGE }),
    '✓ Goal reached (last check passed: npm test) · reused EvoMap strategy "Redis connection pool tuning" · est. ~58k tokens saved (≈$0.52) · this turn used 6k fresh tokens',
  );
});

test('a missed goal counts no saving', () => {
  assert.equal(
    turnSummaryOf({ reusedNames: ['Redis pool'], lastCheck: { command: 'npm test', failed: true }, changedLines: 30, usage: USAGE }),
    '✗ Goal not reached (last check failed: npm test) · reused EvoMap strategy "Redis pool" · no savings counted · this turn used 6k fresh tokens',
  );
});

test('no check is counted as reached, and missing usage is left out', () => {
  assert.equal(
    turnSummaryOf({ reusedNames: ['Redis pool'], changedLines: 0 }),
    '○ Goal counted as reached (no check ran) · reused EvoMap strategy "Redis pool" · est. ~72k tokens saved (≈$0.65)',
  );
});

test('the summary is one line, since the desktop notice renders no line breaks', () => {
  const summary = turnSummaryOf({ reusedNames: ['Redis pool'], lastCheck: { command: 'npm test', failed: false }, usage: USAGE });
  assert.equal(summary.includes('\n'), false);
});
