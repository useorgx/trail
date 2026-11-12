import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalizeAgentWorkJson } from '@useorgx/agent-work-receipt';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-boundary-'));
process.env.HOME = home;
process.env.TRAIL_HOME = path.join(home, '.orgx', 'trail');
process.env.TRAIL_NO_KEYCHAIN = '1';
process.env.TRAIL_CLAUDE_SETTINGS = path.join(home, '.claude', 'settings.json');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Uninjected network request'); };
const { syncReceipts, reconcileCloudReceipts } = await import('../src/sync.mjs');
const { receiptBoundary } = await import('../src/receipt-boundary.mjs');
const { ensure, appendSignals } = await import('../src/store.mjs');
const { readClaude } = await import('../src/adapters.mjs');
const { threadify } = await import('../src/classify.mjs');
const { steps } = await import('../src/steps.mjs');
const { buildGoals } = await import('../src/goals.mjs');
const { buildReceipt } = await import('../src/receipt.mjs');
const { installReceiptHooks, uninstallReceiptHooks, runReceiptHook, recordReceiptDelivery } = await import('../src/receipt-hooks.mjs');
const { startLiveCapture } = await import('../src/live.mjs');
const source = await readClaude(new URL('./fixtures/claude.jsonl', import.meta.url).pathname);
const threads = threadify(source); const st = steps(source); const goal = buildGoals(source, threads, st)[0];
const receipt = buildReceipt({ ...source, client: 'claude', id: 'boundary-fixture' }, goal, st, threads.threads.find((t) => t.id === goal.root));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const base = 'https://example.test';
const configFile = path.join(home, '.orgx', 'cloud.json');
const config = (changes = {}) => fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 'orgx-cloud-config/v1', workspaceId: A, baseUrl: base, authMode: 'direct', nativePayloads: true, receipts: 'content', client: 'claude-code', ...changes }));
const opts = { base, receipts: [receipt], lane: 'provisional' };
const identity = (workspace = A, user = actor) => new Response(JSON.stringify({ data: { principal: { user_id: user }, default_workspace_id: workspace, workspaces: [{ id: workspace }] } }));
function transport({ me = () => identity(), post } = {}) {
  const calls = []; let gets = 0; let posts = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body), headers: init.headers });
    if (init.method === 'GET') return me(++gets);
    posts++;
    if (post) return post(posts, calls.at(-1));
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: body.receipts.map(({ receipt: r }) => ({ ok: true, receipt_id: B, external_receipt_id: r.receipt_id, schema_version: r.schema_version })) }));
  };
  return { calls, fetchImpl };
}
beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true }); ensure(); config();
  process.env.ORGX_API_KEY = 'synthetic-runtime-key';
  delete process.env.ORGX_AUTH_MODE; delete process.env.ORGX_AUTH_SCOPE; delete process.env.ORGX_BASE_URL;
});
after(() => { globalThis.fetch = originalFetch; fs.rmSync(home, { recursive: true, force: true }); });

