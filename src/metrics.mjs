// Corpus metrics: what the work looked like, what it cost, and how far to trust the labels.
import { wallById } from './walls.mjs';

const week = (ts) => { const d = new Date(ts); if (isNaN(d)) return null; const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };
const ratio = (a, b) => (b ? a / b : 0);

/** Per-thread work metrics, all derived from the move string. */
export function threadMetrics(t) {
  const m = t.moves; const firstChange = m.search(/c/);
  const lastChange = m.lastIndexOf('c');
  return {
    probeChange: ratio((m.match(/p/g) || []).length, (m.match(/c/g) || []).length || 1),
    exploreBeforeChange: firstChange < 0 ? m.length : firstChange,
    verified: lastChange < 0 ? null : /[hs]/.test(m.slice(lastChange)),
    loops: (m.match(/c[^c]*h[^c]*c/g) || []).length,
    failRate: ratio((m.match(/[XD]/g) || []).length, m.length),
  };
}

export function corpus(sessions, adoptions = []) {
  const W = new Map(); const walls = new Map(); const seenWall = new Set();
  const tot = { sessions: 0, threads: 0, tools: 0, errs: 0, denied: 0, asks: 0, human: 0, cont: 0, hooks: 0, compactions: 0,
    outcome: 0, abandoned: 0, open: 0, unresolved: 0, surprise: 0, discovery: 0, recovered: 0, walled: 0, backs: 0, ships: 0,
    rediscoveryCalls: 0, wallCalls: 0, changed: 0, verified: 0, unverifiedDone: 0, contradiction: 0, ruleModelAgree: 0, ruleModelN: 0, lowConf: 0,
    byClient: {} };
  const conf = new Array(10).fill(0);
  for (const s of sessions) {
    const wk = week(s.start); if (!wk) continue;
    const w = W.get(wk) || { wk, sessions: 0, threads: 0, outcome: 0, abandoned: 0, tools: 0, wallCalls: 0, human: 0, asks: 0, surprise: 0, changed: 0, verified: 0 };
    W.set(wk, w);
    tot.sessions++; w.sessions++; tot.tools += s.tools; w.tools += s.tools; tot.errs += s.errs; tot.denied += s.denied; tot.asks += s.asks; w.asks += s.asks;
    tot.human += s.steers.human; w.human += s.steers.human; tot.cont += s.steers.cont; tot.hooks += s.steers.hook || 0; tot.compactions += s.compactions || 0;
    const C = (tot.byClient[s.client] ||= { sessions: 0, threads: 0, tools: 0, surprise: 0, abandoned: 0, backs: 0 }); C.sessions++; C.tools += s.tools;
    for (const t of s.threads) {
      tot.threads++; w.threads++; C.threads++;
      const st = t.status; if (st === 'outcome') { tot.outcome++; w.outcome++; } else if (st === 'abandoned') { tot.abandoned++; w.abandoned++; C.abandoned++; } else if (st === 'open') tot.open++; else tot.unresolved++;
      if (t.origin === 'surprise') { tot.surprise++; C.surprise++; if (t.kind === 'wall') tot.walled++; else if (t.kind === 'found') { tot.discovery++; w.surprise++; } else tot.recovered++; }
      tot.backs += t.backs.length; C.backs += t.backs.length; if (/s/.test(t.moves)) tot.ships++;
      const tm = threadMetrics(t);
      if (tm.verified !== null) { tot.changed++; w.changed++; if (tm.verified) { tot.verified++; w.verified++; } }
      if (st === 'outcome' && !/[hs]/.test(t.moves) && /c/.test(t.moves)) tot.unverifiedDone++;
      if (st === 'abandoned' && /s/.test(t.moves)) tot.contradiction++;
      if (t.p_abandon != null) { tot.ruleModelN++; if ((t.status_rule === 'abandoned') === (t.p_abandon >= 0.5)) tot.ruleModelAgree++; conf[Math.min(9, Math.floor(Math.max(t.p_abandon, 1 - t.p_abandon) * 10))]++; if (Math.abs(t.p_abandon - 0.5) < 0.2) tot.lowConf++; }
    }
    for (const x of s.walls || []) {
      const a = walls.get(x.sig) || { sig: x.sig, named: x.named, name: x.named ? wallById(x.sig)?.name : x.sig, tool: x.tool, sessions: 0, calls: 0, first: s.start, last: s.start, weeks: {}, clients: {}, projects: {}, samples: [], list: [] };
      a.sessions++; a.calls += x.n; a.last = s.start; a.weeks[wk] = (a.weeks[wk] || 0) + 1; a.clients[s.client] = (a.clients[s.client] || 0) + 1; a.projects[s.project] = (a.projects[s.project] || 0) + 1;
      if (a.samples.length < 3 && !a.samples.includes(x.sample)) a.samples.push(x.sample);
      a.list.push({ id: s.id, start: s.start, project: s.project, client: s.client, cwd: s.cwd, mode: s.mode, n: x.n });
      walls.set(x.sig, a); tot.wallCalls += x.n; w.wallCalls += x.n;
      if (seenWall.has(x.sig)) tot.rediscoveryCalls += x.n; else seenWall.add(x.sig);
    }
  }
  // Adoption effect, measured honestly: the share of sessions that hit the wall before vs after the fix, counting only
  // sessions in the same scope (the repo for a repo rule) and the same permission mode. If the mode mix itself moved,
  // the comparison is flagged as confounded instead of reported as a win (see: the 2026-09-25 routine mode switch).
  for (const ad of adoptions) {
    const a = walls.get(ad.sig); if (!a) continue;
    a.adopted = adoptionEffect(a, ad, sessions);
  }
  const wallList = [...walls.values()].filter((a) => a.named || a.sessions >= 3).sort((a, b) => b.sessions - a.sessions);
  return { tot, weeks: [...W.values()].sort((a, b) => a.wk.localeCompare(b.wk)), walls: wallList, conf };
}

