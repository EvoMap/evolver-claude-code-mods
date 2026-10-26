import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { evolverCommands, runEvolverCli } from '../lib/commands.js'
import { candidateOf, distillCandidate, skipReason } from '../lib/distill.js'
import { EDIT_TOOL_NAMES, changedLinesOf, editedPath } from '../lib/edited-content.js'
import { feedbackLabelOf } from '../lib/feedback-label.js'
import { noticeDecision, pendingClaimUrl, upgradeNoticeText, versionOf, versionProbeArgv } from '../lib/onboarding.js'
import { isPersonPrompt, promptTextOf, recallStrategy } from '../lib/recall.js'
import { DEFAULT_PROXY_PORT, proxyResultOf, proxySettingsFrom, timedOutResult, unreachableResult } from '../lib/proxy-response.js'
import { OUTBOX_TTL_MS, withQueued } from '../lib/report-outbox.js'
import { ABSENT, retentionOf } from '../lib/retention.js'
import { correctionReportOf, deliverPending, immediateReportOf, reportedReuseOf, retentionReportOf } from '../lib/reuse.js'
import { recallStatusOf, statusLineOf } from '../lib/status-line.js'
import { turnSummaryOf } from '../lib/turn-summary.js'
import { outcomeOfReason } from '../lib/turn-outcomes.js'
import { checkCommandOf, verificationFailed } from '../lib/verification.js'

type ProxyResult = { ok: true; data: any } | { ok: false; error: string }
type Check = { command: string; failed: boolean }
type TurnRecord = {
  reusedNames: string[]
  changedLines: number
  checks: Check[]
  commands: string[]
  paths: string[]
  edits: string[]
  editedBefore: Map<string, string>
}
type Report = ReturnType<typeof immediateReportOf>
type QueuedReport = { report: Report; sessionId: string }
type ReportedReuse = ReturnType<typeof reportedReuseOf>
type PendingRetention = { sessionId: string; projectDir: string; reuses: ReportedReuse[]; files: { path: string; before: string; after: string }[]; atMs: number }
type RecallMatch = { ids: string[]; name?: string; text: string }
type OpenAsset = { assetId: string; strategyText: string; turn: number; sessionId?: string }
type Candidate = ReturnType<typeof candidateOf>
type DueCandidate = { sessionId: string; candidate: Candidate }
type DistillOutcome = { status: string; error?: string; data?: unknown; usage?: unknown }

const NOTICES_KEY = 'notices'
const SIDECAR_TIMEOUT_MS = 90_000
const PROXY_TIMEOUT_MS = 8_000
const DISTILL_TIMEOUT_MS = 120_000
const CLI_TIMEOUT_MS = 10 * 60 * 1000
const UPGRADE_NOTICE_TTL_MS = 24 * 60 * 60 * 1000
const CLAIM_NOTICE_TTL_MS = 12 * 60 * 60 * 1000
const TURN_COUNTER_TTL_MS = 30 * 24 * 60 * 60 * 1000
const OUTBOX_KEY = 'reports:outbox'
const RETENTION_KEY = 'retention:pending'
const PATH_KEYS = ['file_path', 'notebook_path', 'path']
const WINDOWS_COMMAND_NOT_FOUND = 9009

const freshTurnRecord = (): TurnRecord => ({
  reusedNames: [],
  changedLines: 0,
  checks: [],
  commands: [],
  paths: [],
  edits: [],
  editedBefore: new Map(),
})

let turnRecord: TurnRecord = freshTurnRecord()
const personPrompts = new Set<string>()
const turnNumbers = new Map<string, number>()
const abortedTurns = new Set<string>()
const distillations = new Map<string, { outcome: Promise<DistillOutcome>; controller: AbortController }>()
const lastPrompts = new Map<string, string>()
let outboxWork: Promise<unknown> = Promise.resolve()
let outboxWrites: Promise<unknown> = Promise.resolve()
let stateWork: Promise<unknown> = Promise.resolve()

const turnCounterKey = (sessionId: string) => `turns:${sessionId}`
const labelableKey = (sessionId: string) => `labelable:${sessionId}`

function showRecallStatus($: EngineInterface, text: string | null): void {
  $.ui.status(statusLineOf([text]))
}

