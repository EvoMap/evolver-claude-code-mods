import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { appliedVerdictOf } from '../lib/applied.js'
import { EDIT_TOOL_NAMES, changedLinesOf, editedContent, editedPath } from '../lib/edited-content.js'
import { feedbackLabelOf } from '../lib/feedback-label.js'
import { unreportedAssets, withInjected, withReported } from '../lib/injected-ledger.js'
import { noticeDecision, pendingClaimUrl, upgradeNoticeText, versionOf, versionProbeArgv } from '../lib/onboarding.js'
import { isPersonPrompt, promptTextOf, recallStrategy } from '../lib/recall.js'
import { DEFAULT_PROXY_PORT, proxyResultOf, proxySettingsFrom, timedOutResult, unreachableResult } from '../lib/proxy-response.js'
import { OUTBOX_TTL_MS, withQueued } from '../lib/report-outbox.js'
import { ABSENT, retentionOf } from '../lib/retention.js'
import { correctionReportOf, deliverPending, immediateReportOf, reportedReuseOf, retentionReportOf } from '../lib/reuse.js'
import { detectSignals } from '../lib/signals.js'
import { recallStatusOf, statusLineOf } from '../lib/status-line.js'
import { turnSummaryOf } from '../lib/turn-summary.js'
import { EVOLVER_TOOLS, REUSE_RESULT_TOOL, proxyRequestFor, renderToolResult, toolArguments, toolNamed } from '../lib/tools.js'
import { outcomeOfReason } from '../lib/turn-outcomes.js'
import { checkCommandOf, verificationFailed } from '../lib/verification.js'

type ProxyResult = { ok: true; data: any } | { ok: false; error: string }
type Ledger = Record<string, { turn: number; injectedAt: number; strategyText?: string; reportedAt?: number }>
type Check = { command: string; failed: boolean }
type TurnRecord = {
  notices: Set<string>
  reusedNames: string[]
  changedLines: number
  checks: Check[]
  commands: string[]
  paths: string[]
  editedBefore: Map<string, string>
}
type Report = ReturnType<typeof immediateReportOf>
type QueuedReport = { report: Report; sessionId: string }
type ReportedReuse = ReturnType<typeof reportedReuseOf>
type PendingRetention = { sessionId: string; projectDir: string; reuses: ReportedReuse[]; files: { path: string; before: string; after: string }[]; atMs: number }
type RecallMatch = { ids: string[]; name?: string; text: string }

const TOOL_PREFIX = 'mcp__evolver-mods__'
const NOTICES_KEY = 'notices'
const SIDECAR_TIMEOUT_MS = 90_000
const PROXY_TIMEOUT_MS = 8_000
const UPGRADE_NOTICE_TTL_MS = 24 * 60 * 60 * 1000
const CLAIM_NOTICE_TTL_MS = 12 * 60 * 60 * 1000
const OUTBOX_KEY = 'reports:outbox'
const RETENTION_KEY = 'retention:pending'
const PATH_KEYS = ['file_path', 'notebook_path', 'path']

const freshTurnRecord = (): TurnRecord => ({
  notices: new Set(),
  reusedNames: [],
  changedLines: 0,
  checks: [],
  commands: [],
  paths: [],
  editedBefore: new Map(),
})

let turnRecord: TurnRecord = freshTurnRecord()
const personPrompts = new Set<string>()
const turnNumbers = new Map<string, number>()
const abortedTurns = new Set<string>()
const pendingWork = new Set<Promise<unknown>>()
let outboxWork: Promise<unknown> = Promise.resolve()

const ledgerKey = (sessionId: string) => `injected:${sessionId}`
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