const HOME_RULE = /\/\.(claude|codex)\//;
/** Before/after for one adopted fix. Exported for tests and for `trail share`. */
export function adoptionEffect(wall, ad, sessions) {
  const at = Date.parse(ad.at);
  const repoScope = !HOME_RULE.test(ad.target || '') ? (ad.target || '').split('/').slice(0, -1).join('/') : null;
  const inScope = sessions.filter((s) => (!repoScope || s.cwd === repoScope) && s.start);
  const hitIds = new Set(wall.list.map((x) => x.id));
  const mode = (arr) => { const c = {}; for (const s of arr) c[s.mode || 'unknown'] = (c[s.mode || 'unknown'] || 0) + 1; return Object.entries(c).sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'unknown'; };
  const before = inScope.filter((s) => Date.parse(s.start) < at); const after = inScope.filter((s) => Date.parse(s.start) >= at);
  const modeBefore = mode(before.filter((s) => hitIds.has(s.id)).length ? before.filter((s) => hitIds.has(s.id)) : before);
  const share = (arr, m) => { const xs = arr.filter((s) => (s.mode || 'unknown') === m); return { sessions: xs.length, hit: xs.filter((s) => hitIds.has(s.id)).length }; };
  const b = share(before, modeBefore), f = share(after, modeBefore);
  const modeAfter = mode(after);
  const confounded = after.length > 0 && modeAfter !== modeBefore && f.sessions < after.length / 2;
  const rate = (x) => (x.sessions ? x.hit / x.sessions : null);
  return { at: ad.at, target: ad.target, mode: modeBefore, modeAfter, confounded,
    before: b, after: f, beforeRate: rate(b), afterRate: rate(f),
    // Old fields kept for the explorer and web view.
    after_: f.hit, beforePerDay: b.hit / Math.max(1, (at - Math.min(at, ...before.map((s) => Date.parse(s.start)))) / 864e5), afterPerDay: f.hit / Math.max(1, (Date.now() - at) / 864e5),
    enough: b.sessions >= 5 && f.sessions >= 5 };
}
