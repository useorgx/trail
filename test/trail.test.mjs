import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-test-'));
process.env.TRAIL_HOME = tmp;
const fx = (n) => new URL(`./fixtures/${n}`, import.meta.url).pathname;
const { readClaude, readCodex } = await import('../src/adapters.mjs');
const { threadify, FEATURE_NAMES } = await import('../src/classify.mjs');
const { pAbandon, modelInfo } = await import('../src/model.mjs');

test('claude: asks, denials, failures and ships become threads', async () => {
  const s = await readClaude(fx('claude.jsonl'));
  assert.equal(s.ev.filter((e) => e.k === 'ask').length, 2);
  const r = threadify(s);
  assert.equal(r.denied, 1);
  const wall = r.threads.find((t) => t.kind === 'wall');
  assert.ok(wall, 'a permission denial opens a wall thread');
  assert.ok(r.walls.some((w) => w.sig === 'denied-home'), 'the ~/.claude denial is named');
  assert.ok(r.walls.some((w) => w.sig === 'no-module'), 'the missing module is named');
  const found = r.threads.find((t) => t.origin === 'surprise' && t.kind !== 'wall');
  assert.ok(found, 'two real failures followed by a discovery remark open a surprise thread');
  assert.equal(r.steers.cont, 1, 'a bare “continue” is counted, not treated as a new intent');
  const task = r.threads[0];
  assert.equal(task.status, 'outcome', 'the asked-for task keeps its PR even though a recovery happened in between');
  assert.deepEqual(task.claim, ['PR #42'], 'the PR number is read from the command output');
  assert.equal(wall.status, 'outcome', 'a wall the agent routed around is not a dropped thread');
  assert.equal(found.status, 'outcome', 'a recovery that ends in a passing check is done');
});

test('codex: exec commands, patches and commits are read', async () => {
  const s = await readCodex(fx('codex.jsonl'));
  const tools = s.ev.filter((e) => e.k === 'tool');
  assert.deepEqual(tools.map((t) => t.tool), ['Bash', 'apply_patch', 'Bash']);
  const r = threadify(s);
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].status, 'outcome');
  assert.equal(r.threads[0].moves, 'pcs');
});

test('model contract: features line up with the shipped model', () => {
  const info = modelInfo(); assert.ok(info, 'model file ships');
  const p = pAbandon(new Array(FEATURE_NAMES.length).fill(0)); assert.ok(p > 0 && p < 1);
});

test('adopt writes a removable block and unadopt removes it', async () => {
  const { adopt, unadopt } = await import('../src/adopt.mjs');
  const target = path.join(tmp, 'AGENTS.md'); fs.writeFileSync(target, '# Rules\n');
  const w = { sig: 'denied-home', sessions: 94, projects: {}, list: [] };
  adopt(w, target); adopt(w, target); // idempotent
  const txt = fs.readFileSync(target, 'utf8');
  assert.equal((txt.match(/orgx-trail:denied-home adopted/g) || []).length, 1);
  unadopt('denied-home');
  assert.equal(fs.readFileSync(target, 'utf8').includes('orgx-trail'), false);
  assert.ok(fs.readFileSync(target, 'utf8').startsWith('# Rules'));
});

test('ledger server refuses requests without the launch token or with a foreign Host', async () => {
  const { serve } = await import('../src/serve.mjs');
  const { server, url } = await serve({ port: 47471 });
  try {
    assert.equal((await fetch('http://127.0.0.1:47471/data.json')).status, 403);
    assert.equal((await fetch(url.replace('/?', '/data.json?'))).status, 200);
    const http = await import('node:http'); const k = new URL(url).searchParams.get('k');
    const evil = await new Promise((r) => http.get({ host: '127.0.0.1', port: 47471, path: '/data.json?k=' + k, headers: { host: 'evil.example:47471' } }, (res) => r(res.statusCode)));
    assert.equal(evil, 403, 'DNS-rebinding style Host is refused even with the token');
  } finally { server.close(); }
});
