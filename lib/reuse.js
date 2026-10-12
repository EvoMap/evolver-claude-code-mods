// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { checkEvidenceOf } from './checks.js';
import { withDelivery } from './report-outbox.js';
import { outcomeOfReason } from './turn-outcomes.js';

const LABEL_OUTCOMES = { correction: 'failed', praise: 'success' };
const RETENTION_OUTCOMES = { kept: 'success', reverted: 'failed' };

export function turnTaskId(sessionId, turn) {
  return `claude-code:${sessionId || 'unknown'}:${turn ?? 'unknown'}`;
}

export function immediateEvidenceOf({ checks, applied, turnReason }) {
  const check = checkEvidenceOf(checks);
  return { tier: check ? 'L1' : 'none', applied, ...(check && { check }), aborted: turnReason === 'aborted', stage: 'immediate' };
}

function immediateOutcomeOf(evidence, turnReason) {
  if (evidence.check) return evidence.check.passed ? 'success' : 'failed';
  return outcomeOfReason(turnReason) ?? 'failed';
}

function checkPhrase(check) {
  if (!check) return 'no check ran';
  const result = check.passed ? 'passed' : 'failed';
  return `last ${check.kind} ${result}${check.fail_then_pass ? ' after failing earlier' : ''}`;
}

function reportOf({ assetId, serveToken, taskId, outcome, reason, evidence }) {
  return { asset_id: assetId, outcome, task_id: taskId, reason, ...(serveToken && { serve_token: serveToken }), evidence };
}

export function immediateReportOf({ asset, sessionId, turn, turnReason, checks, applied }) {
  const evidence = immediateEvidenceOf({ checks, applied, turnReason });
  return reportOf({
    assetId: asset.assetId,
    serveToken: asset.serveToken,
    taskId: turnTaskId(sessionId, turn),
    outcome: immediateOutcomeOf(evidence, turnReason),
    reason: `Injected by Evolver into Claude Code turn ${turn}; applied: ${applied}; ${checkPhrase(evidence.check)}.`,
    evidence,
  });
}

export function reportedReuseOf(report) {
  return { assetId: report.asset_id, serveToken: report.serve_token, applied: report.evidence.applied, taskId: report.task_id };
}

export function correctionReportOf(reuse, label) {
  if (!LABEL_OUTCOMES[label]) return null;
  return reportOf({
    ...reuse,
    taskId: `${reuse.taskId}:correction`,
    outcome: LABEL_OUTCOMES[label],
    reason: `The person's next prompt read as ${label} of the turn that reused this strategy.`,
    evidence: { tier: 'L3', applied: reuse.applied, stage: 'correction' },
  });
}

export function retentionReportOf(reuse, retentionClass) {
  if (!RETENTION_OUTCOMES[retentionClass]) return null;
  return reportOf({
    ...reuse,
    taskId: `${reuse.taskId}:retention`,
    outcome: RETENTION_OUTCOMES[retentionClass],
    reason: `By the next session the files the turn edited were ${retentionClass}.`,
    evidence: { tier: 'L2', applied: reuse.applied, stage: 'retention' },
  });
}

async function postToHub(proxyFetch, report) {
  try {
    const result = await proxyFetch('POST', '/asset/reuse-result', report);
    return result?.ok === true && result.data?.recorded !== false;
  } catch {
    return false;
  }
}

async function recordFirstAttemptLocally(recordLocally, { report, sessionId, attempts }) {
  if (attempts > 0 || report.evidence.tier === 'none') return;
  await recordLocally({ assetId: report.asset_id, outcome: report.outcome, sessionId }).catch(() => false);
}

export async function deliverPending(ledgers, outbox, now) {
  let delivered = outbox;
  for (const [key, entry] of Object.entries(outbox)) {
    if (entry.sentAt) continue;
    await recordFirstAttemptLocally(ledgers.recordLocally, entry);
    delivered = withDelivery(delivered, key, await postToHub(ledgers.proxyFetch, entry.report), now);
  }
  return delivered;
}