const ERRORS_KEY = 'errors'
const RECALLS_KEY = 'recalls'
const MAX_ERRORS = 10
const MAX_RECALLS = 10

// Background work and recall fail quietly so a turn never pays for them; the
// last failures are kept in the store so a silent seam can still be diagnosed.
async function recordFailure($: EngineInterface, where: string, error: unknown): Promise<void> {
  const at = new Date(await $.clock.now()).toISOString()
  const message = String((error as Error)?.stack ?? error).slice(0, 500)
  const kept = await $.store.get(ERRORS_KEY)
  await $.store.set(ERRORS_KEY, [...(Array.isArray(kept) ? kept : []), { at, where, message }].slice(-MAX_ERRORS))
}

// The status line is not drawn on every surface, so each recall decision is
// also kept, newest last, where it can be read back after the turn.
async function recordRecall($: EngineInterface, prompt: string, startedAt: number, trace: unknown): Promise<void> {
  const now = await $.clock.now()
  const entry = { at: new Date(now).toISOString(), prompt: prompt.slice(0, 60), elapsedMs: now - startedAt, trace }
  const kept = await $.store.get(RECALLS_KEY)
  await $.store.set(RECALLS_KEY, [...(Array.isArray(kept) ? kept : []), entry].slice(-MAX_RECALLS))
}

function quietly($: EngineInterface, where: string, work: Promise<unknown>): Promise<unknown> {
  return work.catch(error => recordFailure($, where, error).catch(() => undefined))
}

function track($: EngineInterface, where: string, work: Promise<unknown>): void {
  void quietly($, where, work)
}

async function homeDir($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
}

async function proxyFetch($: EngineInterface, options: PluginOptions, method: string, path: string, body?: unknown): Promise<ProxyResult> {
  const home = await homeDir($)
  const settingsText = home ? await $.fs.read(`${home}/.evolver/settings.json`).catch(() => '') : ''
  const port = String(options.proxy_port || (await $.env.get('EVOMAP_PROXY_PORT')) || DEFAULT_PROXY_PORT)
  const { url: base, token } = proxySettingsFrom(typeof settingsText === 'string' ? settingsText : '', port)
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const request = $.http
    .fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(response => proxyResultOf(response, base, token), error => unreachableResult(base, error))
  const deadline = $.clock.sleep(PROXY_TIMEOUT_MS).then(() => timedOutResult(base, PROXY_TIMEOUT_MS), () => timedOutResult(base, PROXY_TIMEOUT_MS))
  return Promise.race([request, deadline])
}

function proxyFetcher($: EngineInterface, options: PluginOptions) {
  return (method: string, path: string, body?: unknown) => proxyFetch($, options, method, path, body)
}

async function projectDirOf($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const stat = await $.fs.stat(cwd, { resolve: true }).catch(() => undefined)
  return stat?.realPath ?? cwd
}

// `$.session.turns()` counts only the person's prompts, so a turn a task
// notification starts would reuse the previous number and its reuse report
// would share that turn's task id, which the Hub drops as a duplicate. Every
// turn draws its own number from a per-session counter instead, kept past the
// session's end because `claude --resume` continues under the same id.
function turnCountOf(stored: unknown): number {
  const count = typeof stored === 'object' && stored !== null ? (stored as { turn?: unknown }).turn : stored
  return Number(count ?? 0) || 0
}

// A counter is only needed while its session may still be resumed; the store is capped at 4 MiB in all.
async function pruneTurnCounters($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('turns:')) continue
    const atMs = Number(((await $.store.get(key)) as { atMs?: unknown } | undefined)?.atMs)
    if (Number.isFinite(atMs) && now - atMs > TURN_COUNTER_TTL_MS) await $.store.delete(key)
  }
}

async function turnNumberFor($: EngineInterface, sessionId: string, turnId: string): Promise<number> {
  const known = turnNumbers.get(turnId)
  if (known !== undefined) return known
  const next = turnCountOf(await $.store.get(turnCounterKey(sessionId))) + 1
  await $.store.set(turnCounterKey(sessionId), { turn: next, atMs: await $.clock.now() })
  turnNumbers.set(turnId, next)
  return next
}

