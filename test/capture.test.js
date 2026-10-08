import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { captureOutcome, collectDiff, forgetCaptures, normalizeHubUrl, parseStat, summarize } from '../lib/capture.js';
import { detectSignalsInDiff } from '../lib/signals.js';
import { captureStatePath, findMemoryGraph } from '../lib/workspace.js';

const logDir = mkdtempSync(join(tmpdir(), 'evolver-log-'));
process.env.EVOLVER_HOOK_LOG_DIR = logDir;

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-repo-')));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '--quiet');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'app.js'), 'export const rate = 1;\n');
  run('add', '.');
  run('commit', '--quiet', '-m', 'first');
  currentRepo = dir;
  forgetCaptures(dir);
  return { dir, run };
}

function graphFor(_dir) {
  const path = join(mkdtempSync(join(tmpdir(), 'evolver-graph-')), 'graph.jsonl');
  process.env.MEMORY_GRAPH_PATH = path;
  return path;
}

function entries(graphPath) {
  try {
    return readFileSync(graphPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

let currentRepo = null;

beforeEach(() => {
  if (currentRepo) forgetCaptures(currentRepo);
});

after(() => {
  delete process.env.MEMORY_GRAPH_PATH;
  rmSync(logDir, { recursive: true, force: true });
});

test('a clean tree records nothing, however many commits it has', async () => {
  const { dir, run } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 2;\n');
  run('add', '.');
  run('commit', '--quiet', '-m', 'second');
  const graph = graphFor(dir);

  assert.equal(await captureOutcome({ projectDir: dir, turnReason: 'answer' }), null);
  assert.deepEqual(entries(graph), []);
});

test('an untracked new file is this turn\'s work', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'added.js'), 'export const added = true;\n');
  const graph = graphFor(dir);

  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'answer' }));
  const [recorded] = entries(graph);
  assert.equal(recorded.outcome.status, 'success');
  assert.match(recorded.outcome.note, /added\.js/);
});

test('the same working tree is recorded once, across processes as well as turns', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 3;\n');
  const graph = graphFor(dir);

  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'answer' }));
  assert.equal(await captureOutcome({ projectDir: dir, turnReason: 'answer' }), null);
  assert.equal(entries(graph).length, 1);

  writeFileSync(join(dir, 'app.js'), 'export const rate = 4;\n');
  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'answer' }));
  assert.equal(entries(graph).length, 2);
});

