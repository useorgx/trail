import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-stable-live-'));
process.env.TRAIL_HOME = home; process.env.TRAIL_NO_KEYCHAIN = '1'; process.env.ORGX_API_KEY = 'synthetic-stable-id-key';
const { LiveSession } = await import('../src/live.mjs');
const { allReceipts, writeReceipts, writeSession, appendLabel, loadLabels, loadSignals, P, ensure } = await import('../src/store.mjs');
const { readClaude } = await import('../src/adapters.mjs');
const { threadify } = await import('../src/classify.mjs');
const { steps } = await import('../src/steps.mjs');
const { buildGoals } = await import('../src/goals.mjs');
const { buildReceipt, EXT } = await import('../src/receipt.mjs');
const { REVIEW_EXT } = await import('../src/review.mjs');
const { overrideLabel, loadTaxonomy } = await import('../src/taxonomy.mjs');
const { syncReceipts, toSession } = await import('../src/sync.mjs');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const timestamp = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const row = (type, content, n = 0) => JSON.stringify({ type, timestamp: timestamp(n), cwd: '/workspace/synthetic', message: { role: type, content } }) + '\n';
const ask = (text, n = 0) => row('user', text, n);
const tool = (id, command, n = 1) => row('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }], n);
const result = (id, text = '8 passed', error = false, n = 2) => row('user', [{ type: 'tool_result', tool_use_id: id, content: text, is_error: error }], n);
const goal = (name, n = 0) => ask(`Implement ${name}`, n) + tool(name, 'npm test', n + 1) + result(name, '8 passed', false, n + 2);
const pending = () => ask('Implement original feature') + tool('a', 'npm test', 1) + tool('b', 'npm run build', 2) + tool('probe', 'rg feature src', 3) + result('probe', 'found feature', false, 4) + goal('later independent feature', 5);
const failures = () => result('a', 'FAIL test unexpected regression', true, 9) + result('b', 'Error building project', true, 10);
const source = (id, text) => { const file = path.join(home, `${id}.jsonl`); fs.writeFileSync(file, text); return file; };
const receipts = (live) => live.windows.flatMap((window) => window.receipts);
const rootOf = (live, text) => receipts(live).find((r) => r.intent.summary === text);
const own = (id) => allReceipts().filter((r) => r.lineage.run_ref.id === id);
const identities = (live) => live.windows.flatMap((window) => window.result.threads.map((thread) => [thread.at, thread.id])).sort((a, b) => a[0] - b[0]);
const batch = async (file) => {
  const worker = new Worker(new URL('../src/worker.mjs', import.meta.url));
  try {
    const completed = new Promise((resolve, reject) => { worker.on('error', reject); worker.on('message', (message) => { if ('ok' in message) resolve(message); }); });
    worker.postMessage({ file, client: 'claude' }); const output = await completed;
    if (!output.ok) throw new Error(output.error); return output.sess;
  } finally { await worker.terminate(); }
};

test('late earlier failures preserve later root and receipt IDs while adding unique resolvable detours', async () => {
  const file = source('late-stable', pending()); const live = new LiveSession(file, 'claude'); await live.update();
  const previous = rootOf(live, 'Implement later independent feature');
  fs.appendFileSync(file, failures()); await live.update();
  const current = rootOf(live, previous.intent.summary);
  assert.equal(current.receipt_id, previous.receipt_id);
  assert.equal(current.extensions[EXT].root_thread, previous.extensions[EXT].root_thread);
  const threads = live.windows.flatMap((window) => window.result.threads); const ids = new Set(threads.map((t) => t.id));
  assert.equal(ids.size, threads.length); assert.ok(threads.some((t) => t.kind === 'recovery'));
  for (const thread of threads) for (const ref of [thread.home, thread.parent].filter(Boolean)) assert.ok(ids.has(ref));
  for (const receipt of receipts(live)) for (const episode of receipt.extensions[EXT].episodes) assert.ok(ids.has(episode.thread));
  assert.equal(own('late-stable').filter((r) => r.intent.summary === previous.intent.summary).length, 1);
});

test('persisted identities survive a fresh capture process after a late-result reclassification', async () => {
  const file = source('restart-stable', pending()); const live = new LiveSession(file, 'claude'); await live.update();
  fs.appendFileSync(file, failures()); await live.update();
  const script = `import {LiveSession} from ${JSON.stringify(new URL('../src/live.mjs', import.meta.url).href)}; const live=new LiveSession(${JSON.stringify(file)},'claude');await live.update();console.log(JSON.stringify(live.windows.flatMap(w=>w.result.threads.map(t=>[t.at,t.id])).sort((a,b)=>a[0]-b[0])));`;
  const restarted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: process.env, encoding: 'utf8' }));
  assert.deepEqual(restarted, identities(live));
});