function track($: EngineInterface, where: string, work: Promise<unknown>): void {
  const settled = work.catch(error => recordFailure($, where, error).catch(() => undefined)).finally(() => pendingWork.delete(settled))
  pendingWork.add(settled)
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

async function projectDirOf($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const stat = await $.fs.stat(cwd, { resolve: true }).catch(() => undefined)
  return stat?.realPath ?? cwd
}

// `$.session.turns()` counts only the person's prompts, so a turn a task
// notification starts would reuse the previous number and its reuse report
// would share that turn's task id, which the Hub drops as a duplicate. Every
// turn draws its own number from a per-session counter instead.
async function turnNumberFor($: EngineInterface, sessionId: string, turnId: string): Promise<number> {
  const known = turnNumbers.get(turnId)
  if (known !== undefined) return known
  const next = Number((await $.store.get(turnCounterKey(sessionId))) ?? 0) + 1
  await $.store.set(turnCounterKey(sessionId), next)
  turnNumbers.set(turnId, next)
  return next
}

async function runSidecar($: EngineInterface, options: PluginOptions, command: string, request: unknown): Promise<any> {
  const ran = await $.process.run(
    [String(options.node_path || 'node'), `${$.plugin.root}/bin/evolver-io.mjs`, command],
    { stdin: JSON.stringify(request), timeoutMs: SIDECAR_TIMEOUT_MS },
  )
  const answer = JSON.parse(ran.stdout || '{}')
  if (ran.exitCode !== 0 || answer.error) throw new Error(answer.error ?? `evolver-io ${command} exited ${ran.exitCode}`)
  return answer
}

async function readLedger($: EngineInterface, sessionId: string): Promise<Ledger> {
  const stored = await $.store.get(ledgerKey(sessionId))
  return stored && typeof stored === 'object' ? (stored as Ledger) : {}
}

async function updateLedger($: EngineInterface, sessionId: string, change: (ledger: Ledger, now: number) => Ledger): Promise<void> {
  const now = await $.clock.now()
  await $.store.set(ledgerKey(sessionId), change(await readLedger($, sessionId), now))
}

function reuseLedgers($: EngineInterface, options: PluginOptions) {
  return {
    proxyFetch: (method: string, path: string, body?: unknown) => proxyFetch($, options, method, path, body),
    recordLocally: async (request: unknown) => (await runSidecar($, options, 'record-reuse', request)).recorded === true,
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

async function showOnboardingNotices($: EngineInterface, options: PluginOptions): Promise<void> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const probe = await $.process.run(versionProbeArgv(isWindows), { timeoutMs: 5_000 }).catch(() => null)
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

async function injectStrategy($: EngineInterface, sessionId: string, turn: number, match: RecallMatch): Promise<void> {
  if (!match.text) return
  turnRecord.reusedNames.push(match.name ?? match.ids.join(', '))
  const injection = { turn, strategyText: match.text }
  await updateLedger($, sessionId, (ledger, now) => match.ids.reduce((next, id) => withInjected(next, id, injection, now), ledger))
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: match.text }] } })
}

