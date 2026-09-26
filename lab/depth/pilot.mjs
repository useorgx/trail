// Depth pilot: how much does reading the reasoning change what we learn about a thread?
// For N threads that have readable reasoning, a model labels each thread from two views:
//   A = what trail keeps today (moves, errors, backtracks, clipped assistant text)
//   C = A + full assistant text + thinking (Claude) / reasoning summaries (Codex)
// C is labeled twice to measure the labeler's own noise. Trail's rule-based calls are scored against C.
// This is model-vs-model, not human gold: it measures information loss, not truth.
// Usage: node lab/depth/pilot.mjs [n=40] [model=sonnet]
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline'; import { spawn } from 'node:child_process';
import { loadSessions, HOME } from '../../src/store.mjs';

const N = +(process.argv[2] || 40); const MODEL = process.argv[3] || 'sonnet';
const OUT = path.join(HOME, 'depth'); fs.mkdirSync(OUT, { recursive: true });

// Deep reader: every piece of language with its time, nothing clipped. Joined to threads by time window.
async function language(file, client) {
  const out = []; const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of rl) {
    if (l.length > 200000) continue; let d; try { d = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(d.timestamp); if (!ts) continue;
    if (client === 'claude') {
      if (d.type !== 'assistant' || d.isSidechain || !Array.isArray(d.message?.content)) continue;
      for (const b of d.message.content) {
        if (b.type === 'thinking' && b.thinking) out.push({ ts, k: 'think', text: b.thinking });
        else if (b.type === 'text' && b.text) out.push({ ts, k: 'say', text: b.text });
      }
    } else {
      const p = d.payload || {};
      if (p.type === 'reasoning') { const t = (p.summary || []).map((s) => s.text || '').join('\n'); if (t) out.push({ ts, k: 'think', text: t }); }
      else if (p.type === 'message' && p.role === 'assistant') { const t = (p.content || []).map((x) => x.text || '').join(' '); if (t) out.push({ ts, k: 'say', text: t }); }
    }
  }
  return out;
}

function sample() {
  const sessions = loadSessions().filter((s) => (s.client === 'claude' || s.client === 'codex') && s.file && fs.existsSync(s.file)).reverse();
  const picked = { claude: [], codex: [] };
  for (const s of sessions) {
    const bucket = picked[s.client]; if (bucket.length >= N / 2 * 3) continue;
    for (const t of s.threads) if (t.moves.length >= 5 && t.t0 && t.t1) bucket.push({ s, t });
  }
  // Half with a trail-detected backtrack, half without, per client, newest first.
  const out = [];
  for (const c of ['claude', 'codex']) {
    const b = picked[c]; const yes = b.filter((x) => x.t.backs.length), no = b.filter((x) => !x.t.backs.length);
    out.push(...yes.slice(0, N / 4), ...no.slice(0, N / 2 - Math.min(N / 4, yes.length)));
  }
  return out;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + ' …' : s);
function viewA({ s, t }, lang) {
  const kept = lang.filter((x) => x.k === 'say' && x.text.length > 25).map((x) => '- ' + clip(x.text.replace(/\s+/g, ' '), 400));
  return [`Client: ${s.client} · repo: ${s.project} · permission mode: ${s.mode || 'unknown'}`, `Ask: ${clip(t.ask || t.title, 500)}`,
    `Moves (p probe, r run, c change, h check, s ship, d delegate, X failed, D denied): ${t.moves}`, `Failed calls: ${t.errs}`,
    t.backs.length ? `Detected backtracks:\n${t.backs.map((b) => `- after "${b.why}" → ${b.what}`).join('\n')}` : 'Detected backtracks: none',
    `Agent messages (clipped):\n${clip(kept.join('\n'), 6000)}`].join('\n');
}
function viewC(x, lang) {
  let body = ''; for (const l of lang) { const add = `\n[${l.k === 'think' ? 'reasoning' : 'message'}] ${clip(l.text.trim(), 1500)}`; if (body.length + add.length > 16000) { body += '\n[… later reasoning omitted for length]'; break; } body += add; }
  return viewA(x, []).replace(/Agent messages \(clipped\):\n$/, '') + `\nFull agent messages and reasoning, in order:${body}`;
}

const SYSTEM = `You label one thread of work by an AI coding agent. Read the evidence and reply with ONLY a JSON object:
{"backtracks": [{"from": "<approach or belief abandoned>", "to": "<what replaced it>", "trigger": "error" | "evidence" | "reasoning" | "human"}],
 "status": "done" | "dropped" | "parked" | "unclear",
 "insight": "<the single most useful thing a teammate should learn from this thread, specific, one sentence>",
 "confidence": 0.0-1.0}
A backtrack is a real change of approach, hypothesis or plan, not a retry of the same thing. "reasoning" = the agent changed course from its own thinking with no new error or evidence. List none if there were none.`;

function ask(prompt) {
  return new Promise((resolve) => {
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
    const p = spawn('claude', ['-p', '--model', MODEL, '--output-format', 'json', '--system-prompt', SYSTEM, '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config'], { env });
    let out = ''; p.stdout.on('data', (d) => (out += d)); const timer = setTimeout(() => p.kill('SIGKILL'), 240e3);
    p.on('close', () => { clearTimeout(timer); try { const j = JSON.parse(out); const m = (j.result || '').match(/\{[\s\S]*\}/); resolve({ label: m ? JSON.parse(m[0]) : null, cost: j.total_cost_usd || 0 }); } catch { resolve({ label: null, cost: 0 }); } });
    p.stdin.end(prompt);
  });
}

const items = sample(); console.error(`${items.length} threads`);
const jobs = []; const rows = [];
for (const x of items) {
  const all = await language(x.s.file, x.s.client);
  const a = Date.parse(x.t.t0) - 1000, b = Date.parse(x.t.t1) + 1000; const lang = all.filter((l) => l.ts >= a && l.ts <= b);
  const row = { session: x.s.id, client: x.s.client, thread: x.t.id, moves: x.t.moves, trail_backs: x.t.backs.length, trail_status: x.t.status,
    chars_think: lang.filter((l) => l.k === 'think').reduce((n, l) => n + l.text.length, 0), chars_say: lang.filter((l) => l.k === 'say').reduce((n, l) => n + l.text.length, 0),
    A: viewA(x, lang), C: viewC(x, lang), labels: {} };
  rows.push(row); for (const v of ['A', 'C', 'C2']) jobs.push({ row, v });
}
let cost = 0, done = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (jobs.length) { const j = jobs.shift(); const r = await ask(j.v === 'A' ? j.row.A : j.row.C); cost += r.cost; j.row.labels[j.v] = r.label; if (++done % 10 === 0) console.error(`${done} labels · $${cost.toFixed(2)}`); } }));
const file = path.join(OUT, `pilot-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(file, JSON.stringify({ model: MODEL, cost, rows: rows.map(({ A, C, ...r }) => ({ ...r, lenA: A.length, lenC: C.length })) }, null, 1));
console.log(file, `$${cost.toFixed(2)}`);
