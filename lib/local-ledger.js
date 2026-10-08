// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const HIT_EVENT = 'value.reuse_hit';
const OUTCOME_EVENT = 'value.reuse_outcome';
const MAX_TITLE_CHARS = 80;

// Keyed by path, not a single instance: the log lives under the home directory,
// and a process that sees a different one must not keep writing to the first.
const byPath = new Map();

function loadIngestor() {
  return import('@evomap/evolver-core')
    .then(({ events }) => {
      const path = events.rootEventsPath();
      let ingestor = byPath.get(path);
      if (!ingestor) {
        ingestor = new events.Ingestor({ path });
        byPath.set(path, ingestor);
      }
      return ingestor;
    })
    .catch(() => null);
}

function cycleIdOf(sessionId) {
  return `claude-code:${sessionId || 'unknown'}`;
}

// The verdict has to become a root_event to be worth anything: the actuator
// that re-orders candidates reads root_events, not the Hub, and a Hub without
// the route records nothing at all. Success and the negative verdicts ride
// different events by design -- the ledger derives savings from one and the
// keep/prune signal from the other.
export async function recordReuseLocally({ assetId, outcome, sessionId }) {
  if (!assetId || !outcome) return false;
  const ingestor = await loadIngestor();
  if (!ingestor) return false;

  const cycleId = cycleIdOf(sessionId);
  const success = outcome === 'success';
  try {
    await ingestor.ingest({
      type: success ? HIT_EVENT : OUTCOME_EVENT,
      human: {
        title: `claude-code reuse ${outcome}`.slice(0, MAX_TITLE_CHARS),
        detail: `cycle ${cycleId}`,
      },
      payload: success ? { assetId, cycleId } : { assetId, cycleId, outcome },
    });
    return true;
  } catch {
    return false;
  }
}
