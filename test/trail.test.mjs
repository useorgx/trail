import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-test-'));
process.env.TRAIL_HOME = tmp;
process.env.TRAIL_NO_KEYCHAIN = '1'; // tests never touch the real keychain
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

test('sync outlines carry no text in metadata_only', async () => {
  const { toSession } = await import('../src/sync.mjs');
  const s = { id: 'abc', client: 'claude', project: 'my/repo', start: '2026-09-20T10:00:00Z', end: '2026-09-20T11:00:00Z', tools: 5, errs: 1, denied: 0, steers: { human: 1, cont: 0 },
    walls: [{ sig: 'Bash: secret-ish error text', named: false, n: 2 }, { sig: 'denied-chain', named: true, n: 1 }],
    threads: [{ id: 'T1', origin: 'ask', status: 'outcome', moves: 'pcs', backs: [], claim: ['PR #42', 'commit “fix the thing”'], t0: '2026-09-20T10:00:00Z', t1: '2026-09-20T10:30:00Z', title: 'Private title', p_abandon: 0.1 }] };
  const meta = toSession(s, false);
  assert.equal(meta.repo, 'my-repo', 'no path separators');
  assert.equal(meta.threads[0].title, undefined, 'titles stay local');
  assert.deepEqual(meta.threads[0].claims, ['PR #42'], 'commit messages stay local');
  assert.match(meta.walls[0].sig, /^sig:[0-9a-f]{16}$/, 'unnamed error text is hashed');
  assert.equal(meta.walls[1].sig, 'denied-chain');
  assert.ok(!JSON.stringify(meta).includes('abc'), 'raw session id never sent');
  assert.equal(toSession(s, true).threads[0].title, 'Private title', 'titles only with --with-titles');
});

