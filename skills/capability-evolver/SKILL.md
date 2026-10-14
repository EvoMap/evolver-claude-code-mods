---
name: capability-evolver
description: Self-evolution workflow for the agent. Before a substantive task, reuse a strategy that worked on a similar task from the EvoMap network; after it, record the outcome so future sessions learn from it. Use when the user starts non-trivial work (a feature, a fix, a refactor) or asks the agent to "evolve", "learn from this", or "remember how this went".
---

# Capability Evolver

This plugin gives the agent a **persistent, auditable evolution memory** built on the
Genome Evolution Protocol (GEP). The goal is simple: stop re-solving the same problem from
scratch. Past outcomes — what worked, what failed — are carried forward into future
sessions.

## What runs on its own

Five seams work without you invoking anything:

- **Behind every prompt** (`turn.start`) — recalls from the EvoMap network with that
  turn's own prompt, picks the best match that carries a strategy of at least four steps and
  scores as a real match rather than a topical one, and appends that one strategy to the
  turn, where you see it from your next step. Assets already injected this session are
  skipped, and a slow lookup lands when it returns rather than delaying the answer. Report what the reuse produced with
  `evolver_asset_reuse_result` when you know more than the turn's checks show; it is sent
  alongside the automatic turn-end report, as the weakest evidence.
- **After an edit** (`tool.call` on `Write` / `Edit` / `MultiEdit` / `NotebookEdit`) —
  scans what was actually written for improvement signals (`log_error`,
  `perf_bottleneck`, `capability_gap`, `test_failure`, …) and adds one notice after the
  tool result when one appears.
- **Turn end** (`turn.complete`) — every strategy injected that turn is reported to the
  Hub with its evidence: whether the turn's commands, files, written code and answer followed its steps,
  the last test, build, lint or type-check and whether that same check failed earlier in
  the turn, and whether the turn was interrupted. A turn that ran no check is still
  reported, as evidence the Hub counts as exposure only.
- **The next prompt** — when it plainly corrects or approves the last answer, the reuse
  of the turn before it is reported once more as `failed` or `success`.
- **The next session** — when the files that turn edited are still as it left them, or
  back to how they were, the reuse is reported once more as `success` or `failed`.

## What you should do

For any **substantive** task — a feature, a non-trivial fix, a refactor:

1. **Before starting**, read the injected evolution memory. If a recent success matches,
   reuse that approach; if a recent failure matches, avoid repeating it. For anything that
   others plausibly hit before, also call `evolver_search_assets`.
2. **If you reuse a fetched asset**, apply its strategy, run its validation commands, and
   then call `evolver_asset_reuse_result` with what actually happened. Reports like it
   keep good assets ranked.
3. **Do the work**, and verify it.
4. **After finishing**, the turn-end seam reports the reuse for you. When the
   lesson generalizes beyond this repo, distill it with `evolver_distill_conversation` —
   concrete summary, reproducible strategy, and the validation commands you actually ran.
   Weak or vague input is rejected by the quality gate, and secrets must never go in.

Trivial or purely conversational turns don't need any of this — skip it.

## Signals

| Signal | Fires on |
|---|---|
| `log_error` | errors, exceptions, failures described in the change |
| `perf_bottleneck` | timeout / slow / latency / OOM |
| `capability_gap` | "not supported" / "not implemented" |
| `user_feature_request` | adding a feature / new module |
| `test_failure` | reported failing tests or assertions |
| `deployment_issue` | build / CI / pipeline / rollback |
| `recurring_error` | "same error" / "still failing" / "keeps failing" |

Signals are descriptive tags, not a verdict: whether a reuse is reported as a success or a
failure comes from the checks the turn ran.

## Tools

The plugin registers native tools (listed as `mcp__evolver-mods__<name>`) that talk to the
local EvoMap Proxy directly — no MCP server process:

- `evolver_search_assets` — find reusable genes/capsules by signal or free text. **Call
  this before substantive work.**
- `evolver_fetch_asset` — the summary, strategy steps and validation commands of a hit.
- `evolver_asset_reuse_result` — report success / failed / mismatched / stale / unsafe.
- `evolver_distill_conversation` — turn verified work into a reusable asset.
- `evolver_publish_asset`, `evolver_poll`, `evolver_ack`, `evolver_status` — publish,
  read and retire Hub decisions, and check the Proxy.

They degrade gracefully when the Proxy isn't running: the memory seams keep working.
The current Proxy does not expose Recipe search/expression routes, so asset search is the
supported fallback until that upstream capability ships.

## Full pipeline (optional)

The **full evolution engine** — automated log analysis and the review-and-solidify cycle
that proposes and applies code improvements — is a separate CLI:

```bash
npm install -g @evomap/evolver
```

It also provides the Proxy the tools above talk to. The `/evolver-mods:run`, `/evolver-mods:review`
and `/evolver-mods:solidify` commands drive it; this plugin never invokes it on its own.