test('wrong authenticated workspace refuses before any content POST', async () => {
  const tx = transport({ me: () => identity(B) });
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /intended workspace/);
  assert.deepEqual(tx.calls.map((c) => c.method), ['GET']);
  assert.equal(fs.existsSync(path.join(process.env.TRAIL_HOME, 'sync.json')), false);
});
test('every batch POST is explicitly workspace-bound and freshly identity checked', async () => {
  const tx = transport(); const receipts = Array.from({ length: 26 }, (_, i) => ({ ...receipt, receipt_id: `test:${i}` }));
  const result = await syncReceipts({ ...opts, receipts, fetchImpl: tx.fetchImpl });
  assert.equal(result.receipts, 26); assert.equal(result.delivery.workspaceId, A);
  assert.deepEqual(tx.calls.map((c) => c.method), ['GET', 'GET', 'POST', 'GET', 'POST']);
  assert.ok(tx.calls.filter((c) => c.method === 'POST').every((c) => c.body.workspace_id === A));
});
test('identity drift between batches stops remaining content', async () => {
  const tx = transport({ me: (n) => identity(n >= 3 ? B : A) });
  await assert.rejects(syncReceipts({ ...opts, receipts: Array.from({ length: 26 }, (_, i) => ({ ...receipt, receipt_id: `drift:${i}` })), fetchImpl: tx.fetchImpl }), /intended workspace/);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
});
test('single-route fallback and rate-limit retries retain binding and idempotency identity', async () => {
  const tx = transport({ post: (n, call) => n === 1 ? new Response('{}', { status: 404 }) : n === 2 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : new Response(JSON.stringify({ ok: true, receipt_id: B, external_receipt_id: call.body.receipt.receipt_id, schema_version: call.body.receipt.schema_version })) });
  assert.equal((await syncReceipts({ ...opts, fetchImpl: tx.fetchImpl })).receipts, 1);
  const posts = tx.calls.filter((c) => c.method === 'POST');
  assert.ok(posts.every((c) => c.body.workspace_id === A));
  assert.equal(posts[0].body.receipts[0].idempotency_key, posts[1].body.idempotency_key);
  assert.equal(posts[1].body.idempotency_key, posts[2].body.idempotency_key);
  for (let i = 0; i < tx.calls.length; i++) if (tx.calls[i].method === 'POST') assert.equal(tx.calls[i - 1].method, 'GET');
});
test('proxy-header scope is checked against authenticated identity, not trusted as proof', async () => {
  config({ authMode: 'proxy-header' }); process.env.ORGX_AUTH_MODE = 'proxy-header'; process.env.ORGX_AUTH_SCOPE = `${A}:${B}`;
  const tx = transport(); await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /ORGX_AUTH_SCOPE/);
  assert.equal(tx.calls.length, 1); assert.equal(tx.calls[0].headers.authorization, undefined);
  process.env.ORGX_AUTH_SCOPE = `${A}:${actor}`;
  assert.equal((await syncReceipts({ ...opts, fetchImpl: tx.fetchImpl })).receipts, 1);
  assert.ok(tx.calls.every((c) => c.headers.authorization === undefined));
});
test('proxy-placeholder uses the same verified transport for identity and content', async () => {
  config({ authMode: 'proxy-placeholder' }); process.env.ORGX_AUTH_MODE = 'proxy-placeholder'; process.env.ORGX_AUTH_SCOPE = `${A}:${actor}`;
  const tx = transport(); assert.equal((await syncReceipts({ ...opts, fetchImpl: tx.fetchImpl })).receipts, 1);
  assert.ok(tx.calls.every((c) => c.headers.authorization === 'Bearer synthetic-runtime-key'));
});
test('config removal or disablement during verification sends no content', async () => {
  for (const mutate of [() => fs.unlinkSync(configFile), () => config({ receipts: 'off' }), () => config({ workspaceId: B })]) {
    config(); const tx = transport({ me: () => { mutate(); return identity(); } });
    await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }));
    assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 0);
  }
});
test('malformed config, wrong origin, wrong client, and bulk local backlog fail closed', async () => {
  const tx = transport(); fs.writeFileSync(configFile, '{');
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /invalid/); config();
  await assert.rejects(syncReceipts({ ...opts, base: 'https://other.test', fetchImpl: tx.fetchImpl }), /destination/);
  await assert.rejects(syncReceipts({ ...opts, client: 'codex', fetchImpl: tx.fetchImpl }), /client/);
  await assert.rejects(syncReceipts({ base, fetchImpl: tx.fetchImpl }), /current-session/);
  assert.equal(tx.calls.length, 0);
});
test('cloud final receipts never drain machine-wide precedent signals', async () => {
  appendSignals([{ signalId: 'unrelated', text: 'Private unrelated instruction', receiptId: 'other:session' }]);
  const tx = transport(); const result = await syncReceipts({ ...opts, lane: 'final', now: Date.now() + 86400000, fetchImpl: tx.fetchImpl });
  assert.equal(result.receipts, 1); assert.equal(result.signals.sent, 0);
  assert.ok(tx.calls.every((c) => !c.url.includes('/precedents/')));
});
test('workspace and actor have separate acknowledgment/deduplication scopes', async () => {
  const tx = transport(); assert.equal((await syncReceipts({ ...opts, fetchImpl: tx.fetchImpl })).receipts, 1);
  assert.equal((await syncReceipts({ ...opts, fetchImpl: tx.fetchImpl })).receipts, 0);
  config({ workspaceId: B }); const other = transport({ me: () => identity(B) });
  assert.equal((await syncReceipts({ ...opts, fetchImpl: other.fetchImpl })).receipts, 1);
  const newActor = transport({ me: () => identity(B, A) });
  assert.equal((await syncReceipts({ ...opts, fetchImpl: newActor.fetchImpl })).receipts, 1);
});
test('prepared hook pins workspace and persists fail-closed command after config deletion', async () => {
  const bin = new URL('../bin/trail.mjs', import.meta.url).pathname;
  assert.throws(() => installReceiptHooks(bin, { prepare: true, consent: 'content', base }), /workspace/);
  installReceiptHooks(bin, { prepare: true, consent: 'content', base, workspace: A });
  assert.match(fs.readFileSync(process.env.TRAIL_CLAUDE_SETTINGS, 'utf8'), /--cloud-required/);
  fs.unlinkSync(configFile);
  await assert.rejects(runReceiptHook('{}', { client: 'claude', cloudRequired: true }), /missing/);
});
test('uninstall/disablement stops already queued cloud sends', async () => {
  const bin = new URL('../bin/trail.mjs', import.meta.url).pathname;
  installReceiptHooks(bin, { prepare: true, consent: 'content', base, workspace: A });
  assert.ok(receiptBoundary({ root: base, workspace: A, cloudRequired: true }));
  const tx = transport({ me: () => { fs.writeFileSync(path.join(process.env.TRAIL_HOME, 'receipt-hooks.json'), '{"enabled":false}'); return identity(); } });
  await assert.rejects(syncReceipts({ ...opts, workspace: A, cloudRequired: true, fetchImpl: tx.fetchImpl }), /disabled|activation boundary/);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 0);
});
test('delivery evidence uses authenticated send snapshot, not later rotated credentials', async () => {
  const tx = transport(); const result = await syncReceipts({ ...opts, fetchImpl: tx.fetchImpl });
  process.env.ORGX_API_KEY = 'rotated-after-send';
  recordReceiptDelivery({ client: 'claude', session_id: 'native-session', cwd: '/fixture' }, result);
  const dir = path.join(home, '.orgx', 'cloud-receipts');
  const record = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
  assert.equal(record.workspaceId, A); assert.equal(record.actorId, actor); assert.equal(record.scopeHash, result.delivery.scopeHash);
});
test('wrong or missing receipt identity is not acknowledged and remains pending for readback', async () => {
  const tx = transport({ post: () => new Response(JSON.stringify({ results: [{ ok: true, receipt_id: B, external_receipt_id: 'wrong', schema_version: receipt.schema_version }] })) });
  const result = await syncReceipts({ ...opts, fetchImpl: tx.fetchImpl });
  assert.equal(result.receipts, 0); assert.equal(result.refused[0].error, 'unverified_receipt_acknowledgement');
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /scoped ledger readback/);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
});
test('500 and transport-unknown sends pause without blind replay or fresh identity', async () => {
  for (const post of [() => new Response('{}', { status: 500 }), () => { throw new Error('transport timed out'); }]) {
    fs.rmSync(path.join(process.env.TRAIL_HOME, 'sync.json'), { force: true });
    const tx = transport({ post });
    try { await syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }); } catch (error) { assert.match(error.message, /timed out/); }
    await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /scoped ledger readback/);
    assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
    const state = JSON.parse(fs.readFileSync(path.join(process.env.TRAIL_HOME, 'sync.json'), 'utf8'));
    const pending = Object.values(state.destinations)[0].pendingReceipts[receipt.receipt_id];
    assert.equal(pending.workspaceId, A); assert.equal(pending.actorId, actor); assert.ok(pending.idempotencyKey);
  }
});
test('preparation refuses existing task state instead of assigning it to the new workspace', () => {
  const bin = new URL('../bin/trail.mjs', import.meta.url).pathname;
  fs.writeFileSync(path.join(process.env.TRAIL_HOME, 'sessions', 'old.json'), '{}');
  assert.throws(() => installReceiptHooks(bin, { prepare: true, consent: 'content', base, workspace: A }), /fresh image/);
  assert.equal(fs.existsSync(path.join(process.env.TRAIL_HOME, 'sessions', 'old.json')), true);
  assert.equal(fs.existsSync(process.env.TRAIL_CLAUDE_SETTINGS), false);
});
test('rotating a key for the same actor cannot bypass an unresolved send', async () => {
  const tx = transport({ post: () => { throw new Error('unknown outcome'); } });
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /unknown outcome/);
  process.env.ORGX_API_KEY = 'synthetic-replacement-key';
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /scoped ledger readback/);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
});
test('single-route HTTP 200 cannot override an explicit refused outcome', async () => {
  const tx = transport({ post: (n) => n === 1 ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ ok: false, receipt_id: B, external_receipt_id: receipt.receipt_id, schema_version: receipt.schema_version })) });
  const result = await syncReceipts({ ...opts, fetchImpl: tx.fetchImpl });
  assert.equal(result.receipts, 0); assert.equal(result.refused.length, 1);
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /scoped ledger readback/);
});
test('batch HTTP 422 with a per-item 500 remains uncertain', async () => {
  const tx = transport({ post: () => new Response(JSON.stringify({ results: [{ ok: false, status: 500, error: { code: 'receipt_import_failed' } }] }), { status: 422 }) });
  const result = await syncReceipts({ ...opts, fetchImpl: tx.fetchImpl });
  assert.equal(result.receipts, 0);
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /scoped ledger readback/);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
});
test('corrupt or unreadable existing journals cannot erase an uncertain send', async () => {
  for (const damage of [() => fs.writeFileSync(path.join(process.env.TRAIL_HOME, 'sync.json'), '{'), () => { fs.renameSync(path.join(process.env.TRAIL_HOME, 'sync.json'), path.join(process.env.TRAIL_HOME, 'saved-journal.json')); fs.mkdirSync(path.join(process.env.TRAIL_HOME, 'sync.json')); }]) {
    fs.rmSync(path.join(process.env.TRAIL_HOME, 'sync.json'), { force: true, recursive: true });
    const tx = transport({ post: () => { throw new Error('unknown outcome'); } });
    await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /unknown outcome/);
    damage(); await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /journal cannot be read safely/);
    assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
  }
});
test('actor changes between authenticated attempts stop the send', async () => {
  const tx = transport({ me: (n) => identity(A, n === 1 ? actor : B) });
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /actor changed/);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 0);
});
test('preparation time prevents resumed pre-enable transcript history from uploading', async () => {
  const file = path.join(home, 'resumed.jsonl');
  fs.copyFileSync(new URL('./fixtures/claude.jsonl', import.meta.url), file);
  const errors = []; const sent = []; const captureAfter = new Date(Date.now() - 1000).toISOString();
  const capture = await startLiveCapture(file, 'claude', { receipts: true, base, workspace: A, cloudRequired: true, captureAfter, persist: false, syncImpl: async (value) => { sent.push(value); return { receipts: value.receipts.length }; }, onError: (error) => errors.push(error.message) });
  try {
    fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'A new event after preparation does not authorize old history.' } }) + '\n');
    await capture.update(); await capture.flushed();
    assert.equal(sent.length, 0); assert.ok(errors.some((message) => message.includes('started after preparation')));
  } finally { capture.close(); }
});
test('a fresh post-preparation native session passes the source boundary', async () => {
  const file = path.join(home, 'fresh.jsonl'); const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: now, cwd: '/fixture', message: { role: 'user', content: 'Do this new synthetic task.' } }) + '\n');
  const errors = []; const sent = [];
  const capture = await startLiveCapture(file, 'claude', { receipts: true, base, workspace: A, cloudRequired: true, captureAfter: new Date(Date.now() - 1000).toISOString(), persist: false, syncImpl: async (value) => { sent.push(value); return { receipts: value.receipts.length }; }, onError: (error) => errors.push(error.message) });
  try { await capture.flushed(); assert.equal(errors.length, 0); assert.equal(sent.length, 1); assert.equal(sent[0].workspace, A); assert.equal(sent[0].cloudRequired, true); } finally { capture.close(); }
});
test('re-enabling hooks creates a new activation boundary, not permission for the off period', async () => {
  const bin = new URL('../bin/trail.mjs', import.meta.url).pathname;
  const options = { prepare: true, consent: 'content', base, workspace: A };
  installReceiptHooks(bin, options);
  const hookFile = path.join(process.env.TRAIL_HOME, 'receipt-hooks.json');
  const previous = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
  previous.preparedAt = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(hookFile, JSON.stringify(previous));
  await uninstallReceiptHooks();
  const before = Date.now(); installReceiptHooks(bin, options);
  const current = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
  assert.ok(Date.parse(current.preparedAt) >= before);
  assert.notEqual(current.preparedAt, previous.preparedAt);
});
test('malformed but present pending evidence still blocks replay', async () => {
  const tx = transport({ post: () => { throw new Error('unknown outcome'); } });
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /unknown outcome/);
  const file = path.join(process.env.TRAIL_HOME, 'sync.json'); const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.values(state.destinations)[0].pendingReceipts[receipt.receipt_id] = null; fs.writeFileSync(file, JSON.stringify(state));
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /scoped ledger readback/);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
});
test('activation replacement during identity verification stops content', async () => {
  const bin = new URL('../bin/trail.mjs', import.meta.url).pathname;
  installReceiptHooks(bin, { prepare: true, consent: 'content', base, workspace: A });
  const tx = transport({ me: () => {
    const file = path.join(process.env.TRAIL_HOME, 'receipt-hooks.json'); const hook = JSON.parse(fs.readFileSync(file, 'utf8'));
    hook.preparedAt = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(file, JSON.stringify(hook)); return identity();
  } });
  await assert.rejects(syncReceipts({ ...opts, cloudRequired: true, fetchImpl: tx.fetchImpl }), /activation boundary/);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 0);
});
test('Codex metadata keeps old sessions excluded and allows newly started sessions', async () => {
  config({ client: 'codex' });
  const original = fs.readFileSync(new URL('./fixtures/codex.jsonl', import.meta.url), 'utf8');
  for (const fresh of [false, true]) {
    const file = path.join(home, `codex-${fresh}.jsonl`); const now = new Date().toISOString();
    fs.writeFileSync(file, fresh ? original.replace(/2026-09-20T10:\d\d:00\.000Z/g, now) : original);
    const sent = []; const errors = [];
    const capture = await startLiveCapture(file, 'codex', { receipts: true, base, workspace: A, cloudRequired: true, captureAfter: new Date(Date.now() - 1000).toISOString(), persist: false, syncImpl: async (value) => { sent.push(value); return { receipts: value.receipts.length }; }, onError: (error) => errors.push(error.message) });
    try { await capture.flushed(); assert.equal(sent.length, fresh ? 1 : 0); if (fresh) assert.equal(errors.length, 0); else assert.ok(errors.some((e) => e.includes('started after preparation'))); } finally { capture.close(); }
  }
});
test('documented mixed batch HTTP 200 records valid successes but retains item-500 uncertainty', async () => {
  const other = { ...receipt, receipt_id: 'test:other' };
  const tx = transport({ post: (_n, call) => new Response(JSON.stringify({ ok: false, results: call.body.receipts.map(({ receipt: r }, index) => index === 0 ? { ok: true, status: 201, receipt_id: B, external_receipt_id: r.receipt_id, schema_version: r.schema_version } : { ok: false, status: 500, error: { code: 'receipt_import_failed' } }) })) });
  const result = await syncReceipts({ ...opts, receipts: [receipt, other], fetchImpl: tx.fetchImpl });
  assert.equal(result.receipts, 1); assert.equal(result.refused.length, 1);
  await assert.rejects(syncReceipts({ ...opts, receipts: [receipt, other], fetchImpl: tx.fetchImpl }), /scoped ledger readback/);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
});
async function uncertainHookAttempt() {
  const bin = new URL('../bin/trail.mjs', import.meta.url).pathname;
  installReceiptHooks(bin, { prepare: true, consent: 'content', base, workspace: A });
  let document;
  const tx = transport({ post: (_n, call) => { document = call.body.receipts[0].receipt; throw new Error('unknown outcome'); } });
  await assert.rejects(syncReceipts({ ...opts, cloudRequired: true, fetchImpl: tx.fetchImpl }), /unknown outcome/);
  return { document, tx };
}
test('exact full-document readback confirms delivery without replaying the POST', async () => {
  const { document, tx } = await uncertainHookAttempt(); const gets = [];
  const result = await reconcileCloudReceipts({ base, workspace: A, fetchImpl: async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error'); gets.push(url);
    if (url.endsWith('/api/v1/me')) return identity();
    assert.ok(url.includes(encodeURIComponent(document.receipt_id))); assert.ok(url.endsWith(`workspace_id=${A}`));
    return new Response(JSON.stringify({ ok: true, data: { receipt_id: B, receipt: document } }));
  } });
  assert.equal(result.confirmed.length, 1); assert.equal(result.confirmed[0].evidence, 'exact-document-readback'); assert.equal(result.remaining, 0);
  assert.equal(gets.length, 4);
  assert.equal((await syncReceipts({ ...opts, cloudRequired: true, fetchImpl: tx.fetchImpl })).receipts, 0);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
});
test('absent, newer, malformed or integrity-altered readback never authorizes replay', async () => {
  const { document, tx } = await uncertainHookAttempt();
  const responses = [() => new Response('{}', { status: 404 }),
    () => new Response(JSON.stringify({ ok: true, data: { receipt_id: B, receipt: { ...document, outcome: { ...document.outcome, summary: 'Newer revision' } } } })),
    () => new Response(JSON.stringify({ ok: true, data: { receipt_id: 'bad', receipt: document } })),
    () => new Response(JSON.stringify({ ok: true, data: { receipt_id: B, receipt: { ...document, integrity: { different: true } } } })),
    () => new Response('{')];
  for (const response of responses) {
    const result = await reconcileCloudReceipts({ base, workspace: A, fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET'); return url.endsWith('/api/v1/me') ? identity() : response();
    } });
    assert.equal(result.confirmed.length, 0); assert.equal(result.remaining, 1);
  }
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /scoped ledger readback/);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
});
test('readback actor drift leaves the attempted document pending', async () => {
  const { document, tx } = await uncertainHookAttempt(); let identityReads = 0;
  await assert.rejects(reconcileCloudReceipts({ base, workspace: A, fetchImpl: async (url) => {
    if (url.endsWith('/api/v1/me')) return identity(A, ++identityReads > 2 ? B : actor);
    return new Response(JSON.stringify({ ok: true, data: { receipt_id: B, receipt: document } }));
  } }), /actor changed/);
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /scoped ledger readback/);
});
test('legacy pending records without an exact wire hash are retained for manual review', async () => {
  await uncertainHookAttempt();
  const file = path.join(process.env.TRAIL_HOME, 'sync.json'); const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete Object.values(state.destinations)[0].pendingReceipts[receipt.receipt_id].wireHash; fs.writeFileSync(file, JSON.stringify(state));
  const result = await reconcileCloudReceipts({ base, workspace: A, fetchImpl: async (url) => { assert.ok(url.endsWith('/api/v1/me')); return identity(); } });
  assert.equal(result.confirmed.length, 0); assert.equal(result.unresolved[0].reason, 'pending_evidence_incomplete'); assert.equal(result.remaining, 1);
});
test('same-binding native capture resumes existing task history without re-preparing the image', async () => {
  const bin = new URL('../bin/trail.mjs', import.meta.url).pathname;
  const options = { prepare: true, consent: 'content', base, workspace: A };
  installReceiptHooks(bin, options);
  const hook = JSON.parse(fs.readFileSync(path.join(process.env.TRAIL_HOME, 'receipt-hooks.json'), 'utf8'));
  const file = path.join(home, 'resume-current.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: '/fixture', message: { role: 'user', content: 'Complete this fresh resumable task.' } }) + '\n');
  const tx = transport(); const errors = [];
  const captureOptions = { receipts: true, base, workspace: A, cloudRequired: true, captureAfter: hook.preparedAt,
    syncImpl: (value) => syncReceipts({ ...value, fetchImpl: tx.fetchImpl }), onError: (error) => errors.push(error.message) };
  const first = await startLiveCapture(file, 'claude', captureOptions); await first.flushed(); first.close();
  assert.equal(errors.length, 0); assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
  // Preparation is an image-stage operation, not the task startup/resume path.
  assert.throws(() => installReceiptHooks(bin, options), /fresh image/);
  assert.equal((await runReceiptHook('{}', { client: 'claude', cloudRequired: true })).reason, 'transcript_path missing');
  const resumed = await startLiveCapture(file, 'claude', captureOptions);
  try { await resumed.flushed(); assert.equal(errors.length, 0); assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1); } finally { resumed.close(); }
});
test('recovery pagination reaches an exact match after 50 unresolved older entries', async () => {
  const { document } = await uncertainHookAttempt();
  const file = path.join(process.env.TRAIL_HOME, 'sync.json'); const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pending = Object.values(state.destinations)[0].pendingReceipts;
  for (let i = 0; i < 50; i++) pending[`000-unresolved-${String(i).padStart(2, '0')}`] = null;
  fs.writeFileSync(file, JSON.stringify(state)); let documentReads = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'GET');
    if (url.endsWith('/api/v1/me')) return identity();
    documentReads++; return new Response(JSON.stringify({ ok: true, data: { receipt_id: B, receipt: document } }));
  };
  const first = await reconcileCloudReceipts({ base, workspace: A, fetchImpl });
  assert.equal(first.unresolved.length, 50); assert.ok(first.nextCursor); assert.equal(documentReads, 0);
  const second = await reconcileCloudReceipts({ base, workspace: A, cursor: first.nextCursor, fetchImpl });
  assert.equal(second.confirmed.length, 1); assert.equal(second.nextCursor, null); assert.equal(second.remaining, 50); assert.equal(documentReads, 1);
});

