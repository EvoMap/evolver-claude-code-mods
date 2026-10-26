import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const stage = mkdtempSync(join(tmpdir(), 'evolver-mods-reuse-'));
after(() => rmSync(stage, { recursive: true, force: true }));
cpSync(new URL('../lib/', import.meta.url), join(stage, 'lib'), { recursive: true });
const SIDECAR = new URL('../bin/evolver-io.mjs', import.meta.url).pathname;
const PLUGIN_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
mkdirSync(join(stage, 'hooks'));
writeFileSync(join(stage, 'hooks/register.mjs'), stripTypeScriptTypes(readFileSync(new URL('../hooks/register.ts', import.meta.url), 'utf8')));
const { register } = await import(pathToFileURL(join(stage, 'hooks/register.mjs')));
const { hashedName } = await import('../lib/state-file.js');

const PROMPT = 'fix the flaky redis connection retries in our tests';
const ASSET = {
  asset_id: 'sha256:' + 'a'.repeat(64),
  short_title: 'Fix flaky Redis connection retries',
  summary: 'Stabilise redis connection retries in tests',
  signals_match: ['redis', 'connection', 'retries', 'flaky'],
  strategy: [
    'Set `maxRetriesPerRequest` to null in lib/redis.js',
    'Run npm test to confirm the suite passes',
    'Wrap the client in a singleton factory module',
    'Close the connection in the global teardown hook',
  ],
};

let turnIds = 0;
const settle = () => new Promise((done) => setTimeout(done, 20));

const GENE = { title: 'Stabilise flaky retries', summary: 'Make a flaky connection retry deterministic in tests.', strategy: '1. Reproduce. 2. Pin the retry count.', signals: ['retry'] };

