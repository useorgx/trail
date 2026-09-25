// Terminal primitives: color that degrades cleanly, width-safe lines, the move glyph alphabet.
const env = process.env;
export const plainMode = () => !!env.NO_COLOR || !process.stdout.isTTY;
const TC = env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || /iTerm|vscode|WezTerm|ghostty/i.test(env.TERM_PROGRAM || '');

export function palette(plain = plainMode()) {
  const rgb = (r, g, b, n) => (plain ? '' : TC ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${n}m`);
  const bg = (r, g, b, n) => (plain ? '' : TC ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${n}m`);
  return {
    lime: rgb(191, 255, 0, 154), teal: rgb(45, 212, 191, 43), iris: rgb(139, 140, 255, 105), coral: rgb(255, 122, 102, 209),
    amber: rgb(245, 183, 0, 214), dim: rgb(108, 114, 122, 243), ink: rgb(236, 237, 238, 255), mid: rgb(167, 172, 179, 249),
    sel: bg(34, 38, 44, 236), tab: bg(236, 237, 238, 255) + rgb(12, 13, 15, 232),
    b: plain ? '' : '\x1b[1m', u: plain ? '' : '\x1b[4m', r: plain ? '' : '\x1b[0m', plain,
  };
}

/** Visible width of a string with ANSI codes stripped (wide glyphs counted as 1: we only use narrow ones). */
export const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
/** Clip to w visible columns without cutting an escape sequence. */
export function clip(line, w) {
  let vis = 0, out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') { const j = line.indexOf('m', i); out += line.slice(i, j + 1); i = j; continue; }
    if (vis >= w) break; out += line[i]; vis++;
  }
  return out;
}
export const pad = (s, w) => { const v = vlen(s); return v >= w ? clip(s, w) : s + ' '.repeat(w - v); };
export const fmt = (n) => Math.round(n).toLocaleString('en-US');
export const pct = (x) => (x * 100 < 10 && x > 0 ? (x * 100).toFixed(1) : Math.round(x * 100)) + '%';

export const GLYPH = { p: ['dim', '·'], r: ['dim', '∙'], c: ['lime', '━'], h: ['teal', '✓'], s: ['ink', '▲'], d: ['iris', '◆'], X: ['coral', '✗'], D: ['coral', '⊘'] };
export const LEGEND = [['p', 'probe'], ['c', 'change'], ['h', 'check'], ['s', 'ship'], ['X', 'failed'], ['D', 'denied']];

/** Render a move string at most w cells wide; long strings are bucketed, keeping the most important move per bucket. */
export function braid(C, moves, w) {
  if (!moves) return C.dim + '·' + C.r;
  const rank = (seg) => (/D/.test(seg) ? 'D' : /X/.test(seg) ? 'X' : /s/.test(seg) ? 's' : /h/.test(seg) ? 'h' : /c/.test(seg) ? 'c' : /d/.test(seg) ? 'd' : seg[0]);
  const n = Math.min(w, moves.length); const step = moves.length / n; let out = '';
  for (let k = 0; k < n; k++) { const seg = moves.slice(Math.floor(k * step), Math.max(Math.floor((k + 1) * step), Math.floor(k * step) + 1)); const [col, g] = GLYPH[rank(seg)] || GLYPH.p; out += C[col] + g; }
  return out + C.r;
}
const BLOCKS = '▁▂▃▄▅▆▇█';
export function spark(C, xs, col = 'lime') {
  const mx = Math.max(...xs, 1e-9);
  return C[col] + xs.map((x) => (x <= 0 ? C.dim + '·' + C[col] : BLOCKS[Math.min(7, Math.floor((x / mx) * 7.999))])).join('') + C.r;
}
export function bar(C, f, w, col = 'lime') { const k = Math.round(Math.max(0, Math.min(1, f)) * w); return C[col] + '█'.repeat(k) + C.dim + '░'.repeat(w - k) + C.r; }
export const statusWord = (C, s) => ({ outcome: C.teal + 'done', abandoned: C.coral + 'dropped', open: C.lime + 'open', parked: C.amber + 'parked', 'outcome?': C.mid + 'unclear' })[s] || C.mid + s;
export const originMark = (C, t) => (t.origin === 'surprise' ? (t.kind === 'wall' ? C.coral + '⊘' : t.kind === 'recovery' ? C.amber + '↺' : C.iris + '◇') : t.origin === 'schedule' ? C.dim + '⏲' : t.origin === 'plan' ? C.mid + '↳' : C.ink + '○') + C.r;
export const shortDate = (ts) => (ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
