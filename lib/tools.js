// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const MAX_RENDERED_FIELD_CHARS = 16_000;
const ACK_MAX_MESSAGE_IDS = 50;

function textList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim());
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function boundedText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return text.length <= MAX_RENDERED_FIELD_CHARS ? text : `${text.slice(0, MAX_RENDERED_FIELD_CHARS)}\n[truncated]`;
}

function renderAsset(asset) {
  const lines = [`## ${asset.type ?? 'Asset'} ${asset.asset_id ?? ''}`.trim()];
  if (asset.summary) lines.push('', boundedText(asset.summary));

  const strategy = textList(asset.strategy ?? asset.payload?.strategy ?? asset.gene?.strategy);
  if (strategy.length > 0) {
    lines.push('', 'Strategy:');
    strategy.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }

  const validation = textList(asset.validation ?? asset.payload?.validation ?? asset.capsule?.validation);
  if (validation.length > 0) {
    lines.push('', 'Validation — run these to confirm the change worked:');
    for (const check of validation) lines.push(`- ${check}`);
  }

  if (strategy.length === 0) {
    const content = boundedText(asset.content ?? asset.payload?.content ?? asset.payload);
    if (content) lines.push('', 'Reusable content:', content);
  }
  return lines.join('\n');
}

// Why the Proxy withheld an asset (absent, revoked, or a body that no longer
// hashes to its id) does not reach here, so the missing list is named without a
// guessed cause.
function renderFetched(value) {
  const assets = [value?.assets, value?.results, value?.payload?.results].find(Array.isArray) ?? [];
  const missing = [value?.missing, value?.payload?.missing].find(Array.isArray) ?? [];
  const parts = assets.map(renderAsset);
  if (missing.length > 0) parts.push(`Not retrievable: ${missing.join(', ')}. The Proxy did not report why.`);
  if (parts.length === 0) parts.push('No assets returned.');
  parts.push('After applying an asset and validating the result, call evolver_asset_reuse_result.');
  return parts.join('\n\n');
}

