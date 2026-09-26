// Score a depth pilot: what trail's shallow view misses, measured against the deep (C) read, with C-vs-C2 as the noise floor.
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const rows = j.rows.filter((r) => r.labels.A && r.labels.C && r.labels.C2);
const has = (l) => (l?.backtracks?.length || 0) > 0;
const agree = (f, a, b) => rows.filter((r) => f(r.labels[a]) === f(r.labels[b])).length / rows.length;
const pct = (x) => `${Math.round(x * 100)}%`;
function pr(pred, gold) { let tp = 0, fp = 0, fn = 0; for (const r of rows) { const p = pred(r), g = gold(r); if (p && g) tp++; else if (p) fp++; else if (g) fn++; } return { precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1), tp, fp, fn }; }
const goldBack = (r) => has(r.labels.C);
const trailRule = pr((r) => r.trail_backs > 0, goldBack);
const modelShallow = pr((r) => has(r.labels.A), goldBack);
const noise = pr((r) => has(r.labels.C2), goldBack);
const triggers = {}; for (const r of rows) for (const b of r.labels.C.backtracks || []) triggers[b.trigger] = (triggers[b.trigger] || 0) + 1;
const nBacks = (v) => rows.reduce((n, r) => n + (r.labels[v].backtracks?.length || 0), 0);
const trailStatus = { outcome: 'done', 'outcome?': 'unclear', open: 'parked', abandoned: 'dropped' };
const withThink = rows.filter((r) => r.chars_think > 0);
const sub = (set, f) => set.filter(f).length / (set.length || 1);
console.log(JSON.stringify({
  threads: rows.length, with_reasoning: withThink.length, cost: +j.cost.toFixed(2),
  backtracks_found: { trail_rule_threads: rows.filter((r) => r.trail_backs).length, shallow_model: nBacks('A'), deep_model: nBacks('C'), deep_again: nBacks('C2') },
  deep_backtrack_triggers: triggers,
  vs_deep_read: {
    trail_rule: { precision: pct(trailRule.precision), recall: pct(trailRule.recall) },
    model_on_trail_view: { precision: pct(modelShallow.precision), recall: pct(modelShallow.recall) },
    noise_floor_deep_twice: { precision: pct(noise.precision), recall: pct(noise.recall) },
  },
  status_agreement: {
    trail_vs_deep: pct(rows.filter((r) => trailStatus[r.trail_status] === r.labels.C.status).length / rows.length),
    shallow_model_vs_deep: pct(agree((l) => l.status, 'A', 'C')), deep_twice: pct(agree((l) => l.status, 'C', 'C2')),
  },
  where_reasoning_exists: {
    threads: withThink.length,
    trail_rule_recall: pct(pr((r) => r.trail_backs > 0 && r.chars_think > 0, (r) => goldBack(r) && r.chars_think > 0).recall),
    deep_finds_backtrack: pct(sub(withThink, goldBack)), shallow_finds_backtrack: pct(sub(withThink, (r) => has(r.labels.A))),
  },
  mean_confidence: { shallow: +(rows.reduce((n, r) => n + (r.labels.A.confidence || 0), 0) / rows.length).toFixed(2), deep: +(rows.reduce((n, r) => n + (r.labels.C.confidence || 0), 0) / rows.length).toFixed(2) },
  prompt_chars: { shallow: Math.round(rows.reduce((n, r) => n + r.lenA, 0) / rows.length), deep: Math.round(rows.reduce((n, r) => n + r.lenC, 0) / rows.length) },
}, null, 1));
// Pairs for the insight-specificity judgment
fs.writeFileSync(process.argv[2].replace('.json', '-insights.json'), JSON.stringify(rows.map((r) => ({ id: `${r.session}:${r.thread}`, shallow: r.labels.A.insight, deep: r.labels.C.insight })), null, 1));