test('a fresh process does not re-record the tree the last one recorded', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 7;\n');
  const graph = graphFor(dir);

  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'answer' }));
  const fromChild = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { captureOutcome } = await import(${JSON.stringify(new URL('../lib/capture.js', import.meta.url).href)});
       console.log(JSON.stringify(await captureOutcome({ projectDir: ${JSON.stringify(dir)}, turnReason: 'answer' })));`,
    ],
    { encoding: 'utf8', env: { ...process.env, MEMORY_GRAPH_PATH: graph } },
  );

  assert.equal(fromChild.trim(), 'null');
  assert.equal(entries(graph).length, 1);
});

test('editing a still-untracked file is new work each time', async () => {
  const { dir } = repo();
  const scratch = join(dir, 'draft.js');
  writeFileSync(scratch, 'export const draft = 1;\n');
  const graph = graphFor(dir);

  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'answer' }));
  writeFileSync(scratch, 'export const draft = 2;\nexport const more = 3;\n');
  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'answer' }));
  assert.equal(entries(graph).length, 2);
});

test('workspace state under a nested workspace root is still ignored', async () => {
  const { dir } = repo();
  mkdirSync(join(dir, 'workspace', '.evolver'), { recursive: true });
  writeFileSync(join(dir, 'workspace', '.evolver', 'workspace-id'), 'a'.repeat(32));
  const graph = graphFor(dir);

  assert.equal(await captureOutcome({ projectDir: dir, turnReason: 'answer' }), null);
  assert.deepEqual(entries(graph), []);
});

test('a repository with no commit still sees unstaged work', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-empty-')));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '--quiet');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'staged.js'), 'export const staged = 1;\n');
  run('add', 'staged.js');
  currentRepo = dir;
  forgetCaptures(dir);
  const graph = graphFor(dir);

  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'answer' }));
  writeFileSync(join(dir, 'staged.js'), 'export const staged = 2;\n');
  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'answer' }));
  assert.equal(entries(graph).length, 2);
});

test('a diff that could not be recorded anywhere is not marked as done', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 8;\n');
  process.env.MEMORY_GRAPH_PATH = join(dir, 'no-such-dir', 'nested', 'graph.jsonl');
  mkdirSync(join(dir, 'no-such-dir'), { recursive: true });
  writeFileSync(join(dir, 'no-such-dir', 'nested'), 'not a directory');

  await captureOutcome({ projectDir: dir, turnReason: 'answer' });
  const graph = graphFor(dir);
  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'answer' }));
  assert.equal(entries(graph).length, 1);
});

test('local memory is durable before a slow Hub request settles', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 12;\n');
  const graph = graphFor(dir);
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.EVOMAP_HUB_URL;
  const originalKey = process.env.EVOMAP_API_KEY;
  let started;
  let release;
  const fetchStarted = new Promise((resolve) => {
    started = resolve;
  });
  const fetchRelease = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    started();
    await fetchRelease;
    return { ok: true };
  };
  process.env.EVOMAP_HUB_URL = 'https://evomap.ai';
  process.env.EVOMAP_API_KEY = 'test-key';

  try {
    const pending = captureOutcome({ projectDir: dir, turnReason: 'answer' });
    await fetchStarted;
    assert.equal(entries(graph).length, 1);
    release();
    assert.ok(await pending);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.EVOMAP_HUB_URL;
    else process.env.EVOMAP_HUB_URL = originalUrl;
    if (originalKey === undefined) delete process.env.EVOMAP_API_KEY;
    else process.env.EVOMAP_API_KEY = originalKey;
  }
});

test('a stale capture lock is recovered before the wait deadline', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 13;\n');
  const graph = graphFor(dir);
  const lockPath = `${captureStatePath(dir)}.lock`;
  mkdirSync(join(lockPath, '..'), { recursive: true });
  writeFileSync(lockPath, 'crashed');
  const old = new Date(Date.now() - 1_000);
  utimesSync(lockPath, old, old);

  assert.ok(await captureOutcome({
    projectDir: dir,
    turnReason: 'answer',
    captureLockStaleMs: 10,
    captureLockWaitMs: 200,
  }));
  assert.equal(entries(graph).length, 1);
  assert.match(readFileSync(join(logDir, 'evolution.log'), 'utf8'), /Recovered a stale capture lock/);
});

test('an unrecoverable lock expiry is visible in the evolution log', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 14;\n');
  graphFor(dir);
  const lockPath = `${captureStatePath(dir)}.lock`;
  mkdirSync(join(lockPath, '..'), { recursive: true });
  writeFileSync(lockPath, 'still-live');

  assert.equal(await captureOutcome({
    projectDir: dir,
    turnReason: 'answer',
    captureLockStaleMs: 1_000,
    captureLockWaitMs: 20,
  }), null);
  assert.match(readFileSync(join(logDir, 'evolution.log'), 'utf8'), /capture lock wait expired after 20ms/);
  rmSync(lockPath, { force: true });
});

test('two overlapping turn ends record one outcome', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 9;\n');
  const graph = graphFor(dir);

  const receipts = await Promise.all([
    captureOutcome({ projectDir: dir, turnReason: 'answer' }),
    captureOutcome({ projectDir: dir, turnReason: 'answer' }),
  ]);

  assert.equal(receipts.filter(Boolean).length, 1);
  assert.equal(entries(graph).length, 1);
});

test('a repository with no commit counts both halves of its summary', () => {
  const stats = parseStat(' 1 file changed, 2 insertions(+)\n 1 file changed, 3 insertions(+), 1 deletion(-)');
  assert.deepEqual(stats, { files: 2, insertions: 5, deletions: 1 });
});

test('a failed turn with no diff is still recorded with provenance', async () => {
  const { dir } = repo();
  const graph = graphFor(dir);

  assert.ok(await captureOutcome({
    projectDir: dir,
    turnReason: 'error',
    sessionId: 'session-failed',
    turn: 7,
    observedSignals: ['recurring_error'],
  }));
  const [recorded] = entries(graph);
  assert.equal(recorded.outcome.status, 'failed');
  assert.equal(recorded.session_id, 'session-failed');
  assert.equal(recorded.turn, 7);
  assert.equal(recorded.turn_reason, 'error');
  assert.equal(recorded.diff_scope, 'working_tree');
  assert.match(recorded.diff_hash, /^[a-f0-9]{64}$/);
  assert.ok(recorded.signals.includes('recurring_error'));
});

test('the same successful diff is suppressed across turns in one session', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 11;\n');
  const graph = graphFor(dir);

  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'answer', sessionId: 'session-one', turn: 1 }));
  assert.equal(await captureOutcome({ projectDir: dir, turnReason: 'answer', sessionId: 'session-one', turn: 2 }), null);
  assert.equal(entries(graph).length, 1);
});

test('a failed turn is recorded as a failure', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 5;\n');
  const graph = graphFor(dir);

  assert.ok(await captureOutcome({ projectDir: dir, turnReason: 'error' }));
  const [recorded] = entries(graph);
  assert.equal(recorded.outcome.status, 'failed');
  assert.match(recorded.outcome.note, /Turn ended with error/);
});

test('a written test is not a failing test', () => {
  const diff = ['+++ b/app.test.js', '+test("charges once", () => {', '+  expect(charge(order)).toBe(1);', '+});'].join('\n');
  assert.deepEqual(detectSignalsInDiff(diff), []);

  const reported = ['+// note', '+the deploy failed on ci'].join('\n');
  assert.deepEqual(detectSignalsInDiff(reported), ['deployment_issue', 'log_error']);
});

test('an answered turn stays a success even when the diff mentions a recurring error', () => {
  const outcome = summarize(
    { statText: ' 1 file changed, 1 insertion(+)', body: '+the same error keeps failing here', untracked: [] },
    'answer',
  );
  assert.deepEqual(outcome.signals, ['recurring_error']);
  assert.equal(outcome.status, 'success');
});

test('a symlinked memory graph inside the project is never appended to', async () => {
  const { dir } = repo();
  const outside = mkdtempSync(join(tmpdir(), 'evolver-outside-'));
  const target = join(outside, 'secret.jsonl');
  writeFileSync(target, '');
  const planted = join(dir, 'graph.jsonl');
  symlinkSync(target, planted);
  process.env.MEMORY_GRAPH_PATH = planted;
  writeFileSync(join(dir, 'app.js'), 'export const rate = 6;\n');

  await captureOutcome({ projectDir: dir, turnReason: 'answer' });
  assert.equal(readFileSync(target, 'utf8'), '');
});

test('a symlinked project memory directory is rejected', () => {
  const { dir } = repo();
  const outside = mkdtempSync(join(tmpdir(), 'evolver-outside-memory-'));
  mkdirSync(join(outside, 'evolution'), { recursive: true });
  const target = join(outside, 'evolution', 'memory_graph.jsonl');
  writeFileSync(target, '');
  symlinkSync(outside, join(dir, 'memory'));
  delete process.env.MEMORY_GRAPH_PATH;

  assert.notEqual(findMemoryGraph(dir), target);
});

test('Hub recording requires HTTPS except on loopback', () => {
  assert.equal(normalizeHubUrl('http://evomap.ai'), null);
  assert.equal(normalizeHubUrl('https://user:secret@evomap.ai'), null);
  assert.equal(normalizeHubUrl('https://evomap.ai').hostname, 'evomap.ai');
  assert.equal(normalizeHubUrl('http://127.0.0.1:4000').hostname, '127.0.0.1');
  assert.equal(normalizeHubUrl('not a url'), null);
});

test('a directory outside git reports no repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-plain-'));
  const diff = await collectDiff(dir);
  assert.equal(diff.isRepo, false);
  assert.equal(await captureOutcome({ projectDir: dir, turnReason: 'answer' }), null);
});