async function runSidecar($: EngineInterface, options: PluginOptions, command: string, request: unknown = {}): Promise<any> {
  const ran = await $.process.run(
    [String(options.node_path || 'node'), `${$.plugin.root}/bin/evolver-io.mjs`, command],
    { stdin: JSON.stringify(request), timeoutMs: SIDECAR_TIMEOUT_MS },
  )
  const answer = JSON.parse(ran.stdout || '{}')
  if (ran.exitCode !== 0 || answer.error) throw new Error(answer.error ?? `evolver-io ${command} exited ${ran.exitCode}`)
  return answer
}

// The ledger and candidate files are written by separate sidecar processes, so their order is this module's:
// a correction's drop never lands before the candidate it drops, nor a turn's report before its injection.
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const next = stateWork.catch(() => undefined).then(work)
  stateWork = next
  return next
}

function stateCall($: EngineInterface, options: PluginOptions, command: string, request: unknown = {}): Promise<any> {
  return inOrder(() => runSidecar($, options, command, request))
}

function reuseLedgers($: EngineInterface, options: PluginOptions) {
  return {
    proxyFetch: proxyFetcher($, options),
    recordLocally: async (request: unknown) => (await runSidecar($, options, 'record-reuse', request)).recorded === true,
    onRejected: (rejection: unknown) => recordFailure($, 'reuse-report-rejected', JSON.stringify(rejection)),
  }
}

async function noticeIsDue($: EngineInterface, key: string, ttlMs: number): Promise<boolean> {
  const { isDue, state } = noticeDecision(await $.store.get(NOTICES_KEY), key, ttlMs, await $.clock.now())
  if (isDue) await $.store.set(NOTICES_KEY, state)
  return isDue
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

async function showOnboardingNotices($: EngineInterface, options: PluginOptions): Promise<void> {
  const probe = await $.process.run(versionProbeArgv(await isWindows($)), { timeoutMs: 5_000 }).catch(() => null)
  const version = probe && probe.exitCode === 0 ? versionOf(probe.stdout) : null
  const upgrade = upgradeNoticeText(version)
  if (upgrade && (await noticeIsDue($, `evolver-version:${version}`, UPGRADE_NOTICE_TTL_MS))) $.ui.toast(upgrade)

  if (options.claim_nudge_enabled !== true) return
  const home = await homeDir($)
  const claimText = home ? await $.fs.read(`${home}/.evomap/claim_url`).catch(() => '') : ''
  const claimUrl = pendingClaimUrl(claimText)
  if (claimUrl && (await noticeIsDue($, `claim:${await sha256Hex(claimUrl)}`, CLAIM_NOTICE_TTL_MS))) {
    $.ui.toast(`Evolver node not connected to EvoMap yet — open ${claimUrl} while signed in to evomap.ai.`)
  }
}

async function injectStrategy($: EngineInterface, options: PluginOptions, sessionId: string, turn: number, match: RecallMatch): Promise<void> {
  if (!match.text) return
  turnRecord.reusedNames.push(match.name ?? match.ids.join(', '))
  await stateCall($, options, 'remember-injected', { sessionId, assetIds: match.ids, turn, strategyText: match.text })
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: match.text }] } })
}

// `turn.start` observes and holds no model call, so whatever this appends
// reaches the model from the turn's next step; the wait only decides whether
// the append happens here or once a slower recall lands in the background.
// Assets this session already saw are read off the ledger, so a hot reload does
// not re-inject them.
async function recallForTurn($: EngineInterface, options: PluginOptions, sessionId: string, turn: number, turnId: string, prompt: string, signal: AbortSignal): Promise<void> {
  if (options.recall_enabled === false) return
  const listedIds = new Set<string>((await stateCall($, options, 'listed-assets', { sessionId })).ids)
  const startedAt = await $.clock.now()
  const recall: Promise<RecallMatch> = recallStrategy(proxyFetcher($, options), promptTextOf(prompt), {
    listedIds,
    minSimilarity: Number(options.recall_min_similarity ?? 0.3),
    onTrace: (trace: unknown) => {
      showRecallStatus($, recallStatusOf(trace))
      track($, 'recall-trace', recordRecall($, prompt, startedAt, trace))
    },
  })
  const waitMs = Number(options.recall_wait_ms ?? 6_000)
  const inline = await Promise.race([recall, $.clock.sleep(waitMs).then(() => null)])
  if (signal.aborted) return
  if (inline) return injectStrategy($, options, sessionId, turn, inline)
  showRecallStatus($, recallStatusOf({ outcome: 'waiting', waitedMs: waitMs }))
  track($, 'late-recall', recall.then(late => {
    if (!abortedTurns.has(turnId)) return injectStrategy($, options, sessionId, turn, late)
    if (late.text) showRecallStatus($, recallStatusOf({ outcome: 'dropped' }))
  }))
}

