import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import vm from 'node:vm';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-orgx-output-'));
process.env.TRAIL_HOME = home;
process.env.TRAIL_NO_KEYCHAIN = '1';
process.env.TRAIL_NO_OPEN = '1';
process.env.ORGX_API_KEY = 'oxk_test_output_observations';
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { readClaude, readCodex } = await import('../src/adapters.mjs');
const { threadify } = await import('../src/classify.mjs');
const { observeOrgxResult, orgxArtifactRefs } = await import('../src/orgx-outputs.mjs');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-10-23T12:00:00.000Z';
const completed = '2026-10-23T12:01:00.000Z';
const ref = (id = A, tool = 'orgx_update_work') => ({ artifact_id: id, tool, observed_at: completed });
const row = (type, content, timestamp = stamp) => JSON.stringify({ type, timestamp, cwd: '/workspace/client', message: { content } });
const ask = text => row('user', text);
const call = (name = 'mcp__orgx__orgx_update_work', id = 'attach') => row('assistant', [{ type: 'tool_use', id, name, input: { artifact: { name: 'Private title' } } }]);
const ack = (body = { artifact: { id: A } }, id = 'attach', extra = {}) => row('user', [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(body), ...extra }], completed);
const claude = lines => readClaude(null, { lines });
const hasWall = session => threadify(session).walls.some(w => w.sig === 'orgx-context-unavailable');

// All observations below go through the real transcript reader and thread spans.
test('Claude binds an explicit attachment acknowledgment to its tool-owning thread, even after a newer ask', async () => {
  const session = await claude([ask('Prepare the client deck'), call(), ask('Now investigate a separate pricing question'), ack({ data: { artifact: { id: A } } })]);
  const threads = threadify(session).threads;
  assert.equal(threads.length, 2);
  assert.deepEqual(threads[0].orgx_artifacts, [ref()]);
  assert.equal(threads[1].orgx_artifacts, undefined);
  assert.equal(threads[0].claim.length, 0, 'an observed response adds no shipped or accepted claim');
  assert.equal(session.ev.find(e => e.orgx_artifact).completedAt, completed);
});

test('inspect results, shell output, request arguments and agent prose cannot manufacture attachment observations', async () => {
  for (const name of ['mcp__orgx__orgx_inspect', 'mcp__orgx__orgx_search', 'Bash', 'functions.exec']) {
    const session = await claude([ask('Review the current work'), call(name), ack(), row('assistant', `I attached the artifact https://useorgx.com/artifacts/${A}`)]);
    assert.equal(session.ev.some(e => e.orgx_artifact), false, name);
    assert.equal(threadify(session).threads.some(t => t.orgx_artifacts), false, name);
  }
  const pending = await claude([ask('Attach the deck'), call()]);
  assert.equal(pending.ev.some(e => e.orgx_artifact), false, 'the request itself supplies no acknowledgment');
});

test('only an actual failed OrgX context call creates the named context wall', async () => {
  for (const name of ['mcp__orgx__orgx_bootstrap', 'mcp__orgx__orgx_get_workspace_context', 'mcp__orgx__get_task_with_context']) {
    assert.equal(hasWall(await claude([ask('Review the business plan'), call(name), ack({ isError: true, error: 'OrgX API is not configured' })])), true, name);
  }
  for (const name of ['Bash', 'mcp__other__get_task_with_context', 'mcp__orgx__orgx_inspect']) {
    assert.equal(hasWall(await claude([ask('Review the business plan'), call(name), ack({ error: 'OrgX context was unavailable' }, 'attach', { is_error: true })])), false, name);
  }
  assert.equal(hasWall(await claude([ask('Review the business plan'), call('mcp__orgx__orgx_bootstrap'), ack({ context: {}, note: 'No team was recorded; context is empty.' })])), false);
  assert.equal(hasWall(await claude([ask('Review the business plan'), row('assistant', 'OrgX context was unavailable, according to the earlier conversation.') ])), false);
});

