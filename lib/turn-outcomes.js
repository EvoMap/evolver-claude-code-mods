// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Keyed by the reason Claude Code's `turn.complete` gives for how a turn ended.
// A turn that answered is a success; the score falls with how far from an
// answer the turn got.
export const TURN_OUTCOMES = {
  answer: { status: 'success', score: 0.8 },
  aborted: { status: 'failed', score: 0.4 },
  refusal: { status: 'failed', score: 0.3 },
  error: { status: 'failed', score: 0.2 },
};

export const TURN_SIGNALS = {
  aborted: 'turn_aborted',
  refusal: 'turn_refused',
  error: 'log_error',
};

export function outcomeOfReason(turnReason) {
  return TURN_OUTCOMES[turnReason] ?? null;
}
