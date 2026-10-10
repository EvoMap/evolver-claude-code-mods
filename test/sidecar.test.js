import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SIDECAR = fileURLToPath(new URL('../bin/evolver-io.mjs', import.meta.url));

function sidecar(command, request, home) {
  const ran = spawnSync(process.execPath, [SIDECAR, command], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, EVOLVER_HOOK_LOG_DIR: join(home, 'logs'), MEMORY_GRAPH_PATH: join(home, 'graph.jsonl') },
  });
  return { status: ran.status, answer: JSON.parse(ran.stdout) };
}

test('capture records one turn outcome from a dirty repo and refuses the same turn twice', () => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-home-'));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-repo-')));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '--quiet');
  git('-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '--quiet', '--allow-empty', '-m', 'first');
  writeFileSync(join(repo, 'notes.md'), 'The deploy failed with a timeout.\n');

  const request = { projectDir: repo, turnReason: 'answer', sessionId: 's1', turn: 1, observedSignals: ['test_failure'] };
  const first = sidecar('capture', request, home);
  assert.equal(first.status, 0);
  assert.match(first.answer.receipt, /recorded to local memory/);

  const [entry] = readFileSync(join(home, 'graph.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entry.source, 'claude-code:turn-end');
  assert.equal(entry.session_id, 's1');
  assert.ok(entry.signals.includes('test_failure'));

  assert.equal(sidecar('capture', request, home).answer.receipt, null);
});

test('an unknown command fails with a JSON error', () => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-home-'));
  const ran = sidecar('nope', {}, home);
  assert.equal(ran.status, 2);
  assert.match(ran.answer.error, /unknown command/);
});
