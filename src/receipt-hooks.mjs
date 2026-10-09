// Reversible Claude Code integration. The opt-in install enables uploads and a local, incremental capture worker.
import fs from 'node:fs';
import path from 'node:path';
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
export function receiptHookStatus() {
  const settings = read(settingsPath(), {}); const config = read(CONFIG, {});
  return { installed: config.enabled === true && EVENTS.every((event) => settings.hooks?.[event]?.some((entry) => entry.hooks?.some(ours))), settings: settingsPath(), events: EVENTS };
}
export function installReceiptHooks(binPath, { base } = {}) {
  if (!credential()?.key) throw new Error('Run `trail connect` or set ORGX_API_KEY before enabling receipt uploads.');
  const file = settingsPath(); const settings = read(file, {});
  fs.mkdirSync(path.join(HOME, 'backup'), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(HOME, 'backup', `claude-settings.receipts.${Date.now()}.json`));
  remove(settings); settings.hooks ||= {};
  // Single-quote shell escaping protects executable paths, including spaces and command-substitution characters.
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  for (const event of EVENTS) (settings.hooks[event] ||= []).push({ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(binPath)} receipt-hook run`, timeout: 5, statusMessage: MARK }] });
  fs.writeFileSync(CONFIG, JSON.stringify({ enabled: true, ...(base ? { base } : {}) }), { mode: 0o600 });
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return receiptHookStatus();
}
export async function uninstallReceiptHooks() {
  const file = settingsPath(); const settings = read(file, {}); remove(settings);
  if (fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.writeFileSync(CONFIG, JSON.stringify({ enabled: false }), { mode: 0o600 });
  try { await dispatch({ shutdown: true }); } catch {}
  return receiptHookStatus();
}
function dispatch(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(RECEIPT_SOCKET); let response = '';
    socket.setTimeout(4000, () => socket.destroy(new Error('Receipt hook worker timed out.')));
    socket.once('error', reject); socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => { response += chunk; if (response.includes('\n')) { socket.end(); try { const result = JSON.parse(response.trim()); result.error ? reject(new Error(result.error)) : resolve(result); } catch (error) { reject(error); } } });
  });
}
export async function runReceiptHook(input) {
  const config = read(CONFIG, {}); if (!config.enabled) return { skipped: true };
  const payload = JSON.parse(input || '{}'); if (!payload.transcript_path) return { skipped: true };
  try { return await dispatch(payload); } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  const log = fs.openSync(path.join(HOME, 'receipt-hooks.log'), 'a', 0o600);
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../bin/trail.mjs', import.meta.url)), 'receipt-hook', 'worker'], { detached: true, stdio: ['ignore', log, log] });
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
  const close = async () => { if (closing) return; closing = true; for (const capture of captures.values()) capture.close(); await new Promise((resolve) => server.close(resolve)); try { fs.unlinkSync(RECEIPT_SOCKET); } catch {} release(); };
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
              capture = await captureImpl(file, payload.client || 'claude', { receipts: true, base: config.base, onError: (error) => process.stderr.write(`trail receipts: ${error.message}\n`) });
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
