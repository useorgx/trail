// Step-tag model: sample language steps, get silver labels, train the local model, compare with rules and Jev.
//   node lab/steptag/build.mjs sample [--n 900]     → ~/.orgx/trail/lab/steptag/steps.jsonl
//   node lab/steptag/build.mjs silver [--model sonnet] → silver.jsonl   (Claude via `claude -p`, subscription)
//   node lab/steptag/build.mjs jev --key-file <env>  → jev.jsonl       (opt-in, OpenRouter)
//   node lab/steptag/build.mjs train                 → src/model/steptag.json + a report on held-out sessions
// Silver labels are a model's, not a person's: the report says how the local model tracks them, not truth.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
import { loadSessions, HOME } from '../../src/store.mjs'; import { readSession } from '../../src/clients.mjs';
import { steps, TAGS, featurize, scoreTags, DIM } from '../../src/steps.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = path.join(HOME, 'lab', 'steptag'); fs.mkdirSync(DIR, { recursive: true });
const F = { steps: path.join(DIR, 'steps.jsonl'), silver: path.join(DIR, 'silver.jsonl'), jev: path.join(DIR, 'jev.jsonl') };
const readL = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const DEF = {
  plan: 'States what it will do next.', hypothesis: 'Proposes a possible cause or explanation, not yet confirmed.',
  evidence: 'Reports something observed in output, logs, code or data.', decision: 'Commits to one option among alternatives.',
  course_change: 'Drops an approach, belief or plan for a different one.', verification: 'Reports that a check passed or confirms the result works.',
  claim_done: 'Says the work is finished, shipped or delivered.', handback: 'Asks the person for a decision, approval or action.',
  blocked: 'Says it cannot proceed (refused, unavailable, stuck).', other: 'None of these.' };
let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const cmd = process.argv[2];

if (cmd === 'sample') {
  const N = +arg('n', 900); const pool = [];
  for (const s of loadSessions().filter((x) => x.file && fs.existsSync(x.file) && !x.file.includes('#')).reverse().slice(0, 300)) {
    const ev = await readSession(s.file, s.client); const st = steps(ev, { reasoning: ev.reasoning || [] });
    st.forEach((x, k) => { if (x.kind !== 'say' && x.kind !== 'think') return; if ((x.text || '').length < 30) return;
      const prev = st.slice(Math.max(0, k - 2), k).map((p) => (p.kind === 'tool' ? `${p.action}:${p.result}` : `${p.kind}:${(p.text || '').slice(0, 80)}`));
      pool.push({ id: crypto.createHash('sha1').update(s.id + ':' + k).digest('hex').slice(0, 12), session: s.id, client: s.client, kind: x.kind, rule: x.tag, text: x.text.slice(0, 1200), prev }); });
  }
  // Balance across kind x rule tag so rare acts (course_change, handback, blocked) are represented.
  const groups = new Map(); for (const p of pool) { const k = p.kind + '|' + p.rule; (groups.get(k) || groups.set(k, []).get(k)).push(p); }
  for (const g of groups.values()) g.sort(() => rnd() - 0.5);
  const keys = [...groups.keys()].sort(); const out = [];
  while (out.length < N && keys.some((k) => groups.get(k).length)) for (const k of keys) { const g = groups.get(k); if (g.length && out.length < N) out.push(g.pop()); }
  fs.writeFileSync(F.steps, out.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${out.length} steps from a pool of ${pool.length}`, Object.fromEntries(keys.map((k) => [k, out.filter((x) => x.kind + '|' + x.rule === k).length])));
}

if (cmd === 'silver') {
  const done = new Set(readL(F.silver).map((x) => x.id)); const todo = readL(F.steps).filter((x) => !done.has(x.id));
  const SYSTEM = `You tag single steps of an AI coding agent's work. For each step, pick exactly one tag:\n${TAGS.map((t) => `- ${t}: ${DEF[t]}`).join('\n')}\nIf a step does several things, pick the one that matters most for understanding how the work went (course_change > blocked > handback > verification > claim_done > decision > hypothesis > evidence > plan > other). Reply ONLY with JSON: {"labels":[{"id":"...","tag":"..."}]}`;
  const ask = (prompt) => new Promise((res) => { const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
    const p = spawn('claude', ['-p', '--model', arg('model', 'sonnet'), '--output-format', 'json', '--system-prompt', SYSTEM, '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config'], { env });
    let o = ''; p.stdout.on('data', (d) => (o += d)); const tm = setTimeout(() => p.kill('SIGKILL'), 240e3);
    p.on('close', () => { clearTimeout(tm); try { const j = JSON.parse(o); res({ labels: JSON.parse(j.result.match(/\{[\s\S]*\}/)[0]).labels, cost: j.total_cost_usd || 0 }); } catch { res({ labels: [], cost: 0 }); } }); p.stdin.end(prompt); });
  const batches = []; for (let i = 0; i < todo.length; i += 25) batches.push(todo.slice(i, i + 25)); let cost = 0, n = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (batches.length) { const b = batches.shift();
    const r = await ask(b.map((x) => `id: ${x.id}\nkind: ${x.kind === 'think' ? 'reasoning' : 'message'}\nbefore: ${x.prev.join(' | ') || '—'}\nstep: ${x.text.replace(/\s+/g, ' ')}`).join('\n\n---\n\n')); cost += r.cost;
    for (const l of r.labels) if (b.some((x) => x.id === l.id) && TAGS.includes(l.tag)) { fs.appendFileSync(F.silver, JSON.stringify({ id: l.id, tag: l.tag }) + '\n'); n++; }
    console.error(`${n} labeled · $${cost.toFixed(2)}`); } }));
  console.log(`silver: ${n} new labels, $${cost.toFixed(2)}`);
}

