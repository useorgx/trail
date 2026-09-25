// Score any labeler against your gold labels. Dev split by default; the test split is sealed.
// Usage: node lab/eval.mjs [--labeler trail|jury:opus|jury:sonnet|jury:haiku|jury:majority] [--split dev|test --reason "release 0.2"]
// Every run is appended to experiments.jsonl with the code version, so progress is a ledger, not a memory.
import fs from 'node:fs';
import path from 'node:path';
import { L, safeName, goldByKey, allBatchItems, readSession, toCodebook, gitState, appendJSONL, readJSONL } from './lib.mjs';
import { threadify } from '../src/classify.mjs';
import { decide } from '../src/decide.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const labeler = arg('labeler', 'trail'); const which = arg('split', 'dev'); const quiet = process.argv.includes('--quiet');
if (which === 'test') {
  const reason = arg('reason'); if (!reason) { console.error('The test split is sealed. Pass --reason "<why this run counts>"; every test run is logged.'); process.exit(2); }
  appendJSONL(L.testLog, { at: new Date().toISOString(), labeler, reason, code: gitState() });
  console.log(`Test access #${readJSONL(L.testLog).length} logged.`);
}
const { gold, repeats } = goldByKey();
const items = allBatchItems().filter((i) => gold.has(i.key) && i.split === which && gold.get(i.key).boundary !== 'not_a_thread');
if (!items.length) { console.log(`No gold labels on the ${which} split yet. Label with: node lab/serve.mjs`); process.exit(0); }

// Predictions from the chosen labeler, keyed like gold.
const juryOf = (m, it) => { try { return JSON.parse(fs.readFileSync(path.join(L.jury, m, safeName(it.key) + '.json'), 'utf8')).label; } catch { return null; } };
const vote = (xs) => { const c = {}; for (const x of xs.filter(Boolean)) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
const pred = new Map(); const sessCache = new Map();
for (const it of items) {
  if (labeler === 'trail') {
    // Re-run the current classifier on the transcript and find the thread that owns the anchor event.
    let r = sessCache.get(it.file); if (!r) { const s = await readSession(it.file, it.client); r = threadify(s); r.threads.forEach(decide); sessCache.set(it.file, r); }
    const t = r.threads.find((x) => x.spans?.some(([a, b]) => it.anchor >= a && it.anchor <= b));
    const own = new Set(); for (const [a, b] of it.spans) for (let i = a; i <= b; i++) own.add(i);
    const now = new Set(); for (const [a, b] of t?.spans || []) for (let i = a; i <= b; i++) now.add(i);
    const inter = [...own].filter((i) => now.has(i)).length; const jac = inter / Math.max(1, new Set([...own, ...now]).size);
    pred.set(it.key, t ? { ...toCodebook(t), boundaryStable: jac >= 0.9 } : null);
  } else if (labeler.startsWith('jury:')) {
    const m = labeler.slice(5);
    if (m === 'majority') { const js = ['haiku', 'sonnet', 'opus'].map((x) => juryOf(x, it)); pred.set(it.key, { origin: vote(js.map((j) => j?.origin)), status: vote(js.map((j) => j?.status)), boundary: vote(js.map((j) => j?.boundary)) }); }
    else pred.set(it.key, juryOf(m, it));
  }
}

const fields = ['origin', 'status'].concat(labeler.startsWith('jury') ? ['boundary'] : []);
const res = { n: items.length }; const errors = [];
for (const f of fields) {
  let ok = 0, n = 0; const conf = {};
  for (const it of items) { const g = gold.get(it.key)[f]; const p = pred.get(it.key)?.[f]; if (g == null) continue; n++; if (p === g) ok++; else errors.push({ key: it.key, field: f, gold: g, pred: p ?? '—', project: it.project, client: it.client }); conf[`${g}→${p ?? '—'}`] = (conf[`${g}→${p ?? '—'}`] || 0) + 1; }
  res[f] = { acc: +(ok / Math.max(n, 1)).toFixed(4), n, confusion: conf };
}
if (labeler === 'trail') res.boundary = { acc: +(items.filter((it) => gold.get(it.key).boundary === 'right' && pred.get(it.key)?.boundaryStable).length / items.length).toFixed(4), note: 'share of threads you judged "right" whose spans the current classifier still reproduces' };
// Your own consistency: labels you gave twice without knowing.
const selfPairs = repeats.map((r) => ({ r, g: gold.get(r.key) })).filter((x) => x.g);
res.self = selfPairs.length ? Object.fromEntries(['origin', 'status', 'boundary'].map((f) => [f, +(selfPairs.filter((x) => x.r[f] === x.g[f]).length / selfPairs.length).toFixed(3)])) : null;
res.selfN = selfPairs.length;
const row = { at: new Date().toISOString(), labeler, split: which, code: gitState(), ...res };
appendJSONL(L.experiments, row);
if (!quiet) {
  console.log(`\n${labeler} on ${which} (${items.length} gold threads) — code ${row.code.sha}${row.code.dirty ? '+dirty' : ''}`);
  for (const f of [...fields, ...(labeler === 'trail' ? ['boundary'] : [])]) console.log(`  ${f.padEnd(9)} ${(res[f].acc * 100).toFixed(1)}%`);
  if (res.self) console.log(`  your own consistency on ${res.selfN} repeats: origin ${res.self.origin * 100}% · status ${res.self.status * 100}% · boundary ${res.self.boundary * 100}%`);
  const top = {}; for (const e of errors) top[`${e.field}: ${e.gold} labeled as ${e.pred}`] = (top[`${e.field}: ${e.gold} labeled as ${e.pred}`] || 0) + 1;
  if (which === 'test') { console.log('  (test split: per-thread misses are not shown)'); } else console.log('  most common misses:'); if (which === 'dev') for (const [k, v] of Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ${String(v).padStart(3)}  ${k}`);
}
// Per-thread errors exist only for dev. Test results stay aggregate so nothing (human or agent) can fit to them.
if (which === 'dev') fs.writeFileSync(path.join(path.dirname(L.experiments), `errors-${labeler.replace(':', '-')}-dev.json`), JSON.stringify(errors, null, 1));
