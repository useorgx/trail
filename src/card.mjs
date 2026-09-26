// `trail card`: one image worth sharing, drawn from your own agents' work.
// The artwork is literally your trail: each row is a recent thread's moves, one cell per move.
// Private by default: no project names, titles or paths. SVG + PNG (macOS) + HTML + share text.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadSessions, loadAdoptions, HOME } from './store.mjs';
import { corpus, threadMetrics } from './metrics.mjs';
import { actionFor, effectText } from './actions.mjs';
import { preventedCount } from './guard.mjs';
import { clientLabel } from './clients.mjs';

const C = { bg: '#0B0C0E', ink: '#ECEDEE', mid: '#A7ACB3', dim: '#6C727A', line: '#1C1F24', lime: '#BFFF00', teal: '#2DD4BF', coral: '#FF7A66', iris: '#8B8CFF', amber: '#F5B700' };
const MOVE = { p: C.dim, r: '#4A4F57', c: C.lime, h: C.teal, s: C.ink, d: C.iris, X: C.coral, D: C.coral };
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** An honest one-line profile, from measured behavior (not a horoscope). */
function profile(sessions, T) {
  const explore = []; let backs = 0, n = 0;
  for (const s of sessions) for (const t of s.threads) { n++; backs += t.backs.length; const m = threadMetrics(t); if (/c/.test(t.moves)) explore.push(m.exploreBeforeChange); }
  explore.sort((a, b) => a - b); const med = explore[Math.floor(explore.length / 2)] ?? 0;
  const check = T.verified / Math.max(T.changed, 1); const bt = backs / Math.max(n, 1);
  const name = med >= 6 && check >= 0.55 ? 'The Careful Explorer' : med < 3 && check < 0.4 ? 'The Fast Mover' : bt > 0.6 ? 'The Persistent Debugger' : check >= 0.6 ? 'The Verifier' : 'The Steady Builder';
  return { name, line: `reads ${med} steps before changing anything · checks ${pct(check)} of its changes · ${bt.toFixed(1)} backtracks per thread`, short: `reads ${med} steps before changing · checks ${pct(check)} of changes` };
}

