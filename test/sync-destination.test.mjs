import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-sync-destinations-'));
process.env.TRAIL_HOME = home;
process.env.TRAIL_NO_KEYCHAIN = '1';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Test attempted an uninjected network request'); };
const { sync, syncReceipts } = await import('../src/sync.mjs');
const { ensure, writeSession, writeReceipts, appendSignals } = await import('../src/store.mjs');
const { readClaude } = await import('../src/adapters.mjs');
const { threadify } = await import('../src/classify.mjs');
const { steps } = await import('../src/steps.mjs');
const { buildGoals } = await import('../src/goals.mjs');
const { buildReceipt } = await import('../src/receipt.mjs');
const { verifyAgentWorkReceiptIntegrity } = await import('@useorgx/agent-work-receipt');
const source = await readClaude(new URL('./fixtures/claude.jsonl', import.meta.url).pathname);
const threads = threadify(source);
const st = steps(source);
const goal = buildGoals(source, threads, st)[0];
const receipt = buildReceipt({ ...source, client: 'claude', id: 'destination-fixture' }, goal, st, threads.threads.find((t) => t.id === goal.root));
const statePath = path.join(home, 'sync.json');
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  ensure();
  process.env.ORGX_API_KEY = 'synthetic-account-a';
  writeSession({ id: 'session-one', client: 'claude', project: 'fixture', start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:01:00Z', tools: 1, errs: 0, denied: 0, asks: 1, steers: { human: 0, cont: 0 }, walls: [], threads: [{ id: 'T1', origin: 'ask', status: 'outcome', moves: 'h', backs: [], title: 'Synthetic work' }] });
  appendSignals([{ signalId: 'synthetic-signal', kind: 'correction', text: 'Use the existing API', receiptId: receipt.receipt_id }]);
});
after(() => { globalThis.fetch = originalFetch; fs.rmSync(home, { recursive: true, force: true }); });

function transport() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, authorization: init.headers.authorization });
    for (const item of body.receipts || []) assert.equal((await verifyAgentWorkReceiptIntegrity(item.receipt)).content_hash.state, 'verified');
    return new Response(JSON.stringify(body.receipts ? { results: body.receipts.map(() => ({ ok: true })) } : body.sessions ? { data: { threads: 1, workspaceId: 'synthetic-workspace' } } : {}), { status: 200 });
  };
  return { calls, fetchImpl };
}

test('outline, receipt, revision and signal acknowledgements are isolated by normalized endpoint and credential', async () => {
  const { calls, fetchImpl } = transport();
  const upload = async (base, expected) => {
    const outlines = await sync({ base, fetchImpl });
    const result = await syncReceipts({ base, receipts: [receipt], fetchImpl });
    assert.equal(outlines.sessions, expected);
    assert.equal(result.receipts, expected);
    assert.equal(result.signals.sent, expected);
  };
  await upload('HTTPS://A.EXAMPLE:443/root///', 1);
  await upload('https://b.example/root', 1);
  process.env.ORGX_API_KEY = 'synthetic-account-b';
  await upload('https://b.example/root', 1);
  process.env.ORGX_API_KEY = 'synthetic-account-a';
  await upload('https://b.example/root/', 0);
  await upload('https://a.example/root', 0);
  assert.equal(calls.length, 9);
  assert.ok(calls.every(({ url }) => /^https:\/\/[ab]\.example\/root\/api\//.test(url)));
  const state = readState();
  assert.equal(Object.keys(state.destinations).length, 3);
  for (const scoped of Object.values(state.destinations)) {
    assert.deepEqual(Object.keys(scoped.sessions), ['session-one']);
    assert.deepEqual(Object.keys(scoped.receipts), [receipt.receipt_id]);
    assert.equal(scoped.receiptRevisions[receipt.receipt_id].lane, 'final');
    assert.deepEqual(Object.keys(scoped.signalsSent), ['synthetic-signal']);
  }
  const stored = fs.readFileSync(statePath, 'utf8');
  assert.ok(!stored.includes('synthetic-account-a') && !stored.includes('synthetic-account-b'));
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.equal(new Set(calls.filter(({ body }) => body.receipts).map(({ body }) => body.receipts[0].idempotency_key)).size, 1, 'server idempotency remains content-based across destinations');
});

test('a final revision sent elsewhere cannot suppress a provisional receipt at a new destination', async () => {
  const { fetchImpl } = transport();
  assert.equal((await syncReceipts({ base: 'https://a.example', receipts: [receipt], fetchImpl })).receipts, 1);
  assert.equal((await syncReceipts({ base: 'https://b.example', receipts: [receipt], lane: 'provisional', fetchImpl })).receipts, 1);
  assert.equal((await syncReceipts({ base: 'https://a.example', receipts: [receipt], lane: 'provisional', fetchImpl })).receipts, 0);
});

test('failed outlines, receipts and signals remain retryable within their destination', async () => {
  const { calls, fetchImpl: accepted } = transport();
  const base = 'https://retry.example';
  await assert.rejects(sync({ base, fetchImpl: async () => new Response('{"error":"retry"}', { status: 503 }) }), /refused/);
  const failed = await syncReceipts({ base, receipts: [receipt], fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(body.receipts ? { results: [{ ok: false, error: { code: 'retry' } }] } : { error: { code: 'retry' } }), { status: 503 });
  } });
  assert.equal(failed.receipts, 0);
  assert.equal(failed.signals.sent, 0);
  assert.equal((await sync({ base, fetchImpl: accepted })).sessions, 1);
  const retried = await syncReceipts({ base, receipts: [receipt], fetchImpl: accepted });
  assert.equal(retried.receipts, 1);
  assert.equal(retried.signals.sent, 1);
  assert.equal(calls.length, 3);
});

