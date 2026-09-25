// Follow the session being written right now: threads appear and grow as the agent works.
import fs from 'node:fs';
import { discover } from '../store.mjs';
import { readClaude, readCodex } from '../adapters.mjs';
import { threadify } from '../classify.mjs';
import { palette, clip, braid, statusWord, originMark } from './term.mjs';

export async function watch(opts = {}) {
  const C = palette(opts.plain); const out = process.stdout;
  const pick = () => discover({ since: new Date(Date.now() - 6 * 3600e3), client: opts.client }).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  let f = pick(); if (!f) { console.log('No session was written in the last 6 hours.'); return; }
  let last = -1; let busy = false;
  out.write('\x1b[?1049h\x1b[?25l');
  process.on('SIGINT', () => { out.write('\x1b[?25h\x1b[?1049l'); process.exit(0); });
  const draw = async () => {
    if (busy) return; busy = true;
    try {
      const nf = pick(); if (nf && nf.file !== f.file) { f = nf; last = -1; }
      const size = fs.statSync(f.file).size; if (size === last) return; last = size;
      const s = f.client === 'codex' ? await readCodex(f.file) : await readClaude(f.file); const r = threadify(s);
      const W = Math.min(out.columns || 100, 140); const H = out.rows || 40;
      const L = [`${C.b}${C.lime}■${C.r}${C.b} orgx trail · live${C.r}  ${C.mid}${f.client} · ${(s.cwd || '').split('/').pop()} · ${r.tools} calls · ${r.threads.length} threads · ${r.denied} denied${C.r}`, C.dim + '─'.repeat(W) + C.r, ''];
      for (const t of r.threads.slice(-(H - 6))) {
        const now = t === r.threads.at(-1);
        L.push(` ${originMark(C, t)} ${C.ink}${clip(t.title, 46).padEnd(46)}${C.r} ${braid(C, t.moves.slice(-(W - 70)), W - 70)}${t.backs.length ? C.coral + ' ⟲' + t.backs.length : ''} ${now ? C.lime + '● now' : statusWord(C, t.status)}${C.r}`);
      }
      out.write('\x1b[H' + L.map((l) => clip(l, W) + '\x1b[K').join('\n') + '\x1b[J');
    } finally { busy = false; }
  };
  await draw(); setInterval(() => draw().catch(() => {}), 700);
}