function writeOutbox($: EngineInterface, change: (outbox: any, now: number) => unknown): Promise<unknown> {
  outboxWrites = outboxWrites.catch(() => undefined).then(async () => $.store.set(OUTBOX_KEY, change(await $.store.get(OUTBOX_KEY), await $.clock.now())))
  return outboxWrites
}

function enqueueReports($: EngineInterface, queued: QueuedReport[]): Promise<unknown> {
  return writeOutbox($, (outbox, now) => withQueued(outbox, queued, now))
}

// Delivery waits on the network, so a report queued meanwhile is merged with what was delivered, not overwritten.
function queueReports($: EngineInterface, options: PluginOptions, queued: QueuedReport[]): Promise<unknown> {
  const queuedNow = enqueueReports($, queued)
  outboxWork = outboxWork.catch(() => undefined).then(() => queuedNow).then(async () => {
    const delivered = await deliverPending(reuseLedgers($, options), (await $.store.get(OUTBOX_KEY)) ?? {}, await $.clock.now())
    await writeOutbox($, latest => ({ ...(latest ?? {}), ...delivered }))
  })
  return outboxWork
}

function reportsOf(assets: OpenAsset[], { sessionId, turn, turnReason, checks }: { sessionId: string; turn?: number; turnReason: string; checks: Check[] }): Report[] {
  return assets.map(asset => immediateReportOf({ asset, sessionId, turn: turn ?? asset.turn, turnReason, checks }))
}

async function closeTurnReuse($: EngineInterface, options: PluginOptions, sessionId: string, turn: number, end: { reason: string; answer: string }, finished: TurnRecord): Promise<Report[]> {
  const { assets: due } = await stateCall($, options, 'take-unreported', { sessionId, turn })
  const reports = reportsOf(due, { sessionId, turn, turnReason: end.reason, checks: finished.checks })
  await $.store.set(labelableKey(sessionId), reports.map(reportedReuseOf))
  return reports
}

// A strategy whose turn never ended is reported as aborted, with no evidence of its own.
function abortedReports(assets: OpenAsset[], sessionOf: (asset: OpenAsset) => string): QueuedReport[] {
  return assets.map(asset => {
    const sessionId = sessionOf(asset)
    return { report: reportsOf([asset], { sessionId, turnReason: 'aborted', checks: [] })[0]!, sessionId }
  })
}

// A session killed mid-turn (a closed terminal, a harness timeout) leaves its injections open; once the process
// that held them is gone, the next session start reports them. A session that is merely idle keeps its own.
async function reportOrphanedInjections($: EngineInterface, options: PluginOptions): Promise<void> {
  const { assets } = await stateCall($, options, 'take-orphaned-unreported')
  await queueReports($, options, abortedReports(assets, asset => asset.sessionId ?? 'unknown'))
}

async function contentHashOf($: EngineInterface, path: string): Promise<string> {
  const text = await $.fs.read(path).catch(() => null)
  return typeof text === 'string' ? sha256Hex(text) : ABSENT
}

async function pendingRetentions($: EngineInterface): Promise<PendingRetention[]> {
  const stored = await $.store.get(RETENTION_KEY)
  return Array.isArray(stored) ? (stored as PendingRetention[]) : []
}

async function rememberForRetention($: EngineInterface, sessionId: string, reuses: ReportedReuse[], editedBefore: Map<string, string>): Promise<void> {
  if (reuses.length === 0 || editedBefore.size === 0) return
  const files = await Promise.all([...editedBefore].map(async ([path, before]) => ({ path, before, after: await contentHashOf($, path) })))
  const entry: PendingRetention = { sessionId, projectDir: await projectDirOf($), reuses, files, atMs: await $.clock.now() }
  await $.store.set(RETENTION_KEY, [...(await pendingRetentions($)), entry])
}

