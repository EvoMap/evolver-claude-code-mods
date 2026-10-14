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
| `evolver_asset_reuse_result` | Report a reuse as `success` / `failed` / `mismatched` / `stale` / `unsafe`. Sent with `L5` evidence, alongside the automatic report. |
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
| `HOME` / `USERPROFILE` | (unset) | User directory for Proxy settings and claim reminders. A non-empty `HOME` wins; otherwise `USERPROFILE` is used on Windows. If both are missing, no user credential or claim file is read. |
| `EVOMAP_PROXY_PORT` | `19820` | Fallback Proxy port. |

## Troubleshooting

- **Nothing seems to happen after a recall.** Recall decisions and background failures
  are kept in the plugin's store: open `~/.claude/plugins/store/evolver-mods_*.json` and
  look under `recalls` and `errors`.
- **Recall injects nothing.** Hub text recall usually takes 3–11 s and sometimes fails
  with a Hub 504, which the Proxy relays as HTTP 400. Requests time out after 8 s. A
  strategy is also skipped when its relevance to your prompt is below 2. Each shared
  English word counts 1 and each shared pair of Chinese characters counts 0.5, so a
  short or off-topic prompt injects nothing by design. Engine reminders, markup and
  links are removed from the prompt first, and a strategy longer than 4000 characters
  is passed over.
- **Every reuse is reported twice.** The command-hook `evolver` plugin is enabled too.
- **A reuse report seems lost.** Reports wait in the plugin's store under
  `reports:outbox` until the Proxy accepts them, retried at every turn end, follow-up
  prompt and session start for 8 days; `sentAt` marks the delivered ones and
  `rejectedAt` the ones the Hub refused, with the reason beside it.
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

Installed copies update by version: bump `version` in `.claude-plugin/plugin.json`
(and `package.json`) with every change meant to reach them, or
`claude plugin update` reports the old version as the latest.

## Layout

```
hooks/register.ts      the only file that touches `$` — every IO call lives here
lib/*.js               pure logic (signals, recall ranking, relevance and redaction,
                       reuse reports and their evidence, report outbox, injection
                       ledger, follow-up labels, retention, verification, savings,
                       turn summary, tools)
lib/local-ledger.js    Node-only code, run by the sidecar
bin/evolver-io.mjs     sidecar: `record-reuse`, JSON on stdin/stdout
```

Two engine rules shape this split:

1. **A hooks module has no Node.** evolver-core's `Ingestor` (hash-chained
   `root_events.jsonl`) therefore runs in a Node sidecar, which `register.ts` reaches
   through `$.process.run` the first time it delivers a report with evidence.
2. **`$` may only be passed to functions declared in the same file.** `claude plugin
   validate` refuses `$` crossing an import, so `register.ts` owns all IO and hands
   closures (`proxyFetch`, `recordLocally`, `onTrace`) to the pure `lib/` functions.

## Events

| Concern | Claude Code event | Notes |
|---|---|---|
| Recall | `prompt.submit` marks · `turn.start` recalls | `prompt.submit` knows the prompt's `origin` (`composer`, `bridge`, `sdk`, `scheduled-trigger` count as the person) but resolves only after its turn started, so the prompt is marked before `next`. `turn.start` is observe-only: the strategy is appended with `$.session.append` and reaches the model from the turn's next step. A recall slower than the wait is appended when it lands, unless the turn was interrupted. A prompt folded into a running turn is not recalled for: one recall per turn. |
| Correction follow-up | `prompt.submit` | The next `composer` prompt after a turn is labelled once: a correction or an approval reports that turn's reuse again. |
| Retention follow-up | `session.start` | Turns of an earlier session in the same project are judged by whether the files they edited are kept or reverted. |
| Edit signals | `tool.call` after `next` | The notice rides the result's `context`, as a PostToolUse reminder does. |
| Checks | `tool.call` on Bash | Every test, build, lint and type-check command of the turn, in order; background runs are ignored. Commands, paths, the text each edit wrote (200,000 characters a turn at most, in memory only) and each edited file's content hash before its first edit are kept for the turn too. |
| Turn end | `turn.complete` | Subagent turns (`agentId`) are skipped. Queues a reuse report for every injection the turn saw, returns the one-line summary as `{ text }`. |
| Session end | `session.end` | Drains pending work, forgets the session's ledger, turn counter and follow-up label. |
| Tools | `$.tool.register` + `tool.call` | Engine keys (`tool`, `tool_use_id`, `agentId`, `consent`) are stripped before unknown arguments are refused. |

## Design decisions

- **Relevance gate.** The local Proxy's text recall reports no similarity, and the Hub's
  raw order put off-topic genes behind short follow-ups. A candidate must share terms
  with the prompt through its title, summary and `signals_match`: Latin words are
  stemmed and weigh 1, Han bigrams weigh 0.5, generic task words and the host's own
  name (`claude`, `code`) nothing, and 2 passes. Measured on live recalls, every hit
  that scored 1.5 was off-topic and on-topic ones scored 2 or more; the samples are in
  `test/fixtures/recall-live.json`. Before matching, `<system-reminder>` blocks, markup
  and links are stripped from the prompt, so a session notification recalls nothing.
  A strategy that would inject more than 4000 characters is passed over. Two off-topic
  hits still score exactly 2 (meta questions sharing words like `replay` and `review`),
  the same as an on-topic Redis fix, so the gate alone cannot separate them.
