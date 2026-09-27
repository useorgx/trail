// Per-step classification: what each step of the work was, before anything is grouped into threads or goals.
// Tool steps get deterministic facts (action, result, signals read from their own output). Language steps
// (the person, the agent's messages, its reasoning) get one act tag: rules for the clear cases, and a small local
// model (src/model/steptag.json, trained in lab/steptag) when it exists. No network, microseconds per step.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './store.mjs';

// ---- tool steps: facts ------------------------------------------------------------------------------------
const ACTIONS = [
  ['deploy', (t, x) => /\b(vercel (deploy|--prod)|npm publish|fly deploy|wrangler (deploy|publish)|kubectl apply|terraform apply)\b/.test(x)],
  ['ship', (t, x) => /\bgit push\b|\bgh pr (create|merge)\b/.test(x)],
  ['commit', (t, x) => /\bgit commit\b/.test(x)],
  ['test', (t, x) => /\b(vitest|jest|pytest|playwright test|node --test|cargo test|go test|(npm|pnpm|yarn) (run )?test)\b/.test(x)],
  ['typecheck', (t, x) => /\b(tsc|typecheck|type-check|mypy|pyright)\b/.test(x)],
  ['lint', (t, x) => /\b(eslint|lint|ruff|clippy)\b/.test(x)],
  ['build', (t, x) => /\b(next build|tsup|vite build|cargo build|go build|make\b|(npm|pnpm|yarn) (run )?build)\b/.test(x)],
  ['install', (t, x) => /\b(npm (i|install|ci)|pnpm (i|install|add)|yarn (add|install)|pip install|brew install|uv (add|pip))\b/.test(x)],
  ['edit', (t) => /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/.test(t)],
  ['delegate', (t) => /^(Agent|Task|Workflow|SendMessage|spawn_agent)$/.test(t)],
  ['read', (t, x) => t === 'Read' || /^\s*(cat|sed -n|head|tail|less|bat)\b/.test(x)],
  ['search', (t, x) => /^(Grep|Glob|LS|ToolSearch|WebSearch)$/.test(t) || /^\s*(rg|grep|find|ls|fd|wc)\b/.test(x)],
  ['git_read', (t, x) => /\bgit (log|show|diff|status|blame|branch)\b|\bgh (pr|run|issue) (view|list|diff|checks)\b/.test(x)],
  ['web', (t, x) => /^(WebFetch)$/.test(t) || /Browser|playwright|navigate|screenshot/i.test(t) || /^\s*curl\b/.test(x)],
  ['mcp', (t, x, raw) => /__/.test(raw || '')],
];
const PASS = /\b\d+ (passed|passing)\b|\ball (\d+ )?tests? passed\b|\b0 (errors?|failures?|problems?)\b|found 0 errors|compiled successfully|build (succeeded|completed)|no (lint )?(errors|issues|problems)|✓|✔|\bok\b\s*$/i;
const FAIL = /\b[1-9]\d* (failed|failing|errors?)\b|\bFAIL\b|error TS\d+|✗|✘|build failed|Command failed/;

