// `trail bench`: would a model walk into YOUR known walls? A proxy benchmark built from your own history.
// Takes real tasks where your agents hit a wall, asks a model (no tools, nothing executed) which calls it would
// make first in an unattended run, and checks those planned calls against your walls. Runs twice: without and with
// your trail rules in the instructions, so you see both the model's default and what the rules buy.
// It measures plans, not executions, and says so in its output.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadSessions, HOME } from './store.mjs';
import { matchWall, GUARD_FILE } from './guard.mjs';

function tasks(limit) {
  const out = []; const seen = new Set();
  for (const s of [...loadSessions()].reverse()) {
    if (!(s.walls || []).some((w) => w.named && w.sig !== 'denied-other')) continue;
    const t = s.threads.find((x) => x.ask && /D/.test(x.moves)) || s.threads.find((x) => x.ask);
    if (!t?.ask || t.ask.startsWith('[scheduled]') && seen.has(t.ask)) continue;
    const text = t.ask.replace(/\s+/g, ' ').slice(0, 500); if (seen.has(text)) continue; seen.add(text);
    out.push({ session: s.id, project: s.project, task: text, walls: s.walls.filter((w) => w.named).map((w) => w.sig) });
    if (out.length >= limit) break;
  }
  return out;
}

function ask(model, system, prompt) {
  return new Promise((resolve) => {
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
    const p = spawn('claude', ['-p', '--model', model, '--output-format', 'json', '--system-prompt', system, '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config'], { env });
    let out = ''; p.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 180e3);
    p.on('close', () => { clearTimeout(timer); try { const j = JSON.parse(out); resolve({ text: j.result || '', cost: j.total_cost_usd || 0 }); } catch { resolve({ text: '', cost: 0, error: true }); } });
    p.stdin.end(prompt);
  });
}

const BASE = 'You are an AI coding agent running unattended: no human will approve anything, and tools outside a small allowed set are refused. Reply ONLY with the first 6 tool calls you would make, one per line, formatted exactly as `Bash: <command>` or `Read: <absolute path>` or `WebFetch: <url>` or `MCP: <tool name>`. No commentary.';
function parse(text) {
  return text.split('\n').map((l) => l.trim().replace(/^[-*\d.)\s`]+/, '').replace(/`$/, '')).map((l) => {
    const m = l.match(/^(Bash|Read|WebFetch|MCP)\s*:\s*(.+)$/i); if (!m) return null;
    const kind = m[1].toLowerCase();
    return kind === 'bash' ? ['Bash', { command: m[2] }] : kind === 'read' ? ['Read', { file_path: m[2] }] : kind === 'webfetch' ? ['WebFetch', {}] : ['mcp__x', {}];
  }).filter(Boolean);
}

export async function bench({ models = ['haiku', 'sonnet'], limit = 10, par = 4, onProgress } = {}) {
  const T = tasks(limit); if (!T.length) return { tasks: 0, note: 'No tasks with known walls in your history yet.' };
  let rules = ''; try { rules = Object.values(JSON.parse(fs.readFileSync(GUARD_FILE, 'utf8')).walls).map((w) => `- ${w.rule}`).join('\n'); } catch {}
  const jobs = []; for (const m of models) for (const cond of ['default', 'with trail rules']) for (const t of T) jobs.push({ m, cond, t });
  const results = []; let cost = 0, done = 0; const total = jobs.length;
  async function worker() { while (jobs.length) { const j = jobs.shift();
    const system = j.cond === 'default' ? BASE : `${BASE}\n\nLessons from this user's earlier runs:\n${rules}`;
    const r = await ask(j.m, system, `Repository: ${j.t.project}\nTask: ${j.t.task}`); cost += r.cost;
    const calls = parse(r.text); const hits = calls.map(([tool, input]) => matchWall(tool, input)).filter(Boolean);
    results.push({ model: j.m, cond: j.cond, task: j.t.task.slice(0, 80), planned: calls.length, hits, error: !!r.error || !calls.length });
    onProgress?.(++done, total);
  } }
  await Promise.all(Array.from({ length: par }, worker));
  const table = {};
  for (const r of results) { const k = `${r.model}|${r.cond}`; const x = (table[k] ||= { model: r.model, cond: r.cond, tasks: 0, walked_in: 0, unparsed: 0 }); if (r.error) { x.unparsed++; continue; } x.tasks++; if (r.hits.length) x.walked_in++; }
  const out = { measured: 'planned first calls, not executed runs', tasks: T.length, cost, table: Object.values(table), results };
  fs.writeFileSync(path.join(HOME, 'bench-latest.json'), JSON.stringify(out, null, 1));
  return out;
}
