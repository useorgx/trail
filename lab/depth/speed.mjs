// Cost of also keeping reasoning: time to read 40 recent Claude + 40 Codex sessions with trail's reader, then with thinking extraction added.
import fs from 'node:fs'; import readline from 'node:readline';
import { discover } from '../../src/store.mjs'; import { readSession } from '../../src/clients.mjs';
const files = discover().filter((f) => (f.client === 'claude' || f.client === 'codex') && f.size > 20e3 && f.size < 60e6).sort((a, b) => b.mtimeMs - a.mtimeMs);
const pick = [...files.filter((f) => f.client === 'claude').slice(0, 40), ...files.filter((f) => f.client === 'codex').slice(0, 40)];
const mb = pick.reduce((n, f) => n + f.size, 0) / 1e6;
let t = performance.now(); for (const f of pick) await readSession(f.file, f.client); const base = performance.now() - t;
// Extra pass that only pulls thinking/reasoning text, sniffing lines before parsing (what a production reader would do).
t = performance.now(); let chars = 0;
for (const f of pick) { const rl = readline.createInterface({ input: fs.createReadStream(f.file, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const l of rl) { if (f.client === 'claude' ? !l.includes('"thinking":"') : !l.includes('"type":"reasoning"')) continue; if (l.length > 400000) continue;
    try { const d = JSON.parse(l); if (f.client === 'claude') for (const b of d.message?.content || []) chars += (b.thinking || '').length; else chars += (d.payload?.summary || []).reduce((n, s) => n + (s.text || '').length, 0); } catch {} } }
const extra = performance.now() - t;
console.log({ sessions: pick.length, MB: +mb.toFixed(0), trail_read_s: +(base / 1000).toFixed(1), reasoning_pass_s: +(extra / 1000).toFixed(1), reasoning_chars: chars });
