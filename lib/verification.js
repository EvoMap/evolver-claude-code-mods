// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { detectSignals } from './signals.js';

// A turn reached its goal unless the last check it ran says otherwise: the
// verdict an automatic reuse report carries is read off the final test, build,
// lint or type-check command, never off how the turn ended.
const VERIFICATION_COMMANDS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check)\b/,
  /\bnode\s+--test\b/,
  /\b(?:jest|vitest|mocha|pytest|rspec|phpunit|tsc|eslint|ruff|mypy)\b/,
  /\bgo\s+(?:test|build|vet)\b/,
  /\bcargo\s+(?:test|build|check|clippy)\b/,
  /\bdotnet\s+(?:test|build)\b/,
  /\b(?:mvn|gradle|gradlew)\b/,
  /\bmake\b/,
  /\bclaude\s+plugin\s+(?:validate|test)\b/,
];

const FAILURE_SIGNALS = new Set(['test_failure', 'log_error']);

// Summaries of a passing run still name failures by count ("0 failed",
// "failures: 0"); only those counts are dropped, so "1 failed, 0 errors"
// still reads as a failure.
const ZERO_COUNT = /\b0\s+(?:failed|failures?|errors?)\b|\b(?:failed|failures?|errors?)\s*[:=]\s*0\b/gi;

// A heredoc body is data the command feeds a program, often prose that names
// `make` or `npm test`; only the command lines say what runs.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;

function withoutHeredocBodies(command) {
  return command.replace(HEREDOC, '<<$2$3');
}

export function isVerificationCommand(command) {
  if (typeof command !== 'string') return false;
  const commandLines = withoutHeredocBodies(command);
  return VERIFICATION_COMMANDS.some((pattern) => pattern.test(commandLines));
}

/** @param {{ isError?: boolean, text?: string }} result */
export function verificationFailed({ isError, text }) {
  if (isError) return true;
  const evidence = String(text ?? '').replace(ZERO_COUNT, '');
  return detectSignals(evidence).some((signal) => FAILURE_SIGNALS.has(signal));
}

// Claude Code runs commands through Bash, or PowerShell on Windows; either
// counts as the turn's check. A background run has not finished when its
// call returns, so it says nothing yet.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

export function checkCommandOf(call) {
  if (!SHELL_TOOLS.has(call?.tool) || call.run_in_background) return null;
  return isVerificationCommand(call.command) ? call.command : null;
}

const LABEL_MAX_CHARS = 80;

/**
 * How a check is named to the person: the one-line description the model gave the shell call, else the
 * command's first line. The desktop notice draws no line breaks, so a multi-line script would arrive garbled.
 */
export function checkLabelOf(call) {
  const description = typeof call?.description === 'string' ? call.description.trim() : '';
  const firstLine = String(call?.command ?? '').split('\n').find((line) => line.trim()) ?? '';
  const label = (description || firstLine).replace(/\s+/g, ' ').trim();
  return label.length > LABEL_MAX_CHARS ? `${label.slice(0, LABEL_MAX_CHARS - 1)}…` : label;
}
