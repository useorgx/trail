import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-thread-identities-'));
process.env.TRAIL_HOME = home; process.env.TRAIL_NO_KEYCHAIN = '1';
const { assignThreadIdentities } = await import('../src/identity.mjs');
const { P } = await import('../src/store.mjs');
after(() => fs.rmSync(home, { recursive: true, force: true }));
const stamp = '2026-10-01T00:00:00Z';
const ask = (text) => ({ k: 'ask', ts: stamp, who: 'human', text });
const tool = (target) => ({ k: 'tool', ts: stamp, tool: 'Bash', rawTool: 'Bash', target, pending: true, err: false });
const thread = (id, at) => ({ id, at });
function fixture(id, events, client = 'claude') {
  const file = path.join(home, `${id}.${client === 'claude' || client === 'codex' ? 'jsonl' : 'json'}`);
  fs.writeFileSync(file, 'synthetic source record\n'.repeat(30));
  return { file, client, id, events };
}
const allocate = async (input, threads) => assignThreadIdentities({ ...input, threads });
const output = (result) => [...result.ids];
const childScript = `const {assignThreadIdentities}=await import(${JSON.stringify(new URL('../src/identity.mjs', import.meta.url).href)}); const r=await assignThreadIdentities(JSON.parse(process.argv[1])); console.log(JSON.stringify({ids:[...r.ids],conflicts:r.conflicts}));`;
const child = async (input) => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', childScript, JSON.stringify(input)], { env: process.env, encoding: 'utf8' })).stdout);
const registryFile = (input) => path.join(home, 'thread-identities', crypto.createHash('sha256').update(JSON.stringify([input.client, input.id])).digest('hex') + '.json');
const ownReceipts = (id, documents) => { fs.mkdirSync(P.receipts, { recursive: true }); fs.writeFileSync(path.join(P.receipts, id + '.json'), JSON.stringify(documents)); };
const oldReceipt = (input, alias, at, text = input.events[at].text) => ({
  receipt_id: `trail:${input.client}:${input.id}:${alias}`,
  lineage: { run_ref: { system: input.client, type: 'session', id: input.id } },
  extensions: { 'org.orgx.trail/v1': { root_thread: alias } },
  evidence: [{ kind: 'request', observed_at: input.events[at].ts, excerpt: text, ref: { system: input.client, type: 'transcript_event', id: `${input.id}#${at}` } }],
});

test('late results and newly inferred earlier detours retain existing aliases after process restart', async () => {
  const input = fixture('late-detours', [ask('Implement first synthetic feature'), tool('npm test'), tool('npm run build'), ask('Implement unrelated later feature'), tool('npm test')]);
  const first = await allocate(input, [thread('T1', 0), thread('T2', 3)]);
  assert.deepEqual(output(first), [['T1', 'T1'], ['T2', 'T4']]);
  Object.assign(input.events[1], { pending: false, err: true, errText: 'FAIL synthetic result', completedAt: stamp, lane: 'check' });
  Object.assign(input.events[2], { pending: false, err: true, denied: false, outTail: 'FAIL synthetic result' });
  fs.appendFileSync(input.file, 'synthetic result append\n');
  const changed = await allocate(input, [thread('T1', 0), thread('T2', 2), thread('T3', 3)]);
  assert.deepEqual(output(changed), [['T1', 'T1'], ['T2', 'T3'], ['T3', 'T4']]);
  assert.equal(new Set(changed.ids.values()).size, 3);
  const restarted = await child({ ...input, threads: [thread('T1', 0), thread('T2', 2), thread('T3', 3)] });
  assert.deepEqual(restarted.ids, output(changed));
});

