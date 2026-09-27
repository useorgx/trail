// `trail deepen`: the opt-in accuracy tier. Asks Jev (TypeSafe's decision model, via OpenRouter) what each language
// step is doing, caches the answer by text hash, and rebuilds the affected goals. Off unless you run it with a key;
// step text (agent messages and reasoning) is sent to OpenRouter/TypeSafe, nothing else. Paid per input token
// (about $0.00003 a step). In the lab Jev agreed with Sonnet's step labels 63% of the time vs 32% for the rules.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, loadSessions, loadLanguage, loadIndex, saveIndex } from './store.mjs';
import { readSession } from './clients.mjs';
import { steps, TAGS } from './steps.mjs';

export const JEV_CACHE = path.join(HOME, 'steptags-jev.json');
export const textKey = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
const DEF = {
  plan: 'States what it will do next.', hypothesis: 'Proposes a possible cause or explanation, not yet confirmed.',
  evidence: 'Reports something observed in output, logs, code or data.', decision: 'Commits to one option among alternatives.',
  course_change: 'Drops an approach, belief or plan for a different one.', verification: 'Reports that a check passed or confirms the result works.',
  claim_done: 'Says the work is finished, shipped or delivered.', handback: 'Asks the person for a decision, approval or action.',
  blocked: 'Says it cannot proceed (refused, unavailable, stuck).', other: 'None of these.' };

export function readKey(keyFile) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  if (!keyFile) return null;
  return fs.readFileSync(keyFile, 'utf8').match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*["']?([^"'\s#]+)/m)?.[1] || null;
}

/** @param {{key:string, sessions?:string[], limit?:number, par?:number, onProgress?:(p:any)=>void}} o */
export async function deepen(o) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(JEV_CACHE, 'utf8')); } catch {}
  const pick = loadSessions().filter((s) => s.file && (s.file.includes('#') || fs.existsSync(s.file)) && (!o.sessions || o.sessions.includes(s.id))).reverse().slice(0, o.limit || 1e9);
  const todo = []; const touched = new Set();
  for (const s of pick) {
    const ev = await readSession(s.file, s.client); const lang = loadLanguage(s.id);
    for (const x of steps(ev, lang.reasoning.length ? lang : { reasoning: ev.reasoning || [] })) {
      if ((x.kind !== 'say' && x.kind !== 'think') || (x.text || '').length < 20) continue;
      const k = textKey(x.text); if (cache[k]) continue; todo.push({ k, kind: x.kind, text: x.text.slice(0, 4000), file: s.file }); touched.add(s.file);
    }
  }
  const seen = new Set(); const queue = todo.filter((t) => !seen.has(t.k) && seen.add(t.k)); const total = queue.length; let cost = 0, done = 0, failed = 0;
  await Promise.all(Array.from({ length: o.par || 8 }, async () => { while (queue.length) { const t = queue.shift();
    try {
      const r = await fetch('https://openrouter.ai/api/alpha/decisions', { method: 'POST', headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'typesafe/jev-1.13', state: { kind: t.kind === 'think' ? 'reasoning' : 'message', step: t.text }, questions: { tag: { type: 'choice', instructions: 'What is this step of an AI coding agent\'s work doing? If several, the one that matters most for how the work went.', criteria: DEF } } }) });
      if (!r.ok) throw new Error(String(r.status)); const d = await r.json(); cost += d.usage?.cost || 0;
      if (TAGS.includes(d.answers?.tag?.choice)) cache[t.k] = [d.answers.tag.choice, +(d.answers.tag.confidence ?? 0).toFixed(2)];
    } catch { failed++; }
    if (++done % 200 === 0) { fs.writeFileSync(JEV_CACHE, JSON.stringify(cache)); o.onProgress?.({ done, total, cost }); } } }));
  fs.writeFileSync(JEV_CACHE, JSON.stringify(cache));
  // Sessions whose steps changed are re-read on the next scan so their goals use the new tags.
  const index = loadIndex(); for (const f of touched) delete index.files[f]; saveIndex(index);
  return { steps: total, failed, cost, sessions: touched.size };
}
