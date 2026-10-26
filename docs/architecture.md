# Architecture

Reference for the plugin's tools, settings and troubleshooting, then how it is built on
Claude Code function hooks and the design decisions behind its behaviour.

## What reaches the model

Nothing of Evolver but the recalled strategy: no tools, no skill, no notice after an edit.
Reports go out at every turn end, the session's verified work is distilled outside the
conversation, and the commands below run in the plugin and answer in the transcript.

## Commands

| Command | What it does |
|---|---|
| `/evolver-status` | Proxy state, plus the last recalls and background failures. |
| `/evolver-search <text>` | Search the EvoMap network for reusable assets. |
| `/evolver-distill [focus]` | Distill this session's latest verified turn now, instead of at the next session start. |
| `/evolver-evolve [focus]` | Hand the agent a one-off evolution checkpoint (`assets/commands/evolve.md`). |
| `/evolver-sync`, `/evolver-review`, `/evolver-run`, `/evolver-solidify` | Run the `evolver` CLI (installed, else `npx -y @evomap/evolver@^2.0.39`), ten minutes at most. |

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
- **Installed, but no recall or turn summary.** Check
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
lib/*.js               pure logic (recall ranking, relevance and redaction, reuse
                       reports and their evidence, report outbox,
                       follow-up labels, retention, verification, savings, turn
                       summary, distillation, commands)
lib/local-ledger.js,   Node-only code, run by the sidecar
lib/injected-assets.js,
lib/distill-pending.js,
lib/state-file.js,
lib/process-owner.js
bin/evolver-io.mjs     sidecar: `record-reuse`, the distillation candidates, the
                       owner probe; JSON on stdin/stdout
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
| Checks | `tool.call` on Bash | Every test, build, lint and type-check command of the turn, in order; background runs are ignored. Commands, paths, the text each edit wrote (200,000 characters a turn at most, in memory only) and each edited file's content hash before its first edit are kept for the turn too. |
| Turn end | `turn.complete` | Subagent turns (`agentId`) are skipped. Queues a reuse report for every injection the turn saw, leaves a distillation candidate when the turn qualifies, returns the one-line summary as `{ text }`. |
| Session start | `session.start` | Registers the commands, reports the open injections of any session whose Claude Code process is gone (a resumed one's own included) as aborted, and claims and distills leftover candidates in the background. |
| Session end | `session.end` | Only writes, since every plugin's hook shares one short bound: the injections no turn end reported go into the outbox as aborted (delivered by the next session), the candidate is closed, and the ledger and follow-up label are forgotten. The turn counter stays: `claude --resume` continues under the same session id. |
| Commands | `$.command.register` + `command.run` | Answer with `{ text }`; `/evolver-evolve` alone submits a prompt (`$.prompt.submit`). |

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
  | Aborted: the session ends, or is killed, before the turn ends (a killed session's go out at the next session start, once its Claude Code process is gone) | `claude-code:<session>:<turn>` | `tier: none`, `applied: partial`, `aborted: true`, `stage: immediate` |

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
  `hub 400` or `hub 422`), and the report is settled as rejected, kept
  out of the local ledger and logged under `errors` as `reuse-report-rejected`, where
  a contract mismatch shows up. `hub 404` (the Hub may not serve the route yet),
  `hub 5xx`, 401, 403, 429 and timeouts are retried until the report expires.
- **Turn numbers** come from a per-session counter in `$.store`, one per turn whatever
  started it: `$.session.turns()` counts only the person's prompts, so a turn a task
  notification starts would reuse the previous number and its report would share that
  turn's task id.
- **Session-end distillation.** A turn that ended answered, used tools, passed its last
  check and reused no injected strategy leaves a candidate in
  `~/.evolver/state/claude-code-distill-pending.json`; a later verified turn replaces it,
  and a next prompt that reads as a correction drops it and stops a distillation already
  running. One `$.model.complete` call on the session's own model writes a Gene from a
  digest of that turn (task, commands, touched paths, checks, final answer — never the
  whole history) and sends it to the Proxy's `POST /conversation/distill` with
  `persist: true`, `publish: false` and its own token cost as `distill_usage`. Keys and
  tokens are stripped from the candidate first. `session.end` shares one short
  wall-clock bound, too short for a model call, so it closes the candidate and the next
  session that starts claims it, one process at a time; a failed try keeps it, and three
  give it up. A candidate whose Claude Code process is gone counts as over too, while an
  idle session keeps its own. `/evolver-distill` does the same at once. The file is not
  shared with other hosts: a candidate names a model only its own host can call.
- **Owner liveness.** `$.process.run` starts the sidecar without a shell, so its parent is
  the Claude Code process (a `node_path` that is a shim forking the real Node would break
  this); the sidecar records that pid on every candidate and every
  ledger entry, and probes it with signal 0 to tell a killed session from an idle one.
- **State.** The report outbox, pending retention checks, recall traces and background
  failures live in the plugin's `$.store`. The injection ledgers
  (`~/.evolver/state/claude-code-injected-<hash>.json`) and the distillation candidates
  live in state files under an exclusive lock, so two Claude Code processes cannot
  overwrite each other's entries, report the same orphan twice or claim the same leftover
  twice. The module orders its sidecar calls itself, so a correction's drop never lands
  before the candidate it drops.
- **Timeouts.** `$.http.fetch` takes neither a timeout nor an abort signal: every Proxy
  call races an 8 s `$.clock.sleep`, and an interrupted turn cannot cancel a request
  already sent.
- **Subagents** get no recall; their checks and edits count toward the main turn.
- **Onboarding notices** (upgrade, claim link) are toasts for the person, not model
  context.
- **No skill.** A plugin skill's catalog line rides every turn and cannot be switched
  off per install, so the plugin ships none.

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
