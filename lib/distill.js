// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutSecrets } from './redact.js';

// Distillation runs once a session and outside the agent's conversation: each turn that finished verified only
// leaves a candidate, the latest one wins, and the candidate becomes a Gene through one model call over a digest
// of the turn — never the whole history, which cost ten times as much for fewer usable Genes in the benchmark.

const PROMPT_MAX_CHARS = 6_000;
const ANSWER_MAX_CHARS = 3_000;
const COMMAND_MAX_CHARS = 300;
const MAX_COMMANDS = 40;
const LIST_FIELDS = ['strategy', 'validation', 'signals', 'preconditions'];
const ARGUMENT_FIELDS = ['title', 'summary', ...LIST_FIELDS];
const ITEM_NUMBER = /^\s*(?:\d+[.)]|[-*•])\s+/;
const ANSWERED = 'answer';
const DISTILL_MAX_TOKENS = 4_096;

/**
 * Why a finished turn leaves no candidate, or null when it does. A turn that reused an injected strategy
 * adds evidence to that asset through its reuse report rather than a near-copy of it; a chat reply without a
 * single command has no method to keep.
 */
export function skipReason(turnReason, record, { reusedAsset = false } = {}) {
  if (turnReason !== ANSWERED) return 'not_answered';
  if (!record.answer) return 'no_answer';
  if (record.checks.at(-1)?.failed) return 'failed_check';
  if (record.commands.length === 0 && record.edits.length === 0) return 'no_tool_use';
  if (reusedAsset) return 'asset_reused';
  return null;
}

// Keys and tokens are stripped before anything is written to disk or sent to a model or the Proxy. The
// sidecar stamps the owning process when it writes the candidate.
export function candidateOf({ prompt, record, model, turn, now }) {
  return {
    prompt: withoutSecrets(String(prompt ?? '')).slice(0, PROMPT_MAX_CHARS),
    commands: record.commands.slice(-MAX_COMMANDS).map((command) => withoutSecrets(command).slice(0, COMMAND_MAX_CHARS)),
    paths: [...new Set(record.paths)].map((path) => withoutSecrets(path)),
    checks: record.checks.map(({ command, failed }) => ({ command: withoutSecrets(command), failed })),
    answer: withoutSecrets(record.answer).slice(0, ANSWER_MAX_CHARS),
    model,
    turn,
    attempts: 0,
    at: now,
  };
}

export function distillPrompt(candidate, focus = '') {
  const lines = (items, render) => items.map(render).join('\n') || '(none)';
  const focusText = withoutSecrets(String(focus ?? ''));
  return [
    'Below is the record of a task an agent has just finished and verified. Turn it into one reusable Gene:',
    'a method another agent could follow on a similar task, written for the kind of data or system involved,',
    'not for these files, names or values. Do not include the answer itself.',
    ...(focusText ? [`Focus on: ${focusText}`] : []),
    'Answer with a JSON object only, with these fields:',
    '  title: short capability name',
    '  summary: what was solved and under which conditions',
    '  strategy: ordered, reproducible steps',
    '  validation: checks that proved the result',
    '  signals: keywords of the problem this generalizes to',
    '  preconditions: when the method applies',
    '',
    '## Task',
    candidate.prompt,
    '',
    '## Commands run',
    lines(candidate.commands, (command) => `- ${command}`),
    '',
    '## Files read or written',
    lines(candidate.paths, (path) => `- ${path}`),
    '',
    '## Checks',
    lines(candidate.checks, (check) => `- ${check.failed ? 'FAILED' : 'passed'}: ${check.command}`),
    '',
    '## Final answer',
    candidate.answer,
  ].join('\n');
}

// Models sometimes write a list field as one numbered paragraph ("1. … 2. …"), which the core reads as one step.
function listOf(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  return value.split(/\n+|(?<=\.)\s+(?=\d+[.)]\s)/).map((item) => item.replace(ITEM_NUMBER, '').trim()).filter(Boolean);
}

export function argumentsOf(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed?.summary !== 'string' || !parsed.summary.trim()) return null;
    for (const field of LIST_FIELDS) if (field in parsed) parsed[field] = listOf(parsed[field]);
    return Object.fromEntries(ARGUMENT_FIELDS.filter((field) => parsed[field] !== undefined).map((field) => [field, parsed[field]]));
  } catch {
    return null;
  }
}

export function distillBody(candidate, args, usage) {
  return {
    platform: 'claude-code',
    trigger: 'session_end',
    user_prompt: candidate.prompt,
    // The core rejects a Gene that repeats this answer's values (answer_leak).
    final_answer: candidate.answer,
    ...args,
    execution: { trace: candidate.checks.map((check) => ({ command: check.command, exit: check.failed ? 1 : 0 })) },
    persist: true,
    publish: false,
    // What this distillation itself cost, kept apart from the agent's own tokens.
    ...(usage ? { distill_usage: usage } : {}),
  };
}

/**
 * Distill one candidate through the session's own model (`complete` is `$.model.complete`). `cancel` stops it
 * and `isCurrent` is asked once more before anything is persisted, since the candidate may have been dropped
 * while the model answered. Resolves to what happened; never throws.
 */
export async function distillCandidate({ proxyFetch, complete, candidate, focus, timeoutMs, cancel, isCurrent = async () => true }) {
  if (!complete || !candidate?.model) return { status: 'no_model' };
  try {
    const request = { model: candidate.model, prompt: distillPrompt(candidate, focus), maxTokens: DISTILL_MAX_TOKENS, timeoutMs };
    const answered = await complete(request, cancel ? { signal: cancel } : undefined);
    if (!answered.isAnswered) return cancel?.aborted ? { status: 'dropped', usage: answered.usage } : { status: 'failed', error: answered.reason };
    const args = argumentsOf(answered.text);
    if (!args) return { status: 'unparsed', usage: answered.usage };
    const isWanted = !cancel?.aborted && (await isCurrent()) && !cancel?.aborted;
    if (!isWanted) return { status: 'dropped', usage: answered.usage };
    const result = await proxyFetch('POST', '/conversation/distill', distillBody(candidate, args, answered.usage));
    return result?.ok ? { status: 'sent', usage: answered.usage, data: result.data } : { status: 'failed', error: String(result?.error) };
  } catch (error) {
    return { status: 'failed', error: String(error?.message ?? error) };
  }
}