export function cardData() {
  const sessions = loadSessions(); const K = corpus(sessions, loadAdoptions()); const T = K.tot;
  const starts = sessions.map((s) => Date.parse(s.start)).filter(Number.isFinite).sort((a, b) => a - b);
  const first = starts[0], last = starts.at(-1);
  // Headline the most specific wall; the catch-all 'other denials' bucket is true but tells you nothing to do.
  const top = K.walls.find((w) => w.sig !== 'denied-other') || K.walls[0]; const adopted = K.walls.find((w) => w.adopted && !w.adopted.confounded && w.adopted.enough);
  // The art: recent threads that actually did something (changes, checks, ships), not pure reading.
  const recent = sessions.slice(-600).flatMap((s) => s.threads).filter((t) => t.moves.length >= 8 && (t.moves.match(/[chsX]/g) || []).length >= 3).slice(-46).map((t) => t.moves.slice(-96));
  return {
    range: `${new Date(first).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(last).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    clients: Object.keys(T.byClient), sessions: T.sessions, threads: T.threads, tools: T.tools,
    relearn: T.rediscoveryCalls, outcome: T.outcome / T.threads, checked: T.verified / Math.max(T.changed, 1), discoveries: T.discovery,
    profile: profile(sessions, T), prevented: preventedCount(),
    wall: top ? { name: top.name, sessions: top.sessions, fix: actionFor(top).rule } : null,
    proof: adopted ? { name: adopted.name, effect: effectText(adopted.adopted).text } : null,
    rows: recent,
  };
}

export function svg(d) {
  const W = 1200, H = 630, P = 64;
  // Signature art: your threads as rows of cells in their own column; every card is different because every trail is.
  const cell = 7, step = 9, x0 = 780, y0 = 92, cols = Math.floor((W - P - x0) / step); let art = '';
  d.rows.slice(-42).forEach((m, r) => { [...m.slice(-cols)].forEach((ch, i) => { art += `<rect x="${x0 + i * step}" y="${y0 + r * step}" width="${cell}" height="${cell}" rx="1.5" fill="${MOVE[ch] || C.dim}"/>`; }); });
  const clients = d.clients.map(clientLabel).join(' + ');
  const t = (x, y, s, size, fill, weight = 400, family = 'mono', extra = '') => `<text x="${x}" y="${y}" font-family="${family === 'mono' ? "ui-monospace, 'SF Mono', Menlo, monospace" : "system-ui, -apple-system, 'Segoe UI', sans-serif"}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(s)}</text>`;
  const bottom = d.proof ? `fix that worked · ${d.proof.effect}` : d.prevented ? `trail stopped ${fmt(d.prevented)} rediscoveries before they happened` : d.wall ? `top wall · ${d.wall.name} · hit in ${fmt(d.wall.sessions)} sessions` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="${C.bg}" stop-opacity="1"/><stop offset="0.28" stop-color="${C.bg}" stop-opacity="0"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<g>${art}</g><rect x="${x0 - 2}" y="0" width="${W - x0 + 2}" height="${H}" fill="url(#fade)"/>
<rect x="${P}" y="${P - 14}" width="12" height="12" rx="2" fill="${C.lime}"/>
${t(P + 22, P - 3, 'orgx trail', 18, C.ink, 600, 'sans')}
${t(P + 130, P - 3, `${clients} · ${d.range}`, 15, C.dim)}
${t(P, 196, fmt(d.relearn), 112, C.coral, 600)}
${t(P, 240, 'tool calls my agents spent relearning', 24, C.ink, 400, 'sans')}
${t(P, 272, 'walls they had already hit', 24, C.ink, 400, 'sans')}
${t(P, 326, `${fmt(d.sessions)} sessions · ${fmt(d.threads)} threads`, 17, C.mid)}
${t(P, 352, `${pct(d.outcome)} reached an outcome · ${pct(d.checked)} of changes checked`, 17, C.mid)}
${t(P, 404, d.profile.name, 26, C.lime, 600, 'sans')}
${t(P, 432, d.profile.short, 16, C.mid)}
<line x1="${P}" y1="476" x2="${x0 - 40}" y2="476" stroke="${C.line}"/>
${t(P, 510, bottom, 17, d.proof ? C.teal : C.ink, 400, 'sans')}
${t(P, 566, 'npx @useorgx/trail', 20, C.lime, 600)}
${t(P + 250, 566, 'read locally · nothing uploaded · $0', 15, C.dim)}
</svg>`;
}

export function terminal(d, P) {
  const w = 76; const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const fit = (s, n) => { let out = '', k = 0; for (let i = 0; i < s.length; i++) { if (s[i] === '\x1b') { const j = s.indexOf('m', i); out += s.slice(i, j + 1); i = j; continue; } if (k >= n) break; out += s[i]; k++; } return out + P.r; };
  const line = (s = '') => { const f = fit(s, w - 3); return `${P.dim}│${P.r} ${f}${' '.repeat(Math.max(0, w - 3 - vis(f).length))}${P.dim}│${P.r}`; };
  const art = d.rows.slice(-6).map((m) => [...m.slice(-(w - 4))].map((ch) => `${{ p: P.dim, r: P.dim, c: P.lime, h: P.teal, s: P.ink, d: P.iris, X: P.coral, D: P.coral }[ch] || P.dim}${{ p: '·', r: '∙', c: '━', h: '✓', s: '▲', d: '◆', X: '✗', D: '⊘' }[ch] || '·'}`).join('') + P.r);
  return [
    `${P.dim}╭${'─'.repeat(w - 2)}╮${P.r}`,
    line(`${P.lime}■${P.r} ${P.b}orgx trail${P.r}  ${P.dim}${d.range}${P.r}`), line(),
    line(`${P.coral}${P.b}${fmt(d.relearn)}${P.r} tool calls my agents spent relearning walls they'd already hit`), line(),
    line(`${P.mid}${fmt(d.sessions)} sessions · ${fmt(d.threads)} threads · ${pct(d.outcome)} outcome · ${pct(d.checked)} checked${P.r}`),
    line(`${P.lime}${d.profile.name}${P.r}  ${P.dim}${d.profile.line.slice(0, 52)}${P.r}`), line(),
    ...art.map((a) => line(a)), line(),
    line(d.proof ? `${P.teal}fix that worked · ${d.proof.effect.slice(0, 50)}${P.r}` : d.wall ? `top wall · ${d.wall.name.slice(0, 56)}` : ''),
    line(`${P.lime}npx @useorgx/trail${P.r}  ${P.dim}local · nothing uploaded · $0${P.r}`),
    `${P.dim}╰${'─'.repeat(w - 2)}╯${P.r}`,
  ].join('\n');
}

