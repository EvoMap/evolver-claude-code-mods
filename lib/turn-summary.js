// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { referenceReuseSavings } from './savings.js';

const NAME_MAX_CHARS = 48;

function compactTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

// Cache reads are the context replayed on every step at a tenth of the price;
// counting them would report a long session's context, not this turn's work.
function freshTokens(usage) {
  if (!usage) return null;
  const counted = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens']
    .map((field) => Number(usage[field]))
    .filter(Number.isFinite);
  return counted.length === 0 ? null : counted.reduce((sum, value) => sum + value, 0);
}

function goalLine(lastCheck) {
  if (!lastCheck) return '○ Goal counted as reached (no check ran)';
  return lastCheck.failed
    ? `✗ Goal not reached (last check failed: ${lastCheck.command})`
    : `✓ Goal reached (last check passed: ${lastCheck.command})`;
}

function reuseLine({ reusedNames, lastCheck, changedLines, usage }) {
  const names = reusedNames.map((name) => `"${String(name).slice(0, NAME_MAX_CHARS)}"`).join(', ');
  const used = freshTokens(usage);
  const usedPart = used === null ? '' : ` · this turn used ${compactTokens(used)} fresh tokens`;
  if (lastCheck?.failed) return `reused EvoMap strategy ${names} · no savings counted${usedPart}`;
  const saved = referenceReuseSavings(changedLines);
  return `reused EvoMap strategy ${names} · est. ~${compactTokens(saved.tokens)} tokens saved (≈$${saved.usd.toFixed(2)})${usedPart}`;
}

// One line, shown only for a turn that reused a strategy: the desktop draws it
// as a notice that renders no line breaks. It says whether the goal was
// reached, judged by the last check as the reuse report is, and what the reuse
// is estimated to have saved.
export function turnSummaryOf(turn) {
  if (!turn?.reusedNames?.length) return null;
  return `${goalLine(turn.lastCheck)} · ${reuseLine(turn)}`;
}
