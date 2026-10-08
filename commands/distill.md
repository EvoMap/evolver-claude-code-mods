---
description: Distill a reusable skill/gene from this session's verified work.
argument-hint: "[what to distill]"
---

Distill what this session proved into a reusable asset.

Prefer `evolver_distill_conversation`. Supply a concrete summary, reproducible strategy,
validation commands that actually passed, relevant artifacts, and signals. Persistence is
on by default; set `publish: true` only when the user explicitly asked to share the result.
Never include secrets, credentials, private paths, or an unverified claim.

Use `$ARGUMENTS` as additional scope for what to
distill. If the Proxy is unavailable and the full CLI is installed, use the installed
`evolver` executable (or `npx -y @evomap/evolver`) with its `distill` subcommand and the
same input.

Tell the user what was distilled, the evidence attached, and whether it stayed local or was
submitted for review.