test('fresh batch and differently chunked live captures choose the same source-index defaults', async () => {
  const events = [ask('First root'), tool('npm test'), tool('npm run build'), ask('Second root'), tool('npm test')];
  const batch = fixture('fresh-batch', events); const live = fixture('fresh-live', events);
  const finalThreads = [thread('T1', 0), thread('T2', 2), thread('T3', 3)];
  const once = await allocate(batch, finalThreads);
  await allocate(live, [thread('T1', 0)]);
  await allocate(live, [thread('T1', 0), thread('T2', 3)]);
  const chunked = await allocate(live, finalThreads);
  assert.deepEqual(output(chunked), output(once));
  const offset = await assignThreadIdentities({ ...live, threads: [thread('T1', 0)], offset: 3 });
  assert.equal(offset.ids.get('T1'), once.ids.get('T3'), 'window-local opening indices resolve through the shared global event');
});

test('physical rotation and observed empty truncation allocate disjoint source generations', async () => {
  const input = fixture('replacement-generations', [ask('Repeated immutable synthetic opener')]);
  const original = (await allocate(input, [thread('T1', 0)])).ids.get('T1');
  const replacement = input.file + '.replacement'; fs.writeFileSync(replacement, 'rotated source\n'); fs.renameSync(replacement, input.file);
  const rotated = (await allocate(input, [thread('T1', 0)])).ids.get('T1'); assert.notEqual(rotated, original);
  fs.writeFileSync(input.file, ''); await allocate({ ...input, events: [] }, []);
  fs.appendFileSync(input.file, 'larger replacement\n'.repeat(100));
  const truncated = (await allocate(input, [thread('T1', 0)])).ids.get('T1');
  assert.notEqual(truncated, original); assert.notEqual(truncated, rotated);
  assert.equal((await child({ ...input, threads: [thread('T1', 0)] })).ids[0][1], truncated);
});

test('representation changes cannot repoint old aliases, while snapshot result rewrites keep their opening', async () => {
  const raw = fixture('representation-change', [ask('Stable source ask')], 'codex');
  const first = await assignThreadIdentities({ ...raw, threads: [thread('T1', 0)], representation: 'raw' });
  const items = await assignThreadIdentities({ ...raw, threads: [thread('T1', 0)], representation: 'items' });
  assert.notEqual(first.ids.get('T1'), items.ids.get('T1'));
  const snapshot = fixture('snapshot-results', [ask('Snapshot source ask'), tool('npm test')], 'copilot');
  const old = await allocate(snapshot, [thread('T1', 0)]);
  fs.writeFileSync(snapshot.file, '{}'); snapshot.events[1].pending = false; snapshot.events[1].err = true;
  assert.deepEqual(output(await allocate(snapshot, [thread('T1', 0)])), output(old));
  snapshot.events[0] = ask('A different snapshot source ask');
  assert.notEqual((await allocate(snapshot, [thread('T1', 0)])).ids.get('T1'), old.ids.get('T1'));
});

test('unambiguous historical receipt and session-span aliases win over new defaults', async () => {
  const input = fixture('legacy-exact', [ask('Legacy first source ask'), tool('npm test'), tool('npm run build'), ask('Legacy second source ask')]);
  ownReceipts(input.id, [oldReceipt(input, 'T1', 0), oldReceipt(input, 'T2', 3)]);
  fs.mkdirSync(P.sessions, { recursive: true });
  fs.writeFileSync(path.join(P.sessions, input.id + '.json'), JSON.stringify({ id: input.id, client: input.client, threads: [{ id: 'T1', t0: stamp, ask: input.events[0].text, spans: [[0, 2]] }, { id: 'T2', t0: stamp, ask: input.events[3].text, spans: [[3, 3]] }, { id: 'T40', t0: '2020-01-01T00:00:00Z', spans: [[1, 1]] }] }));
  const aliases = await allocate(input, [thread('T1', 0), thread('T2', 2), thread('T3', 3)]);
  assert.deepEqual(aliases.conflicts, []);
  assert.equal(aliases.ids.get('T1'), 'T1'); assert.equal(aliases.ids.get('T3'), 'T2');
  assert.ok(!['T1', 'T2', 'T40'].includes(aliases.ids.get('T2')));
  assert.ok(JSON.parse(fs.readFileSync(registryFile(input), 'utf8')).reserved.includes('T40'));
});

