// The existing OrgX sign-in lookup, without importing the session store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** The OpenClaw config file the wizard falls back to (plugins.entries["openclaw-plugin"|"orgx"].config.apiKey). */
function openclawKey() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
    const entries = cfg?.plugins?.entries || {}; const entry = entries['openclaw-plugin'] || entries.orgx;
    const key = typeof entry?.config?.apiKey === 'string' ? entry.config.apiKey.trim() : '';
    return key ? { key, from: 'OpenClaw config (~/.openclaw/openclaw.json)', baseUrl: entry.config.baseUrl } : null;
  } catch { return null; }
}

/** The key the OrgX wizard already uses, in the wizard's own order: env, keychain store, OpenClaw config. Never printed. */
export function credential() {
  if (process.env.ORGX_API_KEY) return { key: process.env.ORGX_API_KEY.trim(), from: 'ORGX_API_KEY' };
  if (process.platform === 'darwin' && !process.env.TRAIL_NO_KEYCHAIN) {
    const args = ['find-generic-password', '-s', '@useorgx/wizard', '-a', 'orgx-api-key'];
    try {
      const key = execFileSync('security', [...args, '-w'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8_000 }).toString().trim();
      if (key) return { key, from: 'keychain (@useorgx/wizard)' };
    } catch {
      // The entry can exist while macOS refuses to hand it to a different program until you allow it.
      try { execFileSync('security', args, { stdio: 'ignore' }); const oc = openclawKey(); return oc || { key: null, from: 'keychain', blocked: true }; } catch {}
    }
  }
  return openclawKey();
}
export function baseUrl(flag) {
  if (flag) return flag.replace(/\/$/, '');
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'useorgx', 'wizard', 'auth.json'), 'utf8')).baseUrl.replace(/\/$/, ''); } catch { return 'https://useorgx.com'; }
}

