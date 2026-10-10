import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-live-repairs-'));
process.env.TRAIL_HOME = home; process.env.TRAIL_NO_KEYCHAIN = '1'; process.env.ORGX_API_KEY = 'test-key';
process.env.TRAIL_CLAUDE_SETTINGS = path.join(home, 'claude', 'settings.json');
const { ByteTail, LiveSession, startLiveCapture } = await import('../src/live.mjs');
const { receiptFingerprint, withIntegrity } = await import('../src/integrity.mjs');
const { syncReceipts, withLifecycle, SETTLE_MS } = await import('../src/sync.mjs');
const { steps } = await import('../src/steps.mjs');
const { threadify } = await import('../src/classify.mjs');
const { buildGoals } = await import('../src/goals.mjs');
const { buildReceipt, EXT } = await import('../src/receipt.mjs');
const { readClaude, readCodex } = await import('../src/adapters.mjs');
const { validateAgentWorkReceipt, verifyAgentWorkReceiptIntegrity, hashAgentWorkReceiptContent } = await import('@useorgx/agent-work-receipt');

const row = (type, content, timestamp = new Date().toISOString()) => JSON.stringify({ type, timestamp, cwd: '/workspace/example', message: { role: type, model: 'claude-test', content } }) + '\n';
const ask = (text, timestamp) => row('user', text, timestamp);
const tool = (id, command, timestamp) => row('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }], timestamp);
const result = (id, text, timestamp) => row('user', [{ type: 'tool_result', tool_use_id: id, content: text }], timestamp);
const report = (text, timestamp) => row('assistant', [{ type: 'text', text }], timestamp);
const file = (name, data) => { const target = path.join(home, name); fs.writeFileSync(target, data); return target; };
async function sampleReceipt() {
  const s = await readClaude(new URL('./fixtures/claude.jsonl', import.meta.url).pathname);
  const threads = threadify(s); const st = steps(s); const goal = buildGoals(s, threads, st)[0];
  return buildReceipt({ ...s, id: 'hash-test', label: 'Claude Code' }, goal, st, threads.threads.find((t) => t.id === goal.root));
}

test('R2: canonical AWR integrity covers evidence, intent, artifacts, checks and extensions; evidence edit is re-sent', async () => {
  const receipt = await sampleReceipt();
  assert.equal(receipt.integrity.content_hash.value, (await hashAgentWorkReceiptContent(receipt)).value);
  assert.equal((await verifyAgentWorkReceiptIntegrity(receipt)).content_hash.state, 'verified');
  const fp = receiptFingerprint(receipt);
  const mutations = [
    (r) => { r.evidence[0].excerpt = 'The corrected excerpt'; },
    (r) => { r.intent.objective += ' with a new constraint'; },
    (r) => { r.artifacts[0].name += ' corrected'; },
    (r) => { r.verification.checks[0].method += ' corrected'; },
    (r) => { r.extensions[EXT].episodes.push({ kind: 'new evidence' }); },
  ];
  for (const mutate of mutations) { const changed = structuredClone(receipt); mutate(changed); assert.notEqual(receiptFingerprint(changed), fp); }
  const reordered = Object.fromEntries(Object.entries(receipt).reverse());
  assert.equal(receiptFingerprint(reordered), fp, 'object insertion order has no effect');
  const alteredIntegrity = { ...receipt, integrity: { anything: 'excluded' } };
  assert.equal(receiptFingerprint(alteredIntegrity), fp, 'only root integrity is excluded');
  const uploads = [];
  const fetchImpl = async (_url, init) => {
    const envelope = JSON.parse(init.body); uploads.push(envelope.receipts);
    for (const item of envelope.receipts) assert.equal((await verifyAgentWorkReceiptIntegrity(item.receipt)).content_hash.state, 'verified');
    return { ok: true, status: 200, json: async () => ({ results: envelope.receipts.map(() => ({ ok: true })) }) };
  };
  assert.equal((await syncReceipts({ receipts: [receipt], fetchImpl })).receipts, 1);
  assert.equal((await syncReceipts({ receipts: [receipt], fetchImpl })).receipts, 0);
  const edited = structuredClone(receipt); edited.evidence[0].excerpt = 'The edited excerpt only';
  assert.equal((await syncReceipts({ receipts: [edited], fetchImpl })).receipts, 1);
  assert.notEqual(uploads[0][0].idempotency_key, uploads[1][0].idempotency_key);
  assert.equal(uploads[1][0].receipt.evidence[0].excerpt, 'The edited excerpt only');
});

test('R4: agreement is corroboration with correlated reads; core verification stays based on checks', async () => {
  const session = { ev: [{ k: 'ask', ts: '2026-10-01T00:00:00Z', text: 'Explain how this feature works', who: 'human' }, { k: 'say', ts: '2026-10-01T00:00:01Z', text: 'This feature works by collecting the user intent, storing durable evidence, and returning a useful answer. '.repeat(3) }] };
  const r = threadify(session); const st = steps(session);
  const goal = buildGoals(session, r, st, { sessionId: 'corroboration-test', readJev: () => ['done', 0.9] })[0];
  assert.equal(goal.corroborated, true); assert.equal(Object.hasOwn(goal, 'verified'), false);
  assert.equal(goal.corroboration.independent, false); assert.match(goal.corroboration.calibration, /92.*100%.*13%/);
  const receipt = buildReceipt({ ...session, id: 'corroboration-test', client: 'claude', label: 'Claude Code' }, goal, st, r.threads[0]);
  const baseline = buildReceipt({ ...session, id: 'corroboration-test', client: 'claude', label: 'Claude Code' }, buildGoals(session, r, st)[0], st, r.threads[0]);
  assert.equal(receipt.verification.status, baseline.verification.status);
  assert.equal(receipt.extensions[EXT].corroborated_by_two_reads, true);
  assert.equal(Object.hasOwn(receipt.extensions[EXT], 'verified_by_two_reads'), false);
});

test('R5: byte tail handles split UTF-8, partial records, truncation and inode rotation', () => {
  const target = file('tail.jsonl', ''); const tail = new ByteTail(target);
  const bytes = Buffer.from('{"text":"🌱"}\n'); const split = bytes.indexOf(Buffer.from('🌱')) + 2;
  fs.appendFileSync(target, bytes.subarray(0, split)); assert.deepEqual(tail.read().lines, []);
  fs.appendFileSync(target, bytes.subarray(split)); assert.deepEqual(tail.read().lines, ['{"text":"🌱"}']);
  assert.equal(tail.read().bytes, 0);
  fs.writeFileSync(target, 'x\n'); const truncated = tail.read(); assert.equal(truncated.reset, true); assert.deepEqual(truncated.lines, ['x']);
  const replacement = file('replacement.jsonl', 'y\n'); fs.renameSync(replacement, target);
  assert.equal(tail.read().reset, true);
});

test('R5: tool results in a later tail update the original call and checkpoint; historical goals stay cached', async () => {
  const target = file('pending.jsonl', ask('Run one diagnostic command') + tool('pending', 'npm test'));
  const live = new LiveSession(target, 'claude', { persist: false });
  const first = await live.update(); assert.equal(first.checkpoints[0].verification.status, 'unverified'); assert.equal(first.checkpoints[0].actions[0].status, 'running');
  fs.appendFileSync(target, result('pending', '8 passed'));
  const second = await live.update(); assert.equal(second.session.ev.length, 2);
  assert.equal(second.checkpoints[0].verification.status, 'passed');
  assert.notEqual(receiptFingerprint(first.checkpoints[0]), receiptFingerprint(second.checkpoints[0]));
  fs.appendFileSync(target, ask('Implement the next independent feature') + tool('next', 'rg feature src'));
  await live.update(); const historical = live.windows[0].receipts;
  fs.appendFileSync(target, result('next', 'found one file'));
  await live.update(); assert.strictEqual(live.windows[0].receipts, historical);
  assert.equal(live.windows.length, 2);
});

test('R5: incremental Claude and raw Codex parsers preserve batch reader semantics', async () => {
  for (const client of ['claude', 'codex']) {
    const source = fs.readFileSync(new URL(`./fixtures/${client}.jsonl`, import.meta.url), 'utf8');
    const target = file(`incremental-${client}.jsonl`, ''); const live = new LiveSession(target, client, { persist: false });
    for (const line of source.trimEnd().split('\n')) { fs.appendFileSync(target, line + '\n'); await live.update(); }
    const batch = await (client === 'claude' ? readClaude : readCodex)(target);
    const normalized = (events) => events.map(({ lane, slip, ...event }) => event);
    assert.deepEqual(normalized(live.session.ev), normalized(batch.ev));
    for (const checkpoint of live.windows.flatMap((w) => w.receipts)) assert.equal(validateAgentWorkReceipt(checkpoint).ok, true);
  }
});

test('R5: Codex raw-to-structured transition preserves earlier structured events on the next tail', async () => {
  const codexRow = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
  const target = file('switch-codex.jsonl', codexRow('response_item', { type: 'message', role: 'user', content: [{ text: 'Raw ask before structured items' }] }));
  const live = new LiveSession(target, 'codex', { persist: false }); await live.update();
  fs.appendFileSync(target, codexRow('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: 'Structured original goal' } }));
  await live.update();
  fs.appendFileSync(target, codexRow('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: ['npm', 'test'], exit_code: 0, aggregated_output: '12 passed', status: 'completed' } }));
  const appended = await live.update();
  assert.equal(appended.session.ev.length, 2); assert.equal(appended.session.ev[0].text, 'Structured original goal');
  assert.equal(appended.checkpoints[0].intent.summary, 'Structured original goal');
});

test('R3: filesystem changes send provisional checkpoints automatically and settle to final on the same receipt ID', async (t) => {
  const uploads = []; const latencies = []; let appendedAt;
  const server = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data); const documents = body.receipts || [];
    for (const { receipt } of documents) {
      assert.equal(validateAgentWorkReceipt(receipt).ok, true);
      assert.equal((await verifyAgentWorkReceiptIntegrity(receipt)).content_hash.state, 'verified');
      uploads.push(receipt); if (appendedAt) { latencies.push(performance.now() - appendedAt); appendedAt = null; }
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ results: documents.map(() => ({ ok: true })) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const target = file('automatic.jsonl', ask('Implement a feature with passing tests') + tool('first', 'npm test'));
  const errors = []; const capture = await startLiveCapture(target, 'claude', { receipts: true, base, settleMs: 150, persist: false, onError: (error) => errors.push(error) });
  const until = async (condition) => { const deadline = Date.now() + 2000; while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(condition(), 'event reached the receipt endpoint within 2 seconds'); };
  try {
    await capture.flushed(); const receiptId = uploads[0].receipt_id;
    assert.equal(uploads[0].extensions[EXT].lifecycle.status, 'provisional');
    appendedAt = performance.now(); fs.appendFileSync(target, result('first', '42 passed'));
    await until(() => uploads.some((r) => r.receipt_id === receiptId && r.verification.status === 'passed' && r.extensions[EXT].lifecycle.status === 'provisional'));
    await until(() => uploads.some((r) => r.receipt_id === receiptId && r.extensions[EXT].lifecycle.status === 'final'));
    assert.equal(errors.length, 0); assert.ok(latencies.every((ms) => ms < 2000));
    t.diagnostic(`checkpoint append-to-HTTP latency: ${latencies[0].toFixed(2)} ms`);
  } finally { capture.close(); await new Promise((resolve) => server.close(resolve)); }
});

test('R5 performance: every appended goal checkpoint on a 10 MB transcript completes under 100 ms', async (t) => {
  const rows = []; const payload = 'tool output '.repeat(450); let index = 0;
  while (rows.join('').length < 10 * 1024 * 1024) {
    rows.push(ask(`Implement independent feature ${index}`));
    for (let k = 0; k < 10; k++) rows.push(tool(`${index}-${k}`, 'npm test'), result(`${index}-${k}`, payload + '\n10 passed'));
    rows.push(report('The implementation and tests are complete. '.repeat(8))); index++;
  }
  const target = file('large.jsonl', rows.join('')); const live = new LiveSession(target, 'claude'); await live.update();
  assert.ok(fs.statSync(target).size >= 10 * 1024 * 1024);
  const times = [];
  for (let k = 0; k < 30; k++) {
    const appended = ask(`Implement appended independent feature ${k}`) + tool(`append-${k}`, 'npm test') + result(`append-${k}`, '12 passed') + report('The implementation was checked and every test now passes. '.repeat(5));
    fs.appendFileSync(target, appended); const started = performance.now(); const checkpoint = await live.update(); times.push(performance.now() - started);
    assert.equal(checkpoint.bytes, Buffer.byteLength(appended), 'reads exactly the new tail');
    assert.ok(checkpoint.checkpoints.length); assert.ok(times.at(-1) < 100, `checkpoint took ${times.at(-1).toFixed(2)} ms`);
  }
  const sorted = [...times].sort((a, b) => a - b);
  t.diagnostic(`10 MB transcript: 30 appended checkpoints, p95 ${sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)} ms, maximum ${sorted.at(-1).toFixed(2)} ms (including receipt persistence)`);
});

test('R3: installed harness hooks use the incremental worker; install/uninstall retain existing settings', async () => {
  const { installReceiptHooks, uninstallReceiptHooks, runReceiptHook, receiptHookWorker, receiptHookStatus } = await import('../src/receipt-hooks.mjs');
  const targetSettings = process.env.TRAIL_CLAUDE_SETTINGS;
  fs.mkdirSync(path.dirname(targetSettings), { recursive: true });
  fs.writeFileSync(targetSettings, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] } }));
  const bin = new URL('../bin/trail.mjs', import.meta.url).pathname;
  installReceiptHooks(bin, { base: 'https://orgx.test' }); installReceiptHooks(bin, { base: 'https://orgx.test' });
  assert.equal(receiptHookStatus().installed, true);
  const settings = JSON.parse(fs.readFileSync(targetSettings));
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) assert.equal(settings.hooks[event].flatMap((m) => m.hooks).filter((h) => h.statusMessage === 'orgx trail receipts').length, 1);
  const captures = []; let updates = 0; let closes = 0;
  const worker = await receiptHookWorker({ captureImpl: async (file, client, options) => { captures.push({ file, client, options }); return { update: async () => { updates++; }, close: () => { closes++; } }; } });
  try {
    const payload = { transcript_path: '/tmp/example.jsonl', hook_event_name: 'Stop' };
    await runReceiptHook(JSON.stringify(payload)); await runReceiptHook(JSON.stringify(payload));
    assert.equal(captures.length, 1); assert.equal(updates, 1); assert.equal(captures[0].options.receipts, true);
    const child = promisify(execFile)(process.execPath, [bin, 'receipt-hook', 'status'], { env: process.env });
    assert.equal(JSON.parse((await child).stdout).installed, true);
    const status = await uninstallReceiptHooks(); assert.equal(status.installed, false); assert.equal(closes, 1);
    const retained = JSON.parse(fs.readFileSync(targetSettings));
    assert.deepEqual(retained.permissions, { allow: ['Read'] }); assert.equal(retained.hooks.Stop[0].hooks[0].command, 'existing-hook');
    assert.equal((await runReceiptHook(JSON.stringify(payload))).skipped, true);
  } finally { if (worker.server.listening) await worker.close(); }
});