test('unscoped legacy acknowledgements safely re-send rather than guessing their destination', async () => {
  const { fetchImpl } = transport();
  const base = 'https://legacy.example';
  await sync({ base, fetchImpl });
  await syncReceipts({ base, receipts: [receipt], fetchImpl });
  const previous = Object.values(readState().destinations)[0];
  fs.writeFileSync(statePath, JSON.stringify(previous));
  assert.equal((await sync({ base, fetchImpl })).sessions, 1);
  const result = await syncReceipts({ base, receipts: [receipt], fetchImpl });
  assert.equal(result.receipts, 1);
  assert.equal(result.signals.sent, 1);
  assert.equal(Object.keys(readState().destinations).length, 1);
});

test('dry runs do not create locks or ledger files, change acknowledgements, or require a credential', async () => {
  const { fetchImpl } = transport();
  const base = 'https://preview.example';
  writeReceipts('destination-fixture', [receipt]);
  await sync({ base, fetchImpl });
  await syncReceipts({ base, fetchImpl });
  fs.unlinkSync(path.join(home, 'workstreams.json'));
  const snapshot = () => fs.readdirSync(home, { recursive: true }).filter((name) => fs.statSync(path.join(home, name)).isFile()).sort().map((name) => [name, fs.readFileSync(path.join(home, name), 'utf8')]);
  const before = snapshot();
  const neverFetch = async () => { throw new Error('preview made a network request'); };
  assert.equal((await sync({ base, dryRun: true, fetchImpl: neverFetch })).sessions, 0);
  assert.equal((await syncReceipts({ base, dryRun: true, fetchImpl: neverFetch })).receipts, 0);
  delete process.env.ORGX_API_KEY;
  const outline = await sync({ base, dryRun: true, fetchImpl: neverFetch });
  const preview = await syncReceipts({ base, dryRun: true, fetchImpl: neverFetch });
  assert.equal(outline.scopeKnown, false);
  assert.equal(outline.sessions, 1);
  assert.equal(preview.scopeKnown, false);
  assert.equal(preview.receipts, 1);
  assert.equal(preview.signals.pending, 1);
  assert.deepEqual(snapshot(), before);
  fs.rmSync(home, { recursive: true, force: true });
  await sync({ base, dryRun: true, fetchImpl: neverFetch });
  await syncReceipts({ base, receipts: [], dryRun: true, fetchImpl: neverFetch });
  assert.equal(fs.existsSync(home), false, 'preview of a new store leaves it absent');
});
