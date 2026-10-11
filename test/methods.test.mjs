import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planMethodPublication, publishMethod } from '../src/methods.mjs';
import { methodsCommand } from '../src/methods-cli.mjs';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111';
const digest = (letter) => `sha256:${letter.repeat(64)}`;
function catalog(version = 1, overrides = {}) {
  const now = new Date().toISOString();
  return { schema_version: 'orgx.ratified-method-delivery/v1', workspace_id: WORKSPACE, read_at: now,
    consistency: 'best_effort_multi_read', candidates_withheld: 0, methods: [{ id: 'method:branch', version,
      digest: digest(version === 1 ? 'a' : 'b'), method_version: version, workspace_id: WORKSPACE,
      authority_owner_id: OWNER, owner_id: OWNER, title: 'Open a branch', ruling: 'Use a branch for each change.', mode: 'warn',
      scope: { kind: 'workspace', id: WORKSPACE }, applies_to: {}, steps: ['Open a branch', 'Run the required check'],
      prerequisites: ['Repository access'], exceptions: ['Owner approved recovery'], supporting_evidence: ['orgx://receipts/source'],
      ratification_ref: 'orgx://decisions/44444444-4444-4444-8444-444444444444', ratification_kind: 'decision', authority_ref: 'orgx://decisions/current',
      authority_event_hash: digest('c'), valid_from: '2026-01-01T00:00:00.000Z', valid_until: null, status: 'effective',
      revocation: { checked_at: now, head_version: version, revoked_at: null }, ...overrides }] };
}
const expected = (value) => ({ workspaceId: WORKSPACE, id: value.methods[0].id, version: value.methods[0].version, digest: value.methods[0].digest });
function repository(t, text = 'Unrelated owner instructions\r\n  trailing spaces  ') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-method-publisher-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const file = path.join(repo, 'AGENTS.md'); fs.writeFileSync(file, text, { mode: 0o640 }); fs.chmodSync(file, 0o640);
  return { repo, file, text };
}