// `turn.start` observes and holds no model call, so whatever this appends
// reaches the model from the turn's next step; the wait only decides whether
// the append happens here or once a slower recall lands in the background.
// Assets this session already saw are read off the ledger, so a hot reload does
// not re-inject them.
async function recallForTurn($: EngineInterface, options: PluginOptions, sessionId: string, turn: number, turnId: string, prompt: string, signal: AbortSignal): Promise<void> {
  if (options.recall_enabled === false) return
  const fetcher = (method: string, path: string, body?: unknown) => proxyFetch($, options, method, path, body)
  const listedIds = new Set(Object.keys(await readLedger($, sessionId)))
  const startedAt = await $.clock.now()
  const recall: Promise<RecallMatch> = recallStrategy(fetcher, promptTextOf(prompt), {
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
  if (inline) return injectStrategy($, sessionId, turn, inline)
  showRecallStatus($, recallStatusOf({ outcome: 'waiting', waitedMs: waitMs }))
  track($, 'late-recall', recall.then(late => {
    if (!abortedTurns.has(turnId)) return injectStrategy($, sessionId, turn, late)
    if (late.text) showRecallStatus($, recallStatusOf({ outcome: 'dropped' }))
  }))
}

function queueReports($: EngineInterface, options: PluginOptions, queued: QueuedReport[]): Promise<unknown> {
  outboxWork = outboxWork.catch(() => undefined).then(async () => {
    const now = await $.clock.now()
    const outbox = withQueued(await $.store.get(OUTBOX_KEY), queued, now)
    await $.store.set(OUTBOX_KEY, outbox)
    await $.store.set(OUTBOX_KEY, await deliverPending(reuseLedgers($, options), outbox, now))
  })
  return outboxWork
}

async function closeTurnReuse($: EngineInterface, sessionId: string, turn: number, end: { reason: string; answer: string }, finished: TurnRecord): Promise<Report[]> {
  const due = unreportedAssets(await readLedger($, sessionId), turn)
  const reports = due.map(asset => immediateReportOf({
    asset,
    sessionId,
    turn,
    turnReason: end.reason,
    checks: finished.checks,
    applied: appliedVerdictOf({ strategyText: asset.strategyText, commands: finished.commands, paths: finished.paths, answer: end.answer }).verdict,
  }))
  await updateLedger($, sessionId, (ledger, now) => withReported(ledger, due.map(asset => asset.assetId), now))
  await $.store.set(labelableKey(sessionId), reports.map(reportedReuseOf))
  return reports
}

async function reportFollowUpLabel($: EngineInterface, options: PluginOptions, sessionId: string, prompt: string): Promise<void> {
  const reuses = ((await $.store.get(labelableKey(sessionId))) ?? []) as ReportedReuse[]
  if (reuses.length === 0) return
  await $.store.delete(labelableKey(sessionId))
  const label = feedbackLabelOf(promptTextOf(prompt))
  const reports = reuses.map(reuse => correctionReportOf(reuse, label)).filter(report => report !== null)
  await queueReports($, options, reports.map(report => ({ report, sessionId })))
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

function signalNotice(input: Record<string, unknown>): string | null {
  const signals = detectSignals(editedContent(input))
  if (signals.length === 0) return null
  const where = editedPath(input) || 'edited file'
  const noticeKey = `${where}\0${signals.join(',')}`
  if (turnRecord.notices.has(noticeKey)) return null
  turnRecord.notices.add(noticeKey)
  return `[Evolution Signal] Detected: [${signals.join(', ')}] in ${where}.`
}

function noteToolUse(input: Record<string, unknown>): void {
  if (typeof input.command === 'string') turnRecord.commands.push(input.command)
  for (const key of PATH_KEYS) if (typeof input[key] === 'string') turnRecord.paths.push(input[key] as string)
}

async function noteFileBeforeEdit($: EngineInterface, input: Record<string, unknown>): Promise<void> {
  const path = editedPath(input)
  if (!path || turnRecord.editedBefore.has(path)) return
  const before = await contentHashOf($, path)
  if (!turnRecord.editedBefore.has(path)) turnRecord.editedBefore.set(path, before)
}

async function serveTool($: EngineInterface, options: PluginOptions, name: string, call: Record<string, unknown>) {
  const tool = toolNamed(name)
  if (!tool) return { isError: true as const, result: `Unknown Evolver tool: ${name}` }
  const input = toolArguments(call)
  let request
  try {
    request = proxyRequestFor(tool, input)
  } catch (error) {
    return { isError: true as const, result: String((error as Error).message) }
  }
  const answered = await proxyFetch($, options, request.method, request.path, request.body)
  if (!answered.ok) return { isError: true as const, result: answered.error }
  return { result: renderToolResult(tool, answered.data) }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    for (const tool of EVOLVER_TOOLS) {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    }
    track($, 'onboarding', showOnboardingNotices($, options))
    track($, 'retention', settleRetention($, options, await $.session.id()))
    return next(e)
  })

  // `prompt.submit` knows who sent the prompt but resolves only after its turn
  // started, so the person's prompt is marked before `next`; `turn.start` then
  // recalls for it. A prompt folded into a running turn starts no turn.
  on('prompt.submit', async ($, e, next) => {
    if (!isPersonPrompt(e.origin)) return next(e)
    personPrompts.add(e.text)
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
    if (e.tool.startsWith(TOOL_PREFIX)) return serveTool($, options, e.tool.slice(TOOL_PREFIX.length), e as Record<string, unknown>)
    noteToolUse(e as Record<string, unknown>)
    const isEdit = EDIT_TOOL_NAMES.includes(e.tool)
    if (isEdit) await noteFileBeforeEdit($, e as Record<string, unknown>)
    const ran = await next(e)
    const checkCommand = ran.deny === undefined ? checkCommandOf(e) : null
    if (checkCommand) turnRecord.checks.push({ command: checkCommand.slice(0, 200), failed: verificationFailed(ran) })
    if (!isEdit || ran.deny !== undefined || ran.isError) return ran
    turnRecord.changedLines += changedLinesOf(e)
    const notice = signalNotice(e as Record<string, unknown>)
    return notice ? { ...ran, context: [...(ran.context ?? []), notice] } : ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || !outcomeOfReason(e.reason)) return next(e)
    if (e.reason === 'aborted') abortedTurns.add(e.turnId)
    const sessionId = await $.session.id()
    const turn = await turnNumberFor($, sessionId, e.turnId)
    turnNumbers.delete(e.turnId)
    const finished = turnRecord
    turnRecord = freshTurnRecord()
    const reports = await closeTurnReuse($, sessionId, turn, e, finished).catch(async error => {
      await recordFailure($, 'reuse-report', error)
      return []
    })
    track($, 'reuse-report', queueReports($, options, reports.map(report => ({ report, sessionId }))))
    track($, 'retention', rememberForRetention($, sessionId, reports.map(reportedReuseOf), finished.editedBefore))
    const answered = await next(e)
    const summary = turnSummaryOf({ ...finished, lastCheck: finished.checks.at(-1), usage: e.usage })
    return summary ? { ...answered, text: summary } : answered
  })

  on('session.end', async ($, e, next) => {
    await Promise.all(pendingWork)
    await $.store.delete(ledgerKey(e.sessionId))
    await $.store.delete(turnCounterKey(e.sessionId))
    await $.store.delete(labelableKey(e.sessionId))
    personPrompts.clear()
    turnNumbers.clear()
    abortedTurns.clear()
    return next(e)
  })
}
