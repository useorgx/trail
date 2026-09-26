// The first-run moment: your whole agent history landing, session by session.
import { palette, clip, braid, bar, fmt, originMark } from './term.mjs';
import { scan } from '../scan.mjs';
import { wallById } from '../walls.mjs';
import { loadSessions, loadAdoptions } from '../store.mjs';
import { corpus } from '../metrics.mjs';
import { buildGuard } from '../guard.mjs';
import { ruleFor } from '../adopt.mjs';

export async function scanView(opts) {
  const C = palette(opts.plain); const out = process.stdout; const live = !C.plain && out.isTTY;
  const stats = { sessions: 0, threads: 0, discovery: 0, recovered: 0, walled: 0, backs: 0, denied: 0, claude: 0, codex: 0 };
  const wallSessions = new Map(); const recent = []; let st = { bytes: 0, doneBytes: 0, streamed: 0, t0: Date.now(), todo: 0 };
  const onSession = (s, s2) => {
    st = s2; stats.sessions++; stats[s.client]++; stats.threads += s.threads.length; stats.denied += s.denied;
    for (const t of s.threads) { if (t.origin === 'surprise') t.kind === 'wall' ? stats.walled++ : t.kind === 'found' ? stats.discovery++ : stats.recovered++; stats.backs += t.backs.length; }
    for (const w of s.walls) if (w.named) wallSessions.set(w.sig, (wallSessions.get(w.sig) || 0) + 1);
    recent.push(s); if (recent.length > 12) recent.shift();
  };
  const frame = () => {
    const W = Math.min(out.columns || 100, 118); const H = out.rows || 40;
    const el = ((Date.now() - st.t0) / 1000).toFixed(1); const got = st.doneBytes + st.streamed; const f = st.bytes ? Math.min(1, got / st.bytes) : 1;
    const L = [];
    L.push(`${C.b}${C.lime}■${C.r}${C.b} orgx trail${C.r}  ${C.mid}reading your agents’ work, on this machine${C.r}`);
    L.push(`${C.dim}${'─'.repeat(W)}${C.r}`);
    L.push(`  ${bar(C, f, 24)}  ${C.ink}${fmt(got / 1e6)}${C.mid} / ${fmt(st.bytes / 1e6)} MB · ${fmt(got / 1e6 / Math.max(0.1, (Date.now() - st.t0) / 1000))} MB/s · ${el}s${C.r}`);
    L.push('');
    L.push(`  ${C.ink}${C.b}${fmt(stats.sessions).padStart(6)}${C.r}${C.mid} sessions  ${C.dim}(claude ${fmt(stats.claude)} · codex ${fmt(stats.codex)})${C.r}`);
    L.push(`  ${C.ink}${C.b}${fmt(stats.threads).padStart(6)}${C.r}${C.mid} threads of work${C.r}`);
    L.push(`  ${C.iris}${C.b}${fmt(stats.discovery).padStart(6)}${C.r}${C.mid} times an agent said it found something wrong that nobody asked about${C.r}`);
    L.push(`  ${C.ink}${C.b}${fmt(stats.recovered).padStart(6)}${C.r}${C.mid} recoveries from repeated failures${C.r}`);
    L.push(`  ${C.coral}${C.b}${fmt(stats.walled).padStart(6)}${C.r}${C.mid} times they hit a permission wall  ·  ${C.coral}${fmt(stats.backs)}${C.mid} backtracks${C.r}`);
    L.push('');
    const nRecent = Math.max(3, Math.min(10, H - 20));
    L.push(`  ${C.dim}landing now${C.r}`);
    for (const s of recent.slice(-nRecent)) {
      const lbl = `${(s.start || '').slice(5, 10)} ${String(s.client).slice(0, 6).padEnd(6)} ${String(s.project).slice(0, 14).padEnd(14)}`;
      let row = ''; for (const t of s.threads.slice(0, 6)) row += originMark(C, t) + braid(C, t.moves, Math.max(3, Math.floor((W - 34) / Math.min(6, s.threads.length)) - 2)) + ' ';
      L.push(`  ${C.dim}${lbl}${C.r} ${row}`);
    }
    for (let k = Math.min(recent.length, nRecent); k < nRecent; k++) L.push('');
    L.push('');
    L.push(`  ${C.dim}walls your agents keep rediscovering${C.r}`);
    const top = [...wallSessions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4); const mx = top[0]?.[1] || 1;
    for (const [k, v] of top) L.push(`  ${C.coral}${String(v).padStart(5)}${C.r} ${bar(C, v / mx, 12, 'coral')}  ${C.ink}${wallById(k)?.name || k}${C.r}`);
    for (let k = top.length; k < 4; k++) L.push('');
    out.write('\x1b[H' + L.map((l) => clip(l, W) + '\x1b[K').join('\n') + '\x1b[J');
  };
  if (live) out.write('\x1b[?1049h\x1b[?25l');
  const restore = () => { if (live) out.write('\x1b[?25h\x1b[?1049l'); };
  process.once('SIGINT', () => { restore(); process.exit(130); });
  const timer = live ? setInterval(frame, 60) : null;
  const res = await scan({ ...opts, onSession, onProgress: (s) => { st = s; } });
  if (timer) { clearInterval(timer); frame(); await new Promise((r) => setTimeout(r, 450)); }
  restore();
  // Refresh the guard's evidence from everything read so far.
  try { buildGuard(corpus(loadSessions(), loadAdoptions()).walls.map((w) => ({ ...w, rule: ruleFor(w) }))); } catch {}
  const say = (s) => out.write(s + '\n');
  say('');
  say(`  ${C.b}${res.todo ? `Read ${fmt(res.todo)} sessions (${fmt(res.bytes / 1e6)} MB) in ${res.secs.toFixed(1)}s` : 'Up to date. Nothing new since the last read.'}${C.r}${C.mid} · $0.00 · nothing left this machine${C.r}`);
  const topW = [...wallSessions.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topW) say(`  ${C.mid}Your agents hit “${wallById(topW[0]).name}” in ${C.coral}${fmt(topW[1])}${C.mid} separate sessions, starting from zero each time.${C.r}`);
  if (res.failures.length) say(`  ${C.dim}${res.failures.length} files could not be read.${C.r}`);
  return res;
}
