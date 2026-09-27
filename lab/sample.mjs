// Draw a labeling batch: stratified across clients, origins, statuses and model uncertainty,
// with evidence frozen at sampling time so a label always refers to exactly what the labeler saw.
// Usage: node lab/sample.mjs --n 120 [--seed 7]
//        node lab/sample.mjs --depth --n 100   (gold set for backtracks: Claude Code + Codex, half with readable reasoning,
//                                               evidence shows reasoning and full agent messages)
import fs from 'node:fs';
import path from 'node:path';
import { loadSessions } from '../src/store.mjs';
import { ensureLab, L, keyOf, safeName, split, readSession, renderEvidence, readLanguage, allBatchItems, toCodebook, gitState } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const DEPTH = process.argv.includes('--depth');
const N = +arg('n', DEPTH ? 100 : 120); let seed = +arg('seed', 7);
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
ensureLab();

const taken = new Set(allBatchItems().map((i) => i.key));
const pool = [];
for (const s of loadSessions()) {
  if (!s.file || !fs.existsSync(s.file)) continue;
  for (const t of s.threads) {
    if (!t.spans?.length || (t.moves.length < 2 && t.origin !== 'ask' && t.origin !== 'schedule')) continue;
    if (DEPTH && ((s.client !== 'claude' && s.client !== 'codex') || t.moves.length < 5 || !t.t0 || !t.t1)) continue;
    const key = keyOf(s.id, t.spans[0][0]); if (taken.has(key)) continue;
    const cb = toCodebook(t); const unsure = t.p_abandon != null && Math.abs(t.p_abandon - 0.5) < 0.25;
    pool.push({ s, t, key, cb, stratum: DEPTH ? `${s.client}|${t.backs.length ? 'backs' : 'none'}` : `${s.client}|${cb.origin}|${cb.status}|${unsure ? 'unsure' : 'sure'}` });
  }
}
// Round-robin over strata so rare kinds (found, wall, dropped, uncertain) are represented, not drowned by "asked/done".
const byStratum = new Map(); for (const p of pool) (byStratum.get(p.stratum) || byStratum.set(p.stratum, []).get(p.stratum)).push(p);
for (const arr of byStratum.values()) arr.sort(() => rand() - 0.5);
const strata = [...byStratum.keys()].sort(); const picked = [];
const want = DEPTH ? N * 4 : N; // depth: oversample, then balance on whether the thread has readable reasoning
while (picked.length < want && strata.some((k) => byStratum.get(k).length)) for (const k of strata) { const a = byStratum.get(k); if (a.length && picked.length < want) picked.push(a.pop()); }
const lang = new Map();
if (DEPTH) {
  for (const p of picked) {
    if (!lang.has(p.s.file)) lang.set(p.s.file, await readLanguage(p.s.file, p.s.client));
    const a = Date.parse(p.t.t0) - 1000, b = Date.parse(p.t.t1) + 1000;
    p.reasoning = lang.get(p.s.file).some((x) => x.k === 'think' && x.ts >= a && x.ts <= b);
    p.stratum += p.reasoning ? '|reasoning' : '|no-reasoning';
  }
  const groups = new Map(); for (const p of picked) (groups.get(p.stratum) || groups.set(p.stratum, []).get(p.stratum)).push(p);
  const keys = [...groups.keys()].sort(); const balanced = [];
  while (balanced.length < N && keys.some((k) => groups.get(k).length)) for (const k of keys) { const g = groups.get(k); if (g.length && balanced.length < N) balanced.push(g.shift()); }
  picked.length = 0; picked.push(...balanced);
}

const items = [];
const cache = new Map();
for (const p of picked) {
  let sess = cache.get(p.s.file); if (!sess) { sess = await readSession(p.s.file, p.s.client); cache.set(p.s.file, sess); if (cache.size > 20) cache.delete(cache.keys().next().value); }
  const evidence = DEPTH ? renderEvidence(sess, p.t.spans, 20000, lang.get(p.s.file)) : renderEvidence(sess, p.t.spans);
  fs.writeFileSync(path.join(L.evidence, safeName(p.key) + '.txt'), evidence);
  items.push({ key: p.key, sid: p.s.id, file: p.s.file, client: p.s.client, project: p.s.project, start: p.s.start, anchor: p.t.spans[0][0], spans: p.t.spans,
    split: split(p.s.id), stratum: p.stratum, depth: DEPTH || undefined, pred: { ...p.cb, title: p.t.title, p_abandon: p.t.p_abandon ?? null, backtracks: p.t.backs.length },
    siblings: p.s.threads.map((x) => x.title).slice(0, 12) });
}
const n = fs.readdirSync(L.batches).filter((f) => f.endsWith('.json')).length + 1;
const out = path.join(L.batches, `batch-${String(n).padStart(3, '0')}.json`);
fs.writeFileSync(out, JSON.stringify({ created: new Date().toISOString(), seed: +arg('seed', 7), code: gitState(), pool: pool.length, items }, null, 1));
const c = (f) => items.reduce((m, i) => ((m[f(i)] = (m[f(i)] || 0) + 1), m), {});
console.log(`${out}: ${items.length} threads from a pool of ${pool.length}`);
console.log('split', c((i) => i.split), 'client', c((i) => i.client));
console.log('predicted origin', c((i) => i.pred.origin), 'status', c((i) => i.pred.status));
if (DEPTH) console.log('strata', c((i) => i.stratum));