test('R3: late results reset the quiet clock, and outstanding calls cannot settle', async () => {
  const old = new Date(Date.now() - 40 * 60_000).toISOString();
  const target = file('late-result.jsonl', ask('Run one diagnostic command', old) + tool('long-test', 'npm test', old));
  const live = new LiveSession(target, 'claude', { persist: false }); await live.update();
  assert.equal(live.settled().length, 0, 'an outstanding call stays provisional despite old invocation time');
  const completed = new Date().toISOString(); fs.appendFileSync(target, result('long-test', '12 passed', completed));
  const updated = await live.update();
  assert.equal(updated.checkpoints[0].timestamps.completed_at, completed);
  assert.equal(updated.checkpoints[0].actions[0].completed_at, completed);
  assert.equal(live.settled(Date.now() + SETTLE_MS - 10).length, 0);
  assert.equal(live.settled(Date.now() + SETTLE_MS + 10).length, 1);
});

test('R2: exported graph-enriched receipts retain valid integrity', async () => {
  const { ledger, withGraph } = await import('../src/ledger.mjs');
  const { writeReceipts } = await import('../src/store.mjs');
  const receipt = await sampleReceipt(); writeReceipts('export-regression', [receipt]);
  const enriched = withGraph(receipt, ledger({ fresh: true }));
  assert.equal((await verifyAgentWorkReceiptIntegrity(enriched)).content_hash.state, 'verified');
  assert.equal(enriched.integrity.content_hash.value, receiptFingerprint(enriched));
});

