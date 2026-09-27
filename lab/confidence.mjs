// How accurate is a labeler when it is sure? For pre-filling: at each confidence cutoff, the share of threads
// it would pre-fill and how often those pre-fills match the reference labels. Also the best backtrack threshold.
// Usage: node lab/confidence.mjs [--labeler jev] [--gold-from codex]
import fs from 'node:fs'; import path from 'node:path';
import { L, safeName, goldByKey, allBatchItems } from './lib.mjs';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const name = arg('labeler', 'jev'); const { gold } = goldByKey({ labeler: arg('gold-from', 'codex') });
const rows = allBatchItems().filter((i) => gold.has(i.key) && i.split === 'dev').map((i) => { try { return { g: gold.get(i.key), m: JSON.parse(fs.readFileSync(path.join(L.jury, '..', 'labelers', name, safeName(i.key) + '.json'), 'utf8')) }; } catch { return null; } }).filter(Boolean);
for (const f of ['status', 'origin', 'boundary']) {
  const r = rows.filter((x) => x.m[f] && x.m.conf?.[f] != null);
  const line = [0, 0.5, 0.7, 0.8, 0.9].map((c) => { const s = r.filter((x) => x.m.conf[f] >= c); const ok = s.filter((x) => x.m[f] === x.g[f]).length; return `≥${c}: ${Math.round(100 * s.length / r.length)}% of threads, ${s.length ? Math.round(100 * ok / s.length) : 0}% right`; });
  console.log(f.padEnd(9), line.join(' · '));
}
const bt = rows.filter((x) => x.m.backtracked != null && x.g.backtracks != null);
if (bt.length) { const best = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map((t) => { let tp = 0, fp = 0, fn = 0, tn = 0; for (const x of bt) { const p = x.m.backtracked >= t, g = x.g.backtracks !== '0'; if (p && g) tp++; else if (p) fp++; else if (g) fn++; else tn++; } return { t, acc: (tp + tn) / bt.length, precision: tp / Math.max(tp + fp, 1), recall: tp / Math.max(tp + fn, 1) }; });
  console.log('backtracked threshold:', best.map((b) => `${b.t}: acc ${Math.round(b.acc * 100)}% p ${Math.round(b.precision * 100)} r ${Math.round(b.recall * 100)}`).join(' · ')); }
