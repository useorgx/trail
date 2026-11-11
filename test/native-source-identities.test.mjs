import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-native-identities-'));
process.env.TRAIL_HOME = home; process.env.TRAIL_NO_KEYCHAIN = '1';
const { LiveSession } = await import('../src/live.mjs');
const { allReceipts } = await import('../src/store.mjs');
const { EXT, receiptIdOf } = await import('../src/receipt.mjs');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const timestamp = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const receipts = (live) => live.windows.flatMap((window) => window.receipts);
const threads = (live) => live.windows.flatMap((window) => window.result.threads);
const rootOf = (live, text) => receipts(live).find((receipt) => receipt.intent.summary === text);
const identityOf = (receipt) => ({ receipt: receipt.receipt_id, root: receipt.extensions[EXT].root_thread });
const pairs = (items) => items.map((thread) => [thread.at, thread.id]).sort((a, b) => a[0] - b[0]);
async function batch(file, client) {
  const worker = new Worker(new URL('../src/worker.mjs', import.meta.url));
  try {
    const completed = new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (message) => { if ('ok' in message) resolve(message); });
    });
    worker.postMessage({ file, client }); const output = await completed;
    assert.equal(output.ok, true, output.error); return output.sess;
  } finally { await worker.terminate(); }
}
async function assertFreshReadsAgree(live, receipt) {
  const restarted = new LiveSession(live.file, live.client); await restarted.update();
  assert.deepEqual(pairs(threads(restarted)), pairs(threads(live)));
  assert.ok(receipts(restarted).some((item) => item.receipt_id === receipt.receipt_id));
  const full = await batch(live.file, live.client);
  assert.deepEqual(pairs(full.threads), pairs(threads(live)));
  assert.ok(full.goals.some((goal) => receiptIdOf(full, goal.root) === receipt.receipt_id));
  assert.ok(allReceipts().some((item) => item.receipt_id === receipt.receipt_id));
}
async function sqliteOrSkip(t) {
  try { return await import('node:sqlite'); }
  catch { t.skip('node:sqlite needs Node 22.5+'); return null; }
}

test('Cursor IDE keeps later request and receipt identities when earlier text materializes', async (t) => {
  const sqlite = await sqliteOrSkip(t); if (!sqlite) return;
  const file = path.join(home, 'cursor-ide.db'); const id = 'native-composer';
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);');
  const put = db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)');
  const bubble = (id, data) => put.run(`bubbleId:native-composer:${id}`, JSON.stringify(data));
  const headers = ['user-first', 'assistant-first', 'user-later'].map((bubbleId, i) => ({ bubbleId, createdAt: timestamp(i) }));
  const composer = () => put.run(`composerData:${id}`, JSON.stringify({ createdAt: Date.parse(timestamp(0)), lastUpdatedAt: Date.parse(timestamp(3)), fullConversationHeadersOnly: headers }));
  composer(); bubble('user-first', { type: 1, text: 'Implement the first native feature' });
  bubble('assistant-first', { type: 2, text: 'short' });
  const request = 'Implement a separate later native feature'; bubble('user-later', { type: 1, text: request });
  const live = new LiveSession(`${file}#${id}`, 'cursor-ide');
  try {
    await live.update(); const before = identityOf(rootOf(live, request));
    const earlierAt = live.session.ev.findIndex((event) => event.text === request);
    bubble('assistant-first', { type: 2, text: 'The earlier response has now finished streaming and is long enough to appear.' });
    await live.update(); const current = rootOf(live, request);
    assert.ok(live.session.ev.findIndex((event) => event.text === request) > earlierAt, 'the actual reader inserted an earlier normalized event');
    assert.deepEqual(identityOf(current), before);
    await assertFreshReadsAgree(live, current);
    // Identical words and timestamps cannot make a replacement message inherit the old target.
    headers[2].bubbleId = 'replacement-user-later'; composer(); bubble(headers[2].bubbleId, { type: 1, text: request });
    await live.update(); assert.notDeepEqual(identityOf(rootOf(live, request)), before);
  } finally { db.close(); }
});

test('OpenCode tool start and argument backfills preserve the native part and receipt identities', async (t) => {
  const sqlite = await sqliteOrSkip(t); if (!sqlite) return;
  const file = path.join(home, 'opencode.db'); const id = 'native-opencode';
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, time_created INT, time_updated INT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INT, data TEXT);`);
  const started = Date.parse(timestamp(0));
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(id, '/workspace/synthetic', '{}', started, started);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('assistant-message', id, started, JSON.stringify({ role: 'assistant' }));
  const put = db.prepare('INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?)');
  const tool = (state) => JSON.stringify({ type: 'tool', tool: 'bash', state });
  put.run('stable-part', 'assistant-message', started, tool({ status: 'pending', input: {} }));
  const live = new LiveSession(`${file}#${id}`, 'opencode');
  try {
    await live.update(); const before = identityOf(receipts(live)[0]); const original = live.session.ev[0];
    put.run('stable-part', 'assistant-message', started, tool({ status: 'running', input: { command: 'npm test' }, time: { start: started + 100 } }));
    await live.update(); const current = receipts(live)[0];
    assert.notEqual(live.session.ev[0].ts, original.ts, 'the reader now observes the backfilled invocation start');
    assert.notEqual(live.session.ev[0].target, original.target, 'the reader now observes the hydrated arguments');
    assert.deepEqual(identityOf(current), before);
    await assertFreshReadsAgree(live, current);
    db.prepare('UPDATE part SET id = ? WHERE id = ?').run('replacement-part', 'stable-part');
    await live.update(); assert.notDeepEqual(identityOf(receipts(live)[0]), before);
  } finally { db.close(); }
});

