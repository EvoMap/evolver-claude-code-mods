import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkEvidenceOf, checkKindOf } from '../lib/checks.js';

test('every check command maps onto the four kinds the Hub accepts', () => {
  assert.equal(checkKindOf('npx -p typescript tsc -p .'), 'typecheck');
  assert.equal(checkKindOf('npm run lint'), 'lint');
  assert.equal(checkKindOf('claude plugin validate .'), 'lint');
  assert.equal(checkKindOf('node --test test/*.test.js'), 'test');
  assert.equal(checkKindOf('cargo build --release'), 'build');
  assert.equal(checkKindOf('make'), 'build');
});

test('the last check decides, and a failure of that same command earlier marks a turnaround', () => {
  assert.equal(checkEvidenceOf([]), undefined);
  assert.deepEqual(checkEvidenceOf([{ command: 'npm test', failed: true }, { command: 'npm test', failed: false }]), { kind: 'test', passed: true, fail_then_pass: true });
  assert.deepEqual(checkEvidenceOf([{ command: 'npm run lint', failed: true }, { command: 'npm test', failed: false }]), { kind: 'test', passed: true, fail_then_pass: false });
  assert.deepEqual(checkEvidenceOf([{ command: 'npm test', failed: false }, { command: 'npm test', failed: true }]), { kind: 'test', passed: false, fail_then_pass: false });
});