/** Facts about one tool event. `e` is an adapter event (k === 'tool'). */
export function stepFacts(e) {
  const x = e.target || ''; const action = (ACTIONS.find(([, f]) => f(e.tool, x, e.rawTool)) || ['run'])[0];
  const out = `${e.out || ''} ${e.outTail || ''}`;
  const result = e.denied ? 'denied' : e.err ? 'fail' : FAIL.test(out) ? 'fail' : PASS.test(out) ? 'pass' : 'ok';
  const pr = `${x} ${out}`.match(/pull\/(\d+)|\bPR #(\d+)|#(\d{3,6})\b/);
  return { action, result, ...(pr ? { pr: +(pr[1] || pr[2] || pr[3]) } : {}) };
}
/** A step that proves something: a check that passed, or a ship that went through. */
export const isVerification = (f) => ['test', 'typecheck', 'lint', 'build'].includes(f.action) && f.result === 'pass';
export const isShip = (f) => ['ship', 'deploy'].includes(f.action) && (f.result === 'ok' || f.result === 'pass');

// ---- language steps: act tags -----------------------------------------------------------------------------
export const TAGS = ['plan', 'hypothesis', 'evidence', 'decision', 'course_change', 'verification', 'claim_done', 'handback', 'blocked', 'other'];
// Ordered: the first rule that fires wins. Each rule is a phrase family a person would recognize.
const RULES = [
  ['course_change', /\b(actually|turns out|scratch that|on second thought|i was wrong|my mistake|that'?s not (it|right|the (cause|issue|problem))|wrong (assumption|approach|file)|misread|instead of|rather than|different approach|switch(ing)? to|fall(ing)? ?back|won'?t work|didn'?t work|doesn'?t work|the real (cause|issue|problem)|not the (cause|issue|problem))\b/i],
  ['blocked', /\b(BLOCKED|blocked (by|on)|unable to|can(no|')t (access|read|run|write|proceed|reach|verify)|not (possible|available|accessible)|giving up|no way to|permission (denied|to use))\b/i],
  ['handback', /\b(need(s)? your|waiting (on|for) (you|your)|please (approve|confirm|run|review|check)|let me know|should i\b|do you want|want me to|your call|needs? (your )?approval|over to you|when you'?re ready)\b/i],
  ['verification', /\b(tests? (now )?pass(es|ed)?|all (green|checks pass)|verified|confirm(ed|s) (it|that|the fix)|typecheck (passes|is clean|clean)|build (passes|succeeded|is green)|lint (passes|is clean)|re-?ran .{0,30}(pass|green))\b/i],
  ['claim_done', /^(done|all set|finished|shipped|merged|deployed|published|complete)\b|\b(is|are|has been|have been) (done|merged|deployed|published|shipped|complete)\b|\bPR #?\d+ (is )?(open|opened|merged|up)\b/i],
  ['hypothesis', /\b(likely|probably|maybe|might be|could be|i suspect|suspect(s|ed)? (that|the)|my guess|hypothes\w+|i think (the|this|it'?s) (cause|issue|problem|because)|seems like|appears to be)\b/i],
  ['evidence', /\b(found (that|the|a|an)|the (log|logs|output|error|trace|test|diff|query|response) (shows|says|confirms|indicates)|confirms (that|the)|according to|i see (that|the)|looking at .{0,40}(shows|it'?s))\b/i],
  ['decision', /\b(i'?ll go with|going with|decided|decide to|the fix is|i'?m going to use|we should use|chose|choos(e|ing) (to|the))\b/i],
  ['plan', /^(now|next|then|first|finally|let me|i'?ll|i will|plan:|steps?:)\b|\b(my plan|the plan is|next,? i'?ll)\b/i],
];
function rulesTag(text) { for (const [tag, re] of RULES) if (re.test(text)) return tag; return 'other'; }

// Hashed word and bigram features: the same function trains the model (lab/steptag/train.mjs) and runs it here.
export const DIM = 1 << 13;
function fnv(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function featurize(text, kind) {
  const w = String(text).toLowerCase().replace(/[`*_#>]/g, ' ').match(/[a-z0-9']+|[.!?]/g) || [];
  const f = new Map(); const add = (k) => { const i = fnv(k) % DIM; f.set(i, (f.get(i) || 0) + 1); };
  add('kind:' + kind); add('rule:' + rulesTag(text));
  for (let i = 0; i < Math.min(w.length, 120); i++) { add('w:' + w[i]); if (i + 1 < w.length) add('b:' + w[i] + '_' + w[i + 1]); if (i < 3) add('lead:' + w[i]); }
  return f;
}
let MODEL; // { tags, weights: {tag: {index: weight}}, bias: {tag: b} } or null
function model() {
  if (MODEL === undefined) { try { MODEL = JSON.parse(fs.readFileSync(new URL('./model/steptag.json', import.meta.url), 'utf8')); } catch { MODEL = null; } }
  return MODEL;
}
export function scoreTags(m, f) {
  const z = m.tags.map((t) => { let s = m.bias[t] || 0; const w = m.weights[t]; for (const [i, v] of f) s += (w[i] || 0) * v; return s; });
  const mx = Math.max(...z); const e = z.map((v) => Math.exp(v - mx)); const sum = e.reduce((a, b) => a + b, 0);
  return m.tags.map((t, k) => [t, e[k] / sum]).sort((a, b) => b[1] - a[1]);
}
// Opt-in tier: tags `trail deepen` got from Jev, keyed by text hash (see src/deepen.mjs). Used when present.
let JEV;
function jevTag(text) {
  if (JEV === undefined) { try { JEV = JSON.parse(fs.readFileSync(path.join(HOME, 'steptags-jev.json'), 'utf8')); } catch { JEV = null; } }
  return JEV && JEV[crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16)];
}
/** One act tag for a language step. kind: 'ask' (the person), 'say' (agent message) or 'think' (reasoning). */
export function tagStep(text, kind) {
  if (kind === 'ask') return { tag: 'ask', conf: 1, by: 'rule', rule: 'ask' };
  // `rule` is always kept beside the chosen tag, so goals can combine what the rules and Jev each saw.
  const rule = rulesTag(text);
  const j = jevTag(text); if (j) return { tag: j[0], conf: j[1], by: 'jev', rule };
  const m = model();
  if (m) { const [[tag, conf]] = scoreTags(m, featurize(text, kind)); return { tag, conf: +conf.toFixed(3), by: 'model', rule }; }
  return { tag: rule, conf: rule === 'other' ? 0.5 : 0.7, by: 'rule', rule };
}

/**
 * Every step of a session, in order: tool steps with facts, language steps with tags. Reasoning sits before the
 * event it preceded (`at`); full message text replaces the clipped one when the side file has it.
 */
export function steps(s, lang = { reasoning: [], full: [] }) {
  const full = new Map(lang.full || []); const think = [...(lang.reasoning || [])].sort((a, b) => a.i - b.i); let r = 0; const out = [];
  for (let i = 0; i <= s.ev.length; i++) {
    while (r < think.length && think[r].i <= i) { const t = think[r++]; out.push({ at: t.i, kind: 'think', text: t.text, ...tagStep(t.text, 'think') }); }
    const e = s.ev[i]; if (!e) continue;
    if (e.k === 'tool') out.push({ at: i, kind: 'tool', ...stepFacts(e) });
    else if (e.k === 'say' || e.k === 'ask') { const text = full.get(i) || e.full || e.text; out.push({ at: i, kind: e.k, text, ...tagStep(text, e.k) }); }
  }
  return out;
}