test('Copilot keeps later request and receipt identities when an earlier response materializes', async () => {
  const file = path.join(home, 'copilot-requests.json'); const request = 'Implement the separate later Copilot feature';
  const snapshot = { sessionId: 'native-copilot-requests', creationDate: timestamp(0), requests: [
    { requestId: 'request-first', timestamp: timestamp(0), message: { text: 'Implement the first Copilot feature' }, response: [{ value: 'short' }] },
    { requestId: 'request-later', timestamp: timestamp(2), message: { text: request }, response: [] },
  ] };
  const save = () => fs.writeFileSync(file, JSON.stringify(snapshot)); save();
  const live = new LiveSession(file, 'copilot'); await live.update();
  const before = identityOf(rootOf(live, request)); const earlierAt = live.session.ev.findIndex((event) => event.text === request);
  snapshot.requests[0].response[0].value = 'The earlier response has now finished streaming and is long enough to appear.';
  save(); await live.update(); const current = rootOf(live, request);
  assert.ok(live.session.ev.findIndex((event) => event.text === request) > earlierAt, 'the actual reader inserted an earlier normalized event');
  assert.deepEqual(identityOf(current), before);
  await assertFreshReadsAgree(live, current);
  snapshot.requests[1].requestId = 'replacement-request-later'; save();
  await live.update(); assert.notDeepEqual(identityOf(rootOf(live, request)), before);
});

test('Copilot tool metadata backfills preserve the native invocation and receipt identities', async () => {
  const file = path.join(home, 'copilot-tools.json');
  const snapshot = { sessionId: 'native-copilot-tools', creationDate: timestamp(0), requests: [
    { requestId: 'request-tool', timestamp: timestamp(0), response: [{ kind: 'toolInvocationSerialized', toolCallId: 'stable-call', toolId: 'run_in_terminal', resultDetails: { input: '{}' } }] },
  ] };
  const save = () => fs.writeFileSync(file, JSON.stringify(snapshot)); save();
  const live = new LiveSession(file, 'copilot'); await live.update();
  const before = identityOf(receipts(live)[0]);
  snapshot.requests[0].result = { metadata: { toolCallRounds: [{ toolCalls: [{ name: 'run_in_terminal', arguments: JSON.stringify({ command: 'npm test' }) }] }] } };
  save(); await live.update(); const current = receipts(live)[0];
  assert.equal(live.session.ev[0].target, 'npm test');
  assert.deepEqual(identityOf(current), before);
  await assertFreshReadsAgree(live, current);
  snapshot.requests[0].response[0].toolCallId = 'replacement-call'; save();
  await live.update(); assert.notDeepEqual(identityOf(receipts(live)[0]), before);
});

test('Gemini keeps later message and receipt identities when earlier assistant content materializes', async () => {
  const file = path.join(home, 'gemini-messages.json'); const request = 'Implement the separate later Gemini feature';
  const snapshot = { sessionId: 'native-gemini-messages', startTime: timestamp(0), lastUpdated: timestamp(3), messages: [
    { id: 'message-first-user', type: 'user', timestamp: timestamp(0), content: 'Implement the first Gemini feature' },
    { id: 'message-first-assistant', type: 'gemini', timestamp: timestamp(1), content: 'short' },
    { id: 'message-later-user', type: 'user', timestamp: timestamp(2), content: request },
  ] };
  const save = () => fs.writeFileSync(file, JSON.stringify(snapshot)); save();
  const live = new LiveSession(file, 'gemini'); await live.update();
  const before = identityOf(rootOf(live, request)); const earlierAt = live.session.ev.findIndex((event) => event.text === request);
  snapshot.messages[1].content = 'The earlier Gemini response has now finished streaming and is long enough to appear.';
  save(); await live.update(); const current = rootOf(live, request);
  assert.ok(live.session.ev.findIndex((event) => event.text === request) > earlierAt, 'the actual reader inserted an earlier normalized event');
  assert.deepEqual(identityOf(current), before);
  await assertFreshReadsAgree(live, current);
  snapshot.messages[2].id = 'replacement-message-later-user'; save();
  await live.update(); assert.notDeepEqual(identityOf(rootOf(live, request)), before);
});

test('Droid appends preserve identity while empty resets and inode replacements reserve earlier aliases', async () => {
  const file = path.join(home, 'droid-source.jsonl'); const request = 'Implement the original Droid feature';
  const encode = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const source = encode([
    { type: 'session_start', id: 'native-droid-resets', cwd: '/workspace/synthetic', created_at: timestamp(0) },
    { type: 'message', timestamp: timestamp(1), message: { role: 'user', content: [{ type: 'text', text: request }] } },
  ]);
  fs.writeFileSync(file, source); const live = new LiveSession(file, 'droid'); await live.update();
  const before = identityOf(rootOf(live, request));
  fs.appendFileSync(file, encode([
    { type: 'message', timestamp: timestamp(2), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'stable-droid-call', name: 'Execute', input: { command: 'npm test' } }] } },
    { type: 'message', timestamp: timestamp(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'stable-droid-call', content: '8 passed' }] } },
  ]));
  await live.update(); assert.deepEqual(identityOf(rootOf(live, request)), before);
  fs.writeFileSync(file, ''); await live.update(); fs.writeFileSync(file, source); await live.update();
  const reset = identityOf(rootOf(live, request)); assert.notDeepEqual(reset, before);
  const replacement = path.join(home, 'droid-replacement.jsonl'); fs.writeFileSync(replacement, source); fs.renameSync(replacement, file);
  await live.update(); const rotated = rootOf(live, request);
  assert.notDeepEqual(identityOf(rotated), reset); assert.notDeepEqual(identityOf(rotated), before);
  await assertFreshReadsAgree(live, rotated);
});
