import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const stage = mkdtempSync(join(tmpdir(), 'evolver-mods-reuse-'));
after(() => rmSync(stage, { recursive: true, force: true }));
cpSync(new URL('../lib/', import.meta.url), join(stage, 'lib'), { recursive: true });
mkdirSync(join(stage, 'hooks'));
writeFileSync(join(stage, 'hooks/register.mjs'), stripTypeScriptTypes(readFileSync(new URL('../hooks/register.ts', import.meta.url), 'utf8')));
const { register } = await import(pathToFileURL(join(stage, 'hooks/register.mjs')));

const PROMPT = 'fix the flaky redis connection retries in our tests';
const SERVE_TOKEN = '1791800000.1.3.ab12cd34ef56ab12cd34ef56';
const ASSET = {
  asset_id: 'sha256:' + 'a'.repeat(64),
  short_title: 'Fix flaky Redis connection retries',
  summary: 'Stabilise redis connection retries in tests',
  signals_match: ['redis', 'connection', 'retries', 'flaky'],
  serve_token: SERVE_TOKEN,
  strategy: [
    'Set `maxRetriesPerRequest` to null in lib/redis.js',
    'Run npm test to confirm the suite passes',
    'Wrap the client in a singleton factory module',
    'Close the connection in the global teardown hook',
  ],
};

let turnIds = 0;
const settle = () => new Promise((done) => setTimeout(done, 20));

function engine() {
  const files = new Map([['/proj/lib/redis.js', 'export const retries = 3;\n']]);
  const stored = new Map();
  const reports = [];
  const sidecarRuns = [];
  const proxy = { up: true };
  let sessionId = 's1';
  const $ = {
    plugin: { name: 'evolver-mods', root: '/plugin' },
    env: { get: async () => undefined },
    fs: {
      read: async (path) => {
        if (!files.has(path)) throw new Error('ENOENT');
        return files.get(path);
      },
      stat: async (path) => ({ realPath: path }),
    },
    http: { fetch: async (url, options) => {
      if (url.endsWith('/asset/fetch')) return { ok: true, status: 200, text: JSON.stringify({ assets: [ASSET] }) };
      if (!proxy.up) throw new Error('ECONNREFUSED');
      reports.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: JSON.stringify({ recorded: true }) };
    } },
    clock: { now: async () => Date.now(), sleep: () => new Promise(() => {}) },
    store: {
      get: async (key) => stored.get(key),
      set: async (key, value) => { stored.set(key, JSON.parse(JSON.stringify(value))); },
      delete: async (key) => stored.delete(key),
    },
    session: { id: async () => sessionId, cwd: async () => '/proj', append: async () => {} },
    tool: { register: async () => {} },
    ui: { status: () => {}, toast: () => {} },
    process: { run: async (argv) => {
      if (!String(argv[1]).endsWith('/bin/evolver-io.mjs')) return { exitCode: 1, stdout: '' };
      sidecarRuns.push(argv.slice(2));
      return { exitCode: 0, stdout: '{"recorded":true}' };
    } },
  };
  const handlers = new Map();
  register((event, handler) => { handlers.set(event, handler); return { catch() {} }; }, { recall_wait_ms: 1000 });
  const signal = new AbortController().signal;
  const call = (event, input = {}, answer = (value) => value) => handlers.get(event)($, input, Object.assign(async (value) => answer(value), { signal }));
  return { files, reports, sidecarRuns, proxy, call, useSession: (id) => { sessionId = id; } };
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

test('a turn that ran no check reports its injection with tier none and the serve token', async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f);
  assert.equal(f.reports.length, 1);
  const [report] = f.reports;
  assert.equal(report.asset_id, ASSET.asset_id);
  assert.equal(report.serve_token, SERVE_TOKEN);
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
  assert.equal(followUps[0].serve_token, SERVE_TOKEN);
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

test("the model's own report carries L5 evidence and the injection's serve token", async () => {
  const f = engine();
  await f.call('session.start');
  await injectedTurn(f);
  await f.call('tool.call', { tool: 'mcp__evolver-mods__evolver_asset_reuse_result', asset_id: ASSET.asset_id, outcome: 'success' });
  const self = f.reports.at(-1);
  assert.equal(self.serve_token, SERVE_TOKEN);
  assert.deepEqual(self.evidence, { tier: 'L5', applied: 'used', stage: 'immediate' });
});
