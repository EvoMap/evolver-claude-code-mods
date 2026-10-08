---
description: Show Evolver health — Proxy status, evolution memory, workspace id, network claim, and full-engine availability.
---

Report Evolver health as a short checklist. Use the available filesystem and shell tools for
the current platform; do not assume a POSIX shell.

1. **Proxy** — call `evolver_status`. Show its node id, pending counts, and last sync. If
   unreachable, say that running `evolver` once in a git repository starts the Proxy; local
   recall and capture remain available.
2. **Network claim** — check `~/.evomap/claim_url`. If it contains an HTTPS `evomap.ai`
   link, report that the node is awaiting claim and show the link without modifying it.
3. **Turn capture** — report whether the working directory is a git repository. Turn
   outcomes are derived from git diffs, so outside one they are not recorded; strategy
   injection from the network is unaffected either way.
4. **Evolution memory** — use an existing
   `<workspace>/memory/evolution/memory_graph.jsonl` when present; otherwise inspect
   `~/.evolver/memory/evolution/memory_graph.jsonl`. Report the selected path and count of
   non-empty JSONL rows without printing their contents.
5. **Workspace id** — find the git root, and the `workspace/` directory inside it when one
   exists; that path is the workspace root. The id is stored outside the repository, at
   `~/.evolver/state/workspace-<first 16 hex of sha256(workspace root)>`. Report only
   present/missing, never the id value.
6. **Full engine** — check whether `evolver` is installed and report its version. If absent,
   say that `npm install -g @evomap/evolver` enables `/evolver-mods:run`, `/evolver-mods:review`, and
   `/evolver-mods:solidify`. If it is older than 2.0.39, say that network strategy recall needs
   2.0.39 or newer and give `npm install -g @evomap/evolver@latest` as the upgrade.

Finish with one line on overall readiness and the single next action, if any.
