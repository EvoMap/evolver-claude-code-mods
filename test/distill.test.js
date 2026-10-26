import assert from 'node:assert/strict';
import { test } from 'node:test';

import { argumentsOf, candidateOf, distillCandidate, distillPrompt, skipReason } from '../lib/distill.js';
import {
  claimLeftoverCandidates, closeCandidate, dueCandidates, isCurrentCandidate, rememberCandidate, settleCandidate,
} from '../lib/distill-pending.js';
import { freshHome } from './support/home.js';

const MODEL = 'claude-test-model';
const GENE = { title: 'Retry uploads', summary: 'Retry a flaky upload with backoff.', strategy: '1. Measure. 2. Back off.', signals: ['retry'] };

function record(overrides = {}) {
  return { checks: [], commands: ['npm test'], paths: ['src/up.js'], edits: [], answer: 'Done: retries added.', ...overrides };
}

function fakeModel(text = JSON.stringify(GENE)) {
  const calls = [];
  const model = {
    calls,
    hold: undefined,
    complete: async (request, init) => {
      calls.push(request);
      await model.hold;
      if (init?.signal?.aborted) return { isAnswered: false, reason: 'aborted', usage: {} };
      return { isAnswered: true, text, usage: { input_tokens: 900, output_tokens: 120 } };
    },
  };
  return model;
}

test('only a verified, answered turn that used tools becomes a candidate', () => {
  assert.equal(skipReason('answer', record()), null);
  assert.equal(skipReason('aborted', record()), 'not_answered');
  assert.equal(skipReason('answer', record({ answer: '' })), 'no_answer');
  assert.equal(skipReason('answer', record({ checks: [{ command: 'npm test', failed: true }] })), 'failed_check');
  assert.equal(skipReason('answer', record({ commands: [] })), 'no_tool_use');
});