test('live-to-batch and batch-to-live use the same persisted aliases and receipt identities', async () => {
  for (const first of ['live', 'batch']) {
    const id = `cross-${first}`; const file = source(id, pending()); const live = new LiveSession(file, 'claude');
    let before;
    if (first === 'live') { await live.update(); before = rootOf(live, 'Implement later independent feature').receipt_id; }
    else { ensure(); const session = await batch(file); writeSession(session); before = own(id).find((r) => /later independent/.test(r.intent.summary)).receipt_id; }
    fs.appendFileSync(file, failures());
    if (first === 'live') await batch(file); else await live.update();
    assert.equal(own(id).find((r) => /later independent/.test(r.intent.summary)).receipt_id, before);
    const restart = new LiveSession(file, 'claude'); await restart.update();
    const full = await batch(file);
    assert.deepEqual(full.threads.map((t) => [t.at, t.id]), identities(restart));
  }
});

test('different tail chunk boundaries agree with a fresh full read of the same source events', async () => {
  const text = pending() + failures(); const fullFile = source('chunks-full', text);
  const full = new LiveSession(fullFile, 'claude'); await full.update();
  const tailFile = source('chunks-tail', ''); const tail = new LiveSession(tailFile, 'claude');
  for (const line of text.trimEnd().split('\n')) { fs.appendFileSync(tailFile, line + '\n'); await tail.update(); }
  assert.deepEqual(identities(tail), identities(full));
});

test('human labels, receipt overrides, governed precedents, signals and sync dedupe keep their targets', async () => {
  ensure(); const file = source('annotations', pending()); const live = new LiveSession(file, 'claude'); await live.update();
  const later = rootOf(live, 'Implement later independent feature'); const rid = later.receipt_id; const tid = later.extensions[EXT].root_thread;
  appendLabel({ session: 'annotations', client: 'claude', thread: tid, status: 'done' });
  overrideLabel(rid, { outcome: 'succeeded', work_type: 'maintenance' });
  fs.writeFileSync(P.governed, JSON.stringify({ [rid]: [{ claimId: 'synthetic-rule', version: '1' }] }));
  fs.appendFileSync(file, ask('No, keep the existing behavior instead', 8)); await live.update();
  const before = rootOf(live, later.intent.summary); const labels = fs.readFileSync(P.labels, 'utf8');
  const fetchImpl = async (_url, init) => ({ ok: true, status: 200, json: async () => ({ results: JSON.parse(init.body).receipts.map(() => ({ ok: true })) }) });
  assert.equal((await syncReceipts({ receipts: [before], lane: 'provisional', fetchImpl })).receipts, 1);
  fs.appendFileSync(file, failures()); await live.update(); const after = rootOf(live, later.intent.summary);
  assert.equal(after.receipt_id, rid); assert.equal(after.extensions[EXT].root_thread, tid);
  assert.equal((await syncReceipts({ receipts: [after], lane: 'provisional', fetchImpl })).receipts, 0);
  assert.equal(fs.readFileSync(P.labels, 'utf8'), labels); assert.equal(loadLabels().find((l) => l.session === 'annotations').thread, tid);
  assert.equal(loadTaxonomy().overrides[rid].outcome, 'succeeded');
  assert.ok(after.lineage.references.some((ref) => ref.relationship === 'governed_by'));
  assert.ok(loadSignals().some((signal) => signal.receiptId === rid && /existing behavior/.test(signal.text)));
});

