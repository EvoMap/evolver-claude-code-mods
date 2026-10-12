// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

export const OUTBOX_TTL_MS = 8 * 24 * 60 * 60 * 1000;

const keyOf = (report) => `${report.task_id}\0${report.asset_id}`;

function pruned(outbox, now) {
  return Object.fromEntries(Object.entries(outbox ?? {}).filter(([, entry]) => now - Number(entry?.queuedAt) <= OUTBOX_TTL_MS));
}

export function withQueued(outbox, queued, now) {
  const kept = pruned(outbox, now);
  for (const { report, sessionId } of queued) {
    kept[keyOf(report)] ??= { report, sessionId, queuedAt: now, attempts: 0 };
  }
  return kept;
}

export function withDelivery(outbox, key, delivered, now) {
  const entry = outbox[key];
  if (!entry) return outbox;
  return { ...outbox, [key]: { ...entry, attempts: entry.attempts + 1, ...(delivered && { sentAt: now }) } };
}
