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
      a.list.push({ id: s.id, start: s.start, project: s.project, client: s.client, cwd: s.cwd, n: x.n });
      walls.set(x.sig, a); tot.wallCalls += x.n; w.wallCalls += x.n;
      if (seenWall.has(x.sig)) tot.rediscoveryCalls += x.n; else seenWall.add(x.sig);
    }
  }
  // adoption effect: sessions hitting the wall before vs after adoption, per day
  for (const ad of adoptions) {
    const a = walls.get(ad.sig); if (!a) continue;
    const at = new Date(ad.at).getTime(); const before = a.list.filter((x) => new Date(x.start).getTime() < at); const after = a.list.filter((x) => new Date(x.start).getTime() >= at);
    const days = (ms) => Math.max(1, ms / 864e5);
    const firstT = before.length ? new Date(before[0].start).getTime() : at;
    a.adopted = { at: ad.at, target: ad.target, beforePerDay: before.length / days(at - firstT), after: after.length, afterPerDay: after.length / days(Date.now() - at) };
  }
  const wallList = [...walls.values()].filter((a) => a.named || a.sessions >= 3).sort((a, b) => b.sessions - a.sessions);
  return { tot, weeks: [...W.values()].sort((a, b) => a.wk.localeCompare(b.wk)), walls: wallList, conf };
}
