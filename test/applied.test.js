import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appliedVerdictOf, concreteFeaturesOf, strategyStepsOf } from '../lib/applied.js';

const STRATEGY = [
  '[Evolution Memory] Fix flaky Redis connection in tests (EvoMap network):',
  '1. Set `maxRetriesPerRequest` to null in lib/redis.js',
  '2. Run npm test to confirm the suite passes',
  '3. Wrap the client in a singleton factory module',
  '4. Close the connection in the global teardown hook',
  '',
  'Apply it where it fits, then report the outcome with evolver_asset_reuse_result for sha256:abc.',
].join('\n');

test('only the numbered steps of an injected strategy are matched', () => {
  assert.equal(strategyStepsOf(STRATEGY).length, 4);
});

test('backticked names, paths and commands are concrete features', () => {
  assert.deepEqual(concreteFeaturesOf('Set `maxRetriesPerRequest` to null in lib/redis.js'), ['maxretriesperrequest', 'lib/redis.js']);
  assert.deepEqual(concreteFeaturesOf('Run npm test to confirm'), ['npm test']);
});

test('a turn that touched the named file and ran the named command used the strategy', () => {
  const verdict = appliedVerdictOf({
    strategyText: STRATEGY,
    commands: ['npm test'],
    paths: ['/repo/lib/redis.js'],
    answer: 'I wrapped the client in a singleton factory module.',
  });
  assert.equal(verdict.verdict, 'used');
  assert.equal(verdict.hits, 3);
  assert.equal(verdict.steps, 4);
});

test('one matching step out of four is partial', () => {
  const verdict = appliedVerdictOf({ strategyText: STRATEGY, commands: ['npm test'], paths: [], answer: 'Done.' });
  assert.equal(verdict.verdict, 'partial');
  assert.equal(verdict.ratio, 0.25);
});

test('a turn sharing nothing with the strategy left it unused', () => {
  const verdict = appliedVerdictOf({ strategyText: STRATEGY, commands: ['ls'], paths: ['/repo/README.md'], answer: 'Renamed the heading.' });
  assert.equal(verdict.verdict, 'unused');
  assert.equal(verdict.hits, 0);
});

test('generic words alone do not count as following a prose step', () => {
  const prose = '1. Make sure you always check the result before you report the outcome';
  assert.equal(appliedVerdictOf({ strategyText: prose, commands: [], paths: [], answer: 'make sure always check before report outcome' }).verdict, 'unused');
});

test('a strategy with no steps is unused', () => {
  assert.deepEqual(appliedVerdictOf({ strategyText: '', commands: ['npm test'], paths: [], answer: '' }), { verdict: 'unused', hits: 0, steps: 0, ratio: 0 });
});