test('empty reset and inode rotation reserve prior aliases; raw-to-structured replacement cannot reuse them', async () => {
  const text = goal('same opening'); const file = source('epochs', text); const live = new LiveSession(file, 'claude'); await live.update();
  const before = receipts(live)[0].extensions[EXT].root_thread;
  fs.writeFileSync(file, ''); await live.update(); fs.appendFileSync(file, text); await live.update();
  const emptied = receipts(live)[0].extensions[EXT].root_thread; assert.notEqual(emptied, before);
  const replacement = source('epoch-replacement', text); fs.renameSync(replacement, file); await live.update();
  assert.notEqual(receipts(live)[0].extensions[EXT].root_thread, emptied);
  const codexRow = (type, payload) => JSON.stringify({ timestamp: timestamp(0), type, payload }) + '\n';
  const codexFile = source('representation', codexRow('response_item', { type: 'message', role: 'user', content: [{ text: 'Implement same request' }] }));
  const codex = new LiveSession(codexFile, 'codex'); await codex.update(); const raw = receipts(codex)[0].receipt_id;
  fs.appendFileSync(codexFile, codexRow('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: 'Implement same request' } }));
  await codex.update(); assert.notEqual(receipts(codex)[0].receipt_id, raw);
});

test('later-window thread opening indices join recovery review episodes to the global source steps', async () => {
  const file = source('global-review', goal('earlier feature') + ask('Implement later checked feature', 5) + tool('fail-a', 'npm test', 6) + result('fail-a', 'FAIL first test', true, 7) + tool('fail-b', 'npm run build', 8) + result('fail-b', 'Error building', true, 9) + tool('next-probe', 'rg feature src', 10) + result('next-probe', 'found feature', false, 11));
  const live = new LiveSession(file, 'claude'); await live.update();
  const recovery = live.windows[1].result.threads.find((thread) => thread.kind === 'recovery');
  const at = live.session.ev.findIndex((event) => event.target === 'npm run build'); assert.equal(recovery.at, at);
  const receipt = rootOf(live, 'Implement later checked feature');
  const retry = receipt.extensions[REVIEW_EXT].episodes.find((episode) => episode.thread === recovery.id);
  assert.ok(retry); assert.equal(retry.at, timestamp(8)); assert.ok(retry.action_ids.includes(`step-${at}`));
});

test('exact legacy request evidence preserves aliases; conflicting historical bindings refuse only that session', async () => {
  for (const ambiguous of [false, true]) {
    const id = ambiguous ? 'legacy-conflict' : 'legacy-exact'; const file = source(id, pending()); const session = await readClaude(file);
    const threads = threadify(session); const st = steps(session); const goals = buildGoals(session, threads, st);
    const meta = { ...session, client: 'claude', id, label: 'Claude Code' };
    const old = goals.map((goal) => buildReceipt(meta, goal, st, threads.threads.find((thread) => thread.id === goal.root)));
    if (ambiguous) old.push({ ...old[1], receipt_id: `trail:claude:${id}:T9`, extensions: { ...old[1].extensions, [EXT]: { ...old[1].extensions[EXT], root_thread: 'T9' } } });
    writeReceipts(id, old); const original = fs.readFileSync(path.join(P.receipts, `${id}.json`), 'utf8');
    const live = new LiveSession(file, 'claude');
    if (ambiguous) {
      await assert.rejects(live.update(), /identity conflicts/i);
      await assert.rejects(new LiveSession(file, 'claude').update(), /identity conflicts/i);
      assert.equal(fs.readFileSync(path.join(P.receipts, `${id}.json`), 'utf8'), original);
    } else { await live.update(); assert.equal(rootOf(live, old[1].intent.summary).receipt_id, old[1].receipt_id); }
  }
  await new LiveSession(source('independent-safe', goal('independent safe work')), 'claude').update();
  assert.equal(own('independent-safe').length, 1);
});

test('cooperating scan workers share allocation without collisions or remapping', async () => {
  const file = source('concurrent-identities', pending() + failures());
  const [first, second] = await Promise.all([batch(file), batch(file)]);
  assert.deepEqual(first.threads.map((t) => t.id), second.threads.map((t) => t.id));
  assert.equal(new Set(first.threads.map((t) => t.id)).size, first.threads.length);
  const live = new LiveSession(file, 'claude'); await live.update();
  assert.deepEqual(first.threads.map((t) => [t.at, t.id]), identities(live));
});

test('outline transport preserves larger stable aliases and refuses unsafe IDs instead of renumbering them', async () => {
  const session = await batch(source('outline-identities', goal('outline feature')));
  for (const id of ['T100001', 'T0', 'T0001']) {
    session.threads[0].id = id;
    assert.equal(toSession(session, false).threads[0].id, id);
  }
  for (const id of ['T9007199254740992', 'T-1', 'arbitrary-source-text']) {
    session.threads[0].id = id;
    assert.throws(() => toSession(session, false), /invalid stable thread identity/);
  }
});