test('errors, ambiguous responses, invalid identifiers and prose-wrapped JSON do not produce links', async () => {
  const cases = [
    { isError: true, structuredContent: { artifact: { id: A } } },
    { ok: false, artifact: { id: A } },
    { artifact: { id: 'javascript:alert(1)' } },
    { artifact: { id: [A] } },
    { artifact: { id: { value: A } } },
    { artifact_id: A },
    { id: A },
    { artifact: { id: A }, data: { artifact: { id: B } } },
  ];
  for (const body of cases) assert.equal((await claude([ask('Attach the deck'), call(), ack(body)])).ev.some(e => e.orgx_artifact), false, JSON.stringify(body));
  const session = await claude([ask('Attach the deck'), call(), row('user', [{ type: 'tool_result', tool_use_id: 'attach', content: `Saved it: ${JSON.stringify({ artifact: { id: A } })}` }], completed)]);
  assert.equal(session.ev.some(e => e.orgx_artifact), false);
  assert.equal((await claude([ask('Attach the deck'), call(), ack({ artifact: { id: A } }, 'attach', { is_error: true })])).ev.some(e => e.orgx_artifact), false);
});

test('bounded large OrgX responses remain observable while oversized responses are not sniffed for IDs', async () => {
  const session = await claude([ask('Attach the deck'), call(), ack({ structuredContent: { artifact: { id: A, description: 'x'.repeat(70_000) } } })]);
  assert.deepEqual(threadify(session).threads[0].orgx_artifacts, [ref()]);
  const oversized = await claude([ask('Attach the deck'), call(), ack({ artifact: { id: A, description: 'x'.repeat(1_300_000) } })]);
  assert.equal(oversized.ev.some(e => e.orgx_artifact), false);
});

test('incremental completion updates one existing call and never duplicates its observed artifact', async () => {
  const state = {};
  const pending = await readClaude(null, { state, lines: [ask('Attach the deck'), call()] });
  assert.equal(pending.ev[1].pending, true);
  const completedSession = await readClaude(null, { state, lines: [ack({ artifact: { id: A } })] });
  assert.equal(completedSession.ev.length, 2);
  assert.deepEqual(threadify(completedSession).threads[0].orgx_artifacts, [ref()]);
  await readClaude(null, { state, lines: [ack({ artifact: { id: A } })] });
  assert.deepEqual(threadify(completedSession).threads[0].orgx_artifacts, [ref()]);
});

test('Codex native MCP items require completed success and retain only typed acknowledgment fields', async () => {
  for (const status of ['completed', 'succeeded', 'failed', 'declined', 'in_progress', undefined]) {
    const lines = [JSON.stringify({ timestamp: completed, type: 'item_completed', payload: { item: { type: 'McpToolCall', server: 'orgx', tool: 'orgx_attach_artifact', status, result: { structuredContent: { artifact: { id: A, name: 'Private title', url: 'https://untrusted.example' } } } } } })];
    const session = await readCodex(null, { lines });
    assert.deepEqual(session.ev[0].orgx_artifact, ['completed', 'succeeded'].includes(status) ? ref(A, 'orgx_attach_artifact') : undefined, String(status));
  }
});

test('Codex raw MCP outputs accept structured envelopes and surface explicit context failures', async () => {
  const raw = (name, output) => [
    JSON.stringify({ timestamp: stamp, type: 'response_item', payload: { type: 'function_call', name, arguments: '{}', call_id: 'tool' } }),
    JSON.stringify({ timestamp: completed, type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool', output } }),
  ];
  for (const output of [JSON.stringify({ artifact: { id: A } }), { structuredContent: { artifact: { id: A } } }, [{ type: 'text', text: JSON.stringify({ data: { artifact: { id: A } } }) }]]) {
    const session = await readCodex(null, { lines: raw('mcp__orgx__orgx_attach', output) });
    assert.deepEqual(session.ev[0].orgx_artifact, ref(A, 'orgx_attach'));
  }
  const failed = await readCodex(null, { lines: raw('mcp__orgx__orgx_get_workspace_context', { isError: true, error: 'Upstream timeout' }) });
  assert.equal(hasWall(failed), true);
  assert.equal(failed.ev[0].err, true);
});

test('stored typed references drop arbitrary URLs, extra content and invalid timestamps', () => {
  assert.deepEqual(orgxArtifactRefs([{ ...ref(), url: 'javascript:alert(1)', name: 'Private title' }, ref(), { ...ref(), artifact_id: [A] }, { ...ref(B), observed_at: 'unknown' }, { ...ref(B), tool: 'orgx_inspect' }]), [ref()]);
  const event = { rawTool: 'mcp__orgx__orgx_attach', ts: 'unknown', err: false };
  observeOrgxResult(event, { artifact: { id: A } });
  assert.equal(event.orgx_artifact, undefined);
});

test('worker, local thread endpoint and metadata-only outline preserve the same observed artifact without its body', async () => {
  const { ensure, writeSession } = await import('../src/store.mjs');
  const { toSession } = await import('../src/sync.mjs');
  const { serve } = await import('../src/serve.mjs');
  ensure();
  const file = path.join(home, 'owned-session.jsonl');
  fs.writeFileSync(file, [ask('Prepare the client deck'), call(), ack({ artifact: { id: A, name: 'PRIVATE OUTPUT TITLE', preview_markdown: 'PRIVATE OUTPUT BODY' } })].join('\n') + '\n');
  const worker = new Worker(new URL('../src/worker.mjs', import.meta.url));
  let result;
  try {
    result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.postMessage({ file, client: 'claude' }); });
  } finally { await worker.terminate(); }
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.sess.threads[0].orgx_artifacts, [ref()]);
  writeSession(result.sess);
  const outline = toSession(result.sess, false);
  assert.deepEqual(outline.threads[0].orgx_artifacts, [ref()]);
  assert.equal(JSON.stringify(outline).includes('PRIVATE OUTPUT'), false);
  assert.equal(JSON.stringify(outline).includes('Prepare the client deck'), false);
  const { server, url } = await serve({ port: 47735 });
  try {
    const target = new URL('/thread', url); target.search = new URL(url).search;
    target.searchParams.set('s', result.sess.id); target.searchParams.set('t', result.sess.threads[0].id);
    const response = await fetch(target);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).orgx_artifacts, [ref()]);
  } finally { server.close(); }
});

