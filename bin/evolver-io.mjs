#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The hooks module runs without Node, so evolver-core's root_events ingestor and the locked state files run
// here, one JSON request on stdin and one JSON answer on stdout. Claude Code starts this process directly (no
// shell), so its parent is the Claude Code process that owns the session: the owner a state entry records.

import {
  claimLeftoverCandidates, closeCandidate, dropCandidate, dueCandidates, isCurrentCandidate, rememberCandidate, settleCandidate,
} from '../lib/distill-pending.js';
import { forgetSession, listedAssets, rememberInjected, takeOrphanedUnreported, takeUnreported } from '../lib/injected-assets.js';
import { recordReuseLocally } from '../lib/local-ledger.js';

const owner = process.ppid;

const COMMANDS = {
  'record-reuse': async (request) => ({ recorded: await recordReuseLocally(request) }),
  'remember-injected': async ({ sessionId, assetIds, turn, strategyText }) => {
    for (const assetId of assetIds) rememberInjected(sessionId, assetId, { turn, strategyText }, owner);
    return {};
  },
  'listed-assets': async ({ sessionId }) => ({ ids: listedAssets(sessionId) }),
  'take-unreported': async ({ sessionId, turn }) => ({ assets: takeUnreported(sessionId, turn ?? Infinity) }),
  'take-orphaned-unreported': async () => ({ assets: takeOrphanedUnreported() }),
  'forget-session': async ({ sessionId }) => (forgetSession(sessionId), {}),
  'remember-candidate': async ({ sessionId, candidate }) => (rememberCandidate(sessionId, { ...candidate, pid: owner }), {}),
  'drop-candidate': async ({ sessionId }) => (dropCandidate(sessionId), {}),
  'close-candidate': async ({ sessionId }) => (closeCandidate(sessionId), {}),
  'is-current-candidate': async ({ sessionId, candidate }) => ({ current: isCurrentCandidate(sessionId, candidate) }),
  'due-candidates': async ({ sessionId }) => ({ due: dueCandidates({ sessionId }) }),
  'claim-leftover-candidates': async () => ({ claimed: claimLeftoverCandidates({ pid: owner }) }),
  'settle-candidate': async ({ sessionId, candidate, sent }) => (settleCandidate(sessionId, candidate, { sent }), {}),
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const command = COMMANDS[process.argv[2]];
if (!command) {
  process.stdout.write(JSON.stringify({ error: `unknown command: ${process.argv[2]}` }));
  process.exit(2);
}

try {
  process.stdout.write(JSON.stringify(await command(JSON.parse(await readStdin()))));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }));
  process.exit(1);
}
