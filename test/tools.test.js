import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EVOLVER_TOOLS, renderToolResult, toolNamed } from '../lib/tools.js';

const request = (name, args) => toolNamed(name).request(args);

test('registers the complete Proxy-supported tool surface', () => {
  assert.deepEqual(EVOLVER_TOOLS.map((tool) => tool.name).sort(), [
    'evolver_ack',
    'evolver_asset_reuse_result',
    'evolver_distill_conversation',
    'evolver_fetch_asset',
    'evolver_poll',
    'evolver_publish_asset',
    'evolver_search_assets',
    'evolver_status',
  ]);
});

test('every input schema is a closed JSON Schema object', () => {
  for (const tool of EVOLVER_TOOLS) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
});

test('rejects empty and out-of-range tool arguments before reaching the Proxy', () => {
  assert.throws(() => request('evolver_search_assets', {}), /Provide at least one/);
  assert.throws(() => request('evolver_search_assets', { text: 'task', limit: 26 }), /1 through 25/);
  assert.throws(() => request('evolver_fetch_asset', { asset_ids: [] }), /at least one/);
  assert.throws(() => request('evolver_publish_asset', { assets: [] }), /at least one/);
  assert.throws(
    () => request('evolver_asset_reuse_result', { asset_id: 'sha256:abc', outcome: 'success', time_saved_seconds: -1 }),
    /non-negative/,
  );
  assert.throws(() => request('evolver_poll', { limit: 0 }), /1 through 50/);
});

test('conversation distillation persists locally by default and publishes only when asked', () => {
  const { path, body } = request('evolver_distill_conversation', { summary: 'A concrete verified result.' });
  assert.equal(path, '/conversation/distill');
  assert.equal(body.platform, 'claude-code');
  assert.equal(body.persist, true);
  assert.equal(body.publish, false);
});

test('evolver_ack retires polled messages by trimmed id and refuses bad lists', () => {
  assert.deepEqual(request('evolver_ack', { message_ids: ['m1', ' m2 '] }), {
    method: 'POST',
    path: '/mailbox/ack',
    body: { message_ids: ['m1', 'm2'] },
  });
  assert.throws(() => request('evolver_ack', { message_ids: ['  '] }), /non-empty string/);
  assert.throws(() => request('evolver_ack', { message_ids: Array.from({ length: 51 }, (_, i) => `m${i}`) }), /at most 50/);
});

test('a real Proxy fetch response renders as the part worth reusing', () => {
  const envelope = JSON.parse(readFileSync(new URL('./fixtures/asset-fetch.proxy.json', import.meta.url), 'utf8'));
  const text = renderToolResult(toolNamed('evolver_fetch_asset'), envelope);
  const [asset] = envelope.assets;

  assert.match(text, new RegExp(`## Gene ${asset.asset_id}`));
  assert.match(text, /Validation — run these to confirm/);
  assert.match(text, /Not retrievable: sha256:gone/);
  assert.doesNotMatch(text, /signals_match|source_node_id|gdi_score/);
});

test('a tool without its own renderer answers with the JSON body', () => {
  assert.equal(renderToolResult(toolNamed('evolver_status'), { running: true }), '{\n  "running": true\n}');
});

test('engine keys are stripped and unknown arguments rejected before the Proxy', async () => {
  const { proxyRequestFor, toolArguments } = await import('../lib/tools.js');
  const args = toolArguments({ tool: 'mcp__evolver-mods__evolver_poll', tool_use_id: 't', agentId: 'a', consent: 'c', limit: 3 });
  assert.deepEqual(args, { limit: 3 });
  assert.equal(proxyRequestFor(toolNamed('evolver_poll'), args).body.limit, 3);
  assert.throws(() => proxyRequestFor(toolNamed('evolver_search_assets'), { qurey: 'typo' }), /Unknown argument: qurey/);
});