test('ledger output anchors admit only UUID-based OrgX routes and do not render source HTML', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('const orgxOutputs = '), html.indexOf('\nasync function open(t)'));
  assert.ok(source.startsWith('const orgxOutputs = '));
  const render = vm.runInNewContext(source + '\norgxOutputs');
  const output = render([ref(), { artifact_id: '"><img src=x onerror=alert(1)>' }, { artifact_id: 'javascript:alert(1)' }]);
  assert.match(output, new RegExp(`href="https://useorgx.com/artifacts/${A}"`));
  assert.match(output, /Observed attachment responses/);
  assert.doesNotMatch(output, /<img|javascript:|onerror/);
});

const sessionFixture = (id, artifactIds) => ({ id, client: 'claude', project: 'client', start: stamp, end: completed, tools: 1, errs: 0, denied: 0, steers: {}, walls: [],
  threads: artifactIds.length ? Array.from({ length: Math.ceil(artifactIds.length / 20) }, (_, index) => ({ id: `T${index + 1}`, origin: 'ask', status: 'open', moves: 'r', backs: [], claim: [], t0: stamp, t1: completed, orgx_artifacts: artifactIds.slice(index * 20, index * 20 + 20).map(id => ref(id)) })) : [{ id: 'T1', origin: 'ask', status: 'open', moves: 'r', backs: [], claim: [], t0: stamp, t1: completed }] });
const clearSessions = async () => { const { P, ensure } = await import('../src/store.mjs'); fs.rmSync(P.sessions, { recursive: true, force: true }); ensure(); };

test('new observed outputs resync even if call count, end timestamp and thread count stayed the same', async () => {
  const { writeSession } = await import('../src/store.mjs');
  const { sync } = await import('../src/sync.mjs');
  await clearSessions();
  const session = sessionFixture('resync-observed', [A]); writeSession(session);
  const sent = [];
  const options = { base: 'https://useorgx.test', fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); sent.push(body); return { ok: true, json: async () => ({ data: { workspaceId: B, threads: body.sessions.reduce((n, s) => n + s.threads.length, 0) } }) }; } };
  await sync(options);
  session.threads[0].orgx_artifacts.push(ref(B)); writeSession(session);
  await sync(options);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].sessions[0].threads[0].orgx_artifacts, [ref(), ref(B)]);
  assert.equal((await sync({ ...options, dryRun: true })).sessions, 0);
});

test('outline batches respect the server distinct-artifact bound before any request', async () => {
  const { writeSession } = await import('../src/store.mjs');
  const { sync } = await import('../src/sync.mjs');
  await clearSessions();
  writeSession(sessionFixture('many-observed-a', Array.from({ length: 600 }, () => crypto.randomUUID())));
  writeSession(sessionFixture('many-observed-b', Array.from({ length: 600 }, () => crypto.randomUUID())));
  assert.equal((await sync({ dryRun: true, base: 'https://useorgx.test' })).requests, 2);
  await clearSessions();
  writeSession(sessionFixture('too-many-observed', Array.from({ length: 1020 }, () => crypto.randomUUID())));
  await assert.rejects(sync({ dryRun: true, base: 'https://useorgx.test' }), /1,000.*Nothing was sent/);
});
