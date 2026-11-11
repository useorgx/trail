import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-live-metadata-boundary-'));
process.env.TRAIL_HOME = home; process.env.TRAIL_NO_KEYCHAIN = '1';
const { LiveSession } = await import('../src/live.mjs');
const { loadReceipts, checkpointName } = await import('../src/store.mjs');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const stamp = '2026-10-01T00:00:00.000Z';
const row = (type, content, extra = {}) => JSON.stringify({ type, timestamp: stamp, cwd: '/workspace/synthetic', message: { role: type, content, ...extra } }) + '\n';
const ask = (text) => row('user', text);
const initial = (extra = {}) => ask('Implement the original feature')
  + row('assistant', [{ type: 'tool_use', id: 'original-call', name: 'Bash', input: { command: 'npm test' } }], extra)
  + row('user', [{ type: 'tool_result', tool_use_id: 'original-call', content: '8 passed' }]);
const capture = async (id, text) => {
  const file = path.join(home, `${id}.jsonl`); fs.writeFileSync(file, text);
  const live = new LiveSession(file, 'claude'); await live.update(); return live;
};
const firstReceipt = (live) => live.windows[0].receipts[0];
const tokens = (receipt) => receipt.cost.usage.find((usage) => usage.name === 'model_tokens').quantity;

test('a streamed usage update before a new ask refreshes the closing goal and its persisted checkpoint', async () => {
  const id = 'usage-before-boundary';
  const live = await capture(id, initial({ id: 'original-assistant', model: 'claude-test', usage: { input_tokens: 1000, output_tokens: 10 } }));
  const before = firstReceipt(live); const priorEvents = live.session.ev.length;
  assert.equal(tokens(before), 1010);
  // A streamed completion updates an existing message's usage without adding a normalized event.
  fs.appendFileSync(live.file, row('assistant', [], { id: 'original-assistant', model: 'claude-test', usage: { input_tokens: 1000, output_tokens: 1000 } })
    + ask('Implement a separate next feature'));
  const update = await live.update(); const after = firstReceipt(live);
  assert.equal(live.session.ev.length, priorEvents + 1, 'only the new ask adds an event');
  assert.equal(live.windows.length, 2); assert.equal(after.receipt_id, before.receipt_id);
  assert.equal(tokens(after), 2000, 'the closed goal keeps the updated usage for its original message');
  assert.ok(update.checkpoints.some((receipt) => receipt.receipt_id === after.receipt_id && tokens(receipt) === 2000));
  assert.equal(tokens(loadReceipts(checkpointName(id, 0))[0]), 2000);
});

test('reasoning before a new ask refreshes the closing goal trajectory and its persisted checkpoint', async () => {
  const id = 'reasoning-before-boundary'; const live = await capture(id, initial());
  const before = firstReceipt(live); const priorEvents = live.session.ev.length;
  assert.deepEqual(before.trajectory, []);
  fs.appendFileSync(live.file, row('assistant', [{ type: 'thinking', thinking: 'On second thought, switch to a different approach because the earlier assumption was wrong.' }])
    + ask('Implement another separate next feature'));
  const update = await live.update(); const after = firstReceipt(live);
  assert.equal(live.session.ev.length, priorEvents + 1, 'only the new ask adds an event');
  assert.equal(live.session.reasoning.length, 1); assert.equal(live.windows.length, 2);
  assert.equal(after.receipt_id, before.receipt_id); assert.equal(after.trajectory.length, 1);
  assert.ok(update.checkpoints.some((receipt) => receipt.receipt_id === after.receipt_id && receipt.trajectory.length === 1));
  assert.deepEqual(loadReceipts(checkpointName(id, 0))[0].trajectory, after.trajectory);
});
