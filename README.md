<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver for Claude Code — Mods Edition</h1>

Give the Claude Code agent a **persistent, auditable evolution memory** and a live link
to the **EvoMap network**. On each task you start, the agent is handed one proven
strategy from the network that matches it. While it works, its edits are tagged with
improvement signals. When the turn ends, the outcome is recorded, and each strategy it
reused is reported back. That report is based on the turn's last test or build, not on
whether the turn happened to finish. Each turn that reuses a strategy then gets a
one-line verdict: did the task reach its goal, and roughly how many tokens the reuse saved.

This is the [Evolver Claude Code plugin](https://github.com/EvoMap/evolver-claude-code-plugin)
rebuilt on Claude Code's **function hooks** (Mods). Command hooks start a `node` process
on every event and only see the input to a tool call. Function hooks run inside Claude
Code itself, so the plugin sees what each tool actually returned and how each turn ended,
and it can talk to the EvoMap Proxy directly, with no MCP server process. It writes the
same memory format as the other Evolver plugins, so they all share one evolution memory.

Powered by the [Genome Evolution Protocol (GEP)](https://evomap.ai) and
[`@evomap/evolver`](https://github.com/EvoMap/evolver).

> **Status:** prototype `0.1.0`. Requires Claude Code **2.1.286 or newer**. Function hooks
> are early access, and their API changes between releases. Older versions ignore this
> plugin entirely.

## What it does

These run on their own — you don't invoke them:

| When | Claude Code event | Effect |
|---|---|---|
| You send a prompt | `prompt.submit` → `turn.start` | Recalls from the EvoMap network using the text you typed. Notifications, peer messages and other plugins' prompts are never used. It picks one strategy of 4–8 steps that is actually about your task and adds it to the turn; the agent sees it from its next step onward. Short follow-ups such as "可以" or "继续" inject nothing. |
| Your prompt says the last answer failed | `prompt.submit` | Prompts like "不行" / "still failing" revise this session's earlier `success` reports to `failed`, once per asset. |
| The agent edits a file | `tool.call` (Write / Edit / MultiEdit / NotebookEdit) | Tags the turn with improvement signals (`log_error`, `perf_bottleneck`, `test_failure`, …) and shows the agent one short notice per file and signal set. |
| The agent runs a check | `tool.call` (Bash) | Remembers whether the turn's last test, build, lint or type-check passed. |
| The turn ends | `turn.complete` | Records the outcome from the git diff in the memory graph. Reports each strategy injected this turn as `success`, or as `failed` if the last check failed. If one was reused, adds a one-line summary below the answer. |
| The session ends | `session.end` | Waits for pending reports and records to finish. |

The turn summary looks like this. In the desktop app it appears as a "Claude Code notice":

```text
✓ Goal reached (last check passed: npm test) · reused EvoMap strategy "Redis connection pool tuning" · est. ~58k tokens saved (≈$0.52) · this turn used 6k fresh tokens
```

The saving is an **estimate**. It uses `@evomap/evolver-core`'s savings spec 0.3.0: the
cost of working out the approach from scratch, scaled by how many lines this turn's edits
touched, counted as a reference reuse. It is the same formula the EvoMap ledger uses. If
the last check failed, no saving is counted. "Fresh tokens" means input, cache writes and
output; cache reads of the session's growing context are left out.

### Tools

Served by the plugin itself and listed as `mcp__evolver-mods__<name>`:

| Tool | Purpose |
|---|---|
| `evolver_status` | Proxy state: node id, pending counts, last Hub sync. |
| `evolver_search_assets` | Search genes, capsules, evolution events or anti-genes by signal or text. |
| `evolver_fetch_asset` | An asset's summary, strategy steps and validation commands. |
| `evolver_asset_reuse_result` | Report a reuse as `success` / `failed` / `mismatched` / `stale` / `unsafe`. Overrides the automatic report and credits the author. |
| `evolver_distill_conversation` | Turn verified work into a reusable asset; publishing is opt-in. |
| `evolver_publish_asset` | Queue genes or capsules for Hub review. |
| `evolver_poll` / `evolver_ack` | Read mailbox messages, then retire them by id. |

### Skill and commands

A **`capability-evolver` skill** (the reuse → verify → record loop) and the commands
**`/evolver-mods:status`**, **`/evolver-mods:search`**, **`/evolver-mods:evolve`**,
**`/evolver-mods:distill`**, plus **`/evolver-mods:run`**, **`/evolver-mods:review`**,
**`/evolver-mods:solidify`** and **`/evolver-mods:sync`** when `@evomap/evolver` is installed.

## Install

In Claude Code:

```text
/plugin marketplace add EvoMap/evolver-claude-mods-plugin
/plugin install evolver-mods@evolver-mods
```

Restart Claude Code (or `/reload-plugins`). Nothing to clone and nothing to
`npm install`. The repository is private for now, so adding the marketplace needs git
access to `EvoMap` (your SSH key or `gh` login).

**Run one Evolver plugin, not two.** If the command-hook
[`evolver`](https://github.com/EvoMap/evolver-claude-code-plugin) plugin is enabled as
well, every turn is recorded twice. Disable it while this one is enabled.

### Local development

```bash
git clone git@github.com:EvoMap/evolver-claude-mods-plugin.git
cd evolver-claude-mods-plugin && npm install
claude --plugin-dir ./
```

To load a working copy in sessions the desktop app or an SDK host starts, where you
can't pass a flag, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`.

### Connecting to the EvoMap network (optional)

Without the network, the plugin still records local memory. To get strategies from the
network:

1. Install the engine and run it once inside a git repo:

   ```bash
   npm i -g @evomap/evolver
   evolver
   ```

   This starts the local Proxy and prints a **claim link** for a fresh node.
2. Open the link while signed in to [evomap.ai](https://evomap.ai). Check the result
   with `/evolver-mods:status`.

Strategy recall needs **Evolver 2.0.39 or newer**: older Proxies answer every recall
empty. If yours is older, the plugin shows a toast suggesting an upgrade.

## Requirements

- **Claude Code ≥ 2.1.286.** The desktop app ships its own copy, so the `claude` on
  your `PATH` may be older.
- **Node.js ≥ 22.13.** The hooks don't need it, but a small sidecar does: it takes
  git snapshots and writes the memory graph and the local reuse ledger. The ledger is
  written with the `@evomap/evolver-core` that ships inside the `@evomap/evolver` CLI,
  so the plugin itself has no dependencies to install.
- **Git.** Outcomes are derived from the git diff of the session's directory. Outside a
  repository, only reuse reports are sent.
- **The EvoMap Proxy**, for recall and the tools (see above). When it is down, the
  tools return an actionable error and local recording keeps working.

## Modes

### Local memory (default)

Outcomes are written to `~/.evolver/memory/evolution/memory_graph.jsonl`, or to the
project's `memory/evolution/` inside an evolver-managed repo. Each entry carries the
workspace, session, turn, how the turn ended and a fingerprint of the diff. The same turn
or the same diff is never recorded twice. No account and no network needed.

### Network (Proxy)

When the Proxy is running, prompts are matched to network strategies and the tools
return real assets. The plugin re-reads the Proxy's current loopback URL and token from
`~/.evolver/settings.json` on every request, and never sends that token to a non-loopback
address. Every reuse verdict is written twice: to the Hub through the Proxy, and as a
`value.reuse_hit` / `value.reuse_outcome` root event in
`~/.evomap/evolution/root_events.jsonl`, which ranks future candidates.

### Direct Hub recording

To also post turn outcomes straight to the Hub:

```bash
export EVOMAP_HUB_URL="https://evomap.ai"
export EVOMAP_API_KEY="…"
export EVOMAP_NODE_ID="…"
```

Only HTTPS is accepted for a remote Hub; loopback HTTP is allowed for local testing.
Local memory is written first.

## How it differs from the command-hook plugin

| | [evolver-claude-code-plugin](https://github.com/EvoMap/evolver-claude-code-plugin) | This plugin |
|---|---|---|
| Hook runtime | A `node` process per event | Inside Claude Code; one sidecar process per turn end |
| What it injects | A summary of recent local outcomes, at session start | One network strategy matched to each prompt you send, with a relevance check |
| Edit signals | From the content written | From the content written, as a notice attached to the tool result |
| Reuse verdict | — | Taken from the last test/build/lint/type-check, not from how the turn ended |
| Tools | MCP bridge process | Registered and served in-process |
| User-facing output | Model context only | Turn summary and toasts for you; nothing extra in the model's context |

Why the code is split the way it is (a hooks module has no Node, and `$` may not cross an
import) and the reasoning behind each behaviour are in
[`docs/architecture.md`](docs/architecture.md).

## Configuration

Options, editable from the `/config` menu:

| Option | Default | Purpose |
|---|---|---|
| `proxy_port` | `$EVOMAP_PROXY_PORT`, then `19820` | Fallback Proxy port when `~/.evolver/settings.json` names no URL. |
| `recall_enabled` | `true` | Recall one strategy per prompt. |
| `recall_min_similarity` | `0.3` | Lowest similarity worth injecting, when the Proxy reports one. The relevance check applies either way. |
| `recall_wait_ms` | `6000` | How long recall is awaited when the turn starts before it finishes in the background. |
| `claim_nudge_enabled` | `false` | Show a toast with the pending node-claim link at most every 12 hours. |
| `node_path` | `node` | The Node.js the sidecar runs on. |

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `EVOMAP_PROXY_PORT` | `19820` | Fallback Proxy port. |
| `MEMORY_GRAPH_PATH` | (auto) | Override the memory graph file. |
| `EVOLVER_WORKSPACE_ID` | (auto) | Override the workspace id. |
| `EVOMAP_HUB_URL` / `EVOMAP_API_KEY` / `EVOMAP_NODE_ID` | (unset) | Enable direct Hub recording. |

## Troubleshooting

- **Nothing seems to happen after a recall.** Recall decisions and background failures
  are kept in the plugin's store: open `~/.claude/plugins/store/evolver-mods_*.json` and
  look under `recalls` and `errors`.
- **Recall injects nothing.** Hub text recall usually takes 3–11 s and sometimes fails
  with a Hub 504, which the Proxy relays as HTTP 400. Requests time out after 8 s. A
  strategy is also skipped when its relevance to your prompt is below 1.5. Each shared
  English word counts 1 and each shared pair of Chinese characters counts 0.5, so a
  short or off-topic prompt injects nothing by design.
- **Every turn is recorded twice.** The command-hook `evolver` plugin is enabled too.
- **Turn end says "nothing recorded (not a git workspace)".** The session's directory
  is not a git repository.
- **Installed, but no recall, signals or turn summary.** Check
  `claude plugin list` shows it enabled and that Claude Code is 2.1.286 or newer. Hooks
  modules of installed plugins are behind a Claude Code rollout flag
  (`tengu_plugin_hooks_modules`); a `--plugin-dir` working copy always loads them.
- **Validation passes but lists no hooks.** The `claude` on your `PATH` is older than
  2.1.286. Use the one the desktop app bundles.

## Develop

```bash
npm install
npm test
npx -p typescript tsc -p .
claude plugin validate .
```

`tsconfig.json` reads `.claude/types/claude-code.d.ts`; write it with `/plugin-types`
after each Claude Code update rather than editing it.

The plugin folder is watched, and saving a file reloads it. A **symlink** into a
watched folder loads once and is never reloaded, so for a session's
`~/.claude/dev-mods/<session>/` folder, sync a real copy instead:

```bash
npm run dev:sync -- ~/.claude/dev-mods/<session>/evolver-claude-mods
```

## License

MIT © EvoMap — see [`LICENSE`](LICENSE). The hooks and the pure logic in `lib/` are
original to EvoMap's Evolver plugins. The sidecar imports
[`@evomap/evolver-core`](https://www.npmjs.com/package/@evomap/evolver-core) to write
root events. That package does not declare a license in its `package.json`; check its
terms before you redistribute.
