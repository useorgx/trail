// The precedent loop: human judgment (corrections, rejections, denials, stated rules) read from transcripts, kept
// as local candidates, sent to OrgX, and named on receipts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-precedent-'));
process.env.TRAIL_HOME = tmp;
process.env.TRAIL_NO_KEYCHAIN = '1';
const fx = (n) => new URL(`./fixtures/${n}`, import.meta.url).pathname;
const { readClaude, readCodex } = await import('../src/adapters.mjs');
const { threadify } = await import('../src/classify.mjs');
const { steps } = await import('../src/steps.mjs');
const { buildGoals } = await import('../src/goals.mjs');
const { buildReceipt, receiptIdOf } = await import('../src/receipt.mjs');
const { classifyJudgment, extractSignals, signalIdOf, PRECEDENT_EXT } = await import('../src/precedent.mjs');
const T = (tool, target, extra = {}) => ({ k: 'tool', ts: '2026-10-01T00:00:01Z', tool, rawTool: tool, target, err: false, denied: false, errText: '', ...extra });

test('classifier: corrections and standing rules, conservatively', () => {
  for (const x of ['no, use pnpm instead', "don't do that", 'Actually, keep the old name', 'that\'s not what I asked', 'stop', 'use the v2 client instead', 'Wait, no — revert that']) assert.equal(classifyJudgment(x), 'correction', x);
  for (const x of ['always run the linter before committing', 'Never push to main', 'from now on use pnpm', 'no, never edit generated files']) assert.equal(classifyJudgment(x), 'explicit_rule', x);
  for (const x of ['fix the login bug', 'no worries, now add the docs page', 'can you also add tests?', 'continue', '[screenshot]']) assert.equal(classifyJudgment(x), null, x);
});

test('defect 2: Claude Code tool rejections and interrupts count as denials and carry the person\'s words', async () => {
  const s = await readClaude(fx('claude-judgment.jsonl'));
  const tools = s.ev.filter((e) => e.k === 'tool');
  const install = tools.find((e) => /axios-retry/.test(e.target));
  assert.equal(install.denied, true); assert.equal(install.rejected, true);
  assert.equal(install.feedback, 'no new dependencies, write the retry loop by hand', 'the reason after "the user said:" is kept');
  const edit = tools.find((e) => e.tool === 'Edit' && /upload\.ts$/.test(e.target));
  assert.equal(edit.denied, true, '"doesn\'t want to take this action right now" is a denial');
  const test = tools.find((e) => e.target === 'npm test');
  assert.equal(test.rejected, true, 'a call interrupted while running ([Request interrupted by user for tool use]) is a rejection');
  assert.equal(tools.find((e) => e.tool === 'Read').denied, false);
  const r = threadify(s);
  assert.equal(r.denied, 3, 'all three count as denials');
  assert.ok(!r.threads.some((t) => t.kind === 'wall'), 'a person saying no is not a permission wall to route around');
  assert.ok(!r.walls.length, 'and never becomes a wall signature');
});

