import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-native-checkpoints-'));
process.env.TRAIL_HOME = home; process.env.TRAIL_NO_KEYCHAIN = '1';
const { LiveSession } = await import('../src/live.mjs');
const { allReceipts, P } = await import('../src/store.mjs');
after(() => fs.rmSync(home, { recursive: true, force: true }));

async function fixture(client, label, t) {
  let sqlite; try { sqlite = await import('node:sqlite'); } catch { t.skip('native SQLite readers need Node 22.5+'); return; }
  const id = `${client}-${label}`; const dir = path.join(home, id); fs.mkdirSync(dir);
  const file = path.join(dir, 'store.db'); const db = new sqlite.DatabaseSync(file);
  const created = Date.parse('2026-10-01T00:00:00Z'); const request = `Implement ${id}`;
  let clear;
  if (client === 'cursor') {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ createdAtMs: created, updatedAtMs: created }));
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.prepare('INSERT INTO blobs VALUES (?, ?)').run('user-original', JSON.stringify({ role: 'user', content: request }));
    clear = () => db.exec('DELETE FROM blobs');
  } else if (client === 'cursor-ide') {
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const put = db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)');
    const composer = (headers) => put.run(`composerData:${id}`, JSON.stringify({ createdAt: created, lastUpdatedAt: created, fullConversationHeadersOnly: headers }));
    composer([{ bubbleId: 'user-original', createdAt: new Date(created).toISOString() }]);
    put.run(`bubbleId:${id}:user-original`, JSON.stringify({ type: 1, text: request }));
    clear = () => composer([]);
  } else {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, time_created INT, time_updated INT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INT, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INT, data TEXT)');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(id, '/workspace/synthetic', '{}', created, created);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('user-original', id, created, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('request-original', 'user-original', created, JSON.stringify({ type: 'text', text: request }));
    clear = () => db.exec('DELETE FROM part');
  }
  return { id: client === 'cursor-ide' ? `cursor-${id}` : id, ref: client === 'cursor' ? file : `${file}#${id}`, clear, close: () => db.close() };
}
const own = (id) => allReceipts().filter((receipt) => receipt.lineage.run_ref.id === id);
const disk = () => Object.fromEntries([P.receipts, P.checkpoints].flatMap((dir) => fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => [path.join(dir, name), fs.readFileSync(path.join(dir, name), 'utf8')]) : []));

for (const client of ['cursor', 'cursor-ide', 'opencode']) {
  test(`${client} empty native snapshot clears active checkpoints without treating a session reference as a file`, async (t) => {
    const source = await fixture(client, 'empty', t); if (!source) return;
    try {
      const live = new LiveSession(source.ref, client); await live.update(); assert.equal(own(source.id).length, 1);
      source.clear(); const result = await live.update();
      assert.equal(result.changed, true); assert.deepEqual(result.windows, []); assert.equal(own(source.id).length, 0);
    } finally { source.close(); }
  });
  test(`${client} unavailable reader leaves active checkpoint files intact`, async (t) => {
    const source = await fixture(client, 'unavailable', t); if (!source) return;
    try {
      await new LiveSession(source.ref, client).update(); assert.equal(own(source.id).length, 1); const before = disk();
      const script = `import { LiveSession } from ${JSON.stringify(new URL('../src/live.mjs', import.meta.url).href)}; const live = new LiveSession(${JSON.stringify(source.ref)}, ${JSON.stringify(client)}); console.log(JSON.stringify(await live.update()));`;
      const result = JSON.parse(execFileSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', script], { env: process.env, encoding: 'utf8' }));
      assert.equal(result.changed, false); assert.deepEqual(disk(), before); assert.equal(own(source.id).length, 1);
    } finally { source.close(); }
  });
}