test('R2: receipt batch limits report the complete remaining backlog', async () => {
  const receipt = await sampleReceipt();
  const documents = Array.from({ length: 60 }, (_, i) => ({ ...receipt, receipt_id: `batch-limit:${i}` }));
  const fetchImpl = async (_url, init) => { const body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ results: body.receipts.map(() => ({ ok: true })) }) }; };
  const dry = await syncReceipts({ receipts: documents, dryRun: true });
  assert.equal(dry.receipts, 50); assert.equal(dry.pending, 60);
  const first = await syncReceipts({ receipts: documents, fetchImpl });
  assert.equal(first.receipts, 50); assert.equal(first.remaining, 10);
  const second = await syncReceipts({ receipts: documents, fetchImpl });
  assert.equal(second.receipts, 10); assert.equal(second.remaining, 0);
});

test('R3: simultaneous worker startups acquire one exclusive owner and recover stale PID locks', async () => {
  const { installReceiptHooks, uninstallReceiptHooks, receiptHookWorker } = await import('../src/receipt-hooks.mjs');
  installReceiptHooks(new URL('../bin/trail.mjs', import.meta.url).pathname);
  fs.writeFileSync(path.join(home, 'receipt-hooks.lock'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  const workers = await Promise.all([receiptHookWorker(), receiptHookWorker(), receiptHookWorker()]);
  const owners = workers.filter(Boolean); assert.equal(owners.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'receipt-hooks.lock'))).pid, process.pid);
  await owners[0].close(); assert.equal(fs.existsSync(path.join(home, 'receipt-hooks.lock')), false);
  await uninstallReceiptHooks();
});