function runSidecar(command, stdin, home) {
  const ran = spawnSync(process.execPath, [SIDECAR, command], { input: stdin, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function engine({ asset = ASSET, home = mkdtempSync(join(stage, 'home-')) } = {}) {
  const files = new Map([['/proj/lib/redis.js', 'export const retries = 3;\n']]);
  const stored = new Map();
  const reports = [];
  const distills = [];
  const completions = [];
  const prompts = [];
  const commands = [];
  const sidecarRuns = [];
  const model = { answer: JSON.stringify(GENE), hold: null };
  const proxy = { up: true, answer: { recorded: true } };
  let sessionId = 's1';
  const $ = {
    plugin: { name: 'evolver-mods', root: PLUGIN_ROOT },
    env: { get: async () => undefined },
    fs: {
      read: async (path) => {
        if (path.startsWith(`${PLUGIN_ROOT}/assets/`)) return readFileSync(path, 'utf8');
        if (!files.has(path)) throw new Error('ENOENT');
        return files.get(path);
      },
      stat: async (path) => ({ realPath: path }),
    },
    http: { fetch: async (url, options) => {
      if (url.endsWith('/asset/fetch')) return { ok: true, status: 200, text: JSON.stringify({ assets: [asset] }) };
      if (!proxy.up) throw new Error('ECONNREFUSED');
      if (url.endsWith('/conversation/distill')) {
        distills.push(JSON.parse(options.body));
        return { ok: true, status: 200, text: JSON.stringify({ id: 'gene_x' }) };
      }
      if (url.endsWith('/proxy/status')) return { ok: true, status: 200, text: JSON.stringify({ running: true }) };
      reports.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: JSON.stringify(proxy.answer) };
    } },
    clock: { now: async () => Date.now(), sleep: () => new Promise(() => {}) },
    store: {
      get: async (key) => stored.get(key),
      set: async (key, value) => { stored.set(key, JSON.parse(JSON.stringify(value))); },
      delete: async (key) => stored.delete(key),
      keys: async () => [...stored.keys()],
    },
    session: { id: async () => sessionId, cwd: async () => '/proj', append: async () => {}, model: async () => 'claude-test-model' },
    model: { complete: async (request, init) => {
      completions.push(request);
      await model.hold;
      if (init?.signal?.aborted) return { isAnswered: false, reason: 'aborted', usage: {} };
      return { isAnswered: true, text: model.answer, usage: { input_tokens: 900, output_tokens: 120 } };
    } },
    command: { register: async (spec) => { commands.push(spec); } },
    prompt: { submit: async (input) => { prompts.push(input.text); } },
    ui: { status: () => {}, toast: () => {} },
    process: { run: async (argv, init) => {
      if (!String(argv[1]).endsWith('/bin/evolver-io.mjs')) return { exitCode: 1, stdout: '' };
      if (argv[2] !== 'record-reuse') return runSidecar(argv[2], init.stdin, home);
      sidecarRuns.push(argv.slice(2));
      return { exitCode: 0, stdout: '{"recorded":true}' };
    } },
  };
  const handlers = new Map();
  register((event, handler) => { handlers.set(event, handler); return { catch() {} }; }, { recall_wait_ms: 1000 });
  const signal = new AbortController().signal;
  const call = (event, input = {}, answer = (value) => value) => handlers.get(event)($, input, Object.assign(async (value) => answer(value), { signal }));
  const sidecar = (command, request = {}) => JSON.parse(runSidecar(command, JSON.stringify(request), home).stdout);
  const writeLedger = (sessionId, ledger) => {
    mkdirSync(join(home, '.evolver', 'state'), { recursive: true });
    writeFileSync(join(home, '.evolver', 'state', hashedName('claude-code-injected', sessionId)), JSON.stringify(ledger));
  };
  return { writeLedger, files, reports, distills, completions, prompts, commands, model, sidecarRuns, proxy, stored, call, sidecar, useSession: (id) => { sessionId = id; } };
}

async function injectedTurn(f, { checks = [], edit = false, reason = 'answer' } = {}) {
  const turnId = `t${++turnIds}`;
  await f.call('prompt.submit', { text: PROMPT, origin: { kind: 'composer' } });
  await f.call('turn.start', { text: PROMPT, turnId });
  if (edit) {
    await f.call('tool.call', { tool: 'Edit', file_path: '/proj/lib/redis.js', old_string: '3', new_string: 'null' }, () => {
      f.files.set('/proj/lib/redis.js', 'export const retries = null;\n');
      return { result: 'ok' };
    });
  }
  for (const { command, failed } of checks) {
    await f.call('tool.call', { tool: 'Bash', command }, () => ({ result: failed ? 'Error: test failed' : 'all good', isError: failed }));
  }
  await f.call('turn.complete', { turnId, reason, answer: 'Wrapped the client in a singleton factory module.', isAborted: reason === 'aborted', durationMs: 1 });
  await settle();
}

test('a turn that ran no check reports its injection with tier none', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f);
  assert.equal(f.reports.length, 1);
  const [report] = f.reports;
  assert.equal(report.asset_id, ASSET.asset_id);
  assert.deepEqual(Object.keys(report), ['asset_id', 'outcome', 'task_id', 'reason', 'evidence']);
  assert.equal(report.task_id, 'claude-code:s1:1');
  assert.deepEqual(report.evidence, { tier: 'none', applied: 'partial', aborted: false, stage: 'immediate' });
  assert.deepEqual(f.sidecarRuns, []);
  assert.doesNotMatch(JSON.stringify(f.reports), /flaky redis connection retries in our tests|maxRetriesPerRequest|singleton factory/);
});

test('a check that failed then passed is L1 evidence, recorded locally too', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f, { checks: [{ command: 'npm test', failed: true }, { command: 'npm test', failed: false }] });
  assert.equal(f.reports[0].outcome, 'success');
  assert.deepEqual(f.reports[0].evidence, {
    tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: true }, aborted: false, stage: 'immediate',
  });
  assert.deepEqual(f.sidecarRuns, [['record-reuse']]);
});

test('the next composer prompt reading as a correction sends one L3 follow-up', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f);
  await f.call('prompt.submit', { text: 'still failing, same error', origin: { kind: 'composer' } });
  await settle();
  await f.call('prompt.submit', { text: "that didn't work either", origin: { kind: 'composer' } });
  await settle();
  const followUps = f.reports.filter((report) => report.evidence.stage === 'correction');
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].task_id, 'claude-code:s1:1:correction');
  assert.equal(followUps[0].outcome, 'failed');
  assert.deepEqual(Object.keys(followUps[0]), ['asset_id', 'outcome', 'task_id', 'reason', 'evidence']);
  assert.deepEqual(followUps[0].evidence, { tier: 'L3', applied: 'partial', stage: 'correction' });
});

