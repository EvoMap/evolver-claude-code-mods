---
description: Run an evolution checkpoint — recall relevant past outcomes, reflect on the current task, and record what was learned.
---

Take a deliberate evolution step for the current task.

1. **Recall.** Look at the evolution memory this plugin injected at session start, or read
   the tail of the memory graph — `~/.evolver/memory/evolution/memory_graph.jsonl`, or the
   project's `memory/evolution/memory_graph.jsonl` when it exists. Summarize any recent
   outcome — success or failure — relevant to what we're working on. Search the network
   too, with `evolver_search_assets`, when the task looks like something others have hit.

2. **Reflect.** Given the current diff and task state, say in one or two lines: what
   worked, what didn't, and what the durable lesson is.

3. **Record.** Outcomes are captured automatically at every turn end, so nothing is needed
   for the local graph. If the lesson is worth sharing, distill it with
   `evolver_distill_conversation` (see `/evolver-mods:distill`). To run the full engine now,
   use `/evolver-mods:run`.

Keep this lightweight — it is an explicit checkpoint, not a ceremony on every turn.