test('defect 2: Codex declines (items and raw rollouts) and Cursor rejections are rejections too', async (t) => {
  const f = path.join(tmp, 'rollout-declined.jsonl');
  const item = (ts, it) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', item: it } });
  fs.writeFileSync(f, [
    item('2026-10-01T10:00:00Z', { type: 'UserMessage', content: [{ type: 'text', text: 'clean up the build dir' }] }),
    item('2026-10-01T10:00:05Z', { type: 'CommandExecution', command: ['bash', '-lc', 'rm -rf dist node_modules'], status: 'declined', aggregated_output: '' }),
    item('2026-10-01T10:00:09Z', { type: 'UserMessage', content: [{ type: 'text', text: "don't delete node_modules, only dist" }] }),
    item('2026-10-01T10:00:12Z', { type: 'CommandExecution', command: ['bash', '-lc', 'rm -rf dist'], status: 'completed', exit_code: 0, aggregated_output: '' }),
  ].join('\n'));
  const c = await readCodex(f);
  const [rm] = c.ev.filter((e) => e.k === 'tool');
  assert.equal(rm.denied, true); assert.equal(rm.rejected, true);
  const sig = extractSignals(c, { sessionId: 'cx-1', harness: 'codex' });
  assert.deepEqual(sig.map((x) => [x.kind, x.text]), [['rejection', "don't delete node_modules, only dist"]], 'the follow-up message is the rejection\'s reason, not a second signal');
  assert.equal(threadify(c).threads.filter((x) => x.origin === 'ask').length, 1, 'the reason folds into the same piece of work');

  // Raw (older) rollouts: the rejection is in the call output.
  const raw = path.join(tmp, 'rollout-raw.jsonl');
  fs.writeFileSync(raw, [
    { timestamp: '2026-10-01T10:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'deploy it' }] } },
    { timestamp: '2026-10-01T10:00:01Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"cmd":"vercel --prod"}' } },
    { timestamp: '2026-10-01T10:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Exit code: 1\nOutput: exec command rejected by user' } },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const r2 = await readCodex(raw);
  assert.equal(r2.ev.find((e) => e.k === 'tool').rejected, true);

  let sqlite; try { sqlite = await import('node:sqlite'); } catch { return t.skip('node:sqlite needs Node 22.5+'); }
  const { readCursor } = await import('../src/adapters-sqlite.mjs');
  const chat = path.join(tmp, 'cursor', 'ws', 'chat-r'); fs.mkdirSync(chat, { recursive: true });
  fs.writeFileSync(path.join(chat, 'meta.json'), JSON.stringify({ createdAtMs: 1000, updatedAtMs: 9000, cwd: '/work/app' }));
  const cu = new sqlite.DatabaseSync(path.join(chat, 'store.db'));
  cu.exec('CREATE TABLE blobs (id TEXT, data BLOB); CREATE TABLE meta (key TEXT, value BLOB);');
  const blob = cu.prepare('INSERT INTO blobs VALUES (?, ?)');
  blob.run('b1', JSON.stringify({ role: 'user', content: [{ type: 'text', text: '<user_query>\nreset the db\n</user_query>' }] }));
  blob.run('b2', JSON.stringify({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'run_terminal_cmd', args: { command: 'dropdb app' } }] }));
  blob.run('b3', JSON.stringify({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', result: { isError: true, error: 'User rejected the command' } }] }));
  cu.close();
  const cs = await readCursor(path.join(chat, 'store.db'));
  const drop = cs.ev.find((e) => e.k === 'tool'); assert.equal(drop.denied, true); assert.equal(drop.rejected, true);
});

test('defect 3: a correction folds into the current goal as a change of course triggered by a person', async () => {
  const s = await readClaude(fx('claude-judgment.jsonl'));
  const r = threadify(s); const st = steps(s, { reasoning: [] }); const goals = buildGoals(s, r, st, { sessionId: 's-judg' });
  assert.deepEqual(goals.map((g) => g.title), ['Add a retry to the upload client', 'write the release notes for 1.2'], 'corrections and rejection reasons never open a goal; a new request still does');
  const correctionAt = s.ev.findIndex((e) => e.k === 'ask' && /^No, use exponential/.test(e.text));
  const bt = goals[0].backtracks.find((b) => b.at === correctionAt);
  assert.ok(bt, 'the correction is a change of course inside the goal'); assert.equal(bt.trigger, 'person');
  // Without a correction-shaped message, a new ask still starts new work.
  const plain = { ev: [{ k: 'ask', ts: '2026-10-01T00:00:00Z', text: 'fix the build', who: 'human' }, T('Bash', 'pnpm build'), { k: 'ask', ts: '2026-10-01T00:00:02Z', text: 'add a dark mode toggle', who: 'human' }, T('Edit', '/r/a.ts')], reasoning: [] };
  assert.equal(buildGoals(plain, threadify(plain), steps(plain)).length, 2);
});

test('defect 1: receipts record a person\'s course change as trigger human, not self', async () => {
  const { validateAgentWorkReceipt } = await import('@useorgx/agent-work-receipt');
  const s = { ev: [
    { k: 'ask', ts: '2026-10-01T00:00:00Z', text: 'add caching to the API client', who: 'human' },
    T('Edit', '/repo/src/api.ts'),
    { k: 'ask', ts: '2026-10-01T00:00:02Z', text: 'no, use the existing LRU helper instead of a Map', who: 'human' },
    { k: 'say', ts: '2026-10-01T00:00:03Z', text: 'Switching to the existing LRU helper instead of the hand-rolled Map.' },
    T('Edit', '/repo/src/api.ts'), T('Bash', 'pnpm test', { outTail: 'Tests  4 passed (4)' }),
    { k: 'say', ts: '2026-10-01T00:00:05Z', text: 'Caching now uses the existing LRU helper in api.ts, as you asked, and the suite passes (4/4). No other files changed in this piece of work.' },
  ], reasoning: [] };
  const r = threadify(s); const st = steps(s, { reasoning: [] }); const goals = buildGoals(s, r, st);
  assert.equal(goals.length, 1);
  // An agent course change that follows a plain (non-correction) message is also 'person': it maps to human.
  const g = { ...goals[0], backtracks: [...goals[0].backtracks, { at: 3, trigger: 'person', by: 'say', seen: 'rule' }] };
  const rc = buildReceipt({ client: 'claude', id: 'sess-p', mode: 'default' }, g, st, r.threads.find((t) => t.id === g.root));
  assert.ok(rc.trajectory.length >= 1);
  assert.ok(rc.trajectory.every((x) => x.trigger === 'human'), JSON.stringify(rc.trajectory));
  assert.ok(!rc.trajectory.some((x) => x.trigger === 'self'));
  assert.equal(rc.human_interventions[0].kind, 'correction');
  const v = validateAgentWorkReceipt(rc); assert.ok(v.ok, JSON.stringify(v.issues));
});

test('signals: wire shape, deterministic ids, receipt ids, rule and denial kinds', async () => {
  const s = await readClaude(fx('claude-judgment.jsonl'));
  const r = threadify(s); const st = steps(s, { reasoning: [] }); const goals = buildGoals(s, r, st);
  const at = new Map(); for (const g of goals) for (const [a, b] of g.spans) for (let i = a; i <= b; i++) at.set(i, g);
  const session = { client: 'claude', id: 's-judg' };
  const sig = extractSignals(s, { sessionId: 's-judg', harness: 'claude-code', repo: 'demo-repo', receiptIdAt: (i) => (at.get(i) ? receiptIdOf(session, at.get(i).root) : null) });
  assert.deepEqual(sig.map((x) => x.kind), ['rejection', 'rejection', 'rejection', 'explicit_rule']);
  const keys = ['signalId', 'kind', 'source', 'harness', 'sessionId', 'observedAt', 'text', 'priorAction', 'scopeHints', 'receiptId'];
  for (const x of sig) {
    assert.deepEqual(Object.keys(x), keys);
    assert.match(x.signalId, /^sig_[0-9a-f]{32}$/);
    const expect = 'sig_' + crypto.createHash('sha256').update(`${x.sessionId}|${x.kind}|${x.observedAt}|${x.text}`).digest('hex').slice(0, 32);
    assert.equal(x.signalId, expect); assert.equal(signalIdOf(x), expect);
    assert.equal(x.source, 'trail'); assert.equal(x.harness, 'claude-code');
    assert.ok(!isNaN(Date.parse(x.observedAt)) && x.observedAt.endsWith('Z'));
    assert.ok(x.text.length > 0 && x.text.length <= 2000);
    assert.deepEqual(Object.keys(x.scopeHints), ['repo', 'paths', 'toolNames']);
    assert.ok(x.scopeHints.paths.length <= 20 && x.scopeHints.toolNames.length <= 20);
    assert.equal(x.receiptId, receiptIdOf(session, goals[0].root));
  }
  assert.equal(sig[0].text, 'no new dependencies, write the retry loop by hand');
  assert.deepEqual(sig[0].priorAction, { toolName: 'Bash', summary: 'npm install axios-retry' });
  assert.equal(sig[1].text, 'put it in src/net/retry.ts, not in upload.ts', 'no inline reason: the next thing the person said is the reason');
  assert.ok(sig[1].scopeHints.paths.includes('src/upload.ts'), 'paths are relative to the repo');
  assert.equal(sig[3].text, 'From now on, always run the tests with npm test -- --runInBand in this repo.');
  assert.deepEqual(extractSignals(s, { sessionId: 's-judg', harness: 'claude-code' }).map((x) => x.signalId), sig.map((x) => x.signalId), 'same transcript, same ids');
  // Permission denials (not a person saying no) are 'denial', once per rule per session.
  const d = { ev: [{ k: 'ask', ts: '2026-10-01T00:00:00Z', text: 'tidy up', who: 'human' },
    T('Bash', 'cat ~/.claude/x', { err: true, denied: true, errText: 'Permission to use Bash has been denied.' }),
    T('Bash', 'cat ~/.claude/y', { err: true, denied: true, errText: 'Permission to use Bash has been denied.' })], reasoning: [] };
  const ds = extractSignals(d, { sessionId: 'd', harness: 'claude-code' });
  assert.equal(ds.length, 1); assert.equal(ds[0].kind, 'denial'); assert.equal(ds[0].sessionId, 'd'); assert.equal(ds[0].receiptId, null);
  // A long ask is clipped at 2000 characters, never mid-surrogate.
  const long = extractSignals({ ev: [T('Read', '/r/a.ts'), { k: 'ask', ts: '2026-10-01T00:00:00Z', text: 'never ' + '😀'.repeat(1500), who: 'human' }] }, { sessionId: null, harness: 'codex' });
  assert.ok(long[0].text.length <= 2000); assert.equal(long[0].sessionId, null); assert.doesNotThrow(() => encodeURIComponent(long[0].text));
});

test('defect 4: local candidates are append-only JSONL, idempotent on signalId', async () => {
  const { appendSignals, loadSignals, P } = await import('../src/store.mjs');
  const s = await readClaude(fx('claude-judgment.jsonl'));
  const sig = extractSignals(s, { sessionId: 's-judg', harness: 'claude-code' });
  assert.equal(appendSignals(sig), sig.length);
  assert.equal(appendSignals(sig), 0, 'a re-scan adds nothing');
  assert.equal(appendSignals([...sig.slice(0, 1), { ...sig[0], signalId: 'sig_' + 'f'.repeat(32) }]), 1);
  const lines = fs.readFileSync(P.signals, 'utf8').trim().split('\n');
  assert.equal(lines.length, sig.length + 1);
  fs.appendFileSync(P.signals, lines[0] + '\n'); // a duplicate written by a concurrent worker
  assert.equal(loadSignals().length, sig.length + 1, 'reads dedupe on signalId');
  assert.equal((fs.statSync(P.signals).mode & 0o777).toString(8), '600');
});

test('defect 5: signals POST in batches of 100, 404 keeps them locally, sent ones are not resent', async () => {
  const { sendSignals, SIGNALS_PATH } = await import('../src/sync.mjs');
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ signalId: `sig_${String(i).padStart(32, '0')}`, kind: 'correction', text: 'x' }));
  const calls = []; const ok = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization }); return { ok: true, status: 200, json: async () => ({}) }; };
  const state = {}; const headers = { 'content-type': 'application/json', authorization: 'Bearer k' };
  const out = await sendSignals({ root: 'https://orgx.test', headers, state, signals: mk(250), fetchImpl: ok });
  assert.deepEqual(calls.map((c) => c.body.signals.length), [100, 100, 50]);
  assert.equal(calls[0].url, 'https://orgx.test' + SIGNALS_PATH); assert.equal(SIGNALS_PATH, '/api/v1/precedents/signals');
  assert.deepEqual(Object.keys(calls[0].body), ['signals']); assert.equal(calls[0].auth, 'Bearer k');
  assert.equal(out.sent, 250); assert.equal(Object.keys(state.signalsSent).length, 250);
  const nf = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const st2 = {}; const o2 = await sendSignals({ root: 'https://old.test', headers, state: st2, signals: mk(3), fetchImpl: nf });
  assert.equal(o2.unsupported, true); assert.equal(o2.sent, 0); assert.equal(o2.pending, 3); assert.equal(o2.error, null);
  assert.deepEqual(st2.signalsSent, {}, 'nothing marked sent');

  // Through syncReceipts: only unsent signals go, after receipts, with the same key and base URL.
  const { appendSignals, loadSignals } = await import('../src/store.mjs');
  appendSignals([{ signalId: 'sig_' + 'a'.repeat(32), kind: 'explicit_rule', source: 'trail', harness: 'codex', sessionId: null, observedAt: '2026-10-01T00:00:00.000Z', text: 'never force-push', priorAction: null, scopeHints: { repo: null, paths: [], toolNames: [] }, receiptId: null }]);
  const { syncReceipts } = await import('../src/sync.mjs');
  const realFetch = globalThis.fetch; const seen = [];
  process.env.ORGX_API_KEY = 'test-key';
  try {
    globalThis.fetch = async (url, init) => { seen.push(url); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ results: JSON.parse(init.body).receipts?.map(() => ({ ok: true })) || [] }) }; };
    const dry = await syncReceipts({ dryRun: true, base: 'https://orgx.test' });
    assert.equal(dry.signals.pending, loadSignals().length); assert.equal(seen.length, 0, 'dry run sends nothing');
    const r1 = await syncReceipts({ base: 'https://orgx.test' });
    assert.equal(r1.signals.sent, loadSignals().length); assert.ok(seen.every((u) => u.startsWith('https://orgx.test/')));
    seen.length = 0;
    const r2 = await syncReceipts({ base: 'https://orgx.test' });
    assert.equal(r2.signals.sent, 0); assert.ok(!seen.some((u) => u.endsWith(SIGNALS_PATH)), 'sent signals are not resent');
  } finally { globalThis.fetch = realFetch; delete process.env.ORGX_API_KEY; }
});

