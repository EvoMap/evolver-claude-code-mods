// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// An automatic report is weaker evidence than one the model made after
// validating its own work: the strategy was put in front of the model, but
// nothing proves it was followed. The reason says so, so the Hub can weigh it
// against a reported reuse rather than mistaking it for one.
function automaticReason(turn, lastCheck) {
  const verdict = lastCheck.failed
    ? `the turn's last verification failed (\`${lastCheck.command}\`)`
    : `the turn's last verification passed (\`${lastCheck.command}\`)`;
  return `Injected by Evolver into Claude Code turn ${turn}; not confirmed as applied. Outcome: ${verdict}.`;
}

// Only a check the turn ran can vouch for a reuse: a passing test, build, lint
// or type-check makes it a success, a failing one a failure. A turn that ran
// none has no verdict to report, so nothing is sent; reporting such turns as
// successes credited strategies that were never relevant, every hour a
// scheduled task ran.
export function reuseStatusOf(lastCheck) {
  if (!lastCheck) return null;
  return lastCheck.failed ? 'failed' : 'success';
}

function correctionReason(turn) {
  return `Revising the automatic verdict for Claude Code turn ${turn}: the next prompt `
    + 'in the same session read as a correction, so the earlier reuse did not hold.';
}

// The Hub hashes the task id with the asset and the reporting node into the
// event id that makes a retry idempotent, and its schema requires one. One id
// per turn per session means re-sending a verdict is recognised, while a later
// correction carries its own and is not mistaken for that retry.
function reportId(sessionId, turn) {
  return `claude-code:${sessionId || 'unknown'}:${turn ?? 'unknown'}`;
}

// `ok` only says the Proxy answered; the body carries whether a Hub ledger took
// the report. Treating transport as outcome would mark an asset reported that no
// ledger ever saw.
async function postToHub(proxyFetch, { assetId, outcome, reason, taskId }) {
  try {
    const result = await proxyFetch('POST', '/asset/reuse-result', { asset_id: assetId, outcome, reason, task_id: taskId });
    return result?.ok === true && result.data?.recorded !== false;
  } catch {
    return false;
  }
}

// The local root_event is the half the candidate-reordering actuator reads. A
// verdict counts as delivered when either ledger took it, so one being down does
// not keep the asset pending forever.
async function postOutcome(ledgers, { assetId, outcome, reason, taskId, sessionId }) {
  const hub = await postToHub(ledgers.proxyFetch, { assetId, outcome, reason, taskId });
  const local = await ledgers.recordLocally({ assetId, outcome, sessionId }).catch(() => false);
  return hub || local;
}

export async function reportInjectedReuse(ledgers, { assetIds, lastCheck, turn, sessionId }) {
  if (assetIds.length === 0 || reuseStatusOf(lastCheck) === null) return [];
  const reported = [];
  for (const assetId of assetIds) {
    const delivered = await postOutcome(ledgers, {
      assetId,
      outcome: reuseStatusOf(lastCheck),
      reason: automaticReason(turn, lastCheck),
      taskId: reportId(sessionId, turn),
      sessionId,
    });
    if (delivered) reported.push(assetId);
  }
  return reported;
}

export async function reportReuseCorrection(ledgers, { assets, sessionId }) {
  const corrected = [];
  for (const { assetId, turn } of assets) {
    const delivered = await postOutcome(ledgers, {
      assetId,
      outcome: 'failed',
      reason: correctionReason(turn),
      taskId: `${reportId(sessionId, turn)}:correction`,
      sessionId,
    });
    if (delivered) corrected.push(assetId);
  }
  return corrected;
}