function renderJson(value) {
  return JSON.stringify(value, null, 2);
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return candidate;
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function nonEmptyArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must contain at least one item.`);
  return value;
}

function ackMessageIds(value) {
  const ids = nonEmptyArray(value, 'message_ids').map((id, index) => nonEmptyString(id, `message_ids[${index}]`));
  if (ids.length > ACK_MAX_MESSAGE_IDS) throw new Error(`message_ids must contain at most ${ACK_MAX_MESSAGE_IDS} ids.`);
  return ids;
}

const STRINGS = { type: 'array', items: { type: 'string' } };

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * @typedef {{ method: string, path: string, body?: unknown }} ProxyRequest
 * @typedef {{ name: string, description: string, inputSchema: Record<string, unknown>, request: (args: any) => ProxyRequest, render?: (data: any) => string }} EvolverTool
 */

export const REUSE_RESULT_TOOL = 'evolver_asset_reuse_result';

/** @type {EvolverTool[]} */
export const EVOLVER_TOOLS = [
  {
    name: 'evolver_status',
    description:
      'Get the EvoMap Proxy status: running state, node_id, pending inbound/outbound message counts, and last Hub sync time. Use this first to confirm the Proxy is up.',
    inputSchema: objectSchema({}),
    request: () => ({ method: 'GET', path: '/proxy/status' }),
  },
  {
    name: 'evolver_search_assets',
    description:
      'Search the EvoMap network for reusable evolution assets. Pass `signals` for literal signal/error tags and `text` for natural-language summary matching; optionally narrow with `kind`, `category`, or `gene`. A `degraded: true` response came from the local cache because the Hub was unavailable.',
    inputSchema: objectSchema({
      signals: { ...STRINGS, description: 'Signal keywords, error codes, or trigger tags; any may match.' },
      text: { type: 'string', description: 'Free-text task description matched against asset summaries.' },
      kind: { type: 'string', enum: ['Gene', 'Capsule', 'EvolutionEvent', 'AntiGene'], description: 'Restrict to one asset kind.' },
      category: { type: 'string', description: 'Gene category or EvolutionEvent intent.' },
      gene: { type: 'string', description: 'Return Capsules belonging to this gene id.' },
      limit: { type: 'integer', default: 5, description: 'Result count from 1 through 25.' },
    }),
    request: (args) => {
      if (!args.signals && !args.text && !args.kind && !args.category && !args.gene) {
        throw new Error('Provide at least one of signals, text, kind, category, or gene.');
      }
      if (args.signals !== undefined) nonEmptyArray(args.signals, 'signals');
      return {
        method: 'POST',
        path: '/asset/search',
        body: {
          signals: args.signals,
          text: args.text,
          kind: args.kind,
          category: args.category,
          gene: args.gene,
          limit: boundedInteger(args.limit, 5, 1, 25, 'limit'),
        },
      };
    },
  },
  {
    name: 'evolver_fetch_asset',
    description:
      'Fetch reusable content by asset id. The result presents each asset summary, strategy, validation, and a content fallback. After applying an asset, call evolver_asset_reuse_result with the verified outcome.',
    inputSchema: objectSchema({ asset_ids: STRINGS }, ['asset_ids']),
    request: (args) => ({ method: 'POST', path: '/asset/fetch', body: { asset_ids: nonEmptyArray(args.asset_ids, 'asset_ids') } }),
    render: renderFetched,
  },
  {
    name: 'evolver_publish_asset',
    description:
      'Publish Genes or Capsules to the EvoMap Hub for review. The Proxy queues them locally; poll `asset_submit_result` with evolver_poll for the decision.',
    inputSchema: objectSchema({
      assets: {
        type: 'array',
        items: objectSchema({
          type: { type: 'string', enum: ['Gene', 'Capsule'] },
          content: { type: 'string' },
          summary: { type: 'string' },
          signals: STRINGS,
        }, ['type', 'content']),
      },
    }, ['assets']),
    request: (args) => {
      for (const [index, asset] of nonEmptyArray(args.assets, 'assets').entries()) {
        nonEmptyString(asset?.content, `assets[${index}].content`);
      }
      return { method: 'POST', path: '/asset/submit', body: { assets: args.assets } };
    },
  },
  {
    name: REUSE_RESULT_TOOL,
    description:
      'Report the verified outcome after reusing a fetched asset. This closes the feedback loop, credits its author, and improves future ranking.',
    inputSchema: objectSchema({
      asset_id: { type: 'string', description: 'The reused asset id.' },
      outcome: { type: 'string', enum: ['success', 'failed', 'mismatched', 'stale', 'unsafe'] },
      reason: { type: 'string', description: 'Why the reuse produced this outcome.' },
      time_saved_seconds: { type: 'number', description: 'Estimated wall-clock seconds saved.' },
      task_id: { type: 'string', description: 'Caller-side task identity, when available.' },
    }, ['asset_id', 'outcome']),
    request: (args) => {
      nonEmptyString(args.asset_id, 'asset_id');
      if (args.time_saved_seconds !== undefined && (!Number.isFinite(args.time_saved_seconds) || args.time_saved_seconds < 0)) {
        throw new Error('time_saved_seconds must be a non-negative number.');
      }
      return {
        method: 'POST',
        path: '/asset/reuse-result',
        body: {
          asset_id: args.asset_id,
          outcome: args.outcome,
          reason: args.reason,
          time_saved_seconds: args.time_saved_seconds,
          task_id: args.task_id,
        },
      };
    },
  },
  {
    name: 'evolver_distill_conversation',
    description:
      'Distill a concrete, verified capability from this conversation. Include reproducible strategy and validation evidence; persistence defaults on, while Hub publication requires publish=true.',
    inputSchema: objectSchema({
      summary: { type: 'string', description: 'What was solved and under which conditions.' },
      title: { type: 'string', description: 'Short capability name.' },
      strategy: { ...STRINGS, description: 'Reproducible implementation steps.' },
      validation: { ...STRINGS, description: 'Checks that proved the result.' },
      artifacts: { ...STRINGS, description: 'Files or paths produced.' },
      signals: { ...STRINGS, description: 'Signal keywords this generalizes.' },
      persist: { type: 'boolean', default: true, description: 'Keep the distilled asset locally; defaults to true.' },
      publish: { type: 'boolean', default: false, description: 'Submit it to the Hub; defaults to false.' },
    }, ['summary']),
    request: (args) => {
      nonEmptyString(args.summary, 'summary');
      if (args.strategy !== undefined) nonEmptyArray(args.strategy, 'strategy');
      if (args.validation !== undefined) nonEmptyArray(args.validation, 'validation');
      return {
        method: 'POST',
        path: '/conversation/distill',
        body: {
          platform: 'claude-code',
          title: args.title,
          summary: args.summary,
          strategy: args.strategy,
          validation: args.validation,
          artifacts: args.artifacts,
          signals: args.signals,
          persist: args.persist !== false,
          publish: args.publish === true,
        },
      };
    },
  },
  {
    name: 'evolver_poll',
    description:
      'Poll the local mailbox by optional message type. Polling does not consume: the same messages come back on every call until evolver_ack retires them by id.',
    inputSchema: objectSchema({
      type: { type: 'string', description: 'Message type filter, for example asset_submit_result.' },
      limit: { type: 'integer', default: 10, description: 'Result count from 1 through 50.' },
    }),
    request: (args) => ({
      method: 'POST',
      path: '/mailbox/poll',
      body: { type: args.type, limit: boundedInteger(args.limit, 10, 1, 50, 'limit') },
    }),
  },
  {
    name: 'evolver_ack',
    description:
      'Acknowledge mailbox messages by id so evolver_poll stops returning them. Pass the ids from a previous evolver_poll result once the messages have been acted on.',
    inputSchema: objectSchema({ message_ids: { ...STRINGS, description: 'Message ids from a previous evolver_poll result.' } }, ['message_ids']),
    request: (args) => ({ method: 'POST', path: '/mailbox/ack', body: { message_ids: ackMessageIds(args.message_ids) } }),
  },
];

const ENGINE_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent']);

export function toolArguments(call) {
  return Object.fromEntries(Object.entries(call ?? {}).filter(([key]) => !ENGINE_KEYS.has(key)));
}

/** @returns {ProxyRequest} */
export function proxyRequestFor(tool, args) {
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(tool.inputSchema.properties ?? {}, key));
  if (unknown.length > 0) throw new Error(`Unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  return tool.request(args);
}

export function toolNamed(name) {
  return EVOLVER_TOOLS.find((tool) => tool.name === name) ?? null;
}

export function renderToolResult(tool, data) {
  return (tool.render ?? renderJson)(data);
}