test('defect 6: receipts name the precedents that governed them, and stay schema-valid', async () => {
  const { validateAgentWorkReceipt } = await import('@useorgx/agent-work-receipt');
  const s = await readClaude(fx('claude-judgment.jsonl'));
  const r = threadify(s); const st = steps(s, { reasoning: [] }); const [g] = buildGoals(s, r, st);
  const session = { client: 'claude', id: 's-judg', mode: 'default' };
  const plain = buildReceipt(session, g, st, r.threads.find((t) => t.id === g.root));
  assert.equal(plain.extensions[PRECEDENT_EXT], undefined, 'omitted when nothing is known');
  assert.ok(!plain.lineage.references.some((x) => x.relationship === 'governed_by'));
  const rc = buildReceipt(session, g, st, r.threads.find((t) => t.id === g.root), { governedBy: [{ claimId: 'clm_123', version: 3 }, { claimId: 'clm_456' }, { bogus: true }], signals: ['sig_' + '1'.repeat(32)] });
  assert.deepEqual(rc.lineage.references.filter((x) => x.relationship === 'governed_by'), [
    { relationship: 'governed_by', ref: { system: 'orgx', type: 'precedent', id: 'clm_123', version: '3' } },
    { relationship: 'governed_by', ref: { system: 'orgx', type: 'precedent', id: 'clm_456' } },
  ]);
  assert.deepEqual(rc.extensions[PRECEDENT_EXT], { governedBy: [{ claimId: 'clm_123', version: 3 }, { claimId: 'clm_456', version: null }], signals: ['sig_' + '1'.repeat(32)] });
  assert.ok(rc.extensions['org.orgx.trail/v1'], 'the trail extension is untouched');
  const v = validateAgentWorkReceipt(rc); assert.ok(v.ok, JSON.stringify(v.issues));
  // Session metadata works too.
  const viaSession = buildReceipt({ ...session, governedBy: [{ claimId: 'clm_9', version: '2026-10-01' }] }, g, st, r.threads.find((t) => t.id === g.root));
  assert.equal(viaSession.lineage.references[0].ref.id, 'clm_9');
  assert.ok(validateAgentWorkReceipt(viaSession).ok);
});

