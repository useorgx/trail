import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-checkpoint-reset-'));
process.env.TRAIL_HOME = home;
process.env.TRAIL_NO_KEYCHAIN = '1';
process.env.ORGX_API_KEY = 'synthetic-checkpoint-reset-key';
const { LiveSession } = await import('../src/live.mjs');
const { allReceipts, writeReceipts, P, ensure, appendLabel, appendSignals } = await import('../src/store.mjs');
const { ledger } = await import('../src/ledger.mjs');
const { syncReceipts } = await import('../src/sync.mjs');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const stamp = '2026-10-01T00:00:00Z';
const row = (type, content) => JSON.stringify({ type, timestamp: stamp, cwd: '/workspace/synthetic', message: { role: type, content } }) + '\n';
const goal = (name) => row('user', `Implement ${name}`)
  + row('assistant', [{ type: 'tool_use', id: name, name: 'Bash', input: { command: 'npm test' } }])
  + row('user', [{ type: 'tool_result', tool_use_id: name, content: '8 passed' }]);
const source = (id, text) => { const file = path.join(home, `${id}.jsonl`); fs.writeFileSync(file, text); return file; };
const own = (id, receipts = allReceipts()) => receipts.filter((r) => r.lineage.run_ref.id === id);
const checkpointFiles = (id) => fs.readdirSync(P.receipts).filter((name) => name.startsWith(`${id}--checkpoint-`));
const restartedReceipts = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import { allReceipts } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)}; console.log(JSON.stringify(allReceipts()));`], { env: process.env, encoding: 'utf8' }));

test('truncation excludes removed live goals from ledger and default sync while retaining checkpoint history', async () => {
  const id = 'truncated'; const first = goal('first feature'); const file = source(id, first + goal('removed feature'));
  const live = new LiveSession(file, 'claude'); await live.update();
  const before = own(id); assert.equal(before.length, 2);
  assert.equal(fs.statSync(P.checkpoints).mode & 0o077, 0);
  for (const name of fs.readdirSync(P.checkpoints)) assert.equal(fs.statSync(path.join(P.checkpoints, name)).mode & 0o077, 0);
  const oldFiles = checkpointFiles(id);
  fs.writeFileSync(file, first); await live.update();
  assert.equal(live.windows.length, 1);
  assert.deepEqual(own(id).map((r) => r.intent.summary), ['Implement first feature']);
  assert.equal(own(id, ledger({ fresh: true }).receipts).length, 1);
  assert.deepEqual(checkpointFiles(id), oldFiles, 'historical shards are retained, not deleted');
  const uploaded = [];
  await syncReceipts({ base: 'https://synthetic.invalid', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); uploaded.push(...(body.receipts || []).map((x) => x.receipt));
    return { ok: true, status: 200, json: async () => ({ results: (body.receipts || []).map(() => ({ ok: true })) }) };
  } });
  assert.equal(own(id, uploaded).length, 1, 'default sync uses the reconciled ledger');
  assert.equal(own(id, restartedReceipts()).length, 1, 'the active set survives process restart');
});

test('rotation of the same logical session reconciles orphan shards even in a fresh LiveSession', async () => {
  const id = 'rotated'; const file = source(id, goal('rotation first') + goal('rotation removed'));
  await new LiveSession(file, 'claude').update();
  const replacement = source('replacement', goal('rotation replacement'));
  fs.renameSync(replacement, file);
  await new LiveSession(file, 'claude').update();
  assert.deepEqual(own(id).map((r) => r.intent.summary), ['Implement rotation replacement']);
  assert.equal(checkpointFiles(id).length, 2);
});

test('empty reset clears active receipts and notifies the live view; appending a new goal reactivates its shard', async () => {
  const id = 'emptied'; const file = source(id, goal('empty old one') + goal('empty old two'));
  const live = new LiveSession(file, 'claude'); await live.update();
  fs.writeFileSync(file, '');
  const cleared = await live.update();
  assert.equal(cleared.changed, true);
  assert.deepEqual(cleared.windows, []); assert.deepEqual(cleared.session.ev, []);
  assert.equal(own(id).length, 0);
  assert.equal(own(id, restartedReceipts()).length, 0);
  assert.equal((await live.update()).changed, false, 'an unchanged empty tail does no work');
  fs.appendFileSync(file, goal('empty replacement'));
  await live.update();
  assert.deepEqual(own(id).map((r) => r.intent.summary), ['Implement empty replacement']);
});

test('a worker restart observes a transcript emptied while capture was stopped', async () => {
  const id = 'stopped-empty'; const file = source(id, goal('stopped old'));
  await new LiveSession(file, 'claude').update();
  fs.writeFileSync(file, '');
  await new LiveSession(file, 'claude').update();
  assert.equal(own(id).length, 0);
});

test('an incomplete replacement record does not retire checkpoints until a complete snapshot can rebuild', async () => {
  const id = 'partial-reset'; const file = source(id, goal('partial old first') + goal('partial old second'));
  const live = new LiveSession(file, 'claude'); await live.update();
  const replacement = row('user', 'Implement partial replacement'); const split = Math.floor(replacement.length / 2);
  fs.writeFileSync(file, replacement.slice(0, split));
  assert.equal((await live.update()).changed, false);
  assert.equal(own(id).length, 2, 'an incomplete line has not successfully rebuilt the session');
  fs.appendFileSync(file, replacement.slice(split));
  assert.equal((await live.update()).changed, true);
  assert.deepEqual(own(id).map((r) => r.intent.summary), ['Implement partial replacement']);
});

const snapshot = (id, names) => JSON.stringify({ sessionId: id, creationDate: Date.parse(stamp), requests: names.map((name) => ({ timestamp: Date.parse(stamp), message: { text: `Implement ${name}` }, response: [{ kind: 'toolInvocationSerialized', toolCallId: name, toolId: 'run_in_terminal', isComplete: true, resultDetails: { input: JSON.stringify({ command: 'npm test' }), output: '8 passed' } }] })) });

test('mutable snapshots replace their active set and keep a genuinely different session history', async () => {
  const file = path.join(home, 'mutable.json'); fs.writeFileSync(file, snapshot('snapshot-a', ['snapshot first', 'snapshot removed']));
  const live = new LiveSession(file, 'copilot'); await live.update();
  fs.writeFileSync(file, snapshot('snapshot-a', ['snapshot replacement'])); await live.update();
  assert.deepEqual(own('copilot-snapshot-a').map((r) => r.intent.summary), ['Implement snapshot replacement']);
  fs.writeFileSync(file, snapshot('snapshot-b', ['different session'])); await live.update();
  assert.equal(own('copilot-snapshot-a').length, 1, 'new logical session does not erase earlier work');
  assert.equal(own('copilot-snapshot-b').length, 1);
  fs.writeFileSync(file, snapshot('snapshot-b', [])); await live.update();
  assert.equal(own('copilot-snapshot-b').length, 0);
  assert.equal(own('copilot-snapshot-a').length, 1);
  fs.writeFileSync(file, snapshot('snapshot-b', ['resumed different session'])); await live.update();
  assert.equal(own('copilot-snapshot-b').length, 1);
  fs.writeFileSync(file, ''); await new LiveSession(file, 'copilot').update();
  assert.equal(own('copilot-snapshot-a').length, 1, 'zero-byte restart uses the last source identity without touching an older logical session');
  assert.equal(own('copilot-snapshot-b').length, 0);
});

test('reconciliation preserves full scans, prefix-sharing sessions, signals, labels and legacy unowned checkpoints', async () => {
  ensure();
  const id = 'preserved'; const first = goal('preserved first'); const file = source(id, first + goal('historical full scan'));
  const live = new LiveSession(file, 'claude'); await live.update();
  const historical = own(id)[1]; writeReceipts(id, [historical]);
  const other = source(`${id}-other`, goal('unrelated session')); await new LiveSession(other, 'claude').update();
  writeReceipts('legacy--checkpoint-0', [{ ...historical, receipt_id: 'legacy-receipt', lineage: { ...historical.lineage, run_ref: { ...historical.lineage.run_ref, id: 'legacy' } } }]);
  appendLabel({ receipt_id: historical.receipt_id, label: 'human review' });
  appendSignals([{ signalId: 'synthetic-preserved-signal', text: 'Keep the existing behavior', receiptId: historical.receipt_id }]);
  const labels = fs.readFileSync(P.labels, 'utf8'); const signals = fs.readFileSync(P.signals, 'utf8');
  fs.writeFileSync(file, first); await live.update();
  assert.equal(own(id).length, 2, 'ordinary full-scan history remains eligible, even with a retired live receipt ID');
  assert.equal(own(`${id}-other`).length, 1);
  assert.ok(allReceipts().some((r) => r.receipt_id === 'legacy-receipt'));
  assert.equal(fs.readFileSync(P.labels, 'utf8'), labels);
  assert.equal(fs.readFileSync(P.signals, 'utf8'), signals);
});

test('failed rebuild keeps the prior active set until a successful replacement is persisted', async () => {
  const id = 'failed-rebuild'; const first = goal('failed first'); const file = source(id, first + goal('failed retained'));
  const live = new LiveSession(file, 'claude'); await live.update();
  fs.writeFileSync(file, first);
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    if (String(target).endsWith(`${id}--checkpoint-0.json`)) throw new Error('synthetic checkpoint write failure');
    return write(target, ...args);
  };
  try { await assert.rejects(live.update(), /synthetic checkpoint write failure/); }
  finally { fs.writeFileSync = write; }
  assert.equal(own(id).length, 2);
  await new LiveSession(file, 'claude').update(); assert.equal(own(id).length, 1);
});

test('unchanged and result-only appends do not scan receipt history or rewrite active checkpoint manifests', async () => {
  const id = 'append-cost'; const file = source(id, goal('cached historical'));
  const live = new LiveSession(file, 'claude'); await live.update();
  fs.appendFileSync(file, row('user', 'Implement active next') + row('assistant', [{ type: 'tool_use', id: 'pending', name: 'Bash', input: { command: 'npm test' } }]));
  await live.update(); const historical = live.windows[0].receipts;
  const writes = []; const reads = []; const write = fs.writeFileSync; const read = fs.readdirSync;
  fs.writeFileSync = (target, ...args) => { writes.push(String(target)); return write(target, ...args); };
  fs.readdirSync = (target, ...args) => { reads.push(String(target)); return read(target, ...args); };
  try {
    assert.equal((await live.update()).changed, false);
    fs.appendFileSync(file, row('user', [{ type: 'tool_result', tool_use_id: 'pending', content: '8 passed' }]));
    await live.update();
  } finally { fs.writeFileSync = write; fs.readdirSync = read; }
  assert.strictEqual(live.windows[0].receipts, historical);
  assert.deepEqual(reads, [], 'no receipt directory/history scan on append');
  const stored = writes.filter((target) => path.dirname(target) === P.receipts || path.dirname(target) === P.checkpoints);
  assert.equal(stored.length, 1, 'only the affected checkpoint is written');
  assert.ok(stored[0].endsWith('--checkpoint-2.json'));
});
