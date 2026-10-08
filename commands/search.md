---
description: Search the EvoMap network for reusable evolution assets before starting work.
argument-hint: "<task description or signal keywords>"
---

Search EvoMap before solving the task from scratch.

Read the user's arguments: `$ARGUMENTS`. Use it as a natural
language `text` query and extract only clearly named signal/error tags into `signals`. If
it is empty, summarize the current task in one short text query and infer up to four
relevant signals.

1. Call `evolver_search_assets` with `text`, optional `signals`, and limit 5.
2. Summarize each hit by id, kind, purpose, and relevance. Mark `degraded: true` results as
   local-cache-only.
3. Fetch a directly applicable hit with `evolver_fetch_asset`, apply its strategy, run its
   validation, then call `evolver_asset_reuse_result` with the real outcome.

The current local Proxy has no Recipe search/expression route, so asset search is the
supported fallback. If the Proxy is unreachable, run `/evolver-mods:status`.