test('scan: the worker writes candidates and receipts that reference them, reading governed precedents from a local file', async () => {
  const { P, loadReceipts, loadSignals } = await import('../src/store.mjs');
  const { Worker } = await import('node:worker_threads');
  const before = loadSignals().length;
  fs.writeFileSync(P.governed, JSON.stringify({ 's-scan': [{ claimId: 'clm_scan', version: 1 }] }));
  const file = path.join(tmp, 's-scan.jsonl'); fs.copyFileSync(fx('claude-judgment.jsonl'), file);
  const w = new Worker(new URL('../src/worker.mjs', import.meta.url), { env: { ...process.env, TRAIL_HOME: tmp } });
  const msg = await new Promise((resolve) => { w.on('message', (m) => { if (m.ok !== undefined) resolve(m); }); w.postMessage({ file, client: 'claude' }); });
  await w.terminate();
  assert.ok(msg.ok, msg.error);
  const sigs = loadSignals().filter((x) => x.sessionId === 's-scan');
  assert.equal(sigs.length, 4); assert.ok(loadSignals().length >= before + 4);
  const [first] = loadReceipts('s-scan');
  assert.deepEqual(first.extensions[PRECEDENT_EXT].governedBy, [{ claimId: 'clm_scan', version: 1 }]);
  assert.deepEqual(first.extensions[PRECEDENT_EXT].signals.sort(), sigs.filter((x) => x.receiptId === first.receipt_id).map((x) => x.signalId).sort());
  assert.ok(first.trajectory.some((x) => x.trigger === 'human'));
});
