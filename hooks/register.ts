import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { EDIT_TOOL_NAMES, changedLinesOf, editedContent, editedPath } from '../lib/edited-content.js'
import { looksLikeCorrection } from '../lib/dissatisfaction.js'
import {
  correctableAssets,
  unreportedAssets,
  withCorrected,
  withInjected,
  withModelReport,
  withReported,
  withUnverified,
} from '../lib/injected-ledger.js'
import { noticeDecision, pendingClaimUrl, upgradeNoticeText, versionOf, versionProbeArgv } from '../lib/onboarding.js'
import { isPersonPrompt, promptTextOf, recallStrategy } from '../lib/recall.js'
import { DEFAULT_PROXY_PORT, proxyResultOf, proxySettingsFrom, timedOutResult, unreachableResult } from '../lib/proxy-response.js'
import { reportInjectedReuse, reportReuseCorrection, reuseStatusOf } from '../lib/reuse.js'
import { detectSignals } from '../lib/signals.js'
import { captureStatusOf, recallStatusOf, statusLineOf } from '../lib/status-line.js'
import { turnSummaryOf } from '../lib/turn-summary.js'
import { EVOLVER_TOOLS, REUSE_RESULT_TOOL, proxyRequestFor, renderToolResult, toolArguments, toolNamed } from '../lib/tools.js'
import { outcomeOfReason } from '../lib/turn-outcomes.js'
import { checkCommandOf, verificationFailed } from '../lib/verification.js'

type ProxyResult = { ok: true; data: any } | { ok: false; error: string }
type Ledger = Record<string, { turn: number; injectedAt: number; outcome?: string; corrected?: boolean }>
type LastCheck = { command: string; failed: boolean }
type TurnRecord = { signals: Set<string>; notices: Set<string>; reusedNames: string[]; changedLines: number; lastCheck?: LastCheck }

const TOOL_PREFIX = 'mcp__evolver-mods__'
const NOTICES_KEY = 'notices'
const SIDECAR_TIMEOUT_MS = 90_000
const PROXY_TIMEOUT_MS = 8_000
const UPGRADE_NOTICE_TTL_MS = 24 * 60 * 60 * 1000
const CLAIM_NOTICE_TTL_MS = 12 * 60 * 60 * 1000

const freshTurnRecord = (): TurnRecord => ({ signals: new Set(), notices: new Set(), reusedNames: [], changedLines: 0 })

let turnRecord: TurnRecord = freshTurnRecord()
const personPrompts = new Set<string>()
const turnNumbers = new Map<string, number>()
const abortedTurns = new Set<string>()
const statusParts: { recall: string | null; capture: string | null } = { recall: null, capture: null }
const pendingWork = new Set<Promise<unknown>>()

const ledgerKey = (sessionId: string) => `injected:${sessionId}`
const turnCounterKey = (sessionId: string) => `turns:${sessionId}`