test('R3: live receipts preserve governed precedents and append judgment signals with receipt lineage', async () => {
  const { loadSignals } = await import('../src/store.mjs');
  const target = file('governed-live.jsonl', ask('Implement the feature') + tool('change', 'npm test') + result('change', '10 passed'));
  fs.writeFileSync(path.join(home, 'precedents-governed.json'), JSON.stringify({ 'governed-live': [{ claimId: 'precedent-123', version: 2 }] }));
  const live = new LiveSession(target, 'claude'); await live.update();
  fs.appendFileSync(target, ask('No, use the existing API instead'));
  const updated = await live.update(); const receipt = updated.checkpoints[0];
  assert.ok(receipt.lineage.references.some((ref) => ref.relationship === 'governed_by' && ref.ref.id === 'precedent-123'));
  const signals = loadSignals().filter((signal) => signal.receiptId === receipt.receipt_id);
  assert.equal(signals.length, 1); assert.equal(signals[0].kind, 'correction');
  assert.ok(Object.values(receipt.extensions).some((extension) => extension?.signals?.includes(signals[0].signalId)));
});

test('R2/R3: independent CLI and hook processes serialize uploads and preserve both sync-state entries', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-sync-processes-'));
  const script = `import fs from 'node:fs'; import path from 'node:path'; import { syncReceipts } from ${JSON.stringify(new URL('../src/sync.mjs', import.meta.url).href)};
    const id = process.argv[1]; await syncReceipts({lane:'provisional',receipts:[{receipt_id:id,timestamps:{started_at:'2026-10-01T00:00:00Z',completed_at:'2026-10-01T00:00:00Z'}}],fetchImpl:async()=>{
      fs.writeFileSync(path.join(process.env.TRAIL_HOME,id+'.ready'),''); if(id==='a') await new Promise(r=>setTimeout(r,350));
      return new Response(JSON.stringify({results:[{ok:true}]}),{status:200}); }});`;
  const run = (id) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, id], { env: { ...process.env, TRAIL_HOME: shared } });
  const first = run('a'); const deadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(shared, 'a.ready')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(fs.existsSync(path.join(shared, 'a.ready')));
  await Promise.all([first, run('b')]);
  const state = JSON.parse(fs.readFileSync(path.join(shared, 'sync.json')));
  assert.deepEqual(Object.keys(state.receipts).sort(), ['a', 'b']);
  assert.equal(fs.existsSync(path.join(shared, 'sync.lock')), false);
});