// Server-shaped fixture: admitCheckedReceipt calls sealOrgxAgentWorkReceipt
// with attests=ingested, preserving Trail's digest and appending one seal.
function ingestAndSeal(document, changes = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' });
  const kid = `orgx-receipt-${crypto.createHash('sha256').update(Buffer.from(raw.x, 'base64url')).digest('hex').slice(0, 16)}`;
  const key = { ...raw, kid, alg: 'EdDSA', use: 'sig' };
  const seal = { algorithm: 'ed25519', encoding: 'base64url', key_id: kid,
    signer: { type: 'service', id: 'orgx', display_name: 'OrgX' },
    signed_at: '2026-11-12T00:00:00.000Z', attests: 'ingested', ...changes };
  const payload = canonicalizeAgentWorkJson({ profile: 'agent-work-receipt-signature/v0.1',
    protected: seal, content_hash: { algorithm: 'sha-256', value: document.integrity.content_hash.value } });
  seal.value = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url');
  return { key, document: { ...document, integrity: { content_hash: document.integrity.content_hash, signatures: [seal] } } };
}
test('ingest, OrgX seal, and scoped readback confirms the unchanged submission without replay', async () => {
  const { document, tx } = await uncertainHookAttempt(); const stored = ingestAndSeal(document); const reads = [];
  assert.notEqual(canonicalizeAgentWorkJson(document), canonicalizeAgentWorkJson(stored.document));
  const result = await reconcileCloudReceipts({ base, workspace: A, fetchImpl: async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); reads.push(url);
    if (url.endsWith('/api/v1/me')) return identity();
    if (url.endsWith('/.well-known/orgx-receipt-keys.json')) {
      assert.equal(init.headers, undefined); return new Response(JSON.stringify({ keys: [stored.key] }));
    }
    assert.ok(url.endsWith(`workspace_id=${A}`));
    return new Response(JSON.stringify({ ok: true, data: { receipt_id: B, receipt: stored.document } }));
  } });
  assert.equal(result.confirmed.length, 1); assert.equal(result.remaining, 0); assert.equal(reads.length, 5);
  assert.equal((await syncReceipts({ ...opts, cloudRequired: true, fetchImpl: tx.fetchImpl })).receipts, 0);
  assert.equal(tx.calls.filter((c) => c.method === 'POST').length, 1);
});
test('sealed readback rejects unpermitted transformations, forged seals and unavailable trusted keys', async () => {
  const { document, tx } = await uncertainHookAttempt(); const stored = ingestAndSeal(document);
  const cases = [
    (s) => { s.document.outcome.summary = 'Changed content'; },
    (s) => { s.document.integrity.content_hash.value = 'a'.repeat(64); },
    (s) => { s.document.integrity.extra = true; },
    (s) => { s.document.integrity.signatures.push(s.document.integrity.signatures[0]); },
    (s) => { s.document.integrity.signatures[0].signer.id = 'not-orgx'; },
    (s) => { s.document.integrity.signatures[0].attests = 'observed'; },
    (s) => { s.document.integrity.signatures[0].signed_at = '2026-11-12T00:01:00.000Z'; },
    (s) => { s.document.integrity.signatures[0].extra = true; },
    (s) => { s.document.integrity.signatures[0].value = Buffer.alloc(64).toString('base64url'); },
    (s) => { s.document.integrity.signatures[0].value += '='; },
    (s) => { s.keys = []; },
    (s) => { s.keys.push(s.keys[0]); },
    (s) => { s.keys[0].x = crypto.randomBytes(32).toString('base64url'); },
    (s) => { s.keys[0].d = 'private-material-is-not-a-public-key'; },
    (s) => { s.keyStatus = 503; },
    (s) => { s.document.outcome.claim_level = 'reported'; },
  ];
  for (const mutate of cases) {
    const scenario = JSON.parse(JSON.stringify({ document: stored.document, keys: [stored.key], keyStatus: 200 })); mutate(scenario);
    const result = await reconcileCloudReceipts({ base, workspace: A, fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET');
      if (url.endsWith('/api/v1/me')) return identity();
      if (url.endsWith('/.well-known/orgx-receipt-keys.json')) return new Response(JSON.stringify({ keys: scenario.keys }), { status: scenario.keyStatus });
      return new Response(JSON.stringify({ ok: true, data: { receipt_id: B, receipt: scenario.document } }));
    } });
    assert.equal(result.confirmed.length, 0); assert.equal(result.remaining, 1);
  }
  await assert.rejects(syncReceipts({ ...opts, fetchImpl: tx.fetchImpl }), /scoped ledger readback/);
});
