// `trail deepen`: the opt-in accuracy tier. Jev (TypeSafe's decision model) says what each language step is doing
// and, separately, how each goal ended; answers are cached and the affected goals rebuilt (src/goals.mjs trusts an
// outcome when the steps and Jev agree). Off unless you run it. Two ways to pay:
//   - your own OpenRouter key (--key-file / OPENROUTER_API_KEY): step text and goal evidence go to OpenRouter/TypeSafe;
//   - OrgX credits (after `trail connect`): the same text goes through OrgX, which asks Jev and drops it. You see a
//     quote first, computed from counts alone, and nothing is sent until you say yes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, loadSessions, loadLanguage, loadIndex, saveIndex } from './store.mjs';
import { readSession } from './clients.mjs';
import { steps, TAGS } from './steps.mjs';
import { threadify } from './classify.mjs';
import { buildGoals, GOAL_JEV, goalKey } from './goals.mjs';
import { renderEvidence } from './evidence.mjs';
import { credential, baseUrl } from './sync.mjs';
import { redact } from './redact.mjs';
import { piiEnabled, maskPii } from './pii.mjs';

export const JEV_CACHE = path.join(HOME, 'steptags-jev.json');
export const textKey = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
const STATUSES = ['done', 'dropped', 'parked', 'open', 'unclear'];
const DEF = {
  plan: 'States what it will do next.', hypothesis: 'Proposes a possible cause or explanation, not yet confirmed.',
  evidence: 'Reports something observed in output, logs, code or data.', decision: 'Commits to one option among alternatives.',
  course_change: 'Drops an approach, belief or plan for a different one.', verification: 'Reports that a check passed or confirms the result works.',
  claim_done: 'Says the work is finished, shipped or delivered.', handback: 'Asks the person for a decision, approval or action.',
  blocked: 'Says it cannot proceed (refused, unavailable, stuck).', other: 'None of these.' };
const OUTCOME = { type: 'choice', instructions: 'How did this piece of AI coding agent work end, as far as the log shows? Lines marked ~ belong to other work, shown for context.', criteria: {
  done: 'Delivered: a ship (commit, PR, merge, deploy, publish), a check that passed after the change, or an answer that satisfies the ask.',
  dropped: 'The agent stopped without delivering: gave up, was blocked, or moved on and never came back.',
  parked: 'Explicitly left for later or waiting on the person.',
  open: 'The session transcript ends while this work is still in progress.',
  unclear: 'The log genuinely cannot tell.' } };

// Running out of credits stops the run at once with what to do next, instead of counting every item as failed.
export class OutOfCredits extends Error {}

export function readKey(keyFile) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  if (!keyFile) return null;
  return fs.readFileSync(keyFile, 'utf8').match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*["']?([^"'\s#]+)/m)?.[1] || null;
}

/** Your own OpenRouter key: one Jev call per item. */
export function ownKeyProvider(key, par = 8) {
  const jev = async (body) => {
    const r = await fetch('https://openrouter.ai/api/alpha/decisions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'typesafe/jev-1.13', ...body }) });
    if (r.status === 402) throw new OutOfCredits('The OpenRouter account behind this key is out of credits (402). Add credits at https://openrouter.ai/settings/credits, then run trail deepen again; finished work is cached.');
    if (!r.ok) throw new Error(String(r.status)); return r.json();
  };
  return {
    name: 'your OpenRouter key', batch: 25, cost: 0,
    // Estimated from measured lab costs (~$0.000026 a step, ~$0.0001 a goal); OpenRouter bills the real amount.
    quote: async ({ steps, goals }) => ({ steps, goals, usd: +(steps * 0.000026 + goals * 0.0001).toFixed(2), estimate: true, enough: true, configured: true }),
    async answer(items) {
      const out = {}; const q = [...items];
      await Promise.all(Array.from({ length: par }, async () => { while (q.length) { const it = q.shift();
        try {
          const d = it.kind === 'step'
            ? await jev({ state: { kind: it.step_kind === 'think' ? 'reasoning' : 'message', step: it.text }, questions: { q: { type: 'choice', instructions: 'What is this step of an AI coding agent\'s work doing? If several, the one that matters most for how the work went.', criteria: DEF } } })
            : await jev({ state: { evidence: it.evidence }, questions: { q: OUTCOME } });
          this.cost += d.usage?.cost || 0; const a = d.answers?.q; out[it.id] = a?.choice ? [a.choice, +(a.confidence ?? 0).toFixed(2)] : null;
        } catch (e) { if (e instanceof OutOfCredits) { q.length = 0; throw e; } out[it.id] = null; } } }));
      return out;
    },
  };
}

/** OrgX credits: quote from counts, then batches of 100 through OrgX, each with a fresh batch id. */
export function orgxProvider({ key, base }) {
  const post = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 402) throw new OutOfCredits(`Not enough OrgX credits (${j.available ?? 0} left). Buy a pack at ${base}${j.buy_url || '/settings/billing'}, then run trail deepen again; finished work is cached.`);
    if (!r.ok) throw new Error(j.error || `OrgX ${r.status}`); return j.data;
  };
  return {
    name: 'OrgX credits', batch: 100, charged: 0,
    quote: (counts) => post('/api/v1/trail/deepen/quote', counts),
    async answer(items) { const d = await post('/api/v1/trail/deepen', { batch_id: crypto.randomUUID(), items }); this.charged += d.charged; return d.answers; },
  };
}

