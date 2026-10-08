# Architecture

Reference for the plugin's tools, settings and troubleshooting, then how it is built on
Claude Code function hooks and the design decisions behind its behaviour.

## Tools

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

## Skill and commands

A **`capability-evolver` skill** (the reuse → verify → record loop) and the commands
**`/evolver-mods:status`**, **`/evolver-mods:search`**, **`/evolver-mods:evolve`**,
**`/evolver-mods:distill`**, plus **`/evolver-mods:run`**, **`/evolver-mods:review`**,
**`/evolver-mods:solidify`** and **`/evolver-mods:sync`** when `@evomap/evolver` is installed.

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

## Development

```bash
npm ci
npm test
npx -p typescript tsc -p .
claude plugin validate .
```

`tsconfig.json` reads `.claude/types/claude-code.d.ts`; write it with `/plugin-types`
after each Claude Code update. `claude plugin validate` needs Claude Code 2.1.286 or newer;
an older `claude` on `PATH` validates the plugin as having no hooks.

A `--plugin-dir` folder is watched and reloads on save. A symlink into a watched folder
loads once and is never reloaded, so for a session's `~/.claude/dev-mods/<session>/`
folder sync a real copy instead:

```bash
npm run dev:sync -- ~/.claude/dev-mods/<session>/evolver-claude-mods
```

## Layout

```
hooks/register.ts      the only file that touches `$` — every IO call lives here
lib/*.js               pure logic shared with the sidecar (signals, recall ranking and
                       relevance, correction detection, reuse reports, injection ledger,
                       verification, savings, turn summary, tools)
lib/{capture,git,workspace,local-ledger}.js
                       Node-only code, run by the sidecar
bin/evolver-io.mjs     sidecar: `capture` and `record-reuse`, JSON on stdin/stdout
```

Two engine rules shape this split:

1. **A hooks module has no Node.** Git snapshots, `O_APPEND|O_NOFOLLOW` appends, the
   cross-process capture lock and evolver-core's `Ingestor` (hash-chained
   `root_events.jsonl`) therefore run in a Node sidecar, which `register.ts` reaches
   through `$.process.run` once per turn end.
2. **`$` may only be passed to functions declared in the same file.** `claude plugin
   validate` refuses `$` crossing an import, so `register.ts` owns all IO and hands
   closures (`proxyFetch`, `recordLocally`, `onTrace`) to the pure `lib/` functions.

## Events

| Concern | Claude Code event | Notes |
|---|---|---|
| Recall | `prompt.submit` marks · `turn.start` recalls | `prompt.submit` knows the prompt's `origin` (`composer`, `bridge`, `sdk`, `scheduled-trigger` count as the person) but resolves only after its turn started, so the prompt is marked before `next`. `turn.start` is observe-only: the strategy is appended with `$.session.append` and reaches the model from the turn's next step. A recall slower than the wait is appended when it lands, unless the turn was interrupted. A prompt folded into a running turn is not recalled for: one recall per turn. |
| Verdict correction | `prompt.submit` | Mid-turn prompts are checked too. |
| Edit signals | `tool.call` after `next` | The notice rides the result's `context`, as a PostToolUse reminder does. |
| Last check | `tool.call` on Bash | Test, build, lint and type-check commands only; background runs are ignored. |
| Turn end | `turn.complete` | Subagent turns (`agentId`) are skipped. Reports reuse, runs the capture sidecar, returns the one-line summary as `{ text }`. |
| Session end | `session.end` | Drains pending work, forgets the session's ledger and turn counter. |
| Tools | `$.tool.register` + `tool.call` | Engine keys (`tool`, `tool_use_id`, `agentId`, `consent`) are stripped before unknown arguments are refused. |

## Design decisions

- **Relevance gate.** The local Proxy's text recall reports no similarity, and the Hub's
  raw order put off-topic genes behind short follow-ups. A candidate must share terms
  with the prompt through its title, summary and `signals_match`: Latin words are
  stemmed and weigh 1, Han bigrams weigh 0.5, generic task words nothing, and 1.5
  passes. Measured on live recalls, off-topic hits scored at most 1 and on-topic ones
  1.5 or more; the samples are in `test/fixtures/recall-live.json`.
- **Strategy timing.** `turn.start` holds no request, so a strategy reaches the model
  from the turn's next step and a turn answered in one step never sees it. Attaching
  it as `prompt.submit` context would reach the first request but holds the person's
  message off screen until recall returns (3.6–5.7 s measured); that trade was declined.
- **Reuse verdict.** An automatic report is `success` unless the turn's last test,
  build, lint or type-check failed: how a turn ended says little about whether a
  strategy helped. A model's own `evolver_asset_reuse_result` over an automatic verdict
  stands as its correction, so a later correction prompt does not count it twice. The
  memory-graph outcome follows how the turn ended, in Claude Code's own terms: `answer`
  is a success, `aborted`, `refusal` and `error` are failures.
- **Turn numbers** come from a per-session counter in `$.store`, one per turn whatever
  started it: `$.session.turns()` counts only the person's prompts, so a turn a task
  notification starts would reuse the previous number and its capture would be dropped
  as a duplicate.
- **State.** The injection ledger, recall traces and background failures live in the
  plugin's `$.store`; workspace ids and capture state stay under `~/.evolver/state/`,
  shared with the other Evolver hosts.
- **Timeouts.** `$.http.fetch` takes neither a timeout nor an abort signal: every Proxy
  call races an 8 s `$.clock.sleep`, and an interrupted turn cannot cancel a request
  already sent.
- **Subagents** get no recall; their edits' signals count toward the main turn whose
  git diff carries those edits.
- **Captures** are not serialized per session: each turn end runs its own sidecar and
  the capture lock keeps them from interleaving, but two turns ending back to back may
  commit out of order.
- **Onboarding notices** (upgrade, claim link) are toasts for the person, not model
  context.

## Engine behaviour found while testing

- A `hooks.json` that lists `modules` still runs its command `hooks`.
- A symlinked plugin folder loads once and is never reloaded.
- The engine writes `.claude-plugin/types/` into a mod's folder on every load; a sync that
  deletes it triggers a second reload, reported as "plugin.json changed".
- `$.ui.status` was never seen drawn in the desktop app; `turn.complete`'s `{ text }` is
  drawn there as a "Claude Code notice", without line breaks.
- Gating hooks (`prompt.submit`, `tool.call`) need a `.catch` from 2.1.293 on; its `next`
  is replay-safe, so a failure after `next` never runs the tool twice.

- A marketplace-installed copy loads `modules` as `evolver-mods@evolver-mods`, tier
  `user`, the same as a `--plugin-dir` copy; installed plugins' modules wait on the
  `tengu_plugin_hooks_modules` rollout flag first.
- The marketplace installer runs an npm install in the plugin's folder, so
  `@evomap/evolver-core` is there; the sidecar still falls back to the copy inside the
  global `@evomap/evolver` CLI when it is not.

## Open questions

- Whether `@evomap/evolver-core`'s terms allow redistributing a plugin that imports it.
