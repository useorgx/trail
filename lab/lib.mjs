// Shared lab plumbing: where gold data lives, the sealed split, stable keys, frozen evidence.
// Lab data holds your own transcripts and judgments: it stays under ~/.orgx/trail/lab and never enters git.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HOME } from '../src/store.mjs';
import readline from 'node:readline';
import { readClaude, readCodex } from '../src/adapters.mjs';

export const LAB = path.join(HOME, 'lab');
export const L = {
  batches: path.join(LAB, 'batches'), evidence: path.join(LAB, 'evidence'), jury: path.join(LAB, 'jury'),
  gold: path.join(LAB, 'gold.jsonl'), experiments: path.join(LAB, 'experiments.jsonl'), testLog: path.join(LAB, 'test-access.jsonl'),
};
export const ensureLab = () => { for (const d of [L.batches, L.evidence, L.jury]) fs.mkdirSync(d, { recursive: true }); };

// The split is a pure function of the session id and a fixed salt: a session is dev or test forever,
// and every thread of a session lands on the same side (no leakage across threads of one session).
export const SPLIT_SALT = 'trail-lab-v1';
export const TEST_SHARE = 0.35;
export function split(sessionId) {
  const h = crypto.createHash('sha256').update(sessionId + '|' + SPLIT_SALT).digest();
  return h.readUInt32BE(0) / 2 ** 32 < TEST_SHARE ? 'test' : 'dev';
}

/** A thread's identity survives classifier changes: the session plus the first event it owns. */
export const keyOf = (sid, anchor) => `${sid}:${anchor}`;
export const safeName = (k) => k.replace(/[^\w.-]/g, '_');

export async function readSession(file, client) { return client === 'codex' ? readCodex(file) : readClaude(file); }

/**
 * The language trail's reader clips or skips: Claude visible thinking, Codex reasoning summaries, and full assistant
 * messages, each with its time. Used by depth batches so a labeler sees why the agent changed course.
 */
export async function readLanguage(file, client) {
  const out = []; const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of rl) {
    if (l.length > 400000) continue; let d; try { d = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(d.timestamp); if (!ts) continue;
    if (client === 'claude') {
      if (d.type !== 'assistant' || d.isSidechain || !Array.isArray(d.message?.content)) continue;
      for (const b of d.message.content) { if (b.type === 'thinking' && b.thinking) out.push({ ts, k: 'think', text: b.thinking }); else if (b.type === 'text' && b.text) out.push({ ts, k: 'say', text: b.text }); }
    } else {
      const p = d.payload || {};
      if (p.type === 'reasoning') { const t = (p.summary || []).map((x) => x.text || '').join('\n'); if (t) out.push({ ts, k: 'think', text: t }); }
      else if (p.type === 'message' && p.role === 'assistant') { const t = (p.content || []).map((x) => x.text || '').join(' '); if (t) out.push({ ts, k: 'say', text: t }); }
    }
  }
  return out;
}

/**
 * Render the events a thread owns, numbered, with a little lead-in context. Capped, middle elided.
 * With `language` (from readLanguage), reasoning is interleaved by time as [r] lines and agent messages are shown whole.
 */