test('a prompt that neither corrects nor approves sends nothing, and only composer prompts count', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f);
  await f.call('prompt.submit', { text: 'thanks, works now', origin: { kind: 'sdk' } });
  await f.call('prompt.submit', { text: 'now add a logout button', origin: { kind: 'composer' } });
  await f.call('prompt.submit', { text: 'thanks, works now', origin: { kind: 'composer' } });
  await settle();
  assert.deepEqual(f.reports.map((report) => report.evidence.stage), ['immediate']);
});

test('a follow-up the Proxy missed is retried at the next chance and sent once', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f);
  f.proxy.up = false;
  await f.call('prompt.submit', { text: 'perfect, thanks', origin: { kind: 'composer' } });
  await settle();
  assert.equal(f.reports.length, 1);
  f.proxy.up = true;
  await f.call('session.start');
  await settle();
  await f.call('session.start');
  await settle();
  const approvals = f.reports.filter((report) => report.task_id.endsWith(':correction'));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].outcome, 'success');
});

test('edits still in place by the next session send one L2 retention follow-up', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f, { edit: true, checks: [{ command: 'npm test', failed: false }] });
  await f.call('session.end', { sessionId: 's1' });
  f.useSession('s2');
  await f.call('session.start');
  await settle();
  await f.call('session.start');
  await settle();
  const retention = f.reports.filter((report) => report.evidence.stage === 'retention');
  assert.equal(retention.length, 1);
  assert.equal(retention[0].task_id, 'claude-code:s1:1:retention');
  assert.equal(retention[0].outcome, 'success');
  assert.deepEqual(retention[0].evidence, { tier: 'L2', applied: 'used', stage: 'retention' });
});

test('edits reverted by the next session report the reuse as failed', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f, { edit: true });
  await f.call('session.end', { sessionId: 's1' });
  f.files.set('/proj/lib/redis.js', 'export const retries = 3;\n');
  f.useSession('s2');
  await f.call('session.start');
  await settle();
  const [retention] = f.reports.filter((report) => report.evidence.stage === 'retention');
  assert.equal(retention.outcome, 'failed');
});

test('the same session never judges its own retention', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f, { edit: true });
  await f.call('session.start');
  await settle();
  assert.equal(f.reports.filter((report) => report.evidence.stage === 'retention').length, 0);
});

test('an interrupted turn is reported as aborted', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f, { reason: 'aborted' });
  assert.equal(f.reports[0].evidence.aborted, true);
  assert.equal(f.reports[0].outcome, 'failed');
});

test('a report the Hub refuses outright is logged once and not sent again', async () => {
  const f = engine();
  f.proxy.answer = { recorded: false, terminal: true, reason: 'evidence: Unrecognized key', status: 400 };
  await f.call('session.start');
  await injectedTurn(f, { checks: [{ command: 'npm test', failed: false }] });
  await f.call('session.start');
  await settle();
  assert.equal(f.reports.length, 1);
  assert.deepEqual(f.sidecarRuns, []);
  const rejected = f.stored.get('errors').filter((entry) => entry.where === 'reuse-report-rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].message, /claude-code:s1:1.*Unrecognized key.*400/);
  assert.equal(Object.values(f.stored.get('reports:outbox'))[0].rejection.status, 400);
});

const LRU_TURN = JSON.parse(readFileSync(new URL('./fixtures/lru-turn.json', import.meta.url), 'utf8'));
const LRU_PROMPT = 'implement an LRU cache in Node.js with a doubly-linked list';
const LRU_ASSET = {
  asset_id: 'sha256:40c6ec437967f3ce0a2101857736b95d2770a014f452752a9421db2bee223f37',
  summary: 'Implements a Least Recently Used (LRU) cache in Node.js using a doubly-linked list',
  signals_match: ['lru', 'cache', 'doubly-linked', 'list'],
  strategy: LRU_TURN.strategyText.split('\n').filter((line) => /^\d+\. /.test(line)).map((line) => line.replace(/^\d+\. /, '')),
};

test('a strategy written into code and proven by a check that first failed is reported as used, L1, fail then pass', async () => {
  const f = engine({ asset: LRU_ASSET });
  await f.call('session.start');
  await f.call('prompt.submit', { text: LRU_PROMPT, origin: { kind: 'composer' } });
  await f.call('turn.start', { text: LRU_PROMPT, turnId: 'lru' });
  const [testFile, implementation] = LRU_TURN.edits;
  const [before, after] = LRU_TURN.commands;
  await f.call('tool.call', { tool: 'Write', file_path: LRU_TURN.paths[0], content: testFile }, () => ({ result: 'ok' }));
  await f.call('tool.call', { tool: 'Bash', command: before }, () => ({ result: 'Error: test failed', isError: true }));
  await f.call('tool.call', { tool: 'Write', file_path: LRU_TURN.paths[1], content: implementation }, () => ({ result: 'ok' }));
  await f.call('tool.call', { tool: 'Bash', command: after }, () => ({ result: 'pass 9' }));
  await f.call('turn.complete', { turnId: 'lru', reason: 'answer', answer: LRU_TURN.answer, isAborted: false, durationMs: 1 });
  await settle();
  assert.equal(f.reports[0].asset_id, LRU_ASSET.asset_id);
  assert.equal(f.reports[0].outcome, 'success');
  assert.deepEqual(f.reports[0].evidence, {
    tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: true }, aborted: false, stage: 'immediate',
  });
  assert.doesNotMatch(JSON.stringify(f.reports), /moveToHead|evictTail|hitRatio/);
});