async function retentionReportsOf($: EngineInterface, entry: PendingRetention): Promise<QueuedReport[]> {
  const files = await Promise.all(entry.files.map(async file => ({ ...file, now: await contentHashOf($, file.path) })))
  const verdict = retentionOf(files).class
  return entry.reuses
    .map(reuse => retentionReportOf(reuse, verdict))
    .filter(report => report !== null)
    .map(report => ({ report, sessionId: entry.sessionId }))
}

async function takeDueRetentions($: EngineInterface, sessionId: string): Promise<PendingRetention[]> {
  const pending = await pendingRetentions($)
  if (pending.length === 0) return []
  const projectDir = await projectDirOf($)
  const now = await $.clock.now()
  const isDue = (entry: PendingRetention) => entry.projectDir === projectDir && entry.sessionId !== sessionId
  await $.store.set(RETENTION_KEY, pending.filter(entry => !isDue(entry) && now - entry.atMs <= OUTBOX_TTL_MS))
  return pending.filter(isDue)
}

async function settleRetention($: EngineInterface, options: PluginOptions, sessionId: string): Promise<void> {
  const due = await takeDueRetentions($, sessionId)
  const queued = (await Promise.all(due.map(entry => retentionReportsOf($, entry)))).flat()
  await queueReports($, options, queued)
}

// The session's own model runs the distillation, outside its conversation. A candidate stays on disk until
// distilled (or given up), and one whose session is over — ended, or killed with its process — is claimed and
// retried by the next session that starts. One distillation per session runs at a time: a second request while
// the first runs shares its outcome.
async function settle($: EngineInterface, options: PluginOptions, due: DueCandidate, sent: boolean): Promise<void> {
  await stateCall($, options, 'settle-candidate', { ...due, sent }).catch(error => recordFailure($, 'settle-candidate', error))
}

async function distillOnce($: EngineInterface, options: PluginOptions, { sessionId, candidate }: DueCandidate, focus = ''): Promise<DistillOutcome> {
  const running = distillations.get(sessionId)
  if (running) return running.outcome
  const controller = new AbortController()
  const outcome = (async () => {
    const isCurrent = async () => (await stateCall($, options, 'is-current-candidate', { sessionId, candidate })).current === true
    const complete = (request: any, init?: { signal: AbortSignal }) => $.model.complete(request, init)
    const distilled = await distillCandidate({ proxyFetch: proxyFetcher($, options), complete, candidate, focus, timeoutMs: DISTILL_TIMEOUT_MS, cancel: controller.signal, isCurrent })
    await settle($, options, { sessionId, candidate }, distilled.status === 'sent')
    return distilled
  })().finally(() => distillations.delete(sessionId))
  distillations.set(sessionId, { outcome, controller })
  return outcome
}

async function distillSession($: EngineInterface, options: PluginOptions, sessionId: string, focus: string): Promise<DistillOutcome> {
  const { due } = await stateCall($, options, 'due-candidates', { sessionId })
  return due.length > 0 ? distillOnce($, options, due[0], focus) : { status: 'nothing' }
}

async function distillLeftovers($: EngineInterface, options: PluginOptions): Promise<void> {
  const { claimed } = await stateCall($, options, 'claim-leftover-candidates')
  await Promise.all(claimed.map((due: DueCandidate) => quietly($, 'distill', distillOnce($, options, due))))
}

/** The session's turn no longer deserves a Gene: its candidate goes, and a distillation already running stops. */
async function forgetCandidate($: EngineInterface, options: PluginOptions, sessionId: string): Promise<void> {
  await stateCall($, options, 'drop-candidate', { sessionId })
  distillations.get(sessionId)?.controller.abort()
}

// Queued at once, so a correction that follows the turn finds the candidate already written.
function rememberTurnCandidate($: EngineInterface, options: PluginOptions, sessionId: string, turn: number, end: { reason: string; answer: string }, finished: TurnRecord, reports: Report[]): Promise<void> {
  const record = { ...finished, answer: end.answer }
  if (skipReason(end.reason, record)) return Promise.resolve()
  const prompt = lastPrompts.get(sessionId)
  return inOrder(async () => {
    const candidate = candidateOf({ prompt, record, model: await $.session.model(), turn, now: await $.clock.now() })
    await runSidecar($, options, 'remember-candidate', { sessionId, candidate })
  })
}