test('the prompt is a digest of the turn, never its whole history, and asks for no answer values', () => {
  const candidate = candidateOf({ prompt: 'add a retry to the uploader', record: record({ checks: [{ command: 'npm test', failed: false }] }), model: MODEL, turn: 1, now: 1 });
  const prompt = distillPrompt(candidate, 'the backoff');
  assert.match(prompt, /## Task\nadd a retry to the uploader/);
  assert.match(prompt, /- npm test/);
  assert.match(prompt, /- passed: npm test/);
  assert.match(prompt, /Focus on: the backoff/);
  assert.match(prompt, /Do not include the answer itself/);
});

test('a list the model wrote as one numbered paragraph becomes steps', () => {
  assert.deepEqual(argumentsOf(JSON.stringify(GENE)).strategy, ['Measure.', 'Back off.']);
  assert.equal(argumentsOf('no json here'), null);
  assert.equal(argumentsOf('{"title":"no summary"}'), null);
});

test('a candidate is distilled through the session model and sent to the Proxy with its own cost', async () => {
  const sent = [];
  const proxyFetch = async (method, path, body) => { sent.push({ path, body }); return { ok: true, data: { id: 'gene_x' } }; };
  const candidate = candidateOf({ prompt: 'add a retry', record: record(), model: MODEL, turn: 1, now: 1 });
  const model = fakeModel();
  const outcome = await distillCandidate({ proxyFetch, complete: model.complete, candidate, timeoutMs: 1_000 });

  assert.equal(outcome.status, 'sent');
  assert.equal(model.calls[0].model, MODEL);
  assert.equal(model.calls[0].timeoutMs, 1_000);
  assert.equal(sent[0].path, '/conversation/distill');
  assert.equal(sent[0].body.trigger, 'session_end');
  assert.equal(sent[0].body.persist, true);
  assert.equal(sent[0].body.publish, false);
  assert.deepEqual(sent[0].body.distill_usage, { input_tokens: 900, output_tokens: 120 });
  assert.equal((await distillCandidate({ proxyFetch, complete: model.complete, candidate: { ...candidate, model: null }, timeoutMs: 1_000 })).status, 'no_model');
});

test('a model error is a failed try; a reply without JSON is unparsed', async () => {
  const proxyFetch = async () => ({ ok: true });
  const candidate = candidateOf({ prompt: 'add a retry', record: record(), model: MODEL, turn: 1, now: 1 });
  const refused = async () => ({ isAnswered: false, reason: 'api-error', status: 529, usage: {} });
  assert.deepEqual(await distillCandidate({ proxyFetch, complete: refused, candidate, timeoutMs: 1_000 }), { status: 'failed', error: 'api-error' });
  assert.equal((await distillCandidate({ proxyFetch, complete: fakeModel('nope').complete, candidate, timeoutMs: 1_000 })).status, 'unparsed');
});

test('a candidate dropped or cancelled while the model answers is never sent to the Proxy', async (t) => {
  t.after(freshHome('evolver-distill-dropped-'));
  const sent = [];
  const proxyFetch = async (method, path) => { sent.push(path); return { ok: true }; };
  const candidate = candidateOf({ prompt: 'add a retry', record: record(), model: MODEL, turn: 1, now: 1 });
  rememberCandidate('s', candidate);
  assert.equal(isCurrentCandidate('s', candidate), true);
  rememberCandidate('s', { ...candidate, at: candidate.at + 1 });
  assert.equal(isCurrentCandidate('s', candidate), false);

  const replaced = await distillCandidate({ proxyFetch, complete: fakeModel().complete, candidate, timeoutMs: 1_000, isCurrent: async () => isCurrentCandidate('s', candidate) });
  const controller = new AbortController();
  const model = fakeModel();
  model.hold = new Promise((resolve) => setTimeout(resolve, 20));
  const cancelled = distillCandidate({ proxyFetch, complete: model.complete, candidate, timeoutMs: 1_000, cancel: controller.signal });
  controller.abort();

  assert.equal(replaced.status, 'dropped');
  assert.equal((await cancelled).status, 'dropped');
  assert.deepEqual(sent, []);
});

test("a session's candidate is due to it; another session's only once that session is over", (t) => {
  t.after(freshHome('evolver-candidates-'));
  rememberCandidate('live', { pid: 111, at: 1 });
  rememberCandidate('killed', { pid: 222, at: 2 });
  rememberCandidate('ended', { pid: 111, at: 3 });
  closeCandidate('ended');
  const isGone = (pid) => pid === 222;
  assert.deepEqual(dueCandidates({ sessionId: 'live' }).map((due) => due.sessionId), ['live']);
  assert.deepEqual(claimLeftoverCandidates({ isGone, pid: 7 }).map((due) => due.sessionId), ['killed', 'ended']);
});

test('a leftover candidate is claimed by one process only, and again once the claim dies', (t) => {
  t.after(freshHome('evolver-claim-'));
  const isGone = (pid) => pid !== 111;
  rememberCandidate('killed', { pid: 222, at: 1 });

  assert.deepEqual(claimLeftoverCandidates({ isGone, pid: 111 }).map((due) => due.sessionId), ['killed']);
  assert.deepEqual(claimLeftoverCandidates({ isGone, pid: 333 }), [], 'a live claim is left alone');
  settleCandidate('killed', { at: 1 }, { sent: false });
  assert.deepEqual(claimLeftoverCandidates({ isGone, pid: 333 }).map((due) => due.candidate.attempts), [1], 'a failed try is claimable again');
});

test('a candidate leaves the disk only once distilled, or after three failed tries', (t) => {
  t.after(freshHome('evolver-settle-'));
  const candidate = { pid: process.pid, at: 5, attempts: 0 };
  rememberCandidate('s', candidate);
  settleCandidate('s', candidate, { sent: false });
  settleCandidate('s', candidate, { sent: false });
  assert.equal(dueCandidates({ sessionId: 's' })[0].candidate.attempts, 2, 'kept for a retry');
  settleCandidate('s', candidate, { sent: false });
  assert.deepEqual(dueCandidates({ sessionId: 's' }), [], 'given up');

  rememberCandidate('s', candidate);
  rememberCandidate('s', { ...candidate, at: 9 });
  settleCandidate('s', candidate, { sent: true });
  assert.equal(dueCandidates({ sessionId: 's' })[0].candidate.at, 9, 'a newer candidate written meanwhile stays');
});

test('keys and tokens never reach the candidate, nor the prompt a manual focus writes', () => {
  const secret = 'sk-evomap-0123456789abcdef0123456789abcdef';
  const candidate = candidateOf({
    prompt: `use ${secret}`, model: MODEL, turn: 1, now: 1,
    record: record({ commands: [`curl -H "Authorization: Bearer ${secret}" x`], answer: `done with ${secret}`, paths: [`keys/${secret}.pem`] }),
  });
  assert.doesNotMatch(JSON.stringify(candidate), new RegExp(secret));
  assert.doesNotMatch(distillPrompt(candidate, `Authorization: Bearer ${secret}`), new RegExp(secret));
});
