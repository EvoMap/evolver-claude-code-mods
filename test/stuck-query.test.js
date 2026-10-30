import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addedIdentifiersOf, stuckQueryOf } from '../lib/stuck-query.js';

const GO_OUTPUT = [
  '\x1b[31m--- FAIL: TestScanFolder (0.01s)\x1b[0m',
  '    /home/runner/work/navidrome/scanner/walk_dir_tree_test.go:42: expected 3 dirs, got 2',
  'FAIL\tgithub.com/navidrome/navidrome/scanner\t0.123s',
  'ok  \tgithub.com/navidrome/navidrome/model\t0.010s',
].join('\n');

test('a failed check becomes language, changed identifiers, error lines, failing tests and file names', () => {
  const query = stuckQueryOf({
    output: GO_OUTPUT,
    paths: ['/repo/scanner/walk_dir_tree.go', '/repo/scanner/walk_dir_tree_test.go'],
    addedIdentifiers: ['isDirIgnored', 'ignoredFile', 'isDirIgnored'],
  });
  assert.equal(query, [
    'language: Go',
    'changed: isDirIgnored, ignoredFile',
    '--- FAIL: TestScanFolder (0.01s); walk_dir_tree_test.go:42: expected 3 dirs, got 2; FAIL\tgithub.com/navidrome/navidrome/scanner\t0.123s',
    'failing: TestScanFolder, github.com/navidrome/navidrome/scanner',
    'files: walk_dir_tree.go, walk_dir_tree_test.go',
  ].join(' | '));
});

test('output with no error line yields no query, so nothing is recalled', () => {
  assert.equal(stuckQueryOf({ output: 'Killed', paths: ['/a/b.py'] }), '');
  assert.equal(stuckQueryOf({ output: '', paths: [] }), '');
});

test('secrets in the output never reach the query, and the query is capped', () => {
  const output = `AssertionError: token=${'s'.repeat(30)} rejected\n${Array.from({ length: 40 }, (_, i) => `Error: case ${i} ${'x'.repeat(100)}`).join('\n')}`;
  const query = stuckQueryOf({ output });
  assert.doesNotMatch(query, /s{30}/);
  assert.ok(query.length <= 512);
});

test('an edit adds the identifiers its new text has and its old text lacked, across a MultiEdit', () => {
  assert.deepEqual(addedIdentifiersOf({ old_string: 'const retries = 3', new_string: 'const retries = maxRetries(budget)' }), ['maxRetries', 'budget']);
  assert.deepEqual(addedIdentifiersOf({ content: 'def parse_hsv(value): pass' }), ['parse_hsv', 'value']);
  assert.deepEqual(addedIdentifiersOf({ edits: [{ old_string: '', new_string: 'hueRange' }, { old_string: 'a', new_string: 'satRange' }] }), ['hueRange', 'satRange']);
});