// The next prompt is the only verdict on a turn available without asking anyone: when it reads as a correction,
// the reuse reports are revised and the turn is no longer worth distilling.
async function reportFollowUpLabel($: EngineInterface, options: PluginOptions, sessionId: string, prompt: string): Promise<void> {
  const label = feedbackLabelOf(promptTextOf(prompt))
  if (label === 'correction') await forgetCandidate($, options, sessionId)
  const reuses = ((await $.store.get(labelableKey(sessionId))) ?? []) as ReportedReuse[]
  if (reuses.length === 0) return
  await $.store.delete(labelableKey(sessionId))
  const reports = reuses.map(reuse => correctionReportOf(reuse, label)).filter(report => report !== null)
  await queueReports($, options, reports.map(report => ({ report, sessionId })))
}

function noteToolUse(input: Record<string, unknown>): void {
  if (typeof input.command === 'string') turnRecord.commands.push(input.command)
  for (const key of PATH_KEYS) if (typeof input[key] === 'string') turnRecord.paths.push(input[key] as string)
}

function noteEditedFile(input: Record<string, unknown>): void {
  const edited = editedPath(input)
  if (edited) turnRecord.edits.push(edited)
}

async function noteFileBeforeEdit($: EngineInterface, input: Record<string, unknown>): Promise<void> {
  const path = editedPath(input)
  if (!path || turnRecord.editedBefore.has(path)) return
  const before = await contentHashOf($, path)
  if (!turnRecord.editedBefore.has(path)) turnRecord.editedBefore.set(path, before)
}

// `$.process.run` takes no shell, so on Windows the `evolver` and `npx` shims run through cmd.exe, which
// reports a missing command by its exit code instead of failing to start.
function cliRunner($: EngineInterface) {
  return async (argv: string[]) => {
    const onWindows = await isWindows($)
    const ran = await $.process.run(onWindows ? ['cmd.exe', '/d', '/s', '/c', ...argv] : argv, { timeoutMs: CLI_TIMEOUT_MS })
      .catch((error: Error) => ({ exitCode: -1, stdout: '', stderr: String(error?.message ?? error), isMissing: !/time/i.test(String(error?.message)) }))
    const output = `${ran.stdout ?? ''}${ran.stderr ? `\n${ran.stderr}` : ''}`.trim()
    const isMissing = 'isMissing' in ran ? ran.isMissing : onWindows && ran.exitCode === WINDOWS_COMMAND_NOT_FOUND
    if (isMissing) return { error: { code: 'ENOENT', message: output }, output }
    return { error: ran.exitCode === 0 ? null : { message: `exited ${ran.exitCode}` }, output }
  }
}

async function proxyStatus($: EngineInterface, options: PluginOptions): Promise<unknown> {
  const answered = await proxyFetch($, options, 'GET', '/proxy/status')
  return {
    proxy: answered.ok ? answered.data : { error: answered.error },
    recentRecalls: (await $.store.get(RECALLS_KEY)) ?? [],
    recentErrors: (await $.store.get(ERRORS_KEY)) ?? [],
  }
}

function commandsFor($: EngineInterface, options: PluginOptions) {
  return evolverCommands({
    status: () => proxyStatus($, options),
    search: async (text: string) => {
      const answered = await proxyFetch($, options, 'POST', '/asset/search', { text, limit: 5 })
      return answered.ok ? { ok: true, data: answered.data } : { ok: false, error: answered.error }
    },
    distillNow: async (focus: string) => distillSession($, options, await $.session.id(), focus),
    evolveText: async () => String(await $.fs.read(`${$.plugin.root}/assets/commands/evolve.md`)),
    followup: async (text: string) => { void quietly($, 'evolve', $.prompt.submit({ text })) },
    runCli: (args: string[]) => runEvolverCli(args, cliRunner($)),
  })
}

async function registerCommands($: EngineInterface, options: PluginOptions): Promise<void> {
  for (const command of commandsFor($, options)) {
    const hint = 'argumentHint' in command ? { argumentHint: command.argumentHint } : {}
    await $.command.register({ name: command.name, description: command.description, ...hint })
  }
}

async function dropRetiredStoreLedgers($: EngineInterface): Promise<void> {
  for (const key of await $.store.keys()) if (key.startsWith('injected:')) await $.store.delete(key)
}

