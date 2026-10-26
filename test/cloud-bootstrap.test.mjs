import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-cloud-'));
process.env.HOME = home;
process.env.CODEX_HOME = path.join(home, '.codex');
process.env.TRAIL_HOME = path.join(home, '.orgx', 'trail');
process.env.TRAIL_NO_KEYCHAIN = '1';
process.env.TRAIL_CLAUDE_SETTINGS = path.join(home, '.claude', 'settings.json');
delete process.env.ORGX_API_KEY;
const { installReceiptHooks, uninstallReceiptHooks, receiptHookStatus, runReceiptHook, recordReceiptDelivery } = await import('../src/receipt-hooks.mjs');
const { credential, authHeaders, baseUrl } = await import('../src/credentials.mjs');
const { processOwner, ownerAlive, withProcessLock } = await import('../src/process-lock.mjs');
const bin = new URL('../bin/trail.mjs', import.meta.url).pathname;
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('restored lock ownership uses process birth and preserves live owners', async () => {
  const owner = processOwner();
  assert.equal(ownerAlive(owner), true);
  if (owner.bootId) {
    assert.equal(ownerAlive({ ...owner, bootId: 'previous-vm-boot' }), false);
    const lock = path.join(home, 'restored.lock');
    fs.writeFileSync(lock, JSON.stringify({ ...owner, bootId: 'previous-vm-boot', token: 'stale' }));
    assert.equal(await withProcessLock(lock, async () => 'recovered', { timeoutMs: 50 }), 'recovered');
    assert.equal(fs.existsSync(lock), false);
  }
  const live = path.join(home, 'live.lock');
  fs.writeFileSync(live, JSON.stringify({ ...owner, token: 'live-owner' }));
  await assert.rejects(withProcessLock(live, async () => assert.fail('live ownership stolen'), { timeoutMs: 25 }), /Another Trail/);
  assert.equal(JSON.parse(fs.readFileSync(live, 'utf8')).token, 'live-owner');
});

test('unattended preparation requires content consent, no credential, and preserves both clients', async () => {
  assert.throws(() => installReceiptHooks(bin, { prepare: true }), /consent content/);
  const claude = process.env.TRAIL_CLAUDE_SETTINGS;
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foreign-hook' }] }] } }));
  const options = { prepare: true, consent: 'content', base: 'https://useorgx.com' };
  assert.equal(installReceiptHooks(bin, options).installed, true);
  const before = fs.readFileSync(claude, 'utf8');
  const backups = fs.readdirSync(path.join(process.env.TRAIL_HOME, 'backup'));
  installReceiptHooks(bin, options);
  assert.equal(fs.readFileSync(claude, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(process.env.TRAIL_HOME, 'backup')), backups);
  assert.equal(installReceiptHooks(bin, { ...options, client: 'codex' }).installed, true);
  assert.match(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'), /run --client codex/);
  assert.equal((await runReceiptHook('{}', { client: 'codex' })).reason, 'transcript_path missing');
  await uninstallReceiptHooks({ client: 'codex' });
  assert.equal(receiptHookStatus().installed, true);
  await uninstallReceiptHooks();
  assert.match(fs.readFileSync(claude, 'utf8'), /foreign-hook/);
  assert.equal(receiptHookStatus().installed, false);
});

test('CLI preparation cannot silently authorize text uploads', () => {
  const result = spawnSync(process.execPath, [bin, 'receipt-hook', 'prepare', '--client', 'codex'], { env: process.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /consent content/);
});

test('runtime proxy transports skip stored credentials and scope receipt acknowledgements', () => {
  process.env.ORGX_AUTH_MODE = 'proxy-header';
  process.env.ORGX_API_KEY = 'must-not-be-sent';
  delete process.env.ORGX_AUTH_SCOPE;
  assert.throws(() => credential(), /ORGX_AUTH_SCOPE/);
  process.env.ORGX_AUTH_SCOPE = 'workspace:actor';
  assert.deepEqual(authHeaders(credential()), {});
  process.env.ORGX_AUTH_MODE = 'proxy-placeholder';
  process.env.ORGX_API_KEY = 'placeholder';
  assert.deepEqual(authHeaders(credential()), { authorization: 'Bearer placeholder' });
  assert.equal(credential().scope, 'workspace:actor');
  process.env.ORGX_BASE_URL = 'https://api.example';
  assert.equal(baseUrl(), 'https://api.example');
  recordReceiptDelivery({ client: 'codex', session_id: 'native-session', cwd: '/repo' }, {
    receipts: 1, url: 'https://api.example/api/v1/agent-work-receipts', refused: [],
  });
  const records = fs.readdirSync(path.join(home, '.orgx', 'cloud-receipts'));
  assert.equal(records.length, 1);
  const text = fs.readFileSync(path.join(home, '.orgx', 'cloud-receipts', records[0]), 'utf8');
  assert.equal(JSON.parse(text).evidence, 'receipt-api-acknowledgement');
  assert.doesNotMatch(text, /placeholder|native-session|workspace:actor/);
  recordReceiptDelivery({ session_id: 'failed' }, { receipts: 0, refused: [{ id: 'failed' }] });
  assert.equal(fs.readdirSync(path.join(home, '.orgx', 'cloud-receipts')).length, 1);
});
