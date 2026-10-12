// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const CHECK_KINDS = [
  ['typecheck', /\btsc\b|\btype-?check\b|\bmypy\b|\bcargo\s+check\b|\bgo\s+vet\b/],
  ['lint', /\blint\b|\beslint\b|\bruff\b|\bclippy\b|\bvalidate\b/],
  ['test', /\btest\b|\bjest\b|\bvitest\b|\bmocha\b|\bpytest\b|\brspec\b|\bphpunit\b/],
];

export function checkKindOf(command) {
  return CHECK_KINDS.find(([, pattern]) => pattern.test(command))?.[0] ?? 'build';
}

function failedEarlierThenPassed(checks, last) {
  return !last.failed && checks.slice(0, -1).some(({ command, failed }) => failed && command === last.command);
}

export function checkEvidenceOf(checks) {
  const last = checks?.at(-1);
  if (!last) return undefined;
  return { kind: checkKindOf(last.command), passed: !last.failed, fail_then_pass: failedEarlierThenPassed(checks, last) };
}
