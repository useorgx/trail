// One worker = one transcript at a time: read → threads → model → compact session record.
import { parentPort } from 'node:worker_threads';
import path from 'node:path';
import { setByteListener } from './adapters.mjs';
import { readSession } from './clients.mjs';
import { threadify } from './classify.mjs';
import { decide } from './decide.mjs';
import { steps } from './steps.mjs';
import { buildGoals } from './goals.mjs';
import { writeLanguage } from './store.mjs';
import { costOf, tokensOf, spanCost } from './cost.mjs';

let acc = 0;
setByteListener((n) => { acc += n; if (acc > 8e6) { parentPort.postMessage({ progress: acc }); acc = 0; } });


parentPort.on('message', async ({ file, client }) => {
  acc = 0;
  try {
    const s = await readSession(file, client);
    // Empty conversations (drafts, windows opened and closed) are not sessions.
    if (!s.ev.length) { parentPort.postMessage({ ok: true, skip: true }); return; }
    const r = threadify(s);
    // Language the record leaves out goes to a side file; goals are built from per-step facts and tags.
    const full = s.ev.map((e, i) => (e.full ? [i, e.full] : null)).filter(Boolean);
    const lang = { reasoning: s.reasoning || [], full };
    const id = s.id || path.basename(file).replace(/\.gz$/, '').replace(/\.jsonl$/, '').slice(-36);
    if (lang.reasoning.length || full.length) writeLanguage(id, lang);
    const st = steps(s, lang); const goals = buildGoals(s, r, st, { sessionId: id });
    // Estimated cost from the transcript's own token counts and list prices (src/cost.mjs).
    const ue = s.usageEvents || [];
    for (const t of r.threads) { const c = spanCost(ue, t.spans || [], s.model, client); if (c) t.cost = c; }
    for (const g of goals) { const c = spanCost(ue, g.spans || [], s.model, client); if (c) g.cost = c; }
    const tagCounts = {}; for (const x of st) if (x.tag) tagCounts[x.tag] = (tagCounts[x.tag] || 0) + 1;
    const sess = {
      id, client, file,
      project: (s.cwd || '').split('/').filter(Boolean).slice(-1)[0] || '—', cwd: s.cwd, model: s.model, mode: s.mode,
      start: s.start, end: s.end, asks: s.ev.filter((e) => e.k === 'ask').length,
      tools: r.tools, errs: r.errs, denied: r.denied, compactions: r.compactions, steers: r.steers, walls: r.walls,
      lang: { reasoning: lang.reasoning.length, full: full.length }, tags: tagCounts,
      ...(s.usage ? { usage: s.usage, tokens: tokensOf(s.usage, client), cost: costOf(s.usage, s.model, client) } : {}), ...(s.interrupts ? { interrupts: s.interrupts } : {}),
      goals: goals.map((g) => ({ id: g.id, root: g.root, title: g.title, origin: g.origin, threads: g.threads, episodes: g.episodes.map((e) => e.kind), spans: g.spans, outcome: g.outcome, status: g.status, backtracks: g.backtracks, conf: g.conf, ...(g.cost ? { cost: g.cost } : {}), ...(g.checkedAfterChange != null ? { checkedAfterChange: g.checkedAfterChange } : {}), ...(g.jev ? { jev: g.jev, agree: g.agree, verified: g.verified } : {}) })),
      threads: r.threads.map((t) => decide({ id: t.id, origin: t.origin, kind: t.kind, title: t.title, ask: t.ask, notes: t.notes, moves: t.moves, backs: t.backs, status: t.status, claim: t.claim, subj: t.subj, errs: t.errs, parent: t.parent, t0: t.t0, t1: t.t1, spans: t.spans || [], feat: t.feat, ...(t.cost ? { cost: t.cost } : {}) })),
    };
    parentPort.postMessage({ ok: true, sess });
  } catch (err) { parentPort.postMessage({ ok: false, error: String(err).slice(0, 200) }); }
});