export function renderEvidence(s, spans, cap = 14000, language = null) {
  const own = new Set(); for (const [a, b] of spans) for (let i = a; i <= b; i++) own.add(i);
  const first = spans[0]?.[0] ?? 0; const last = spans[spans.length - 1]?.[1] ?? first; const lines = [];
  const after = new Set(); for (let i = last + 1, n = 0; i < s.ev.length && n < 3; i++, n++) after.add(i);
  const think = (language || []).filter((x) => x.k === 'think'); let ti = 0; let prevTs = -Infinity;
  const fullSay = (e) => { if (!language) return e.text; const t = Date.parse(e.ts); const m = language.find((x) => x.k === 'say' && Math.abs(x.ts - t) < 2000 && x.text.replace(/\s+/g, ' ').startsWith(e.text.replace(/\s+/g, ' ').slice(0, 60))); return m ? m.text : e.text; };
  for (let i = Math.max(0, first - 3); i < s.ev.length; i++) {
    if (!own.has(i) && i >= first && !after.has(i)) continue;
    const e = s.ev[i]; const mark = own.has(i) ? ' ' : '~';
    const at = Date.parse(e.ts);
    if (own.has(i) && Number.isFinite(at)) { while (ti < think.length && think[ti].ts <= at) { if (think[ti].ts > prevTs) lines.push(`[r] REASONING: ${think[ti].text.replace(/\s+/g, ' ').slice(0, 900)}`); ti++; } prevTs = at; }
    else if (Number.isFinite(at)) { while (ti < think.length && think[ti].ts <= at) ti++; prevTs = at; }
    let line;
    if (e.k === 'ask') line = `[${i}]${mark}PERSON${e.who !== 'human' ? ` (${e.who})` : ''}: ${e.text}`;
    else if (e.k === 'say') line = `[${i}]${mark}AGENT: ${own.has(i) ? fullSay(e) : e.text}`;
    else if (e.k === 'compact') line = `[${i}]${mark}(context compacted)`;
    else line = `[${i}]${mark}TOOL ${e.tool}: ${e.target}${e.err ? `  => ${e.denied ? 'DENIED' : 'FAILED'}: ${String(e.errText).replace(/\s+/g, ' ').slice(0, 220)}` : ''}${e.out ? `  => ${String(e.out).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
    lines.push(line.replace(/\s+/g, ' ').slice(0, language ? 1500 : 700));
  }
  // Say plainly where the thread stops relative to the session, so "still open" vs "moved on" is decidable.
  const remaining = s.ev.length - 1 - last;
  lines.push(remaining <= 0 ? `[end] The session transcript ends at this thread's last event [${last}].` : `[end] This thread's last event is [${last}]. The session continued for ${remaining} more events (other threads; the first ${Math.min(3, remaining)} are shown with ~).`);
  let text = lines.join('\n');
  if (text.length > cap) { const head = text.slice(0, cap * 0.55); const tail = text.slice(-cap * 0.4); text = `${head}\n… [${lines.length} events total; middle omitted] …\n${tail}`; }
  return text;
}

export function gitState() {
  try {
    const cwd = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd }).toString().trim().length > 0;
    return { sha, dirty };
  } catch { return { sha: 'unknown', dirty: true }; }
}

export function readJSONL(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
export const appendJSONL = (p, o) => fs.appendFileSync(p, JSON.stringify(o) + '\n');

/**
 * Latest label per key from one labeler kind; repeats kept apart for self-consistency.
 * Gold means a person: labels written before the labeler field existed were made by Codex (2026-09-27) and are
 * marked `codex`. `labeler: 'any'` returns every label, for queueing the bench only.
 */
export function goldByKey({ labeler = 'human', form = 'v1' } = {}) {
  // Keep the two form generations as separate datasets even though they share one append-only file.
  const all = readJSONL(L.gold).filter((g) => (form === 'v2' ? g.form === 'v2' : g.form !== 'v2') && (labeler === 'any' || (g.labeler || 'codex') === labeler)); const gold = new Map(); const repeats = [];
  for (const g of all) { if (g.repeat) repeats.push(g); else gold.set(g.key, g); }
  return { gold, repeats, all };
}

export function allBatchItems() {
  let files = []; try { files = fs.readdirSync(L.batches).filter((f) => f.endsWith('.json')).sort(); } catch {}
  return files.flatMap((f) => JSON.parse(fs.readFileSync(path.join(L.batches, f), 'utf8')).items.map((it) => ({ ...it, batch: f })));
}

// Codebook vocabulary, and how the CLI's own labels map onto it.
export const ORIGINS = ['asked', 'plan', 'found', 'recovery', 'wall', 'scheduled'];
export const STATUSES = ['done', 'dropped', 'parked', 'open', 'unclear'];
export const BOUNDARIES = ['right', 'too_big', 'too_small', 'not_a_thread'];
export function toCodebook(t) {
  const origin = t.origin === 'surprise' ? ({ wall: 'wall', recovery: 'recovery' }[t.kind] || 'found') : ({ ask: 'asked', plan: 'plan', schedule: 'scheduled', agent: 'plan' }[t.origin] || 'asked');
  const status = { outcome: 'done', abandoned: 'dropped', open: 'open', parked: 'parked', 'outcome?': 'unclear' }[t.status] || 'unclear';
  return { origin, status };
}