function showStatus($: EngineInterface, part: 'recall' | 'capture', text: string | null): void {
  statusParts[part] = text
  $.ui.status(statusLineOf([statusParts.recall, statusParts.capture]))
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
// notification starts would reuse the previous number and its capture would be
// dropped as a duplicate. Every turn draws its own number from a per-session
// counter instead.
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

async function injectStrategy($: EngineInterface, sessionId: string, turn: number, match: { ids: string[]; name?: string; text: string }): Promise<void> {
  if (!match.text) return
  turnRecord.reusedNames.push(match.name ?? match.ids.join(', '))
  await updateLedger($, sessionId, (ledger, now) => match.ids.reduce((next, id) => withInjected(next, id, turn, now), ledger))
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
  const recall = recallStrategy(fetcher, promptTextOf(prompt), {
    listedIds,
    minSimilarity: Number(options.recall_min_similarity ?? 0.3),
    onTrace: (trace: unknown) => {
      showStatus($, 'recall', recallStatusOf(trace))
      track($, 'recall-trace', recordRecall($, prompt, startedAt, trace))
    },
  })
  const waitMs = Number(options.recall_wait_ms ?? 6_000)
  const inline = await Promise.race([recall, $.clock.sleep(waitMs).then(() => null)])
  if (signal.aborted) return
  if (inline) return injectStrategy($, sessionId, turn, inline)
  showStatus($, 'recall', recallStatusOf({ outcome: 'waiting', waitedMs: waitMs }))
  track($, 'late-recall', recall.then(late => {
    if (!abortedTurns.has(turnId)) return injectStrategy($, sessionId, turn, late)
    if (late.text) showStatus($, 'recall', recallStatusOf({ outcome: 'dropped' }))
  }))
}

// Only a prompt that plainly says the last answer did not hold revises a
// verdict, and each asset at most once: the Hub counts every report.
async function correctEarlierVerdicts($: EngineInterface, options: PluginOptions, sessionId: string, prompt: string): Promise<void> {
  if (!looksLikeCorrection(prompt)) return
  const assets = correctableAssets(await readLedger($, sessionId))
  if (assets.length === 0) return
  const corrected = await reportReuseCorrection(reuseLedgers($, options), { assets, sessionId })
  await updateLedger($, sessionId, (ledger, now) => corrected.reduce((next: Ledger, id: string) => withCorrected(next, id, now), ledger))
}

async function reportTurnReuse($: EngineInterface, options: PluginOptions, sessionId: string, turn: number, lastCheck: LastCheck | undefined): Promise<void> {
  const status = reuseStatusOf(lastCheck)
  const due = unreportedAssets(await readLedger($, sessionId)).filter((entry: { turn: number }) => entry.turn <= turn)
  if (status === null) {
    await updateLedger($, sessionId, (ledger, now) => due.reduce((next: Ledger, entry: { assetId: string }) => withUnverified(next, entry.assetId, now), ledger))
    return
  }
  for (const injectedTurn of new Set(due.map((entry: { turn: number }) => entry.turn))) {
    const assetIds = due.filter((entry: { turn: number }) => entry.turn === injectedTurn).map((entry: { assetId: string }) => entry.assetId)
    const reported = await reportInjectedReuse(reuseLedgers($, options), { assetIds, lastCheck, turn: injectedTurn, sessionId })
    await updateLedger($, sessionId, (ledger, now) => reported.reduce((next: Ledger, id: string) => withReported(next, id, status, now), ledger))
  }
}

async function captureTurn($: EngineInterface, options: PluginOptions, request: Record<string, unknown>): Promise<void> {
  const { receipt } = await runSidecar($, options, 'capture', request)
  showStatus($, 'capture', captureStatusOf(receipt))
}

function signalNotice(input: Record<string, unknown>): string | null {
  const signals = detectSignals(editedContent(input))
  if (signals.length === 0) return null
  signals.forEach(signal => turnRecord.signals.add(signal))
  const where = editedPath(input) || 'edited file'
  const noticeKey = `${where}\0${signals.join(',')}`
  if (turnRecord.notices.has(noticeKey)) return null
  turnRecord.notices.add(noticeKey)
  return `[Evolution Signal] Detected: [${signals.join(', ')}] in ${where}. This will be attached to the turn outcome.`
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
  if (name === REUSE_RESULT_TOOL && answered.data?.recorded !== false) {
    const sessionId = await $.session.id()
    const outcome = typeof input.outcome === 'string' && input.outcome ? input.outcome : 'success'
    await updateLedger($, sessionId, (ledger, now) => withModelReport(ledger, String(input.asset_id), outcome, now))
  }
  return { result: renderToolResult(tool, answered.data) }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    for (const tool of EVOLVER_TOOLS) {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    }
    track($, 'onboarding', showOnboardingNotices($, options))
    return next(e)
  })

  // `prompt.submit` knows who sent the prompt but resolves only after its turn
  // started, so the person's prompt is marked before `next`; `turn.start` then
  // recalls for it. A prompt folded into a running turn starts no turn and is
  // only checked for a correction.
  on('prompt.submit', async ($, e, next) => {
    if (!isPersonPrompt(e.origin)) return next(e)
    personPrompts.add(e.text)
    track($, 'correction', correctEarlierVerdicts($, options, await $.session.id(), e.text))
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
    const ran = await next(e)
    const checkCommand = ran.deny === undefined ? checkCommandOf(e) : null
    if (checkCommand) turnRecord.lastCheck = { command: checkCommand.slice(0, 200), failed: verificationFailed(ran) }
    if (!EDIT_TOOL_NAMES.includes(e.tool) || ran.deny !== undefined || ran.isError) return ran
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
    const projectDir = await projectDirOf($)
    const finished = turnRecord
    turnRecord = freshTurnRecord()
    track($, 'reuse-report', reportTurnReuse($, options, sessionId, turn, finished.lastCheck))
    track($, 'capture', captureTurn($, options, { projectDir, turnReason: e.reason, sessionId, turn, observedSignals: [...finished.signals] }))
    const answered = await next(e)
    const summary = turnSummaryOf({ ...finished, usage: e.usage })
    return summary ? { ...answered, text: summary } : answered
  })

  on('session.end', async ($, e, next) => {
    await Promise.all(pendingWork)
    await $.store.delete(ledgerKey(e.sessionId))
    await $.store.delete(turnCounterKey(e.sessionId))
    personPrompts.clear()
    turnNumbers.clear()
    abortedTurns.clear()
    return next(e)
  })
}
