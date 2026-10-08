// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

/** @typedef {Record<string, { turn: number, injectedAt: number, outcome?: string, reportedAt?: number, corrected?: boolean, correctedAt?: number, modelOutcome?: string }>} Ledger */

const ENTRY_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

// The Hub counts every reuse report it receives and de-duplicates nothing, so
// exactly-once is this ledger's job, keyed on asset id. It is plain data: the
// caller persists it, so a report survives the session ending between the
// injection and the turn end.
/** @returns {Ledger} */
function pruned(ledger, now) {
  const kept = {};
  for (const [assetId, entry] of Object.entries(ledger ?? {})) {
    const at = Number(entry?.injectedAt);
    if (Number.isFinite(at) && now - at <= ENTRY_PRUNE_MS) kept[assetId] = entry;
  }
  return kept;
}

/** @returns {Ledger} */
export function withInjected(ledger, assetId, turn, now) {
  const kept = pruned(ledger, now);
  if (kept[assetId]) return kept;
  return { ...kept, [assetId]: { turn, injectedAt: now } };
}

export function unreportedAssets(ledger) {
  return Object.entries(ledger ?? {})
    .filter(([, entry]) => !entry?.outcome)
    .map(([assetId, entry]) => ({ assetId, turn: Number(entry?.turn) }));
}

// A correction can only revise a verdict actually sent, and only once: a second
// correction would be a second negative for one reuse.
export function correctableAssets(ledger) {
  return Object.entries(ledger ?? {})
    .filter(([, entry]) => entry?.outcome === 'success' && !entry?.corrected)
    .map(([assetId, entry]) => ({ assetId, turn: Number(entry?.turn) }));
}

/** @returns {Ledger} */
export function withReported(ledger, assetId, outcome, now) {
  const kept = pruned(ledger, now);
  const entry = kept[assetId] ?? { turn: 0, injectedAt: now };
  if (entry.outcome) return kept;
  return { ...kept, [assetId]: { ...entry, outcome, reportedAt: now } };
}

/** @returns {Ledger} */
export function withCorrected(ledger, assetId, now) {
  const kept = pruned(ledger, now);
  const entry = kept[assetId];
  if (!entry || entry.corrected) return kept;
  return { ...kept, [assetId]: { ...entry, corrected: true, correctedAt: now } };
}

// The model's own report is the verified one. Over an automatic verdict already
// sent it stands as that asset's correction, so a later correction prompt does
// not send the Hub a second negative for the same reuse.
/** @returns {Ledger} */
export function withModelReport(ledger, assetId, outcome, now) {
  const kept = pruned(ledger, now);
  const entry = kept[assetId];
  if (!entry?.outcome) return withReported(kept, assetId, outcome, now);
  return { ...kept, [assetId]: { ...entry, corrected: true, correctedAt: now, modelOutcome: outcome } };
}