test('conflicting historical aliases are retained and reported durably without raw prompt text', async () => {
  const input = fixture('legacy-conflict', [ask('Private synthetic request must stay out of identity metadata')]);
  ownReceipts(input.id, [oldReceipt(input, 'T2', 0), oldReceipt(input, 'T3', 0)]);
  const before = fs.readFileSync(path.join(P.receipts, input.id + '.json'), 'utf8');
  const initial = await allocate(input, [thread('T1', 0)]);
  assert.deepEqual(output(initial), []); assert.deepEqual(initial.conflicts, [{ kind: 'legacy_alias_conflict', at: 0, aliases: ['T2', 'T3'] }]);
  assert.deepEqual((await allocate(input, [thread('T1', 0)])).conflicts, initial.conflicts);
  assert.deepEqual((await child({ ...input, threads: [thread('T1', 0)] })).conflicts, initial.conflicts);
  assert.equal(fs.readFileSync(path.join(P.receipts, input.id + '.json'), 'utf8'), before);
  assert.ok(!fs.readFileSync(registryFile(input), 'utf8').includes(input.events[0].text));
});

test('legacy evidence mismatch only reserves an unused ID and never guesses by title', async () => {
  const input = fixture('legacy-unused', [ask('Current unrelated source ask')]);
  ownReceipts(input.id, [oldReceipt(input, 'T10', 0, 'Old unrelated source ask')]);
  fs.mkdirSync(P.sessions, { recursive: true });
  fs.writeFileSync(path.join(P.sessions, input.id + '.json'), JSON.stringify({ id: input.id, client: input.client, threads: [{ id: 'T10', t0: stamp, ask: 'Old unrelated source ask', title: input.events[0].text, spans: [[0, 0]] }] }));
  const result = await allocate(input, [thread('T1', 0)]);
  assert.deepEqual(result.conflicts, []); assert.notEqual(result.ids.get('T1'), 'T10');
});

test('annotation-only historical targets are reserved without altering labels, reviews or precedents', async () => {
  const input = fixture('orphan-annotations', [ask('Replacement work without legacy source evidence')]);
  const receipt = (alias) => `trail:${input.client}:${input.id}:${alias}`;
  const files = [P.labels, P.signals, P.governed, path.join(home, 'taxonomy.json')];
  const before = new Map(files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
  fs.writeFileSync(P.labels, JSON.stringify({ session: input.id, client: input.client, thread: 'T1', status: 'done' }) + '\n');
  fs.writeFileSync(P.signals, JSON.stringify({ signalId: 'synthetic-identity-signal', receiptId: receipt('T2') }) + '\n');
  fs.writeFileSync(P.governed, JSON.stringify({ [receipt('T3')]: [{ claimId: 'synthetic-claim' }] }));
  fs.writeFileSync(path.join(home, 'taxonomy.json'), JSON.stringify({ overrides: { [receipt('T4')]: { by: 'human', outcome: 'succeeded' } } }));
  const snapshots = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]));
  try {
    const result = await allocate(input, [thread('T1', 0)]);
    assert.deepEqual(result.conflicts, []); assert.equal(result.ids.get('T1'), 'T5');
    for (const [file, content] of snapshots) assert.equal(fs.readFileSync(file, 'utf8'), content);
  } finally {
    for (const [file, content] of before) { if (content === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, content); }
  }
});

test('cooperating processes allocate unique aliases and reuse each other\'s bindings', async () => {
  const input = fixture('process-cooperation', [ask('First concurrent root'), tool('npm test'), ask('Second concurrent root')]);
  const [left, right] = await Promise.all([child({ ...input, threads: [thread('T1', 0)] }), child({ ...input, threads: [thread('T1', 2)] })]);
  assert.equal(left.conflicts.length, 0); assert.equal(right.conflicts.length, 0);
  assert.notEqual(left.ids[0][1], right.ids[0][1]);
  assert.deepEqual(output(await allocate(input, [thread('T1', 0), thread('T2', 2)])), [['T1', left.ids[0][1]], ['T2', right.ids[0][1]]]);
});

