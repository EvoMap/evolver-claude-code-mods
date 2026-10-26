import assert from 'node:assert/strict';
import { test } from 'node:test';

import { argumentsOf, runEvolverCli } from '../lib/commands.js';

test('quoted words stay one argument and a backslash escapes a quote', () => {
  assert.deepEqual(argumentsOf('--dry-run --summary="two words"'), ['--dry-run', '--summary=two words']);
  assert.deepEqual(argumentsOf('--summary="say \\"hi\\""'), ['--summary=say "hi"']);
  assert.deepEqual(argumentsOf('   '), []);
});

test('a missing evolver falls back to the published package held to the supported range', async () => {
  const runs = [];
  const run = async (argv) => {
    runs.push(argv);
    return argv[0] === 'evolver' ? { error: { code: 'ENOENT', message: 'missing' }, output: '' } : { error: null, output: 'synced 3' };
  };
  assert.deepEqual(await runEvolverCli(['sync', '--dry-run'], run), { kind: 'success', text: 'synced 3' });
  assert.deepEqual(runs[1], ['npx', '-y', '@evomap/evolver@^2.0.39', 'sync', '--dry-run']);
});

test('a failing run answers with its output', async () => {
  const run = async () => ({ error: { message: 'exited 1' }, output: 'not a git repository' });
  assert.deepEqual(await runEvolverCli(['run'], run), { kind: 'error', text: 'not a git repository' });
});