test('R3: older checkpoints cannot replace a newer or settled receipt; resumed activity can reopen it', async () => {
  const baseline = await sampleReceipt(); const id = 'revision-order-test'; let uploads = 0;
  const fetchImpl = async (_url, init) => { const body = JSON.parse(init.body); if (body.receipts) uploads++; return new Response(JSON.stringify({ results: body.receipts?.map(() => ({ ok: true })) || [] }), { status: 200 }); };
  const earlier = { ...baseline, receipt_id: id, timestamps: { ...baseline.timestamps, completed_at: new Date(Date.now() - 2 * SETTLE_MS).toISOString() } };
  const later = { ...earlier, timestamps: { ...earlier.timestamps, completed_at: new Date(Date.now() - SETTLE_MS - 1000).toISOString() } };
  assert.equal((await syncReceipts({ receipts: [later], lane: 'final', fetchImpl })).receipts, 1);
  assert.equal((await syncReceipts({ receipts: [earlier], lane: 'provisional', fetchImpl })).receipts, 0);
  assert.equal((await syncReceipts({ receipts: [later], lane: 'provisional', fetchImpl })).receipts, 0);
  assert.equal(uploads, 1);
  const resumed = structuredClone(later); resumed.extensions[EXT].lifecycle = { material_at: new Date().toISOString() }; resumed.evidence[0].excerpt = 'Newly observed result';
  assert.equal((await syncReceipts({ receipts: [resumed], lane: 'provisional', fetchImpl })).receipts, 1);
});
