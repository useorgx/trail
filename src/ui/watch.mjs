// Follow the session being written right now: incremental steps, goals and receipts share the local view.
import { discover } from '../store.mjs';
import { startLiveCapture } from '../live.mjs';
import { palette, clip, braid, statusWord, originMark } from './term.mjs';

export async function watch(opts = {}) {
  const C = palette(opts.plain); const out = process.stdout;
  const pick = () => discover({ since: new Date(Date.now() - 6 * 3600e3), client: opts.client }).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  let file = pick(); if (!file) { console.log('No session was written in the last 6 hours.'); return; }
  let capture; let switching = false;
  out.write('\x1b[?1049h\x1b[?25l');
  const draw = ({ session, windows }) => {
      const threads = windows.flatMap((w) => w.result?.threads || []);
      const tools = windows.reduce((sum, w) => sum + (w.result?.tools || 0), 0);
      const goals = windows.reduce((sum, w) => sum + (w.goals?.length || 0), 0);
      const W = Math.min(out.columns || 100, 140); const H = out.rows || 40;
      const L = [`${C.b}${C.lime}■${C.r}${C.b} orgx trail · live${C.r}  ${C.mid}${file.client} · ${(session.cwd || '').split('/').pop()} · ${tools} calls · ${goals} goals${opts.receipts ? ' · syncing checkpoints' : ''}${C.r}`, C.dim + '─'.repeat(W) + C.r, ''];
      for (const t of threads.slice(-(H - 6))) {
        const now = t === threads.at(-1);
        L.push(` ${originMark(C, t)} ${C.ink}${clip(t.title, 46).padEnd(46)}${C.r} ${braid(C, t.moves.slice(-(W - 70)), W - 70)}${t.backs.length ? C.coral + ' ⟲' + t.backs.length : ''} ${now ? C.lime + '● now' : statusWord(C, t.status)}${C.r}`);
      }
      out.write('\x1b[H' + L.map((l) => clip(l, W) + '\x1b[K').join('\n') + '\x1b[J');
  };
  const start = () => startLiveCapture(file.file, file.client, { receipts: opts.receipts, base: opts.base, onUpdate: draw, onError: (error) => process.stderr.write(`trail live: ${error.message}\n`) });
  capture = await start();
  const repick = setInterval(async () => {
    if (switching) return;
    const next = pick(); if (!next || next.file === file.file) return;
    switching = true;
    try { capture.close(); file = next; capture = await start(); } finally { switching = false; }
  }, 2000);
  process.once('SIGINT', () => { capture.close(); clearInterval(repick); out.write('\x1b[?25h\x1b[?1049l'); process.exit(0); });
}