test('known result-only appends read no history and never rewrite the complete identity map', async () => {
  const input = fixture('append-identity-cost', [ask('Cached root'), tool('npm test')]);
  await allocate(input, [thread('T1', 0)]);
  fs.appendFileSync(input.file, 'synthetic appended result\n'); input.events[1].pending = false;
  const reads = []; const writes = []; const read = fs.readFileSync; const write = fs.writeFileSync; const list = fs.readdirSync;
  fs.readFileSync = (target, ...args) => { reads.push(String(target)); return read(target, ...args); };
  fs.writeFileSync = (target, ...args) => { writes.push(String(target)); return write(target, ...args); };
  fs.readdirSync = () => { throw new Error('Unexpected history scan'); };
  try { assert.equal((await allocate(input, [thread('T1', 0)])).ids.get('T1'), 'T1'); }
  finally { fs.readFileSync = read; fs.writeFileSync = write; fs.readdirSync = list; }
  assert.ok(!reads.includes(registryFile(input)));
  assert.ok(!writes.some((file) => file.startsWith(registryFile(input) + '.')));
  assert.ok(writes.some((file) => file.includes('.source.json.')), 'only a constant-size source observation is refreshed');
});

test('duplicate opening claims and corrupt state fail safely, while persist:false remains scoped in memory', async () => {
  const duplicate = fixture('duplicate-openers', [ask('One immutable opener')]);
  const conflict = await allocate(duplicate, [thread('T1', 0), thread('T2', 0)]);
  assert.equal(conflict.conflicts[0].kind, 'duplicate_source_opening'); assert.equal(conflict.ids.size, 0);
  const corrupt = fixture('corrupt-state', [ask('No alias reuse after corrupt state')]);
  await allocate(corrupt, [thread('T1', 0)]); fs.writeFileSync(registryFile(corrupt), '{broken');
  await assert.rejects(allocate(corrupt, [thread('T1', 0)]), /Cannot read stable thread identity state/);
  assert.equal(fs.readFileSync(registryFile(corrupt), 'utf8'), '{broken');
  const memory = fixture('memory-scope', [ask('Ephemeral first'), tool('npm test'), ask('Ephemeral later')]);
  await assignThreadIdentities({ ...memory, threads: [thread('T1', 0)], persist: false });
  const later = await assignThreadIdentities({ ...memory, threads: [thread('T1', 2)], persist: false });
  assert.equal(later.ids.get('T1'), 'T3'); assert.equal(fs.existsSync(registryFile(memory)), false);
});

test('failed atomic writes retry without losing allocations or shifting a new source generation range', async () => {
  const input = fixture('atomic-epoch-retry', [ask('Repeated opener across a rotated source')]);
  await allocate(input, [thread('T1', 0)]);
  const replacement = input.file + '.replacement'; fs.writeFileSync(replacement, 'replacement\n'); fs.renameSync(replacement, input.file);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).endsWith('.source.json')) throw new Error('Synthetic source pointer failure'); return rename(from, to); };
  try { await assert.rejects(allocate(input, [thread('T1', 0)]), /Synthetic source pointer failure/); }
  finally { fs.renameSync = rename; }
  assert.equal((await allocate(input, [thread('T1', 0)])).ids.get('T1'), 'T2');
  input.events.push(ask('New second opener')); fs.appendFileSync(input.file, 'append\n');
  assert.equal((await allocate(input, [thread('T1', 1)])).ids.get('T1'), 'T3', 'the epoch base committed with its first allocation is reused on retry');
  const initial = fixture('atomic-map-retry', [ask('New root after an interrupted registry write')]);
  fs.renameSync = (from, to) => { if (to === registryFile(initial)) throw new Error('Synthetic registry failure'); return rename(from, to); };
  try { await assert.rejects(allocate(initial, [thread('T1', 0)]), /Synthetic registry failure/); }
  finally { fs.renameSync = rename; }
  assert.equal((await allocate(initial, [thread('T1', 0)])).ids.get('T1'), 'T1');
  assert.equal((await child({ ...initial, threads: [thread('T1', 0)] })).ids[0][1], 'T1');
});
