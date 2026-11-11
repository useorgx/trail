import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-reader-availability-'));
process.env.TRAIL_HOME = path.join(root, 'fixture-builder'); process.env.TRAIL_NO_KEYCHAIN = '1';
const { readSession } = await import('../src/clients.mjs');
const { threadify } = await import('../src/classify.mjs');
const { steps } = await import('../src/steps.mjs');
const { buildGoals } = await import('../src/goals.mjs');
const { buildReceipt } = await import('../src/receipt.mjs');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const stamp = '2026-10-01T00:00:00.000Z'; const created = Date.parse(stamp);
const request = 'Implement the original requested feature';
const moduleURL = (name) => new URL(`../src/${name}.mjs`, import.meta.url).href;
const environment = (home) => ({ ...process.env, TRAIL_HOME: home, TRAIL_NO_KEYCHAIN: '1' });
function child(home, script, input, disabled = false) {
  return JSON.parse(execFileSync(process.execPath, [...(disabled ? ['--no-experimental-sqlite'] : []), '--input-type=module', '-e', script, JSON.stringify(input)], { env: environment(home), encoding: 'utf8' }));
}
async function worker(home, fixture, disabled = false) {
  const scan = new Worker(new URL('../src/worker.mjs', import.meta.url), { env: environment(home), execArgv: disabled ? ['--no-experimental-sqlite'] : [] });
  try {
    const completed = new Promise((resolve, reject) => {
      scan.on('error', reject); scan.on('message', (message) => { if ('ok' in message) resolve(message); });
    });
    scan.postMessage({ file: fixture.file, client: fixture.client }); return await completed;
  } finally { await scan.terminate(); }
}
const liveScript = `
  import { LiveSession } from ${JSON.stringify(moduleURL('live'))};
  const { file, client } = JSON.parse(process.argv[1]);
  const live = new LiveSession(file, client); const result = await live.update();
  console.log(JSON.stringify({ changed: result.changed, checkpoints: result.checkpoints.map(r => r.receipt_id), threads: live.windows.flatMap(w => w.result.threads.map(t => t.id)) }));
`;
function snapshot(home) {
  const result = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file); else result[path.relative(home, file)] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(home); return result;
}
async function fixtureFor(t, client, mode) {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { t.skip('node:sqlite needs Node 22.5+'); return null; }
  if (!process.allowedNodeEnvironmentFlags.has('--no-experimental-sqlite')) { t.skip('this runtime cannot disable node:sqlite'); return null; }
  const dir = path.join(root, `${client}-${mode}`); fs.mkdirSync(dir);
  const home = path.join(dir, 'home'); const database = path.join(dir, 'store.db');
  const db = new sqlite.DatabaseSync(database); let file = database; let clear;
  if (client === 'cursor') {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ createdAtMs: created, updatedAtMs: created, cwd: '/workspace/synthetic' }));
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);');
    db.prepare('INSERT INTO blobs VALUES (?, ?)').run('native-user', JSON.stringify({ role: 'user', content: request }));
    clear = () => db.exec('DELETE FROM blobs;');
  } else if (client === 'opencode') {
    file += '#native-opencode';
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, time_created INT, time_updated INT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INT, data TEXT);`);
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('native-opencode', '/workspace/synthetic', '{}', created, created);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('native-user', 'native-opencode', created, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('native-part', 'native-user', created, JSON.stringify({ type: 'text', text: request }));
    clear = () => db.exec('DELETE FROM part;');
  } else {
    file += '#native-composer'; db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);');
    const put = db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)');
    const composer = (headers) => put.run('composerData:native-composer', JSON.stringify({ createdAt: created, lastUpdatedAt: created, fullConversationHeadersOnly: headers }));
    composer([{ bubbleId: 'native-user', createdAt: stamp }]);
    put.run('bubbleId:native-composer:native-user', JSON.stringify({ type: 1, text: request }));
    clear = () => composer([]);
  }
  const session = await readSession(file, client); const classified = threadify(session);
  assert.equal(classified.threads.length, 1); classified.threads[0].id = 'T7';
  const st = steps(session); const goals = buildGoals(session, classified, st);
  const legacy = buildReceipt(session, goals[0], st, classified.threads[0]);
  child(home, `
    import { ensure, writeSession, writeReceipts, checkpointName, reconcileCheckpoints } from ${JSON.stringify(moduleURL('store'))};
    const { session, receipt, file, client } = JSON.parse(process.argv[1]);
    ensure(); writeSession(session); writeReceipts(session.id, [receipt]);
    writeReceipts(checkpointName(session.id, 0), [receipt]); reconcileCheckpoints(file, client, session.id, [0]);
    console.log('{}');
  `, { session: { ...session, file, threads: classified.threads, goals }, receipt: legacy, file, client });
  return { home, client, file, id: session.id, legacy: legacy.receipt_id, clear, close: () => db.close() };
}

for (const client of ['cursor', 'opencode', 'cursor-ide']) {
  test(`unavailable ${client} worker leaves legacy work and identity migration untouched`, async (t) => {
    const fixture = await fixtureFor(t, client, 'worker'); if (!fixture) return;
    try {
      const before = snapshot(fixture.home);
      const skipped = await worker(fixture.home, fixture, true);
      assert.equal(skipped.ok, true, skipped.error); assert.equal(skipped.skip, true);
      assert.deepEqual(snapshot(fixture.home), before, 'an unavailable reader cannot create identity state or change stored work');
      const supported = await worker(fixture.home, fixture);
      assert.equal(supported.ok, true, supported.error); assert.equal(supported.sess.threads[0].id, 'T7');
      assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.home, 'receipts', `${fixture.id}.json`), 'utf8'))[0].receipt_id, fixture.legacy);
    } finally { fixture.close(); }
  });

  test(`unavailable ${client} live capture preserves checkpoints before a supported legacy migration`, async (t) => {
    const fixture = await fixtureFor(t, client, 'live'); if (!fixture) return;
    try {
      const before = snapshot(fixture.home);
      const skipped = child(fixture.home, liveScript, fixture, true);
      assert.equal(skipped.changed, false); assert.deepEqual(skipped.checkpoints, []);
      assert.deepEqual(snapshot(fixture.home), before, 'an unavailable reader cannot reconcile checkpoints or consume legacy migration');
      const supported = child(fixture.home, liveScript, fixture);
      assert.equal(supported.changed, true); assert.deepEqual(supported.threads, ['T7']); assert.deepEqual(supported.checkpoints, [fixture.legacy]);
      // A readable, genuinely empty SQLite snapshot must still reconcile old checkpoints.
      fixture.clear(); const empty = child(fixture.home, liveScript, fixture);
      assert.equal(empty.changed, true); assert.deepEqual(empty.checkpoints, []); assert.deepEqual(empty.threads, []);
      const manifests = fs.readdirSync(path.join(fixture.home, 'receipt-checkpoints')).map((name) => JSON.parse(fs.readFileSync(path.join(fixture.home, 'receipt-checkpoints', name), 'utf8')));
      assert.deepEqual(manifests.find((state) => state.version === 1 && state.session_id === fixture.id).active, []);
    } finally { fixture.close(); }
  });
}