export function shareText(d) {
  return `My coding agents spent ${fmt(d.relearn)} tool calls relearning walls they'd already hit (${fmt(d.sessions)} ${d.clients.map(clientLabel).join(' + ')} sessions).${d.wall ? ` The top one: "${d.wall.name}", in ${fmt(d.wall.sessions)} sessions.` : ''}\n\nFound in ~40s, locally: npx @useorgx/trail`;
}

const CHROMES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
/** 2x PNG of the card. Headless Chrome renders SVG exactly; QuickLook is the macOS fallback (square canvas, cropped). */
function renderPng(svgPath, out) {
  const chrome = CHROMES.find((c) => fs.existsSync(c));
  if (chrome) {
    try {
      const html = svgPath.replace(/\.svg$/, '.render.html');
      fs.writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:#0B0C0E}</style>${fs.readFileSync(svgPath, 'utf8')}`);
      execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1200,630', `--screenshot=${out}`, `file://${html}`], { stdio: 'ignore', timeout: 30000 });
      fs.rmSync(html, { force: true });
      if (fs.existsSync(out)) return out;
    } catch {}
  }
  if (process.platform === 'darwin') {
    try {
      execFileSync('qlmanage', ['-t', '-s', '1200', '-o', path.dirname(out), svgPath], { stdio: 'ignore', timeout: 30000 });
      const q = svgPath + '.png'; if (!fs.existsSync(q)) return null; fs.renameSync(q, out);
      execFileSync('sips', ['--cropToHeightWidth', '630', '1200', '--cropOffset', '0', '0', out], { stdio: 'ignore' });
      return out;
    } catch {}
  }
  return null;
}

export function writeCard(outDir = path.join(HOME, 'card')) {
  const d = cardData(); fs.mkdirSync(outDir, { recursive: true });
  const svgPath = path.join(outDir, 'trail-card.svg'); fs.writeFileSync(svgPath, svg(d));
  let png = null;
  png = renderPng(svgPath, path.join(outDir, 'trail-card.png'));
  const html = `<!doctype html><meta charset="utf-8"><title>My trail</title><style>body{margin:0;background:#0B0C0E;color:#ECEDEE;font:15px system-ui;display:grid;place-items:center;min-height:100vh;gap:16px;padding:24px}svg{max-width:100%;height:auto;border-radius:12px}textarea{width:min(1200px,100%);height:110px;background:#121417;color:#ECEDEE;border:1px solid #2a2e35;border-radius:8px;padding:10px;font:14px system-ui}button{all:unset;cursor:pointer;background:#BFFF00;color:#111;font-weight:600;padding:8px 14px;border-radius:7px}</style>${svg(d)}<textarea id="t">${esc(shareText(d))}</textarea><button onclick="navigator.clipboard.writeText(document.getElementById('t').value);this.textContent='Copied'">Copy post text</button>`;
  const htmlPath = path.join(outDir, 'trail-card.html'); fs.writeFileSync(htmlPath, html);
  return { d, svgPath, png, htmlPath, text: shareText(d) };
}
