// The existing OrgX sign-in lookup, without importing the session store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function cloudConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orgx', 'cloud.json'), 'utf8')); } catch { return {}; }
}
function wizardConfig() {
  const dir = process.env.ORGX_WIZARD_CONFIG_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'useorgx', 'wizard');
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')); } catch { return {}; }
}
export function authHeaders(cred) {
  return cred?.mode === 'proxy-header' ? {} : { authorization: `Bearer ${cred.key}` };
}

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
  const mode = process.env.ORGX_AUTH_MODE || cloudConfig().authMode || 'direct';
  if (!['direct', 'proxy-header', 'proxy-placeholder'].includes(mode)) throw new Error('Unsupported ORGX_AUTH_MODE.');
  if (mode !== 'direct') {
    const scope = process.env.ORGX_AUTH_SCOPE?.trim();
    if (!scope) throw new Error('Proxy receipt delivery requires ORGX_AUTH_SCOPE set to the workspace and actor identity.');
    if (mode === 'proxy-placeholder' && !process.env.ORGX_API_KEY?.trim()) throw new Error('Proxy placeholder is missing ORGX_API_KEY.');
    return { key: mode === 'proxy-header' ? `proxy-header:${scope}` : process.env.ORGX_API_KEY.trim(), scope, mode, from: mode };
  }
  if (process.env.ORGX_API_KEY) return { key: process.env.ORGX_API_KEY.trim(), from: 'ORGX_API_KEY' };
  const stored = wizardConfig();
  if (stored.storage === 'file' && stored.apiKey?.trim()) return { key: stored.apiKey.trim(), from: 'wizard store', baseUrl: stored.baseUrl };
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
  return (flag || process.env.ORGX_BASE_URL || cloudConfig().baseUrl || wizardConfig().baseUrl || 'https://useorgx.com').replace(/\/$/, '');
}
