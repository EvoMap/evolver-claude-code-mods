// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { ownerIsGone } from './process-owner.js';
import { readState, statePath, updateState } from './state-file.js';

// A candidate leaves the disk only once distilled or given up after MAX_ATTEMPTS failed tries; a try that failed
// is claimed again by the next session that starts. Each host keeps its own file: a candidate names the model of
// the host that wrote it, which no other host can call.

const MAX_ATTEMPTS = 3;

const pendingPath = () => statePath('claude-code-distill-pending.json');

export function rememberCandidate(sessionId, candidate) {
  if (!sessionId) return;
  updateState(pendingPath(), {}, (pending) => ({ ...pending, [sessionId]: candidate }));
}

export function dropCandidate(sessionId) {
  if (!sessionId) return;
  updateState(pendingPath(), {}, (pending) => {
    if (!(sessionId in pending)) return undefined;
    const { [sessionId]: dropped, ...rest } = pending;
    return rest;
  });
}

/** Whether this is still the session's candidate on disk: not dropped by a correction, nor replaced by a newer one. */
export function isCurrentCandidate(sessionId, candidate) {
  return readState(pendingPath(), {})[sessionId]?.at === candidate.at;
}

/** A session that ended keeps its candidate due, so the next session start distills it. */
export function closeCandidate(sessionId) {
  if (!sessionId) return;
  updateState(pendingPath(), {}, (pending) => (pending[sessionId]
    ? { ...pending, [sessionId]: { ...pending[sessionId], closed: true } }
    : undefined));
}

// A candidate is up for distillation again once its session is over and no live process is working on it.
function leftover(candidate, isGone) {
  const over = Boolean(candidate?.closed) || isGone(candidate?.pid);
  return over && (!candidate?.claimedBy || isGone(candidate.claimedBy));
}

/** This session's own candidate, if it has one. Left on disk until settled. */
export function dueCandidates({ sessionId }) {
  const candidate = readState(pendingPath(), {})[sessionId];
  return candidate ? [{ sessionId, candidate }] : [];
}

/**
 * The candidates of sessions that are over — ended, or killed with their process — claimed for `pid` under the
 * state lock, so two hosts starting at once cannot distill the same one twice. An idle session whose process
 * still runs keeps its candidate however long it waits.
 */
export function claimLeftoverCandidates({ isGone = ownerIsGone, pid }) {
  const claimed = [];
  updateState(pendingPath(), {}, (pending) => {
    const next = { ...pending };
    for (const [sessionId, candidate] of Object.entries(pending)) {
      if (!leftover(candidate, isGone) || candidate.claimedBy === pid) continue;
      next[sessionId] = { ...candidate, claimedBy: pid };
      claimed.push({ sessionId, candidate: next[sessionId] });
    }
    return claimed.length > 0 ? next : undefined;
  });
  return claimed;
}

/**
 * Removes a candidate once it was distilled, or counts a failed try and gives up after MAX_ATTEMPTS. A
 * newer candidate the session wrote meanwhile is left alone.
 */
export function settleCandidate(sessionId, candidate, { sent }) {
  updateState(pendingPath(), {}, (pending) => {
    const current = pending[sessionId];
    if (!current || current.at !== candidate.at) return undefined;
    const attempts = (current.attempts ?? 0) + 1;
    if (sent || attempts >= MAX_ATTEMPTS) {
      const { [sessionId]: settled, ...rest } = pending;
      return rest;
    }
    // The claim is released, so the next session start can try this candidate again.
    return { ...pending, [sessionId]: { ...current, attempts, claimedBy: null } };
  });
}
