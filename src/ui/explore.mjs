// The explorer: every thread your agents ran, navigable from the keyboard.
// Tabs: Overview · Walls · Threads · Sessions · Quality.  Keys: ←/→ tabs, ↑/↓ move, enter open, esc back, / search, q quit.
import { palette, clip, pad, vlen, braid, spark, bar, fmt, pct, statusWord, originMark, shortDate, LEGEND, GLYPH } from './term.mjs';
import { loadSessions, loadAdoptions, loadLabels, appendLabel } from '../store.mjs';
import { corpus, threadMetrics } from '../metrics.mjs';
import { adopt, ruleFor, targetsFor } from '../adopt.mjs';
import { modelInfo } from '../model.mjs';
import { actionFor, effectText, copy } from '../actions.mjs';
import { guardStatus } from '../guard.mjs';

const TABS = ['Overview', 'Walls', 'Threads', 'Sessions', 'Quality'];

export async function explore(opts = {}) {
  const C = palette(false); const out = process.stdout; const inp = process.stdin;
  if (!out.isTTY || !inp.isTTY) { console.log('trail explore needs an interactive terminal. Try `trail scan --plain` instead.'); return; }
  let sessions = loadSessions(); let adoptions = loadAdoptions(); let labels = loadLabels();
  if (!sessions.length) { console.log('Nothing read yet. Run `trail` first.'); return; }
  let K = corpus(sessions, adoptions);
  const threads = []; for (const s of sessions) for (const t of s.threads) threads.push({ ...t, s });
  threads.reverse(); // newest first
  const S = { tab: opts.tab ?? 0, sel: [0, 0, 0, 0, 0], top: [0, 0, 0, 0, 0], open: new Set(), detail: null, q: '', typing: false, filter: { origin: 'all', status: 'all' }, modal: null, toast: '', teach: null };

  const W = () => Math.min(out.columns || 100, 140); const H = () => out.rows || 40;
  const origins = ['all', 'surprise', 'ask', 'schedule']; const statuses = ['all', 'outcome', 'abandoned', 'open'];
  const filteredThreads = () => threads.filter((t) => (S.filter.origin === 'all' || t.origin === S.filter.origin || (S.filter.origin === 'surprise' && t.origin === 'surprise')) && (S.filter.status === 'all' || t.status === S.filter.status) && (!S.q || (t.title + ' ' + (t.ask || '') + ' ' + t.s.project).toLowerCase().includes(S.q.toLowerCase())));
  const filteredSessions = () => [...sessions].reverse().filter((s) => !S.q || (s.project + ' ' + s.threads.map((t) => t.title).join(' ')).toLowerCase().includes(S.q.toLowerCase()));
  const filteredWalls = () => K.walls.filter((w) => !S.q || (w.name + ' ' + w.sig).toLowerCase().includes(S.q.toLowerCase()));

  // ───────────── views ─────────────
  function header() {
    const first = sessions[0]?.start, last = sessions.at(-1)?.start; const cl = K.tot.byClient;
    const L = [`${C.b}${C.lime}■${C.r}${C.b} orgx trail${C.r}  ${C.mid}${fmt(K.tot.sessions)} sessions · ${fmt(K.tot.threads)} threads · ${shortDate(first)} → ${shortDate(last)}${C.r}   ${C.dim}${Object.entries(cl).map(([k, v]) => `${k} ${fmt(v.sessions)}`).join(' · ')}${C.r}`];
    L.push(' ' + TABS.map((t, i) => (i === S.tab ? `${C.tab} ${i + 1} ${t} ${C.r}` : `${C.mid} ${i + 1} ${t} ${C.r}`)).join(''));
    L.push(C.dim + '─'.repeat(W()) + C.r);
    return L;
  }
  function footer(hint) {
    const f = S.typing ? `${C.lime}/${C.ink}${S.q}${C.lime}▏${C.r}  ${C.dim}enter to keep · esc to clear${C.r}` : `${C.dim}${hint}${S.q ? `   ${C.lime}filter: ${S.q}${C.dim} (esc clears)` : ''}${C.r}`;
    return [C.dim + '─'.repeat(W()) + C.r, ' ' + (S.toast ? C.lime + S.toast + C.r + '   ' : '') + f];
  }

  function overview() {
    const T = K.tot; const wk = K.weeks.slice(-16); const L = [];
    const kpi = (v, label, col = 'ink') => `${C[col]}${C.b}${v}${C.r} ${C.mid}${label}${C.r}`;
    L.push('');
    L.push('  ' + [kpi(pct(T.outcome / T.threads), 'of threads reached an outcome', 'teal'), kpi(pct(T.abandoned / T.threads), 'were dropped', 'coral'), kpi(pct(T.verified / Math.max(T.changed, 1)), 'of changes were checked before moving on', 'lime')].join('   '));
    L.push('  ' + [kpi(fmt(T.discovery), 'discoveries nobody asked for', 'iris'), kpi(fmt(T.backs), 'backtracks'), kpi(pct(T.human / Math.max(T.asks, 1)), 'of your messages steered or corrected')].join('   '));
    L.push('');
    L.push(`  ${C.b}The rediscovery tax${C.r}`);
    L.push(`  ${C.mid}Your agents spent ${C.coral}${fmt(T.rediscoveryCalls)}${C.mid} tool calls hitting walls an earlier session had already hit.${C.r}`);
    L.push(`  ${C.mid}That's ${C.coral}${pct(T.rediscoveryCalls / Math.max(T.tools, 1))}${C.mid} of all calls, spent relearning. Adopting a wall's fix writes it where your agents read it.${C.r}`);
    const g = guardStatus();
    L.push(g.installed ? `  ${C.teal}●${C.r} ${C.mid}guard on · trail stopped ${C.ink}${fmt(g.prevented)}${C.mid} rediscoveries before they happened${C.r}` : `  ${C.dim}○ guard off · ${C.lime}trail guard install${C.dim} stops known walls before they happen (don't-ask sessions only)${C.r}`);
    L.push('');
    L.push(`  ${C.dim}last ${wk.length} weeks · ${shortDate(wk[0]?.wk)} → now${C.r}`);
    const row = (label, xs, col, note) => L.push(`  ${pad(C.mid + label + C.r, 30)} ${spark(C, xs, col)}  ${C.dim}${note}${C.r}`);
    row('threads', wk.map((w) => w.threads), 'ink', fmt(wk.at(-1)?.threads || 0) + ' this week');
    row('outcome rate', wk.map((w) => w.outcome / Math.max(w.threads, 1)), 'teal', pct((wk.at(-1)?.outcome || 0) / Math.max(wk.at(-1)?.threads || 1, 1)));
    row('checked after change', wk.map((w) => w.verified / Math.max(w.changed, 1)), 'lime', pct((wk.at(-1)?.verified || 0) / Math.max(wk.at(-1)?.changed || 1, 1)));
    row('calls lost to walls', wk.map((w) => w.wallCalls), 'coral', fmt(wk.at(-1)?.wallCalls || 0));
    row('steers per ask', wk.map((w) => w.human / Math.max(w.asks, 1)), 'amber', pct((wk.at(-1)?.human || 0) / Math.max(wk.at(-1)?.asks || 1, 1)));
    row('discoveries', wk.map((w) => w.surprise), 'iris', fmt(wk.at(-1)?.surprise || 0));
    L.push('');
    L.push(`  ${C.b}Top walls${C.r}  ${C.dim}(2 to see all, enter to open one)${C.r}`);
    for (const w of K.walls.slice(0, 3)) L.push(`  ${C.coral}${String(w.sessions).padStart(5)}${C.r} ${C.mid}sessions${C.r}  ${C.ink}${w.name}${C.r}${w.adopted ? `  ${C.teal}● adopted${C.r}` : ''}`);
    L.push('');
    L.push(`  ${C.b}Recent discoveries${C.r}`);
    for (const t of threads.filter((t) => t.kind === 'found').slice(0, 4)) L.push(`  ${C.iris}◇${C.r} ${C.dim}${shortDate(t.s.start).padEnd(7)}${C.r} ${C.ink}${t.title}${C.r} ${C.dim}· ${t.s.project}${C.r}`);
    return { L, hint: '←/→ tabs · 1–5 jump · q quit' };
  }

  function wallsView() {
    const list = filteredWalls(); const L = []; const w0 = W();
    L.push(`  ${C.dim}${pad('sessions', 9)}${pad('calls', 8)}${pad('trend (weekly)', 18)}wall${C.r}`);
    const weeks = K.weeks.slice(-16).map((w) => w.wk);
    const rows = [];
    list.forEach((w, i) => {
      const sel = i === S.sel[1]; const opened = S.open.has(w.sig);
      const trend = spark(C, weeks.map((k) => w.weeks[k] || 0), 'coral');
      const badge = w.adopted ? ` ${C.teal}● adopted ${shortDate(w.adopted.at)}${C.r}` : w.named ? '' : ` ${C.dim}(auto-grouped)${C.r}`;
      rows.push({ i, line: `${sel ? C.lime + '›' : ' '}${C.r} ${C.coral}${String(w.sessions).padStart(6)}${C.r}   ${C.mid}${String(fmt(w.calls)).padStart(6)}${C.r}  ${trend}  ${opened ? '▾' : '▸'} ${C.ink}${w.name}${C.r}${badge}`, sel });
      if (opened) {
        const sub = [];
        const cl = Object.entries(w.clients).map(([k, v]) => `${k} ${v}`).join(' · '); const pj = Object.entries(w.projects).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(' · ');
        sub.push(`${C.dim}first ${shortDate(w.first)} · last ${shortDate(w.last)} · ${cl} · ${pj}${C.r}`);
        for (const x of w.samples.slice(0, 2)) sub.push(`${C.dim}what happens:${C.r} ${C.mid}${x.slice(0, w0 - 30)}${C.r}`);
        sub.push(`${C.lime}fix:${C.r} ${C.ink}${ruleFor(w).slice(0, w0 - 16)}${C.r}`);
        if (w.adopted) { const e = effectText(w.adopted); sub.push(`${C.teal}adopted${C.r} ${C.dim}→ ${w.adopted.target}${C.r}  ${C[e.tone]}${e.text}${C.r}`); }
        else sub.push(`${C.lime}a${C.dim} adopt here · ${C.lime}c${C.dim} copy a prompt for your agent · ${C.lime}r${C.dim} copy the rule · ${C.lime}x${C.dim} copy the command${C.r}`);
        sub.push(`${C.dim}sessions: ${w.list.slice(-6).reverse().map((x) => `${shortDate(x.start)} ${x.project}`).join(' · ')}${C.r}`);
        for (const x of sub) rows.push({ i, line: '             ' + x, sel: false });
      }
    });
    const body = scroll(rows, 1);
    return { L: [...L, ...body], hint: '↑/↓ move · enter expand · a adopt · c copy agent prompt · r rule · x command · / search' };
  }

  function threadRow(t, sel, w) {
    const date = shortDate(t.s.start).padEnd(7); const cli = t.s.client === 'codex' ? 'cx' : 'cc';
    const conf = t.p_abandon != null && Math.abs(t.p_abandon - 0.5) < 0.2 ? C.amber + '?' + C.r : ' ';
    return `${sel ? C.lime + '›' : ' '}${C.r} ${C.dim}${date}${cli}${C.r} ${originMark(C, t)} ${braid(C, t.moves, 22)}${' '.repeat(Math.max(0, 22 - Math.min(22, t.moves.length || 1)))} ${pad(statusWord(C, t.status) + C.r, 8)}${conf} ${C.ink}${clip(t.title, w - 70)}${C.r} ${C.dim}${t.s.project}${C.r}`;
  }
  function threadsView() {
    const list = filteredThreads(); const L = [];
    L.push(`  ${C.dim}show:${C.r} ${origins.map((o) => (o === S.filter.origin ? C.lime + '[' + o + ']' : C.mid + o) + C.r).join(' ')}   ${C.dim}status:${C.r} ${statuses.map((o) => (o === S.filter.status ? C.lime + '[' + o + ']' : C.mid + o) + C.r).join(' ')}   ${C.dim}${fmt(list.length)} threads${C.r}`);
    const rows = list.slice(0, 5000).map((t, i) => ({ i, line: threadRow(t, i === S.sel[2], W()), sel: i === S.sel[2] }));
    return { L: [...L, ...scroll(rows, 2)], hint: '↑/↓ move · enter open · o origin · s status · / search · t teach' };
  }
  function sessionsView() {
    const list = filteredSessions();
    const rows = list.map((s, i) => { const sel = i === S.sel[3]; let b = ''; for (const t of s.threads.slice(0, 5)) b += originMark(C, t) + braid(C, t.moves, 9) + ' ';
      return { i, sel, line: `${sel ? C.lime + '›' : ' '}${C.r} ${C.dim}${shortDate(s.start).padEnd(7)}${s.client.padEnd(7)}${C.r}${C.mid}${pad(String(s.project), 16)}${C.r} ${C.ink}${String(s.threads.length).padStart(3)}${C.dim} thr ${String(fmt(s.tools)).padStart(6)} calls${C.r}  ${b}` }; });
    return { L: scroll(rows, 3), hint: '↑/↓ move · enter open session · / search' };
  }
  function qualityView() {
    const T = K.tot; const mi = modelInfo(); const L = [''];
    L.push(`  ${C.b}How far to trust these labels${C.r}`);
    L.push(`  ${C.mid}Threads come from rules that read the transcript directly: exact for denials and failures, approximate for intent.${C.r}`);
    if (mi) L.push(`  ${C.mid}“Dropped” is decided by ${C.ink}${mi.name}${C.mid}: F1 ${C.ink}${mi.cv.f1}${C.mid} (precision ${pct(mi.cv.precision)}, recall ${pct(mi.cv.recall)}) against model-labeled threads; rules alone scored ${mi.cv.rules_f1}.${C.r}`);
    L.push(`  ${C.dim}Those reference labels came from a larger model, not from you. Your own labels are the real test (press t).${C.r}`);
    L.push('');
    const chk = (ok, label, v, why) => L.push(`  ${ok ? C.teal + '✓' : C.amber + '!'}${C.r} ${pad(C.ink + label + C.r, 44)} ${C.b}${v}${C.r}  ${C.dim}${why}${C.r}`);
    chk(T.lowConf / Math.max(T.ruleModelN, 1) < 0.1, 'Uncertain status calls', `${fmt(T.lowConf)} (${pct(T.lowConf / Math.max(T.ruleModelN, 1))})`, 'model confidence between 30% and 70%');
    chk(T.unresolved / Math.max(T.threads, 1) < 0.15, 'Threads with no clear ending', `${fmt(T.unresolved)} (${pct(T.unresolved / T.threads)})`, 'no ship, no check, no failure at the end');
    chk(T.unverifiedDone / Math.max(T.outcome, 1) < 0.2, 'Done without any check or ship', `${fmt(T.unverifiedDone)} (${pct(T.unverifiedDone / Math.max(T.outcome, 1))})`, 'changed files, never tested or shipped');
    chk(T.contradiction === 0, 'Dropped after shipping', fmt(T.contradiction), 'a label contradiction');
    chk(T.hooks / Math.max(T.asks, 1) < 0.05, 'Messages from hooks and bots', `${fmt(T.hooks)}`, 'counted apart from your steers');
    L.push('');
    L.push(`  ${C.b}Confidence of status calls${C.r}  ${C.dim}(0.5 → 1.0)${C.r}`);
    const mx = Math.max(...K.conf.slice(5), 1);
    L.push('  ' + K.conf.slice(5).map((n, i) => `${C.dim}${(0.5 + i / 10).toFixed(1)}${C.r} ${bar(C, n / mx, 10, i < 2 ? 'amber' : 'teal')} ${C.mid}${fmt(n)}${C.r}`).join('  '));
    L.push('');
    L.push(`  ${C.b}Same classifier, different clients${C.r}  ${C.dim}large gaps can mean a client-specific blind spot${C.r}`);
    L.push(`  ${C.dim}${pad('client', 10)}${pad('threads/session', 18)}${pad('discoveries/100', 18)}${pad('dropped', 12)}backtracks/thread${C.r}`);
    for (const [k, v] of Object.entries(T.byClient)) L.push(`  ${C.ink}${pad(k, 10)}${C.r}${pad((v.threads / v.sessions).toFixed(1), 18)}${pad((100 * v.surprise / v.threads).toFixed(1), 18)}${pad(pct(v.abandoned / v.threads), 12)}${(v.backs / v.threads).toFixed(2)}`);
    L.push('');
    const agree = labels.filter((l) => l.status).map((l) => { const t = threads.find((x) => x.s.id === l.session && x.id === l.thread); return t ? (t.status === 'abandoned') === (l.status === 'abandoned') : null; }).filter((x) => x !== null);
    L.push(`  ${C.b}Your labels${C.r}  ${C.mid}${labels.length} so far${agree.length ? ` · the model agrees with you on ${pct(agree.filter(Boolean).length / agree.length)}` : ''}. ${C.lime}t${C.mid} opens the ${fmt(T.lowConf)} least-certain threads, one key each.${C.r}`);
    return { L, hint: 't teach (label uncertain threads) · ←/→ tabs · q quit' };
  }

  function threadDetail(t) {
    const w = W(); const m = threadMetrics(t); const L = [''];
    L.push(`  ${originMark(C, t)} ${C.b}${C.ink}${t.title}${C.r}`);
    L.push(`  ${C.dim}${t.s.client} · ${t.s.project} · ${shortDate(t.t0 || t.s.start)} · ${t.moves.length} moves · ${t.origin === 'surprise' ? (t.kind === 'wall' ? 'permission wall' : t.kind === 'recovery' ? 'recovery from repeated failures' : 'found along the way') : t.origin}${C.r}`);
    L.push('');
    L.push(`  ${statusWord(C, t.status)}${C.r}${t.p_abandon != null ? `  ${C.dim}model: ${pct(t.p_abandon)} likely dropped · rules said ${t.status_rule}${C.r}` : ''}`);
    L.push('');
    for (let k = 0; k < t.moves.length; k += w - 8) L.push('  ' + braid(C, t.moves.slice(k, k + w - 8), w - 8));
    L.push('  ' + LEGEND.map(([k, n]) => C[GLYPH[k][0]] + GLYPH[k][1] + C.dim + ' ' + n + C.r).join('  '));
    L.push('');
    L.push(`  ${C.mid}explored ${C.ink}${m.exploreBeforeChange}${C.mid} moves before the first change · ${m.verified === null ? 'no changes' : m.verified ? C.teal + 'checked after its last change' : C.amber + 'not checked after its last change'}${C.mid} · ${m.loops} change→check loops · ${pct(m.failRate)} of calls failed${C.r}`);
    if (t.claim?.length) L.push(`  ${C.teal}claims:${C.r} ${C.ink}${t.claim.join(' · ')}${C.r}`);
    if (t.ask) { L.push(''); L.push(`  ${C.dim}asked${C.r}`); L.push(`  ${C.ink}${clip(t.ask, (w - 4) * 2)}${C.r}`); }
    if (t.backs.length) { L.push(''); L.push(`  ${C.dim}backtracks${C.r}`); for (const b of t.backs.slice(0, 5)) L.push(`  ${C.coral}⟲${C.r} ${C.mid}${clip(b.why, w - 40)}${C.r} ${C.dim}→ ${b.what}${C.r}`); }
    if (t.notes?.length) { L.push(''); L.push(`  ${C.dim}the agent said${C.r}`); for (const n of t.notes) L.push(`  ${C.mid}“${clip(n, w - 8)}”${C.r}`); }
    return { L, hint: S.teach ? `${C.lime}d${C.dim} done · ${C.lime}x${C.dim} dropped · ${C.lime}p${C.dim} parked · ${C.lime}f${C.dim} found-along-the-way · ${C.lime}n${C.dim} next · esc stop` : 'esc back · l label this thread' };
  }
  function sessionDetail(s) {
    const L = ['', `  ${C.b}${C.ink}${s.project}${C.r}  ${C.dim}${s.client} · ${shortDate(s.start)} · ${fmt(s.tools)} calls · ${s.errs} failed · ${s.denied} denied · ${s.compactions || 0} compactions${C.r}`, ''];
    const rows = s.threads.map((t, i) => ({ i, sel: i === S.detail.sel, line: threadRow({ ...t, s }, i === S.detail.sel, W()) }));
    return { L: [...L, ...rows.map((r) => r.line)], hint: '↑/↓ move · enter open thread · esc back' };
  }

  function scroll(rows, tab) {
    const room = H() - 7; const selRow = rows.findIndex((r) => r.sel);
    if (selRow >= 0) { if (selRow < S.top[tab]) S.top[tab] = selRow; if (selRow >= S.top[tab] + room) S.top[tab] = selRow - room + 1; }
    return rows.slice(S.top[tab], S.top[tab] + room).map((r) => r.line);
  }

  function modalView() {
    const m = S.modal; const L = ['', `  ${C.b}Adopt: ${m.wall.name}${C.r}`, '', `  ${C.mid}This line goes into the file you pick, inside a marked block you can remove later:${C.r}`, `  ${C.ink}- ${ruleFor(m.wall)}${C.r}`, ''];
    m.targets.forEach((t, i) => L.push(`  ${i === m.sel ? C.lime + '› ' : '  '}${C.ink}${t.label}${C.r}  ${C.dim}${t.file}${C.r}`));
    L.push(''); L.push(`  ${C.dim}enter writes it · esc cancels. After this, trail counts how many sessions still hit this wall.${C.r}`);
    return { L, hint: '↑/↓ choose file · enter adopt · esc cancel' };
  }

  function render() {
    const w = W(); const h = H();
    let v;
    if (S.modal) v = modalView();
    else if (S.detail?.kind === 'thread') v = threadDetail(S.detail.t);
    else if (S.detail?.kind === 'session') v = sessionDetail(S.detail.s);
    else v = [overview, wallsView, threadsView, sessionsView, qualityView][S.tab]();
    const body = v.L.slice(0, h - 5); while (body.length < h - 5) body.push('');
    const all = [...header(), ...body, ...footer(v.hint)];
    out.write('\x1b[H' + all.map((l) => clip(l, w) + '\x1b[K').join('\n') + '\x1b[J');
    S.toast = '';
  }

  // ───────────── input ─────────────
  function listLen() { return [0, filteredWalls().length, filteredThreads().length, filteredSessions().length, 0][S.tab]; }
  function move(d) { if (S.modal) { S.modal.sel = (S.modal.sel + d + S.modal.targets.length) % S.modal.targets.length; return; } if (S.detail?.kind === 'session') { S.detail.sel = Math.max(0, Math.min(S.detail.s.threads.length - 1, S.detail.sel + d)); return; } const n = listLen(); S.sel[S.tab] = Math.max(0, Math.min(n - 1, S.sel[S.tab] + d)); }
  function enter() {
    if (S.modal) { const t = S.modal.targets[S.modal.sel]; const r = adopt(S.modal.wall, t.file); adoptions = loadAdoptions(); K = corpus(sessions, adoptions); S.modal = null; S.toast = `Adopted → ${r.target}`; return; }
    if (S.detail?.kind === 'session') { const t = S.detail.s.threads[S.detail.sel]; S.detail = { kind: 'thread', t: { ...t, s: S.detail.s }, back: S.detail }; return; }
    if (S.tab === 0) { S.tab = 1; return; }
    if (S.tab === 1) { const w = filteredWalls()[S.sel[1]]; if (w) S.open.has(w.sig) ? S.open.delete(w.sig) : S.open.add(w.sig); return; }
    if (S.tab === 2) { const t = filteredThreads()[S.sel[2]]; if (t) S.detail = { kind: 'thread', t }; return; }
    if (S.tab === 3) { const s = filteredSessions()[S.sel[3]]; if (s) S.detail = { kind: 'session', s, sel: 0 }; }
  }
  function back() { if (S.modal) S.modal = null; else if (S.teach) { S.teach = null; S.detail = null; } else if (S.detail) S.detail = S.detail.back || null; else if (S.q) S.q = ''; }
  function startTeach() {
    const q = threads.filter((t) => t.p_abandon != null && Math.abs(t.p_abandon - 0.5) < 0.2 && !labels.some((l) => l.session === t.s.id && l.thread === t.id)).slice(0, 25);
    if (!q.length) { S.toast = 'Nothing uncertain left to label.'; return; }
    S.teach = { q, i: 0 }; S.detail = { kind: 'thread', t: q[0] };
  }
  function label(status, discovery) {
    const t = S.detail.t; appendLabel({ at: new Date().toISOString(), session: t.s.id, thread: t.id, client: t.s.client, status, discovery, model_p: t.p_abandon, rule: t.status_rule, feat: t.feat });
    labels = loadLabels(); S.toast = `Labeled ${status || ''}${discovery ? ' · found along the way' : ''} — thanks`;
    if (S.teach) { S.teach.i++; if (S.teach.i >= S.teach.q.length) { S.teach = null; S.detail = null; S.toast = 'Batch done. Labels saved to ~/.orgx/trail/labels.jsonl'; } else S.detail = { kind: 'thread', t: S.teach.q[S.teach.i] }; }
  }

  out.write('\x1b[?1049h\x1b[?25l'); inp.setRawMode(true); inp.resume(); inp.setEncoding('utf8');
  const quit = () => { out.write('\x1b[?25h\x1b[?1049l'); inp.setRawMode(false); process.exit(0); };
  out.on('resize', render);
  inp.on('data', (k) => {
    if (S.typing) {
      if (k === '\r') S.typing = false; else if (k === '\x1b') { S.typing = false; S.q = ''; } else if (k === '\x7f') S.q = S.q.slice(0, -1); else if (k >= ' ' && k.length === 1) S.q += k;
      S.sel[S.tab] = 0; S.top[S.tab] = 0; return render();
    }
    const thread = S.detail?.kind === 'thread';
    if (k === 'q' || k === '\x03') return quit();
    else if (k === '\x1b[A' || k === 'k') move(-1); else if (k === '\x1b[B' || k === 'j') move(1);
    else if (k === '\x1b[5~') move(-(H() - 8)); else if (k === '\x1b[6~') move(H() - 8);
    else if (k === '\x1b[C' && !S.detail && !S.modal) S.tab = (S.tab + 1) % TABS.length; else if (k === '\x1b[D' && !S.detail && !S.modal) S.tab = (S.tab + TABS.length - 1) % TABS.length;
    else if (/^[1-5]$/.test(k) && !S.detail && !S.modal) S.tab = +k - 1;
    else if (k === '\r') enter(); else if (k === '\x1b' || k === '\x7f') back();
    else if (k === '/' && !S.detail) { S.typing = true; }
    else if ((k === 'c' || k === 'r' || k === 'x') && S.tab === 1 && !S.detail && !S.modal) { const w = filteredWalls()[S.sel[1]]; if (w) { const act = actionFor(w); const what = { c: ['prompt', act.prompt], r: ['rule', act.rule], x: ['command', act.command] }[k]; S.toast = copy(what[1]) ? `Copied the ${what[0]} for “${w.name}”` : 'Could not reach the clipboard'; } }
    else if (k === 'a' && S.tab === 1 && !S.detail) { const w = filteredWalls()[S.sel[1]]; if (w) S.modal = { wall: w, targets: targetsFor(w), sel: 0 }; }
    else if (k === 'o' && S.tab === 2 && !S.detail) { S.filter.origin = origins[(origins.indexOf(S.filter.origin) + 1) % origins.length]; S.sel[2] = 0; S.top[2] = 0; }
    else if (k === 's' && S.tab === 2 && !S.detail) { S.filter.status = statuses[(statuses.indexOf(S.filter.status) + 1) % statuses.length]; S.sel[2] = 0; S.top[2] = 0; }
    else if (k === 't' && !S.detail) startTeach();
    else if (k === 'l' && thread && !S.teach) { S.teach = { q: [S.detail.t], i: 0 }; S.toast = 'd done · x dropped · p parked · f found-along-the-way'; }
    else if (thread && S.teach && k === 'd') label('outcome'); else if (thread && S.teach && k === 'x') label('abandoned'); else if (thread && S.teach && k === 'p') label('parked');
    else if (thread && S.teach && k === 'f') label(null, true); else if (thread && S.teach && k === 'n') { S.teach.i++; S.detail = S.teach.i < S.teach.q.length ? { kind: 'thread', t: S.teach.q[S.teach.i] } : null; if (!S.detail) S.teach = null; }
    render();
  });
  render();
}
