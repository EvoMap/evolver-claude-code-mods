import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UNVERIFIED, correctableAssets, unreportedAssets, withCorrected, withInjected, withModelReport, withReported, withUnverified } from '../lib/injected-ledger.js';

const NOW = 1_000_000_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

test('an injected asset is unreported until a verdict lands, and only the first verdict counts', () => {
  let ledger = withInjected({}, 'sha256:a', 3, NOW);
  assert.deepEqual(unreportedAssets(ledger), [{ assetId: 'sha256:a', turn: 3 }]);

  ledger = withReported(ledger, 'sha256:a', 'success', NOW + 1);
  ledger = withReported(ledger, 'sha256:a', 'failed', NOW + 2);
  assert.deepEqual(unreportedAssets(ledger), []);
  assert.equal(ledger['sha256:a'].outcome, 'success');
});

test('re-injecting an asset keeps its first turn', () => {
  const ledger = withInjected(withInjected({}, 'sha256:a', 1, NOW), 'sha256:a', 5, NOW + 1);
  assert.equal(ledger['sha256:a'].turn, 1);
});

test('only a successful verdict is correctable, and only once', () => {
  let ledger = withReported(withInjected({}, 'sha256:a', 2, NOW), 'sha256:a', 'success', NOW);
  ledger = withReported(withInjected(ledger, 'sha256:b', 2, NOW), 'sha256:b', 'failed', NOW);
  assert.deepEqual(correctableAssets(ledger), [{ assetId: 'sha256:a', turn: 2 }]);

  ledger = withCorrected(ledger, 'sha256:a', NOW + 1);
  assert.deepEqual(correctableAssets(ledger), []);
});

test('a model-reported asset never injected is still recorded once', () => {
  const ledger = withReported({}, 'sha256:x', 'mismatched', NOW);
  assert.equal(ledger['sha256:x'].outcome, 'mismatched');
});

test('entries older than a week are pruned on the next write', () => {
  const ledger = withInjected(withInjected({}, 'sha256:old', 1, NOW), 'sha256:new', 2, NOW + WEEK + 1);
  assert.deepEqual(Object.keys(ledger), ['sha256:new']);
});

test('a model report over an automatic success stands as its correction', () => {
  let ledger = withReported(withInjected({}, 'sha256:a', 6, NOW), 'sha256:a', 'success', NOW);
  ledger = withModelReport(ledger, 'sha256:a', 'mismatched', NOW + 1);
  assert.deepEqual(correctableAssets(ledger), []);
  assert.equal(ledger['sha256:a'].modelOutcome, 'mismatched');
  assert.equal(ledger['sha256:a'].outcome, 'success');
});

test('a model report on an unreported asset is its first verdict', () => {
  const ledger = withModelReport(withInjected({}, 'sha256:b', 2, NOW), 'sha256:b', 'failed', NOW + 1);
  assert.equal(ledger['sha256:b'].outcome, 'failed');
  assert.deepEqual(unreportedAssets(ledger), []);
});

test('an unverified reuse is closed: no later turn reports it and no correction revises it', () => {
  const ledger = withUnverified(withInjected({}, 'sha256:u', 4, NOW), 'sha256:u', NOW + 1);
  assert.equal(ledger['sha256:u'].outcome, UNVERIFIED);
  assert.deepEqual(unreportedAssets(ledger), []);
  assert.deepEqual(correctableAssets(ledger), []);
});

test('the model\'s own report on an unverified reuse is its first verdict', () => {
  let ledger = withUnverified(withInjected({}, 'sha256:u', 4, NOW), 'sha256:u', NOW + 1);
  ledger = withModelReport(ledger, 'sha256:u', 'success', NOW + 2);
  assert.equal(ledger['sha256:u'].outcome, 'success');
  assert.equal(ledger['sha256:u'].corrected, undefined);
  assert.deepEqual(correctableAssets(ledger), [{ assetId: 'sha256:u', turn: 4 }]);
});