if (cmd === 'jev') {
  const f = arg('key-file'); const key = process.env.OPENROUTER_API_KEY || (f && fs.readFileSync(f, 'utf8').match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*["']?([^"'\s#]+)/m)?.[1]);
  if (!key) { console.error('Set OPENROUTER_API_KEY or pass --key-file.'); process.exit(2); }
  const done = new Set(readL(F.jev).map((x) => x.id)); const todo = readL(F.steps).filter((x) => !done.has(x.id)); let cost = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (todo.length) { const x = todo.shift();
    const r = await fetch('https://openrouter.ai/api/alpha/decisions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'typesafe/jev-1.13', state: { kind: x.kind === 'think' ? 'reasoning' : 'message', before: x.prev.join(' | '), step: x.text }, questions: { tag: { type: 'choice', instructions: 'What is this step of an AI coding agent\'s work doing? If several, the one that matters most for how the work went.', criteria: DEF } } }) });
    if (!r.ok) continue; const d = await r.json(); cost += d.usage?.cost || 0;
    fs.appendFileSync(F.jev, JSON.stringify({ id: x.id, tag: d.answers.tag.choice, conf: d.answers.tag.confidence }) + '\n'); } }));
  console.log(`jev: ${readL(F.jev).length} tagged, $${cost.toFixed(4)}`);
}

if (cmd === 'train') {
  const silver = new Map(readL(F.silver).map((x) => [x.id, x.tag])); const all = readL(F.steps).filter((x) => silver.has(x.id));
  // Split by session so near-duplicate steps of one session never sit on both sides.
  const test = (x) => parseInt(crypto.createHash('sha1').update(x.session).digest('hex').slice(0, 8), 16) / 2 ** 32 < 0.25;
  const tr = all.filter((x) => !test(x)), te = all.filter(test);
  const X = (x) => featurize(x.text, x.kind);
  const m = { tags: TAGS, weights: Object.fromEntries(TAGS.map((t) => [t, {}])), bias: Object.fromEntries(TAGS.map((t) => [t, 0])) };
  const W = Object.fromEntries(TAGS.map((t) => [t, new Float64Array(DIM)]));
  const data = tr.map((x) => ({ f: X(x), y: silver.get(x.id) }));
  const counts = {}; for (const d of data) counts[d.y] = (counts[d.y] || 0) + 1; // class weights: rare acts matter
  for (let ep = 0; ep < 40; ep++) { const lr = 0.3 / (1 + ep * 0.15); data.sort(() => rnd() - 0.5);
    for (const d of data) { const probs = scoreTags({ tags: TAGS, bias: m.bias, weights: Object.fromEntries(TAGS.map((t) => [t, W[t]])) }, d.f); const p = Object.fromEntries(probs);
      const cw = Math.min(4, data.length / (TAGS.length * (counts[d.y] || 1)));
      for (const t of TAGS) { const g = ((t === d.y ? 1 : 0) - p[t]) * cw; m.bias[t] += lr * g * 0.1; for (const [i, v] of d.f) W[t][i] += lr * (g * v - 1e-4 * W[t][i]); } } }
  for (const t of TAGS) for (let i = 0; i < DIM; i++) { const v = +W[t][i].toFixed(3); if (Math.abs(v) >= 0.02) m.weights[t][i] = v; }
  const acc = (pred) => { const ok = te.filter((x) => pred(x) === silver.get(x.id)).length; const per = {}; for (const t of TAGS) { const g = te.filter((x) => silver.get(x.id) === t); const p = te.filter((x) => pred(x) === t); const tp = g.filter((x) => pred(x) === t).length; per[t] = { n: g.length, precision: p.length ? +(tp / p.length).toFixed(2) : null, recall: g.length ? +(tp / g.length).toFixed(2) : null }; } return { acc: +(ok / te.length).toFixed(3), per }; };
  const jev = new Map(readL(F.jev).map((x) => [x.id, x.tag]));
  const report = { train: tr.length, test: te.length, rules: acc((x) => x.rule), model: acc((x) => scoreTags(m, X(x))[0][0]), ...(jev.size ? { jev: acc((x) => jev.get(x.id) || 'other') } : {}) };
  fs.mkdirSync(new URL('../../src/model/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('../../src/model/steptag.json', import.meta.url), JSON.stringify({ trained: new Date().toISOString(), silver: arg('model', 'sonnet'), n: tr.length, ...m }));
  fs.writeFileSync(path.join(DIR, 'report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ train: report.train, test: report.test, rules: report.rules.acc, model: report.model.acc, jev: report.jev?.acc }, null, 1));
  const cc = (k) => report[k]?.per?.course_change; console.log('course_change  rules', JSON.stringify(cc('rules')), ' model', JSON.stringify(cc('model')), report.jev ? ' jev ' + JSON.stringify(cc('jev')) : '');
  console.log('model size', (fs.statSync(new URL('../../src/model/steptag.json', import.meta.url)).size / 1024).toFixed(0), 'KB');
}