test('preview reads current authority without writing instructions or creating locks', async (t) => {
  const fixture = repository(t); const value = catalog(); let reads = 0;
  const result = await publishMethod({ repo: fixture.repo, expected: expected(value), loadAuthority: async () => { reads++; return value; } });
  assert.equal(result.preview, true); assert.equal(reads, 1); assert.match(result.text, /Run the required check/);
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.text); assert.deepEqual(fs.readdirSync(fixture.repo), ['AGENTS.md']);
});
test('opt-in publication is idempotent and preserves original bytes and mode', async (t) => {
  const fixture = repository(t); const value = catalog();
  const input = { repo: fixture.repo, expected: expected(value), loadAuthority: async () => value, enabled: true };
  assert.equal((await publishMethod(input)).operation, 'published');
  const written = fs.readFileSync(fixture.file, 'utf8'); assert.ok(written.startsWith(fixture.text));
  assert.equal((await publishMethod(input)).operation, 'unchanged'); assert.equal(fs.readFileSync(fixture.file, 'utf8'), written);
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640); assert.deepEqual(fs.readdirSync(fixture.repo), ['AGENTS.md']);
});
test('human rewrite changes only its own block and retains another managed method', async (t) => {
  const fixture = repository(t, 'Owner prefix\n'); const first = catalog();
  await publishMethod({ repo: fixture.repo, expected: expected(first), loadAuthority: async () => first, enabled: true });
  const second = catalog(1, { id: 'method:other', title: 'Another method' });
  await publishMethod({ repo: fixture.repo, expected: expected(second), loadAuthority: async () => second, enabled: true });
  const before = fs.readFileSync(fixture.file, 'utf8'); const other = before.slice(before.indexOf('## Another method'));
  const rewritten = catalog(2, { steps: ['Use the ratified replacement'] });
  const result = await publishMethod({ repo: fixture.repo, expected: expected(rewritten), loadAuthority: async () => rewritten, enabled: true });
  assert.equal(result.operation, 'rewritten'); const after = fs.readFileSync(fixture.file, 'utf8');
  assert.ok(after.startsWith('Owner prefix\n')); assert.ok(after.endsWith(other)); assert.match(after, /Use the ratified replacement/);
  assert.doesNotMatch(after, /Run the required check\n\nPrerequisites:[\s\S]*Canonical method: method:branch/);
});
test('canonical revocation removes only its block and restores original bytes without inventing a newline', async (t) => {
  const fixture = repository(t); const first = catalog();
  await publishMethod({ repo: fixture.repo, expected: expected(first), loadAuthority: async () => first, enabled: true });
  const revoked = catalog(2, { status: 'revoked', revocation: { checked_at: new Date().toISOString(), head_version: 2, revoked_at: '2026-10-11T00:00:00.000Z' } });
  revoked.methods[0].revocation.checked_at = revoked.read_at;
  const result = await publishMethod({ repo: fixture.repo, expected: expected(revoked), loadAuthority: async () => revoked, enabled: true });
  assert.equal(result.operation, 'removed'); assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.text);
});
test('publication and explicit removal preserve a UTF-8 BOM and support a missing CLAUDE.md', async (t) => {
  const fixture = repository(t, '\uFEFFOwner instructions\r\n'); const value = catalog();
  const input = { repo: fixture.repo, expected: expected(value), loadAuthority: async () => value, enabled: true };
  await publishMethod(input); await publishMethod({ ...input, remove: true });
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.text);
  const result = await publishMethod({ ...input, targetName: 'CLAUDE.md' });
  assert.equal(result.operation, 'published'); assert.ok(fs.readFileSync(path.join(fixture.repo, 'CLAUDE.md'), 'utf8').startsWith('<!-- orgx-method:'));
});
test('a current human shadow rewrite withdraws the prior managed instructions', () => {
  const first = catalog(); const original = 'Owner instructions\n';
  const installed = planMethodPublication(original, first, expected(first)).text;
  const shadow = catalog(2, { mode: 'shadow', status: 'inactive' });
  const removed = planMethodPublication(installed, shadow, expected(shadow));
  assert.equal(removed.operation, 'removed'); assert.equal(removed.text, original);
});
test('canonical no-Decision human ratification carries its real provenance without a fabricated Decision', () => {
  const value = catalog(1, { ratification_kind: 'canonical_human_ratification',
    ratification_ref: 'orgx://precedents/method:branch/ratify/44444444-4444-4444-8444-444444444444', ratification_event_hash: digest('d'),
    authority_ref: 'orgx://precedents/method:branch/edit/55555555-5555-4555-8555-555555555555' });
  const plan = planMethodPublication('Owner text', value, expected(value));
  assert.match(plan.text, /Ratification: orgx:\/\/precedents\/method:branch\/ratify\//);
  assert.doesNotMatch(plan.text, /orgx:\/\/decisions\//);
  assert.throws(() => planMethodPublication('Owner text', catalog(1, { ...value.methods[0], ratification_event_hash: undefined }), expected(value)), /authority witness/);
});
test('a held publisher lock refuses another publisher without changing the target', async (t) => {
  const fixture = repository(t); const value = catalog(); const lock = path.join(fixture.repo, '.orgx-methods.lock'); fs.writeFileSync(lock, 'other publisher');
  await assert.rejects(publishMethod({ repo: fixture.repo, expected: expected(value), loadAuthority: async () => value, enabled: true }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.text); assert.equal(fs.readFileSync(lock, 'utf8'), 'other publisher');
});
test('a version changing between preview and commit refuses the write', async (t) => {
  const fixture = repository(t); const first = catalog(); let reads = 0;
  await assert.rejects(publishMethod({ repo: fixture.repo, expected: expected(first), loadAuthority: async () => ++reads === 1 ? first : catalog(2), enabled: true }), /changed/);
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.text); assert.deepEqual(fs.readdirSync(fixture.repo), ['AGENTS.md']);
});
test('an editor change before commit is preserved', async (t) => {
  const fixture = repository(t); const value = catalog();
  await assert.rejects(publishMethod({ repo: fixture.repo, expected: expected(value), loadAuthority: async () => value, enabled: true,
    beforeCommit: () => fs.writeFileSync(fixture.file, 'Concurrent owner edit') }), /changed during/);
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), 'Concurrent owner edit'); assert.deepEqual(fs.readdirSync(fixture.repo), ['AGENTS.md']);
});
test('symlink targets, duplicate blocks, edited blocks and malformed markers refuse publication', async (t) => {
  const fixture = repository(t); const value = catalog(); const plan = planMethodPublication('', value, expected(value), { repo: fixture.repo });
  assert.throws(() => planMethodPublication(plan.text + plan.text, value, expected(value)), /Duplicate/);
  assert.throws(() => planMethodPublication(plan.text.replace('Run the required check', 'Owner changed this step'), value, expected(value)), /edited/);
  assert.throws(() => planMethodPublication('<!-- orgx-method:bad BEGIN -->', value, expected(value)), /Malformed/);
  fs.renameSync(fixture.file, path.join(fixture.repo, 'owner.txt')); fs.symlinkSync('owner.txt', fixture.file);
  await assert.rejects(publishMethod({ repo: fixture.repo, expected: expected(value), loadAuthority: async () => value, enabled: true }), /symlink/);
  assert.equal(fs.readFileSync(path.join(fixture.repo, 'owner.txt'), 'utf8'), fixture.text);
});
test('absence, stale reads, mismatched workspace, conflicting digest and repo mismatch retain instructions', () => {
  const value = catalog(); const expectedValue = expected(value); const installed = planMethodPublication('Owner text', value, expectedValue).text;
  assert.throws(() => planMethodPublication(installed, { ...value, methods: [] }, expectedValue), /absent/);
  assert.throws(() => planMethodPublication(installed, { ...value, read_at: '2020-01-01T00:00:00.000Z' }, expectedValue), /stale/);
  assert.throws(() => planMethodPublication(installed, { ...value, workspace_id: OWNER }, expectedValue), /workspace/);
  const changed = catalog(1, { digest: digest('f') }); assert.throws(() => planMethodPublication(installed, changed, expected(changed)), /conflicts/);
  const scoped = catalog(1, { applies_to: { repos: ['another-project'] } }); assert.throws(() => planMethodPublication('Owner text', scoped, expected(scoped), { repo: '/my-project' }), /repository/);
  const newer = catalog(2); const newerBlock = planMethodPublication('', newer, expected(newer)).text;
  assert.throws(() => planMethodPublication(newerBlock, value, expectedValue), /newer/);
});
test('publisher HTTP reports only delivery, hashes the local path, and retries an unrecorded unchanged block', async (t) => {
  const fixture = repository(t); const value = catalog(); const calls = []; let reportFails = true;
  const previousKey = process.env.ORGX_API_KEY; process.env.ORGX_API_KEY = 'test-method-api-key';
  t.after(() => { if (previousKey === undefined) delete process.env.ORGX_API_KEY; else process.env.ORGX_API_KEY = previousKey; });
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'POST') return reportFails ? new Response('', { status: 503 }) : Response.json({ ok: true, data: { stage: 'method.delivered', assurance_rung: 0, producer_reported: true } });
    return Response.json({ ok: true, data: catalog() });
  };
  const args = ['publish', '--workspace', WORKSPACE, '--repo', fixture.repo, '--method', value.methods[0].id, '--version', '1', '--digest', value.methods[0].digest, '--yes'];
  const first = await methodsCommand(args, { fetchImpl }); assert.equal(first.operation, 'published'); assert.equal(first.delivery.stage, 'unrecorded');
  reportFails = false; const second = await methodsCommand(args, { fetchImpl }); assert.equal(second.operation, 'unchanged'); assert.equal(second.delivery.stage, 'method.delivered');
  const reports = calls.filter((call) => call.options.method === 'POST'); assert.equal(reports.length, 2);
  const report = JSON.parse(reports[0].options.body); assert.match(report.opportunity_id, /^instruction-file:[0-9a-f]{64}$/);
  assert.ok(!reports[0].options.body.includes(fixture.repo)); assert.ok(!reports[0].options.body.includes('test-method-api-key'));
  assert.equal(report.version, 1); assert.equal(report.digest, value.methods[0].digest); assert.equal(calls[0].options.redirect, 'error');
});
test('early CLI canonical method listing does not read the hidden session store', async (t) => {
  const fixture = repository(t); const forbidden = path.join(fixture.repo, 'hidden-transcript-store'); fs.mkdirSync(forbidden);
  const preload = path.join(fixture.repo, 'guard.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';\nfor (const name of ['readFileSync','readdirSync','openSync']) { const original = fs[name]; fs[name] = function(file,...rest) { if (String(file).startsWith(process.env.TRAIL_HOME)) throw new Error('Hidden transcript read forbidden'); return original.call(this,file,...rest); }; }\n`);
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, data: catalog() })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const child = spawn(process.execPath, ['--import', preload, fileURLToPath(new URL('../bin/trail.mjs', import.meta.url)), 'methods', 'list', '--workspace', WORKSPACE, '--base', `http://127.0.0.1:${server.address().port}`], { env: { ...process.env, ORGX_API_KEY: 'test-key', TRAIL_HOME: forbidden }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
  const code = await new Promise((resolve) => child.on('close', resolve)); assert.equal(code, 0, stderr); assert.equal(JSON.parse(stdout).catalog.methods.length, 1);
  assert.deepEqual(fs.readdirSync(forbidden), []);
});
test('CLI drains a large bounded catalog into a pipe before exit', async (t) => {
  const value = { ...catalog(), schema_version: 'orgx.ratified-method-index/v1',
    methods: Array.from({ length: 200 }, (_, index) => ({ id: `method:${index}`, version: 1, digest: digest('a'), title: 'x'.repeat(200), status: 'effective', scope: { kind: 'workspace', id: WORKSPACE } })) };
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, data: value })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/trail.mjs', import.meta.url)), 'methods', 'list', '--workspace', WORKSPACE, '--base', `http://127.0.0.1:${server.address().port}`], { env: { ...process.env, ORGX_API_KEY: 'test-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => child.on('close', resolve));
  let stdout = ''; let stderr = ''; child.stderr.on('data', (chunk) => stderr += chunk);
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.stdout.on('data', (chunk) => stdout += chunk);
  const code = await closed;
  assert.equal(code, 0, stderr); assert.equal(JSON.parse(stdout).catalog.methods.length, 200);
  assert.equal(JSON.parse(stdout).catalog.methods.at(-1).title, 'x'.repeat(200));
});
