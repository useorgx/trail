// Opt-in personal-data masking with OpenAI Privacy Filter (open weights, Apache-2.0, runs locally): names, emails,
// phones, addresses, private dates, account numbers and secrets, decided from context rather than format.
// It is a 1.5B-parameter model with a Python CLI (`opf`, github.com/openai/privacy-filter), so trail uses it only
// for text that is about to leave the machine (trail deepen, trail sync --with-titles), never for local storage.
// Turn it on with `trail privacy --pii on`; if it is on and fails, nothing is sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME } from './store.mjs';

const CONFIG = path.join(HOME, 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
export const piiEnabled = () => readConfig().pii === 'opf';
export function setPii(on) { const c = readConfig(); c.pii = on ? 'opf' : null; fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1), { mode: 0o600 }); }

/** The `opf` executable: TRAIL_OPF, else on PATH. */
export function opfPath() {
  if (process.env.TRAIL_OPF) return process.env.TRAIL_OPF;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['opf'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
}

// Items are masked in one model load: joined with a separator line the model has no reason to touch, then split.
const MARK = 'TRAIL ITEM BOUNDARY'; const SEP = `\n${MARK}\n`;
export class PiiError extends Error {}
// opf prints one JSON object per input, compact or pretty-printed: read every top-level object in the output.
function jsonObjects(out) {
  const objs = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < out.length; i++) { const c = out[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') { if (depth++ === 0) start = i; } else if (c === '}' && depth > 0 && --depth === 0) { try { objs.push(JSON.parse(out.slice(start, i + 1))); } catch {} }
  }
  return objs;
}

/** Mask personal data in each text with Privacy Filter. Throws PiiError (so the caller sends nothing) on any failure. */
export function maskPii(texts, { bin = opfPath(), device = process.env.TRAIL_OPF_DEVICE || 'cpu' } = {}) {
  if (!texts.length) return [];
  if (!bin) throw new PiiError('Personal-data masking is on, but OpenAI Privacy Filter (`opf`) is not installed. Install it (pip install git+https://github.com/openai/privacy-filter) or run `trail privacy --pii off`. Nothing was sent.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-opf-')); const file = path.join(dir, 'in.txt');
  try {
    fs.writeFileSync(file, texts.join(SEP), { mode: 0o600 });
    const r = spawnSync(bin, ['--device', device, '-f', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60e3 });
    if (r.status !== 0) throw new PiiError(`Privacy Filter failed (${(r.stderr || '').trim().split('\n').pop() || 'exit ' + r.status}). Nothing was sent.`);
    const objs = jsonObjects(r.stdout);
    const redacted = objs.map((o) => o.redacted_text).filter((t) => typeof t === 'string').join('\n');
    const parts = redacted.split(SEP);
    if (parts.length !== texts.length) throw new PiiError(`Privacy Filter returned ${parts.length} items for ${texts.length}; refusing to send text that may not be masked.`);
    return parts;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
