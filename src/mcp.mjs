// `trail mcp`: trail as tools any MCP client (Claude Code, Codex, Cursor) can call.
// Read-only by design: an agent can learn from your history, but only a person adopts a fix.
//   claude mcp add trail -- npx -y @useorgx/trail mcp
import readline from 'node:readline';
import { loadSessions, loadAdoptions } from './store.mjs';
import { corpus } from './metrics.mjs';
import { actionFor, effectText, wallId } from './actions.mjs';
import { matchWall, PREDICATES } from './guard.mjs';
import { wallById } from './walls.mjs';
import { VERSION } from './store.mjs';

const TOOLS = [
  { name: 'trail_check', description: 'Before running a command or tool, check whether it matches a wall your agents have hit before in don\'t-ask/unattended runs, and get the rule that avoids it.',
    inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'Tool name, e.g. Bash, Read, WebFetch' }, command: { type: 'string', description: 'Shell command, for Bash' }, file_path: { type: 'string' } }, required: ['tool'] } },
  { name: 'trail_walls', description: 'The failures your coding agents keep rediscovering across sessions, most frequent first, each with a fix you can apply.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, project: { type: 'string', description: 'Only walls seen in this repo folder name' } } } },
  { name: 'trail_threads', description: 'Search past threads of agent work (what was attempted, how it ended) across Claude Code and Codex sessions.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string', enum: ['outcome', 'abandoned', 'open', 'outcome?'] }, limit: { type: 'number' } } } },
  { name: 'trail_summary', description: 'Headline numbers for this machine\'s agent work: sessions, threads, outcome rate, calls lost to known walls.',
    inputSchema: { type: 'object', properties: {} } },
];

let cache = null;
const data = () => { if (!cache) { const sessions = loadSessions(); cache = { sessions, K: corpus(sessions, loadAdoptions()) }; } return cache; };

function call(name, a = {}) {
  if (name === 'trail_check') {
    const id = matchWall(a.tool, { command: a.command, file_path: a.file_path });
    if (!id) return { known_wall: false, note: 'No known wall matches this call.' };
    const w = data().K.walls.find((x) => x.sig === id); const named = wallById(id);
    return { known_wall: true, wall: id, name: named?.name, sessions: w?.sessions ?? 0, applies_in: 'dontAsk (unattended) runs', rule: w ? actionFor(w).rule : named?.rule };
  }
  if (name === 'trail_walls') {
    return data().K.walls.filter((w) => !a.project || w.projects?.[a.project]).slice(0, a.limit || 10)
      .map((w) => ({ id: wallId(w.sig), name: w.name, sessions: w.sessions, calls: w.calls, last_seen: w.last, fix: actionFor(w).rule, adopted: w.adopted ? effectText(w.adopted).text : null }));
  }
  if (name === 'trail_threads') {
    const q = (a.query || '').toLowerCase(); const out = [];
    for (const s of [...data().sessions].reverse()) for (const t of s.threads) {
      if (a.status && t.status !== a.status) continue;
      if (q && !(`${t.title} ${t.ask || ''} ${s.project}`.toLowerCase().includes(q))) continue;
      out.push({ when: s.start, client: s.client, project: s.project, title: t.title, status: t.status, origin: t.kind || t.origin, backtracks: t.backs.length, claims: t.claim });
      if (out.length >= (a.limit || 20)) return out;
    }
    return out;
  }
  if (name === 'trail_summary') { const T = data().K.tot; return { sessions: T.sessions, threads: T.threads, outcome_rate: +(T.outcome / T.threads).toFixed(3), dropped_rate: +(T.abandoned / T.threads).toFixed(3), calls_relearning_known_walls: T.rediscoveryCalls, checked_after_change: +(T.verified / Math.max(T.changed, 1)).toFixed(3) }; }
  throw new Error(`Unknown tool ${name}`);
}

export async function serveMcp() {
  const rl = readline.createInterface({ input: process.stdin });
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  for await (const line of rl) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue; // notifications
    try {
      if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'orgx-trail', version: VERSION } } });
      else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
      else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(call(m.params.name, m.params.arguments), null, 1) }] } });
      else if (m.method === 'ping') send({ jsonrpc: '2.0', id: m.id, result: {} });
      else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    } catch (e) { send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } }); }
  }
}
export { PREDICATES };