async function startSession($: EngineInterface, options: PluginOptions): Promise<void> {
  const sessionId = await $.session.id()
  await registerCommands($, options)
  track($, 'store-ledgers', dropRetiredStoreLedgers($))
  track($, 'turn-counters', pruneTurnCounters($))
  track($, 'onboarding', showOnboardingNotices($, options))
  track($, 'retention', settleRetention($, options, sessionId))
  track($, 'orphaned', reportOrphanedInjections($, options))
  void quietly($, 'distill', distillLeftovers($, options))
}

// `session.end` shares one short bound with every plugin's hook, so it only writes: the aborted reports wait in
// the outbox for the next delivery, and the closed candidate for the next session start.
async function endSession($: EngineInterface, options: PluginOptions, sessionId: string): Promise<void> {
  const closing = Promise.all([
    stateCall($, options, 'take-unreported', { sessionId }).then(({ assets }) => enqueueReports($, abortedReports(assets, () => sessionId))),
    stateCall($, options, 'close-candidate', { sessionId }),
    stateCall($, options, 'forget-session', { sessionId }),
  ])
  await quietly($, 'session-end', closing)
  await $.store.delete(labelableKey(sessionId))
  lastPrompts.delete(sessionId)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await startSession($, options)
    return next(e)
  })

  // `prompt.submit` knows who sent the prompt but resolves only after its turn
  // started, so the person's prompt is marked before `next`; `turn.start` then
  // recalls for it. A prompt folded into a running turn starts no turn.
  on('prompt.submit', async ($, e, next) => {
    if (!isPersonPrompt(e.origin)) return next(e)
    personPrompts.add(e.text)
    lastPrompts.set(await $.session.id(), promptTextOf(e.text))
    if (e.origin?.kind === 'composer') track($, 'follow-up', reportFollowUpLabel($, options, await $.session.id(), e.text))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (personPrompts.delete(e.text)) {
      const sessionId = await $.session.id()
      const turn = await turnNumberFor($, sessionId, e.turnId)
      await recallForTurn($, options, sessionId, turn, e.turnId, e.text, next.signal).catch(error => recordFailure($, 'recall', error))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    noteToolUse(e as Record<string, unknown>)
    const isEdit = EDIT_TOOL_NAMES.includes(e.tool)
    if (isEdit) await noteFileBeforeEdit($, e as Record<string, unknown>)
    const ran = await next(e)
    const checkCommand = ran.deny === undefined ? checkCommandOf(e) : null
    if (checkCommand) turnRecord.checks.push({ command: checkCommand.slice(0, 200), failed: verificationFailed(ran) })
    if (!isEdit || ran.deny !== undefined || ran.isError) return ran
    turnRecord.changedLines += changedLinesOf(e)
    noteEditedFile(e as Record<string, unknown>)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || !outcomeOfReason(e.reason)) return next(e)
    if (e.reason === 'aborted') abortedTurns.add(e.turnId)
    const sessionId = await $.session.id()
    const turn = await turnNumberFor($, sessionId, e.turnId)
    turnNumbers.delete(e.turnId)
    const finished = turnRecord
    turnRecord = freshTurnRecord()
    const reports = await closeTurnReuse($, options, sessionId, turn, e, finished).catch(async error => {
      await recordFailure($, 'reuse-report', error)
      return []
    })
    track($, 'reuse-report', queueReports($, options, reports.map(report => ({ report, sessionId }))))
    track($, 'retention', rememberForRetention($, sessionId, reports.map(reportedReuseOf), finished.editedBefore))
    track($, 'distill-candidate', rememberTurnCandidate($, options, sessionId, turn, e, finished, reports))
    const answered = await next(e)
    const summary = turnSummaryOf({ ...finished, lastCheck: finished.checks.at(-1), usage: e.usage })
    return summary ? { ...answered, text: summary } : answered
  })

  on('command.run', async ($, e, next) => {
    const command = commandsFor($, options).find(candidate => candidate.name === e.command)
    if (!command) return next(e)
    const { kind, text } = await command.handler({ rawInput: e.args })
    return kind === 'error' ? { text, exitCode: 1 } : { text }
  })

  on('session.end', async ($, e, next) => {
    await endSession($, options, e.sessionId)
    personPrompts.clear()
    turnNumbers.clear()
    abortedTurns.clear()
    return next(e)
  })
}