/** Which way to pay: your own key if you gave one, else OrgX credits if `trail connect` found a key, else none. */
export function pickProvider({ keyFile, base } = {}) {
  const key = readKey(keyFile); if (key) return ownKeyProvider(key);
  const c = credential(); if (c?.key) return orgxProvider({ key: c.key, base: baseUrl(base) });
  return null;
}

/**
 * @param {{provider:any, sessions?:string[], limit?:number, confirm?:(quote:any)=>Promise<boolean>, onProgress?:(p:any)=>void}} o
 */
export async function deepen(o) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(JEV_CACHE, 'utf8')); } catch {}
  let gcache = {}; try { gcache = JSON.parse(fs.readFileSync(GOAL_JEV, 'utf8')); } catch {}
  const pick = loadSessions().filter((s) => s.file && (s.file.includes('#') || fs.existsSync(s.file)) && (!o.sessions || o.sessions.includes(s.id))).reverse().slice(0, o.limit || 1e9);
  // Gather everything first so the quote is exact: unique step texts not yet tagged, goals not yet read.
  const stepItems = new Map(); const goalItems = []; const fileOf = new Map();
  for (const s of pick) {
    const ev = await readSession(s.file, s.client); const lang = loadLanguage(s.id);
    const st = steps(ev, lang.reasoning.length ? lang : { reasoning: ev.reasoning || [] });
    for (const x of st) {
      if ((x.kind !== 'say' && x.kind !== 'think') || (x.text || '').length < 20) continue;
      const k = textKey(x.text); if (cache[k] || stepItems.has(k)) continue;
      stepItems.set(k, { id: k, kind: 'step', step_kind: x.kind, text: redact(x.text).slice(0, 4000) }); fileOf.set(k, s.file);
    }
    for (const g of buildGoals(ev, threadify(ev), st, { sessionId: s.id })) {
      const k = goalKey(s.id, g); if (gcache[k]) continue;
      goalItems.push({ id: crypto.createHash('sha1').update(k).digest('hex').slice(0, 16), kind: 'goal', evidence: redact(renderEvidence(ev, g.spans, 16000, null)), _k: k }); fileOf.set(k, s.file);
    }
  }
  const counts = { steps: stepItems.size, goals: goalItems.length };
  if (!counts.steps && !counts.goals) return { ...counts, sessions: 0, cost: 0, charged: 0, nothing: true };
  if (o.provider.quote) {
    const q = await o.provider.quote(counts);
    if (!q.configured) throw new Error('Paid deepen is not turned on for this OrgX server yet.');
    if (!(await (o.confirm ? o.confirm(q) : false))) return { ...counts, cancelled: true, quote: q };
    if (!q.enough) throw new OutOfCredits(`This run needs ${q.credits} credits and you have ${q.available}. Buy a pack at ${baseUrl()}${q.buy_url}, then run trail deepen again.`);
  }
  // Opt-in: personal data masked locally with OpenAI Privacy Filter before anything is sent (throws = nothing sent).
  if (piiEnabled()) {
    const all = [...stepItems.values(), ...goalItems];
    for (let i = 0; i < all.length; i += 500) { const chunk = all.slice(i, i + 500); const masked = maskPii(chunk.map((x) => x.text ?? x.evidence)); chunk.forEach((x, k) => { if ('text' in x) x.text = masked[k]; else x.evidence = masked[k]; }); }
  }
  const touched = new Set(); let done = 0; const total = counts.steps + counts.goals;
  const save = () => { fs.writeFileSync(JEV_CACHE, JSON.stringify(cache)); fs.writeFileSync(GOAL_JEV, JSON.stringify(gcache)); };
  const run = async (items, onAnswer) => {
    for (let i = 0; i < items.length; i += o.provider.batch) {
      const b = items.slice(i, i + o.provider.batch);
      const ans = await o.provider.answer(b.map(({ _k, ...x }) => x));
      for (const it of b) { const a = ans[it.id]; if (a) onAnswer(it, a); }
      done += b.length; save(); o.onProgress?.({ done, total, cost: o.provider.cost, charged: o.provider.charged });
    }
  };
  try {
    await run([...stepItems.values()], (it, a) => { if (TAGS.includes(a[0])) { cache[it.id] = a; touched.add(fileOf.get(it.id)); } });
    await run(goalItems, (it, a) => { if (STATUSES.includes(a[0])) { gcache[it._k] = a; touched.add(fileOf.get(it._k)); } });
  } finally {
    save(); // answers so far are kept; the next run skips them
    const index = loadIndex(); for (const f of touched) delete index.files[f]; saveIndex(index); // rebuild their goals on the next scan
  }
  return { ...counts, sessions: touched.size, cost: o.provider.cost ?? null, charged: o.provider.charged ?? null };
}