async function until(condition, what, deadlineMs = 10_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > deadlineMs) assert.fail(`never happened: ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

const plainAsset = { ...ASSET, strategy: ['Read the logs.', 'Bisect the change.', 'Write the fix.', 'Ship it.'] };

async function verifiedTurn(f, prompt = 'add a retry to the uploader please') {
  const turnId = `t${++turnIds}`;
  await f.call('prompt.submit', { text: prompt, origin: { kind: 'composer' } });
  await f.call('turn.start', { text: prompt, turnId });
  await f.call('tool.call', { tool: 'Bash', command: 'npm test' }, () => ({ result: 'pass 3' }));
  await f.call('turn.complete', { turnId, reason: 'answer', answer: 'Retries added.', isAborted: false, durationMs: 1 });
  await settle();
}

const due = (f, sessionId = 's1') => f.sidecar('due-candidates', { sessionId }).due;

test('nothing of Evolver but the commands is registered: no tools, no skill, no edit notice', async () => {
  const f = engine();
  await f.call('session.start');
  assert.deepEqual(f.commands.map((command) => command.name), [
    'evolver-status', 'evolver-search', 'evolver-distill', 'evolver-evolve', 'evolver-sync', 'evolver-review', 'evolver-run', 'evolver-solidify',
  ]);
  assert.equal('argumentHint' in f.commands[0], false, 'a command without an argument declares no hint');
  const edited = await f.call('tool.call', { tool: 'Write', file_path: '/proj/a.js', content: 'throw new Error("timeout")' }, () => ({ result: 'ok' }));
  assert.equal(edited.context, undefined);
});

test('a verified turn that reused nothing becomes the candidate, distilled by the session model at the next session start', async () => {
  const f = engine({ asset: plainAsset });
  await f.call('session.start');
  await verifiedTurn(f);
  assert.equal(due(f).length, 1);
  assert.equal(f.completions.length, 0, 'nothing runs at turn end');
  assert.equal(due(f)[0].candidate.model, 'claude-test-model');
  assert.equal(due(f)[0].candidate.pid, process.pid, "the sidecar's parent owns it");

  await f.call('session.end', { sessionId: 's1' });
  assert.equal(due(f)[0].candidate.closed, true);
  f.useSession('s2');
  await f.call('session.start');
  await until(() => f.distills.length === 1, 'the leftover was distilled');
  await until(() => due(f).length === 0, 'the candidate was settled');

  const [body] = f.distills;
  assert.equal(body.platform, 'claude-code');
  assert.equal(body.trigger, 'session_end');
  assert.equal(body.persist, true);
  assert.equal(body.publish, false);
  assert.deepEqual(body.strategy, ['Reproduce.', 'Pin the retry count.']);
  assert.deepEqual(body.execution, { trace: [{ command: 'npm test', exit: 0 }] });
  assert.deepEqual(body.distill_usage, { input_tokens: 900, output_tokens: 120 });
  assert.equal(f.completions[0].model, 'claude-test-model');
  assert.match(f.completions[0].prompt, /## Task\nadd a retry to the uploader please/);
});

test('a turn that reused the injected strategy adds evidence to it instead of a candidate', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f, { checks: [{ command: 'npm test', failed: false }] });
  assert.equal(f.reports[0].evidence.applied, 'used');
  assert.deepEqual(due(f), []);
});

test('a correction drops the candidate, and stops a distillation already running', async () => {
  const f = engine({ asset: plainAsset });
  await f.call('session.start');
  await verifiedTurn(f);
  let release;
  f.model.hold = new Promise((done) => { release = done; });
  const running = f.call('command.run', { command: 'evolver-distill', args: '' });
  await until(() => f.completions.length === 1, 'the model was asked');
  await f.call('prompt.submit', { text: '不对，这样不行', origin: { kind: 'composer' } });
  await until(() => due(f).length === 0, 'the candidate was dropped');
  release();
  assert.match((await running).text, /Distillation dropped/);
  assert.deepEqual(f.distills, []);
});

test('/evolver-distill distills now, with the focus, and says when there is nothing yet', async () => {
  const f = engine({ asset: plainAsset });
  await f.call('session.start');
  assert.match((await f.call('command.run', { command: 'evolver-distill', args: '' })).text, /Nothing to distill yet/);
  await verifiedTurn(f);
  const answer = await f.call('command.run', { command: 'evolver-distill', args: 'the backoff' });
  assert.match(answer.text, /gene_x/);
  assert.match(f.completions[0].prompt, /Focus on: the backoff/);
  assert.deepEqual(due(f), []);
});

test('a failed distillation keeps the candidate for the next try and gives up after three', async () => {
  const f = engine({ asset: plainAsset });
  f.model.answer = 'not json';
  await f.call('session.start');
  await verifiedTurn(f);
  for (const attempts of [1, 2]) {
    assert.match((await f.call('command.run', { command: 'evolver-distill', args: '' })).text, /Distillation unparsed/);
    assert.equal(due(f)[0].candidate.attempts, attempts);
  }
  await f.call('command.run', { command: 'evolver-distill', args: '' });
  assert.deepEqual(due(f), []);
});

test('a strategy whose turn never ended is reported aborted when the session ends', async () => {
  const f = engine();
  await f.call('session.start');
  await f.call('prompt.submit', { text: PROMPT, origin: { kind: 'composer' } });
  await f.call('turn.start', { text: PROMPT, turnId: 'cut' });
  await f.call('session.end', { sessionId: 's1' });
  assert.equal(f.reports.length, 0, 'session end only writes the outbox');
  assert.equal(Object.keys(f.stored.get('reports:outbox')).length, 1);
  f.useSession('s2');
  await f.call('session.start');
  await until(() => f.reports.length === 1, 'the next session delivered it');
  assert.equal(f.reports[0].task_id, 'claude-code:s1:1');
  assert.equal(f.reports[0].outcome, 'failed');
  assert.deepEqual(f.reports[0].evidence, { tier: 'none', applied: 'partial', aborted: true, stage: 'immediate' });
});

test("the next session reports a killed session's open strategies, and leaves an idle one's alone", async () => {
  const f = engine();
  const dead = deadPid();
  f.writeLedger('killed', { 'sha256:orphan': { turn: 4, injectedAt: Date.now(), strategyText: '1. a.', sessionId: 'killed', pid: dead } });
  f.writeLedger('idle', { 'sha256:idle': { turn: 2, injectedAt: Date.now(), strategyText: '1. a.', sessionId: 'idle', pid: process.pid } });
  f.writeLedger('old', { 'sha256:old': { turn: 1, injectedAt: Date.now(), strategyText: '', sessionId: 'old' } });
  await f.call('session.start');
  await until(() => f.reports.length === 1, 'the orphan was reported');
  await f.call('session.start');
  await settle();

  assert.equal(f.reports.length, 1, 'reported once');
  assert.equal(f.reports[0].asset_id, 'sha256:orphan');
  assert.equal(f.reports[0].task_id, 'claude-code:killed:4');
  assert.equal(f.reports[0].evidence.aborted, true);
});

test("a killed session's leftover candidate is claimed and distilled by the next session", async () => {
  const f = engine();
  f.sidecar('remember-candidate', { sessionId: 'killed', candidate: { prompt: 'p', commands: ['npm test'], paths: [], checks: [], answer: 'done', model: 'claude-test-model', turn: 1, attempts: 0, at: 1 } });
  const written = f.sidecar('due-candidates', { sessionId: 'killed' }).due[0].candidate;
  assert.equal(written.pid, process.pid);
  assert.deepEqual(f.sidecar('claim-leftover-candidates').claimed, [], 'a live owner keeps its candidate');
  await f.call('session.start');
  await settle();
  assert.equal(f.distills.length, 0);
});

test('/evolver-evolve hands the agent the checkpoint as a one-off prompt; status and search answer from the Proxy', async () => {
  const f = engine();
  await f.call('session.start');
  await f.call('command.run', { command: 'evolver-evolve', args: 'the retries' });
  await settle();
  assert.match(f.prompts[0], /Take a deliberate evolution step/);
  assert.match(f.prompts[0], /\n\nFocus: the retries$/);
  assert.doesNotMatch(f.prompts[0], /evolver_/);
  assert.equal(JSON.parse((await f.call('command.run', { command: 'evolver-status', args: '' })).text).proxy.running, true);
  assert.match((await f.call('command.run', { command: 'evolver-search', args: '' })).text, /Usage: \/evolver-search/);
});

test('a resumed session reports what its killed process left open, before its own turns', async () => {
  const f = engine();
  f.writeLedger('s1', { 'sha256:left': { turn: 1, injectedAt: Date.now(), strategyText: '1. a.', sessionId: 's1', pid: deadPid() } });
  await f.call('session.start');
  await until(() => f.reports.length === 1, 'the open injection was reported');
  assert.equal(f.reports[0].task_id, 'claude-code:s1:1');
  assert.equal(f.reports[0].evidence.aborted, true);
});

test('a correction right after the answer drops the candidate the turn just wrote', async () => {
  const f = engine({ asset: plainAsset });
  await f.call('session.start');
  const turnId = `t${++turnIds}`;
  await f.call('prompt.submit', { text: 'add a retry to the uploader please', origin: { kind: 'composer' } });
  await f.call('turn.start', { text: 'add a retry to the uploader please', turnId });
  await f.call('tool.call', { tool: 'Bash', command: 'npm test' }, () => ({ result: 'pass 3' }));
  await f.call('turn.complete', { turnId, reason: 'answer', answer: 'Retries added.', isAborted: false, durationMs: 1 });
  await f.call('prompt.submit', { text: '不对，这样不行', origin: { kind: 'composer' } });
  await new Promise((done) => setTimeout(done, 600));
  assert.deepEqual(due(f), []);
});

test('ledgers left in the store by an earlier version are dropped', async () => {
  const f = engine();
  f.stored.set('injected:old-session', { 'sha256:x': { turn: 1, injectedAt: 0 } });
  await f.call('session.start');
  await until(() => !f.stored.has('injected:old-session'), 'the old ledger was dropped');
});

test('a resumed session keeps counting its turns, so its reports never repeat a task id', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f);
  await f.call('session.end', { sessionId: 's1' });
  await f.call('session.start');
  await injectedTurn(f, { checks: [{ command: 'npm test', failed: false }] });
  await until(() => f.reports.some((report) => report.task_id === 'claude-code:s1:2'), 'the resumed turn was numbered 2');
});

test('a turn counter untouched for a month is pruned; a recent one and an older-format one stay', async () => {
  const f = engine();
  f.stored.set('turns:stale', { turn: 4, atMs: Date.now() - 31 * 24 * 60 * 60 * 1000 });
  f.stored.set('turns:recent', { turn: 2, atMs: Date.now() });
  f.stored.set('turns:s1', 3);
  await f.call('session.start');
  await until(() => !f.stored.has('turns:stale'), 'the stale counter was pruned');
  assert.ok(f.stored.has('turns:recent'));
  await injectedTurn(f);
  await until(() => f.reports.some((report) => report.task_id === 'claude-code:s1:4'), 'an older-format counter keeps counting');
});