test('guard: denies known walls only in dontAsk sessions, never allows, never throws', async () => {
  const fs = await import('node:fs'); const { runHook, buildGuard, matchWall } = await import('../src/guard.mjs');
  buildGuard([{ sig: 'denied-chain', name: 'Loops and chained shell commands get denied', sessions: 12, rule: 'Run one simple command per call.' }]);
  const chain = { tool_name: 'Bash', tool_input: { command: 'cd a && ls' }, session_id: 's' };
  const out = await runHook(JSON.stringify({ ...chain, permission_mode: 'dontAsk' }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /known wall/);
  assert.equal(await runHook(JSON.stringify({ ...chain, permission_mode: 'default' })), null, 'other modes: no opinion');
  assert.equal(await runHook('not json'), null);
  assert.equal(matchWall('Bash', { command: 'git status' }), null);
  assert.equal(matchWall('Read', { file_path: '/Users/x/.claude/settings.json' }), 'denied-home');
});

test('adoption effects compare like with like and flag a permission-mode switch', async () => {
  const { adoptionEffect } = await import('../src/metrics.mjs');
  const mk = (i, mode, hit, day) => ({ id: `s${i}`, cwd: '/r', mode, start: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`, hit });
  const sessions = [...Array(10)].map((_, i) => mk(i, 'dontAsk', i % 2 === 0, 10 + i)).concat([...Array(10)].map((_, i) => mk(20 + i, 'auto', false, 22 + i % 5)));
  const wall = { list: sessions.filter((s) => s.hit).map((s) => ({ id: s.id })) };
  const e = adoptionEffect(wall, { at: '2026-09-21T00:00:00Z', target: '/r/AGENTS.md' }, sessions);
  assert.equal(e.mode, 'dontAsk'); assert.equal(e.modeAfter, 'auto'); assert.equal(e.confounded, true, 'the 2026-09-25 case: mode switch, not a win');
});

test('mcp: lists tools and answers trail_check', async () => {
  const { spawn } = await import('node:child_process');
  const p = spawn(process.execPath, [new URL('../bin/trail.mjs', import.meta.url).pathname, 'mcp'], { env: process.env });
  const lines = []; p.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_check', arguments: { tool: 'WebFetch' } } }) + '\n');
  p.stdin.end(); await new Promise((r) => p.on('close', r));
  const res = lines.map((l) => JSON.parse(l));
  assert.ok(res[0].result.tools.some((t) => t.name === 'trail_check'));
  assert.equal(JSON.parse(res[1].result.content[0].text).wall, 'denied-web');
});

test('experiments: bootstrap intervals are deterministic and honest about zero', async () => {
  const { bootstrapDiff } = await import('../src/experiments.mjs');
  const same = bootstrapDiff([0.4, 0.5, 0.45, 0.5, 0.42], [0.41, 0.48, 0.47, 0.5, 0.44]);
  assert.ok(same.lo < 0 && same.hi > 0, 'no real change → interval spans zero');
  assert.deepEqual(bootstrapDiff([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]), bootstrapDiff([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]), 'same data, same interval');
  assert.ok(bootstrapDiff([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]).lo > 0);
});

test('discovery needs a problem, not just the word "found"', async () => {
  const { SURPRISE_SAY } = await import('../src/classify.mjs');
  for (const t of ['Found a cross-tenant leak in the cache key.', 'Root cause: the replay guard raises 40001.', 'Turns out the cron never ran since Sep 5.', 'The hook is silently broken on Linux.', 'Discovered a regression in the pulse view.'])
    assert.ok(SURPRISE_SAY.test(t), `should count: ${t}`);
  for (const t of ['I found the file that defines the route.', 'Discovered the config lives in ~/.codex.', 'I found that the test passes now.', 'Found it — the handler is in routes.ts.'])
    assert.ok(!SURPRISE_SAY.test(t), `should not count: ${t}`);
});

test('opencode and cursor: SQLite sessions read into the same events, read-only', async (t) => {
  let sqlite; try { sqlite = await import('node:sqlite'); } catch { return t.skip('node:sqlite needs Node 22.5+'); }
  const dir = fs.mkdtempSync(path.join(tmp, 'sqlite-'));
  process.env.XDG_DATA_HOME = dir; fs.mkdirSync(path.join(dir, 'opencode'));
  const oc = new sqlite.DatabaseSync(path.join(dir, 'opencode', 'opencode.db'));
  oc.exec(`CREATE TABLE session (id TEXT, directory TEXT, model TEXT, time_created INT, time_updated INT);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INT, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, time_created INT, data TEXT);
    INSERT INTO session VALUES ('ses_1', '/work/app', '{"id":"deepseek-v4"}', 1000, 5000);
    INSERT INTO message VALUES ('m1', 'ses_1', 1000, '{"role":"user"}'), ('m2', 'ses_1', 2000, '{"role":"assistant"}');`);
  const part = oc.prepare('INSERT INTO part VALUES (?, ?, ?, ?)');
  part.run('p1', 'm1', 1000, JSON.stringify({ type: 'text', text: 'fix the build' }));
  part.run('p2', 'm2', 2000, JSON.stringify({ type: 'reasoning', text: 'private' }));
  part.run('p3', 'm2', 2100, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'cat ~/.claude/settings.json' }, error: 'The user rejected permission to use this specific tool call.' } }));
  part.run('p4', 'm2', 2200, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/work/app/package.json' } } }));
  oc.close();
  const { discoverOpenCode, readOpenCode, readCursor } = await import('../src/adapters-sqlite.mjs');
  const [entry] = discoverOpenCode();
  assert.equal(entry.client, 'opencode'); assert.match(entry.file, /#ses_1$/);
  const s = await readOpenCode(entry.file);
  assert.equal(s.cwd, '/work/app'); assert.equal(s.model, 'deepseek-v4');
  assert.deepEqual(s.ev.map((e) => e.k), ['ask', 'tool', 'tool'], 'reasoning parts are never read into events');
  const [bash, read] = s.ev.filter((e) => e.k === 'tool');
  assert.equal(bash.tool, 'Bash'); assert.equal(bash.denied, true); assert.equal(read.target, '/work/app/package.json');

  const chat = path.join(dir, 'cursor', 'ws', 'chat-1'); fs.mkdirSync(chat, { recursive: true });
  fs.writeFileSync(path.join(chat, 'meta.json'), JSON.stringify({ createdAtMs: 1000, updatedAtMs: 9000, cwd: '/work/app' }));
  const cu = new sqlite.DatabaseSync(path.join(chat, 'store.db'));
  cu.exec('CREATE TABLE blobs (id TEXT, data BLOB); CREATE TABLE meta (key TEXT, value BLOB);');
  const blob = cu.prepare('INSERT INTO blobs VALUES (?, ?)');
  blob.run('b1', JSON.stringify({ role: 'user', content: '<user_info>OS</user_info>' }));
  blob.run('b2', JSON.stringify({ role: 'user', content: [{ type: 'text', text: '<user_query>\nrun the tests\n</user_query>' }] }));
  blob.run('b3', JSON.stringify({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'run_terminal_cmd', args: { command: 'npm test' } }] }));
  blob.run('b4', JSON.stringify({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', result: { isError: true, error: 'Cannot find module vitest' } }] }));
  cu.close();
  const c = await readCursor(path.join(chat, 'store.db'));
  assert.deepEqual(c.ev.filter((e) => e.k === 'ask').map((e) => e.text), ['run the tests'], 'only the person’s words, not injected context');
  const call = c.ev.find((e) => e.k === 'tool');
  assert.equal(call.tool, 'Bash'); assert.equal(call.target, 'npm test'); assert.equal(call.err, true);
  assert.equal(c.cwd, '/work/app');
});

test('connect: uses an existing key without running the wizard, and hands sign-in to the wizard otherwise', async () => {
  const { connect } = await import('../src/sync.mjs');
  let ran = null;
  process.env.ORGX_API_KEY = 'oxk_test_placeholder';
  const a = await connect({ run: async (args) => { ran = args; return 0; } });
  assert.equal(a.already, true); assert.equal(ran, null, 'no wizard run when a key already exists');
  delete process.env.ORGX_API_KEY;
  const home = process.env.HOME; process.env.HOME = tmp; // no keychain entry or OpenClaw config reachable here
  try {
    await assert.rejects(connect({ run: async (args) => { ran = args; return 1; } }), /did not complete/);
    assert.deepEqual(ran.slice(1, 4), ['@useorgx/wizard@latest', 'auth', 'login']);
  } finally { process.env.HOME = home; }
});

test('steps and goals: a recovery stays inside its goal, outcome and backtrack point at their steps', async () => {
  const { threadify } = await import('../src/classify.mjs');
  const { steps, stepFacts } = await import('../src/steps.mjs');
  const { buildGoals } = await import('../src/goals.mjs');
  const T = (tool, target, extra = {}) => ({ k: 'tool', ts: '2026-09-27T00:00:00Z', tool, rawTool: tool, target, err: false, denied: false, errText: '', ...extra });
  const s = { ev: [
    { k: 'ask', ts: '2026-09-27T00:00:00Z', text: 'fix the failing build and open a PR', who: 'human' },
    T('Bash', 'pnpm build', { err: true, errText: 'Cannot find module x' }),
    T('Bash', 'pnpm build', { err: true, errText: 'Cannot find module x' }),
    { k: 'say', ts: '2026-09-27T00:00:01Z', text: 'Actually the real cause is a stale lockfile, not the import. Reinstalling instead.' },
    T('Bash', 'pnpm install'),
    T('Edit', '/repo/src/a.ts'),
    T('Bash', 'pnpm test', { outTail: 'Tests  12 passed (12)' }),
    T('Bash', 'gh pr create --fill', { out: 'https://github.com/o/r/pull/42' }),
    { k: 'say', ts: '2026-09-27T00:00:02Z', text: 'Opened PR #42: the build failed because the lockfile was stale; reinstalling fixed it, tests pass (12/12), and the change to a.ts is in the PR for review.' },
  ], reasoning: [] };
  assert.deepEqual(stepFacts(s.ev[6]), { action: 'test', result: 'pass' });
  const r = threadify(s); assert.ok(r.threads.length >= 2, 'threadify still splits the recovery out as its own thread');
  const goals = buildGoals(s, r, steps(s, { reasoning: [] }));
  assert.equal(goals.length, 1, 'one goal: the recovery is an episode inside it');
  assert.ok(goals[0].episodes.some((e) => e === 'recovery' || e.kind === 'recovery'));
  assert.equal(goals[0].outcome.kind, 'shipped_checked'); assert.equal(goals[0].outcome.at, 7);
  assert.equal(goals[0].backtracks.length, 1); assert.equal(goals[0].backtracks[0].at, 3); assert.equal(goals[0].backtracks[0].trigger, 'error');
});

test('deepen via OrgX credits: quotes from counts, sends nothing if declined, stops with a buy link when short', async () => {
  const http = await import('node:http');
  const { deepen, orgxProvider, OutOfCredits } = await import('../src/deepen.mjs');
  // A session record pointing at the Claude fixture, so deepen has real steps and goals to count.
  fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'sessions', 'fx-deepen.json'), JSON.stringify({ id: 'fx-deepen', client: 'claude', file: fx('claude.jsonl'), start: '2026-09-27T00:00:00Z', threads: [] }));
  const calls = []; let available = 1000;
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const body = JSON.parse(b || '{}'); calls.push({ path: req.url, auth: req.headers.authorization, body });
    const send = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/v1/trail/deepen/quote') { const credits = Math.ceil(body.steps / 40 + body.goals / 4); return send(200, { ok: true, data: { ...body, credits, usd: credits * 0.02, available, enough: available >= credits, buy_url: '/settings/billing', configured: true } }); }
    if (req.url === '/api/v1/trail/deepen') { if (available <= 0) return send(402, { ok: false, available: 0, buy_url: '/settings/billing' }); available -= 1;
      return send(200, { ok: true, data: { answers: Object.fromEntries(body.items.map((i) => [i.id, i.kind === 'step' ? ['plan', 0.9] : ['done', 0.9]])), charged: 1, failed: 0, remaining: available } }); }
    send(404, {}); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const declined = await deepen({ provider: orgxProvider({ key: 'oxk_test', base }), sessions: ['fx-deepen'], confirm: async () => false });
    assert.equal(declined.cancelled, true);
    assert.deepEqual(calls.map((c) => c.path), ['/api/v1/trail/deepen/quote'], 'declining sends counts only');
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['goals', 'steps'], 'the quote carries no text');
    assert.equal(calls[0].auth, 'Bearer oxk_test');
    available = 0; calls.length = 0;
    await assert.rejects(deepen({ provider: orgxProvider({ key: 'oxk_test', base }), sessions: ['fx-deepen'], confirm: async () => true }), (e) => e instanceof OutOfCredits && /settings\/billing/.test(e.message));
    assert.deepEqual(calls.map((c) => c.path), ['/api/v1/trail/deepen/quote'], 'not enough credits: nothing is sent');
    available = 1000; calls.length = 0;
    const r = await deepen({ provider: orgxProvider({ key: 'oxk_test', base }), sessions: ['fx-deepen'], confirm: async () => true });
    assert.ok(r.charged >= 1 && calls.some((c) => c.path === '/api/v1/trail/deepen'));
    const sent = calls.filter((c) => c.path === '/api/v1/trail/deepen').flatMap((c) => c.body.items);
    assert.ok(sent.every((i) => (i.kind === 'step' && i.text) || (i.kind === 'goal' && i.evidence)), 'items carry only step text or goal evidence');
    assert.ok(new Set(calls.filter((c) => c.path === '/api/v1/trail/deepen').map((c) => c.body.batch_id)).size === calls.filter((c) => c.path === '/api/v1/trail/deepen').length, 'every batch has its own id');
    const again = await deepen({ provider: orgxProvider({ key: 'oxk_test', base }), sessions: ['fx-deepen'], confirm: async () => true });
    assert.equal(again.nothing, true, 'answers are cached: a second run sends nothing');
  } finally { server.close(); }
});

test('secrets are redacted before anything is stored, and stored files are private', async () => {
  const { redact } = await import('../src/redact.mjs');
  // Realistic shapes: gitleaks rightly ignores low-entropy strings like 'aaaa…', so test keys must look real.
  const fake = 'sk-or-v1-' + '3f9a0c7e1b52d846'.repeat(4); const bearer = 'Qm8xZ2VhY2Jk' + 'N3RrLW9yZ3gtdGVzdA';
  const out = redact(`curl -H "Authorization: Bearer ${bearer}" and key ${fake}`);
  assert.equal(out.includes(fake) || out.includes(bearer), false);
  assert.match(redact('OPENROUTER_API_KEY=' + 'aZ9kQ2xP7mW4'.repeat(3)), /OPENROUTER_API_KEY=\[redacted:/);
  assert.equal(redact('the task-runner and desk-chair stay'), 'the task-runner and desk-chair stay', 'ordinary words are untouched');
  const { writeSession, P } = await import('../src/store.mjs');
  writeSession({ id: 'redact-test', threads: [{ ask: `use ${fake} please` }] });
  const f = path.join(P.sessions, 'redact-test.json');
  assert.equal(fs.readFileSync(f, 'utf8').includes(fake), false);
  assert.equal(fs.statSync(f).mode & 0o077, 0, 'readable by the owner only');
});

test('personal-data masking: Privacy Filter output is split back per item, and any failure means nothing is sent', async () => {
  const { maskPii, PiiError } = await import('../src/pii.mjs');
  // A stand-in for `opf -f file`: prints one pretty-printed JSON object whose redacted_text masks "Alice".
  const bin = path.join(tmp, 'fake-opf.mjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nconst fs=require('fs');const f=process.argv[process.argv.indexOf('-f')+1];const t=fs.readFileSync(f,'utf8');\nif(t.includes('FAIL'))process.exit(3);\nconsole.log(JSON.stringify({schema_version:1,text:t,redacted_text:t.replace(/Alice/g,'<PRIVATE_PERSON>')},null,2));\n`.replace('require', 'require'));
  fs.writeFileSync(bin.replace('.mjs', '.cjs'), fs.readFileSync(bin, 'utf8')); fs.chmodSync(bin.replace('.mjs', '.cjs'), 0o755);
  const out = maskPii(['ask Alice about it', 'no names here', 'Alice again\nwith a second line'], { bin: bin.replace('.mjs', '.cjs') });
  assert.deepEqual(out, ['ask <PRIVATE_PERSON> about it', 'no names here', '<PRIVATE_PERSON> again\nwith a second line']);
  assert.throws(() => maskPii(['FAIL'], { bin: bin.replace('.mjs', '.cjs') }), PiiError);
  assert.throws(() => maskPii(['x'], { bin: null }), (e) => e instanceof PiiError && /Nothing was sent/.test(e.message));
});