- **Estimated savings.** The turn summary claims a saving only when the turn's last
  check passed, and never more than the fresh tokens (input, cache writes, output) the
  turn spent: evolver-core's estimator prices deriving a whole approach from scratch,
  which put ~72k against single questions that cost 5k.
- **Strategy timing.** `turn.start` holds no request, so a strategy reaches the model
  from the turn's next step and a turn answered in one step never sees it. Attaching
  it as `prompt.submit` context would reach the first request but holds the person's
  message off screen until recall returns (3.6–5.7 s measured); that trade was declined.
- **Reuse reports.** Every injection is reported, through the Proxy's
  `POST /asset/reuse-result`, as `{asset_id, outcome, task_id, reason, evidence}`; the
  field names are shared with the Hub and Evolver. `reason` names the turn, the applied
  verdict and the check kind, never the prompt, a command, code or a diff, and the
  prompt loses keys and tokens before recall sends it.

  | Report | `task_id` | `evidence` |
  |---|---|---|
  | Turn end | `claude-code:<session>:<turn>` | `tier` `L1` when a check ran, else `none`; `applied`; `check` `{kind, passed, fail_then_pass}`; `aborted`; `stage: immediate` |
  | Next prompt corrects or approves | `…:correction` | `tier: L3`, `applied`, `stage: correction` |
  | Next session finds the edits kept or reverted | `…:retention` | `tier: L2`, `applied`, `stage: retention` |
  | `evolver_asset_reuse_result` | the model's own | `tier: L5`, `applied`, `stage: immediate` |

  `applied` is `used` when at least half the strategy's steps show up in the turn's
  commands, edited paths, written code or answer, `partial` when fewer do and `unused`
  when none do. A step shows up when a name, path or command it quotes appears, or
  half its words do. The written code has to count: a strategy carried out in code
  and summed up in another language shares no word with the answer. When there is
  nothing to compare, a strategy without numbered steps or a turn that left only an
  answer, the verdict is unknown. The Hub's contract has no such value and charges
  `unused` a soft negative, so an unknown reuse is sent as tier `none` with `applied:
  partial`, which weighs nothing either way, and the reason says `applied: unknown`.
  `fail_then_pass` compares checks with output trimming (`| tail -9`, `2>&1`) removed,
  so the same check piped differently is still the same check.
  The outcome follows the last check; with none it follows how the turn ended. A tier
  `none` report counts as exposure only on the Hub and is not written to the local
  ledger. An older Proxy drops the new fields and the plugin runs unchanged.
- **Report outbox.** Reports are keyed by task id and asset, queued once and retried
  for 8 days, long enough for a retention follow-up a week later. A report counts as
  delivered once the Hub answers it at all: `recorded`, `duplicate_report`, or
  `eligible: false` (`daily_cap`, `same_owner`, `no_delivery_proof`) are final, so
  only an unreachable Proxy or an unrecorded answer is retried. The Hub counts one
  turn-end report per node, asset and UTC day. A request the Hub refuses as invalid
  can never succeed: the Proxy marks it `terminal: true` (an older one says
  `hub 400`, `hub 404` or `hub 422`), and the report is settled as rejected, kept
  out of the local ledger and logged under `errors` as `reuse-report-rejected`, where
  a contract mismatch shows up. `hub 5xx`, 401, 403, 429 and timeouts are retried.
- **Turn numbers** come from a per-session counter in `$.store`, one per turn whatever
  started it: `$.session.turns()` counts only the person's prompts, so a turn a task
  notification starts would reuse the previous number and its report would share that
  turn's task id.
- **State.** The injection ledger, report outbox, pending retention checks, recall
  traces and background failures live in the plugin's `$.store`.
- **Timeouts.** `$.http.fetch` takes neither a timeout nor an abort signal: every Proxy
  call races an 8 s `$.clock.sleep`, and an interrupted turn cannot cancel a request
  already sent.
- **Subagents** get no recall; their checks and edits count toward the main turn.
- **Onboarding notices** (upgrade, claim link) are toasts for the person, not model
  context.

## Engine behaviour found while testing

- A `hooks.json` that lists `modules` still runs its command `hooks`.
- A symlinked plugin folder loads once and is never reloaded.
- The engine writes `.claude-plugin/types/` into a mod's folder on every load; a sync that
  deletes it triggers a second reload, reported as "plugin.json changed".
- The desktop app draws `$.ui.toast` (top right, gone after its timeout), `$.ui.status`
  (a line under the prompt) and an `AbovePrompt` band. `turn.complete`'s `{ text }` is
  drawn as a "Claude Code notice" under the answer, without line breaks; the turn
  summary stays there because it is a record of that turn, kept in the transcript.
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
