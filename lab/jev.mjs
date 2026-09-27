// Jev (TypeSafe's decision model, via OpenRouter's Decisions API) as a lab labeler.
// Same frozen evidence the bench shows, same codebook definitions, typed answers with probabilities.
// Opt-in and paid per input token: needs OPENROUTER_API_KEY, or --key-file <env file> holding that line (never printed).
// Usage: node lab/jev.mjs [--key-file path] [--limit N] [--par 6]      → ~/.orgx/trail/lab/labelers/jev/<key>.json
// Score:  node lab/eval.mjs --labeler model:jev --gold-from codex
import fs from 'node:fs';
import path from 'node:path';
import { L, ensureLab, safeName, allBatchItems } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  const f = arg('key-file'); if (!f) return null;
  const m = fs.readFileSync(f, 'utf8').match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*["']?([^"'\s#]+)/m);
  return m ? m[1] : null;
}
const KEY = apiKey(); if (!KEY) { console.error('Set OPENROUTER_API_KEY or pass --key-file <env file>.'); process.exit(2); }
const MODEL = 'typesafe/jev-1.13'; const OUT = path.join(L.jury, '..', 'labelers', 'jev');
ensureLab(); fs.mkdirSync(OUT, { recursive: true });

// Criteria are the codebook's own definitions (lab/codebook.md), so Jev and people answer the same question.
const Q = {
  origin: { type: 'choice', instructions: 'Where did the intent of this thread of AI coding agent work come from? Precedence when two fit: wall, then recovery, then found, then plan, then asked, then scheduled.', criteria: {
    asked: 'A person asked for it in this session, including a scheduled task\'s standing ask.',
    plan: 'The agent split an asked-for goal into this step itself.',
    found: 'The agent visibly noticed a problem nobody asked about (bug, incident, leak, wrong data, broken tool) and took it up.',
    recovery: 'Repeated failures of the agent\'s own commands, tests or builds that it worked through to get back to the asked-for work.',
    wall: 'The agent\'s calls were refused by permissions or policy and it routed around or stopped.',
    scheduled: 'A routine that ran on a timer with no live person.' } },
  status: { type: 'choice', instructions: 'How did this thread end, as far as the log shows? Lines marked ~ are other threads shown for context.', criteria: {
    done: 'Delivered: a ship (commit, PR, merge, deploy, publish), a check that passed after the change, or an answer that satisfies the ask.',
    dropped: 'The agent stopped without delivering: gave up, was blocked, or moved on and never came back.',
    parked: 'Explicitly left for later or waiting on a person.',
    open: 'The session transcript ends while this thread is still mid-work.',
    unclear: 'The log genuinely cannot tell.' } },
  boundary: { type: 'choice', instructions: 'Are the events shown one thread: one line of intent?', criteria: {
    right: 'The events serve one intent; small detours that serve it belong to it.',
    too_big: 'Two or more intents a person would name separately were merged.',
    too_small: 'Only a piece of an intent that continues in another thread.',
    not_a_thread: 'No intent: harness noise, a greeting, a single status line.' } },
};
const BACKTRACK = { type: 'noul', instructions: 'Did the agent really change approach, hypothesis or plan at least once in this thread (with or without an error first)? Lines starting [r] are its reasoning.', criteria: {
  true: 'At least once the agent dropped one approach or belief for a different one.',
  false: 'No real change of approach; retrying the same thing does not count.' } };

async function decide(it) {
  const evidence = fs.readFileSync(path.join(L.evidence, safeName(it.key) + '.txt'), 'utf8');
  const questions = { ...Q, ...(it.depth ? { backtracked: BACKTRACK } : {}) };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://openrouter.ai/api/alpha/decisions', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state: { client: it.client, repo: it.project, thread_evidence: evidence }, questions }) });
    if (r.ok) return r.json();
    const text = (await r.text()).slice(0, 200);
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    throw new Error(`${r.status} ${text}`);
  }
  throw new Error('retries exhausted');
}

const items = allBatchItems().filter((i) => !fs.existsSync(path.join(OUT, safeName(i.key) + '.json'))).slice(0, +arg('limit', 1e9));
let cost = 0, done = 0, failed = 0; const par = +arg('par', 6); const queue = [...items];
await Promise.all(Array.from({ length: par }, async () => { while (queue.length) { const it = queue.shift();
  try { const d = await decide(it); const a = d.answers; cost += d.usage?.cost || 0;
    fs.writeFileSync(path.join(OUT, safeName(it.key) + '.json'), JSON.stringify({ model: d.model, origin: a.origin?.choice, status: a.status?.choice, boundary: a.boundary?.choice,
      backtracked: a.backtracked?.noul ?? null, conf: { origin: a.origin?.confidence, status: a.status?.confidence, boundary: a.boundary?.confidence },
      probs: { origin: a.origin?.probabilities, status: a.status?.probabilities, boundary: a.boundary?.probabilities }, usage: d.usage }));
  } catch (e) { failed++; if (failed <= 3) console.error(it.key, String(e.message).slice(0, 160)); }
  if (++done % 20 === 0) console.error(`${done}/${items.length} · $${cost.toFixed(4)}`); } }));
console.log(`jev: ${done - failed} labeled, ${failed} failed, $${cost.toFixed(4)} → ${OUT}`);
