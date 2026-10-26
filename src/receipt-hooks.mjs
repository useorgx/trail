// Reversible Claude Code integration. The opt-in install enables uploads and a local, incremental capture worker.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME } from './store.mjs';
import { settingsPath } from './guard.mjs';
import { startLiveCapture } from './live.mjs';
import { credential } from './sync.mjs';

const MARK = 'orgx trail receipts';
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
const CONFIG = path.join(HOME, 'receipt-hooks.json');
export const RECEIPT_SOCKET = path.join(HOME, 'receipt-hooks.sock');
const LOCK = path.join(HOME, 'receipt-hooks.lock');
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
const ours = (hook) => hook?.statusMessage === MARK;
const remove = (settings) => {
  for (const event of EVENTS) {
    if (!settings.hooks?.[event]) continue;
    settings.hooks[event] = settings.hooks[event].map((entry) => ({ ...entry, hooks: (entry.hooks || []).filter((hook) => !ours(hook)) })).filter((entry) => entry.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
};
export function receiptSettingsPath(client = 'claude') {
  if (client === 'claude') return settingsPath();
  if (client === 'codex') return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
  throw new Error('Receipt hooks support claude and codex.');
}
export function receiptHookStatus({ client = 'claude' } = {}) {
  const file = receiptSettingsPath(client);
  const settings = read(file, {}); const config = read(CONFIG, {});
  return { installed: config.enabled === true && EVENTS.every((event) => settings.hooks?.[event]?.some((entry) => entry.hooks?.some(ours))), settings: file, client, consent: config.consent || 'content', events: EVENTS };
}
export function installReceiptHooks(binPath, { base, client = 'claude', prepare = false, consent } = {}) {
  if (prepare && consent !== 'content') throw new Error('Cloud receipt preparation requires --consent content: prompts, summaries, commands and output excerpts can be uploaded at runtime.');
  if (!prepare && !credential()?.key) throw new Error('Run `trail connect` or set ORGX_API_KEY before enabling receipt uploads.');
  const file = receiptSettingsPath(client); const settings = read(file, {});
  const previous = JSON.stringify(settings);
  const previousConfig = read(CONFIG, {});
  fs.mkdirSync(path.join(HOME, 'backup'), { recursive: true, mode: 0o700 });
  remove(settings); settings.hooks ||= {};
  // Single-quote shell escaping protects executable paths, including spaces and command-substitution characters.
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  for (const event of EVENTS) (settings.hooks[event] ||= []).push({ hooks: [{ type: 'command', command: `${process.platform === 'win32' ? '' : 'env NODE_USE_ENV_PROXY=1 '}${quote(process.execPath)} ${quote(binPath)} receipt-hook run --client ${client}`, timeout: 5, statusMessage: MARK }] });
  const config = { ...previousConfig, enabled: true, consent: 'content', clients: [...new Set([...(previousConfig.clients || (previousConfig.enabled ? ['claude'] : [])), client])].sort(), ...(base ? { base } : {}) };
  if (previous === JSON.stringify(settings) && JSON.stringify(config) === JSON.stringify(previousConfig)) return receiptHookStatus({ client });
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(HOME, 'backup', `${client}-settings.receipts.${Date.now()}.json`));
  fs.writeFileSync(CONFIG, JSON.stringify(config), { mode: 0o600 });
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return receiptHookStatus({ client });
}
export async function uninstallReceiptHooks({ client = 'claude' } = {}) {
  const file = receiptSettingsPath(client); const settings = read(file, {}); remove(settings);
  if (fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  const config = read(CONFIG, {});
  const clients = (config.clients || ['claude']).filter((name) => name !== client);
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.writeFileSync(CONFIG, JSON.stringify({ ...config, clients, enabled: clients.length > 0 }), { mode: 0o600 });
  if (!clients.length) { try { await dispatch({ shutdown: true }); } catch {} }
  return receiptHookStatus({ client });
}
function dispatch(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(RECEIPT_SOCKET); let response = '';
    socket.setTimeout(4000, () => socket.destroy(new Error('Receipt hook worker timed out.')));
    socket.once('error', reject); socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => { response += chunk; if (response.includes('\n')) { socket.end(); try { const result = JSON.parse(response.trim()); result.error ? reject(new Error(result.error)) : resolve(result); } catch (error) { reject(error); } } });
  });
}
export async function runReceiptHook(input, { client } = {}) {
  const config = read(CONFIG, {}); if (!config.enabled) return { skipped: true };
  const payload = JSON.parse(input || '{}'); if (client) payload.client = client;
  payload.transcript_path ||= payload.transcriptPath;
  if (!payload.transcript_path) return { skipped: true, reason: 'transcript_path missing' };
  if (config.clients && !config.clients.includes(payload.client || 'claude')) return { skipped: true, reason: 'client disabled' };
  try { return await dispatch(payload); } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  const log = fs.openSync(path.join(HOME, 'receipt-hooks.log'), 'a', 0o600);
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../bin/trail.mjs', import.meta.url)), 'receipt-hook', 'worker'], { detached: true, env: { ...process.env, NODE_USE_ENV_PROXY: '1' }, stdio: ['ignore', log, log] });
  worker.unref(); fs.closeSync(log);
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    try { return await dispatch(payload); } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  }
  throw new Error('Receipt hook worker did not start.');
}
export async function receiptHookWorker({ captureImpl = startLiveCapture } = {}) {
  const config = read(CONFIG, {}); if (!config.enabled) return null;
  const captures = new Map(); let queue = Promise.resolve();
  // A refused connection is stale; a live worker owns the socket, so racing startups exit without replacing it.
  try { await dispatch({ ping: true }); return null; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') throw error; }
  const token = crypto.randomUUID();
  for (;;) {
    try { const fd = fs.openSync(LOCK, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); } break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner; try { owner = read(LOCK, null); } catch { return null; }
      if (!Number.isInteger(owner?.pid) || owner.pid < 1) return null; // the owner may still be writing its lock
      try { process.kill(owner.pid, 0); return null; } catch (probe) { if (probe.code !== 'ESRCH') return null; }
      // Only remove the same stale owner observed above, never a replacement lock.
      if (read(LOCK, null)?.token === owner.token) { try { fs.unlinkSync(LOCK); } catch (unlink) { if (unlink.code !== 'ENOENT') throw unlink; } }
    }
  }
  const release = () => { try { if (read(LOCK, null)?.token === token) fs.unlinkSync(LOCK); } catch {} };
  // Recheck under exclusive startup ownership before cleaning a stale socket.
  try { await dispatch({ ping: true }); release(); return null; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') { release(); throw error; } }
  if (fs.existsSync(RECEIPT_SOCKET)) fs.unlinkSync(RECEIPT_SOCKET);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; for (const capture of captures.values()) { await capture.flushed?.(); capture.close(); } await new Promise((resolve) => server.close(resolve)); try { fs.unlinkSync(RECEIPT_SOCKET); } catch {} release(); };
  const server = net.createServer((socket) => {
    let input = ''; socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', (chunk) => {
      input += chunk; if (input.length > 1_048_576) return socket.destroy();
      if (!input.includes('\n')) return;
      const line = input.slice(0, input.indexOf('\n')); input = '';
      queue = queue.then(async () => {
        try {
          const payload = JSON.parse(line);
          if (payload.shutdown) { socket.end('{"ok":true}\n'); void close(); return; }
          if (!payload.ping && read(CONFIG, {}).enabled) {
            const file = payload.transcript_path;
            if (typeof file !== 'string') throw new Error('Receipt hook requires transcript_path.');
            let capture = captures.get(file);
            if (!capture) {
              capture = await captureImpl(file, payload.client || 'claude', { receipts: true, base: config.base, onDelivery: (result) => recordReceiptDelivery(payload, result), onError: (error) => process.stderr.write(`trail receipts: ${error.message}\n`) });
              captures.set(file, capture);
            } else await capture.update();
          }
          socket.end('{"ok":true}\n');
        } catch (error) { socket.end(JSON.stringify({ error: error.message }) + '\n'); }
      });
    });
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(RECEIPT_SOCKET, resolve); }); } catch (error) { release(); throw error; }
  fs.chmodSync(RECEIPT_SOCKET, 0o600);
  return { server, captures, close };
}

// Bounded, private evidence of a receipt API acknowledgement, scoped to a native session.
export function recordReceiptDelivery(payload, result) {
  if (!result.receipts || result.dryRun || result.refused?.length) return;
  const session = payload.session_id || payload.sessionId;
  if (typeof session !== 'string' || !session) return;
  const client = payload.client === 'codex' ? 'codex' : 'claude-code';
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const dir = path.join(os.homedir(), '.orgx', 'cloud-receipts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sessionHash = hash(`${client}:${session}`);
  const cred = credential();
  const file = path.join(dir, `${sessionHash}.json`);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 'orgx-receipt-delivery/v1', sessionHash,
    destination: new URL(result.url).origin, scopeHash: hash(cred.scope || cred.key), cwdHash: hash(payload.cwd || process.cwd()), acknowledgedAt: new Date().toISOString(),
    receipts: result.receipts, evidence: 'receipt-api-acknowledgement' }) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
