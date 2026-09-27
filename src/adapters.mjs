// Read Claude Code and Codex transcripts into one normalized event stream.
// Streaming and selective: huge tool outputs are sniffed, never fully parsed.
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { HARNESS } from './classify.mjs';

let onBytes = null;
export const setByteListener = (fn) => { onBytes = fn; };

async function* lines(file) {
  const raw = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  if (onBytes) raw.on('data', (b) => onBytes(b.length));
  // Archived transcripts (trail archive) are gzipped; read them the same way.
  const input = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const l of rl) yield l;
}
/** The permission mode a session mostly ran in (the one that decides which walls can happen). */
const topMode = (m) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const safeJSON = (l) => { try { return JSON.parse(l); } catch { return null; } };
const SHIP = /\bgit (commit|push)|gh pr (create|merge)/;
// Checks whose output tail says whether they passed (kept so a step can point at its own evidence).
export const CHECK = /\b(tsc|typecheck|vitest|jest|pytest|playwright test|eslint|lint|pnpm (test|check|build)|npm (test|run \S+)|cargo (test|build|check)|go (test|build|vet)|node --test|next build|tsup|vite build|make)\b/;
const FULL = 6000; // full message length kept for the side file; events keep the 400-char cut so indices and outputs stay stable
const HOOKISH = /^\s*(Stop hook|<ci-monitor|Auto-fix|\[SYSTEM NOTIFICATION)/i;

export async function readClaude(file) {
  const ev = []; const reasoning = []; const pend = new Map(); let start = null, end = null, cwd = null, model = null; const modes = {};
  const usageById = new Map(); // streamed chunks repeat a message's usage: keep one per message id, placed where it first appeared
  for await (const l of lines(file)) {
    if (l.length < 20) continue;
    if (l.length > 60000 && l.includes('"tool_result"')) {
      const id = l.match(/"tool_use_id":"([^"]+)"/)?.[1]; const e = id && pend.get(id);
      if (e && /"is_error":true/.test(l)) { const at = l.indexOf('"content"'); e.err = true; e.errText = l.slice(at + 10, at + 410); e.denied = /Permission to use/.test(e.errText); }
      continue;
    }
    const d = safeJSON(l); if (!d || d.isSidechain) continue;
    const ts = d.timestamp; if (ts) { start ??= ts; end = ts; }
    cwd ??= d.cwd; model ??= d.message?.model;
    const u = d.type === 'assistant' && d.message?.usage;
    if (u && d.message.id) { const prev = usageById.get(d.message.id); usageById.set(d.message.id, { i: prev ? prev.i : ev.length, ts: prev ? prev.ts : ts, model: d.message.model, input: u.input_tokens | 0, cacheWrite: u.cache_creation_input_tokens | 0, cached: u.cache_read_input_tokens | 0, output: u.output_tokens | 0 }); }
    if (d.permissionMode) modes[d.permissionMode] = (modes[d.permissionMode] || 0) + 1;
    let c = d.message?.content; if (typeof c === 'string') c = [{ type: 'text', text: c }];
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (d.type === 'user' && b.type === 'text') {
        const x = (b.text || '').trim(); if (!x || HARNESS.test(x)) continue;
        if (x.startsWith('This session is being continued')) { ev.push({ k: 'compact', ts }); continue; }
        const sched = x.match(/<scheduled-task name="([^"]+)"/);
        ev.push({ k: 'ask', ts, text: sched ? `[scheduled] ${sched[1]}` : x.startsWith('[Image') ? '[screenshot]' : x.slice(0, 600), who: sched ? 'schedule' : HOOKISH.test(x) ? 'hook' : 'human' });
      } else if (d.type === 'user' && b.type === 'tool_result') {
        const e = pend.get(b.tool_use_id); if (!e) continue;
        if (b.is_error) { e.err = true; e.errText = (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 400); e.denied = /Permission to use/.test(e.errText); }
        else if (SHIP.test(e.target)) e.out = (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 300);
        else if (CHECK.test(e.target)) e.outTail = (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(-400);
      } else if (d.type === 'assistant' && b.type === 'thinking' && b.thinking) {
        reasoning.push({ i: ev.length, ts, text: b.thinking.slice(0, FULL) }); // i = the event it precedes
      } else if (d.type === 'assistant' && b.type === 'text' && (b.text || '').length > 25) {
        ev.push({ k: 'say', ts, text: b.text.slice(0, 400), ...(b.text.length > 400 ? { full: b.text.slice(0, FULL) } : {}) });
      } else if (d.type === 'assistant' && b.type === 'tool_use') {
        const i = b.input || {}; const rawTool = b.name; const tool = rawTool.split('__').pop();
        const target = String(i.file_path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.skill ?? i.description ?? i.path ?? i.action ?? '').slice(0, 240);
        const e = { k: 'tool', ts, tool, rawTool, target, err: false, denied: false, errText: '' };
        pend.set(b.id, e); ev.push(e);
      }
    }
  }
  const usageEvents = [...usageById.values()];
  const usage = usageEvents.length ? usageEvents.reduce((a, x) => ({ input: a.input + x.input, cacheWrite: a.cacheWrite + x.cacheWrite, cached: a.cached + x.cached, output: a.output + x.output }), { input: 0, cacheWrite: 0, cached: 0, output: 0 }) : null;
  return { client: 'claude', start, end, cwd, model, mode: topMode(modes), ev, reasoning, usage, usageEvents };
}

// Codex writes two views of the same work. Older rollouts only have raw model items (function_call / *_output),
// where the actual commands sit inside JavaScript `exec` cells. Current rollouts also emit structured
// `item_completed` records: CommandExecution (argv, cwd, exit code, output), McpToolCall (server, tool, status),
// FileChange (paths, status), Reasoning summaries, messages, compactions. Those are read when present.
const shellCmd = (argv) => (Array.isArray(argv) ? (argv.length >= 3 && /(^|\/)(ba|z|)sh$/.test(argv[0]) && /^-l?c$/.test(argv[1]) ? argv.slice(2).join(' ') : argv.join(' ')) : String(argv ?? ''));
const fileUrl = (u) => (typeof u === 'string' ? decodeURIComponent(u.replace(/^file:\/\//, '')) : null);
const textOf = (content) => (Array.isArray(content) ? content.map((c) => c.text || '').join(' ') : String(content ?? '')).trim();
const SANDBOX_DENIED = /sandbox|Operation not permitted|permission denied|not allowed|rejected by (the )?user|approval (was )?(denied|rejected)/i;

function codexItem(it, ts, sink) {
  const { ev, reasoning } = sink;
  switch (it.type) {
    case 'UserMessage': { const x = textOf(it.content); if (x && !HARNESS.test(x) && !x.startsWith('<')) ev.push({ k: 'ask', ts, text: x.slice(0, 600), who: /^Automation:/.test(x) ? 'schedule' : HOOKISH.test(x) ? 'hook' : 'human' }); break; }
    case 'HookPrompt': { const x = (it.fragments || []).map((f) => f.text || '').join(' ').trim(); if (x) ev.push({ k: 'ask', ts, text: x.slice(0, 600), who: 'hook' }); break; }
    case 'AgentMessage': { const x = textOf(it.content); if (x.length > 25) ev.push({ k: 'say', ts, text: x.slice(0, 400), ...(x.length > 400 ? { full: x.slice(0, 6000) } : {}) }); break; }
    case 'Reasoning': { const x = (it.summary_text || []).map((t) => (typeof t === 'string' ? t : t?.text || '')).join('\n').trim(); if (x) reasoning.push({ i: ev.length, ts, text: x.slice(0, 6000) }); break; }
    case 'ContextCompaction': ev.push({ k: 'compact', ts }); break;
    case 'CommandExecution': {
      const target = shellCmd(it.command).slice(0, 240); const out = String(it.aggregated_output || it.stderr || it.stdout || '');
      const code = Number(it.exit_code);
      // Exit 1 from a search or compare means "no match" / "differs", not a failure.
      const benign = code === 1 && /^\s*(rg|grep|egrep|fgrep|ag|diff|cmp|test|\[|git (diff|grep)|pgrep|find)\b/.test(target) && !/error|fatal|exception/i.test(out.slice(0, 400));
      const err = it.status === 'declined' || ((it.status === 'failed' || (Number.isFinite(code) && code !== 0)) && !benign);
      const denied = it.status === 'declined' || (err && SANDBOX_DENIED.test(out));
      const e = { k: 'tool', ts, client: 'codex', tool: 'Bash', rawTool: 'exec_command', target, err, denied, errText: err ? (out.slice(0, 380) + (Number.isFinite(code) ? ` (exit ${code})` : '')).trim() : '', exitCode: Number.isFinite(code) ? code : null };
      if (!err && SHIP.test(target)) e.out = out.slice(0, 300);
      if (CHECK.test(target)) e.outTail = out.slice(-400);
      ev.push(e); sink.cwd ??= fileUrl(it.cwd); break;
    }
    case 'McpToolCall': {
      const res = typeof it.result === 'string' ? it.result : JSON.stringify(it.result ?? '');
      const failed = it.status === 'failed' || /isError['"]?:\s*(True|true)/.test(res);
      ev.push({ k: 'tool', ts, client: 'codex', tool: `mcp__${it.server}__${it.tool}`, rawTool: `mcp__${it.server}__${it.tool}`, target: String(typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? '')).slice(0, 240), err: failed, denied: it.status === 'declined', errText: failed ? res.replace(/^\{['"]content['"]:\s*\[\{['"]type['"]:\s*['"]text['"],\s*['"]text['"]:\s*/, '').slice(0, 400) : '' });
      break;
    }
    case 'FileChange': {
      const failed = it.status && it.status !== 'completed';
      for (const f of Object.keys(it.changes || {}).slice(0, 20)) ev.push({ k: 'tool', ts, client: 'codex', tool: 'apply_patch', rawTool: 'apply_patch', target: f.slice(0, 240), err: failed, denied: failed && SANDBOX_DENIED.test(String(it.stderr || '')), errText: failed ? String(it.stderr || it.stdout || '').slice(0, 400) : '' });
      break;
    }
    case 'ImageView': ev.push({ k: 'tool', ts, client: 'codex', tool: 'Read', rawTool: 'view_image', target: String(fileUrl(it.path) || '').slice(0, 240), err: false, denied: false, errText: '' }); break;
    case 'Extension': ev.push({ k: 'tool', ts, client: 'codex', tool: it.kind || 'extension', rawTool: it.kind || 'extension', target: '', err: it.status === 'failed', denied: false, errText: '' }); break;
  }
}

export async function readCodex(file) {
  const items = { ev: [], reasoning: [], cwd: null }; let usage = null; const usageEvents = []; let interrupts = 0;
  const ev = []; const reasoning = []; const pend = new Map(); let start = null, end = null, cwd = null, model = null; const modes = {};
  for await (const l of lines(file)) {
    const head = l.slice(0, 220);
    if (head.includes('"item_completed"')) { const d = safeJSON(l); const it = d?.payload?.item; if (it) codexItem(it, d.timestamp, items); continue; }
    if (head.includes('"token_count"')) {
      const d = safeJSON(l); const info = d?.payload?.info; const last = info?.last_token_usage;
      if (info?.total_token_usage) usage = info.total_token_usage;
      if (last) usageEvents.push({ i: items.ev.length, ts: d.timestamp, input: last.input_tokens | 0, cached: last.cached_input_tokens | 0, output: last.output_tokens | 0, reasoning: last.reasoning_output_tokens | 0 });
      continue;
    }
    if (head.includes('"turn_aborted"')) { interrupts++; continue; }
    if (head.includes('"turn_context"')) { if (!cwd) cwd = fileUrl(safeJSON(l)?.payload?.cwd) || safeJSON(l)?.payload?.cwd || null; continue; }
    if (/"type":"(world_state|token_usage_record|inter_agent)/.test(head)) continue;
    if (/"type":"reasoning"/.test(l.slice(0, 400))) {
      // Raw reasoning is encrypted; the summary, when present, is the readable part.
      if (l.includes('"summary":[{')) { const d = safeJSON(l); const t = (d?.payload?.summary || []).map((x) => x.text || '').join('\n'); if (t) reasoning.push({ i: ev.length, ts: d.timestamp, text: t.slice(0, FULL) }); }
      continue;
    }
    if (/"thread_settings_applied"/.test(head)) {
      model ??= l.match(/"model":"([^"]+)"/)?.[1];
      // Codex approval policy → the closest Claude Code permission mode, so walls compare like with like.
      const ap = l.match(/"approval_policy":"([^"]+)"/)?.[1];
      if (ap) { const m = { never: 'bypassPermissions', 'on-request': 'default', untrusted: 'default', 'on-failure': 'auto' }[ap] || ap; modes[m] = (modes[m] || 0) + 1; }
      continue;
    }
    if (l.length > 80000 && /_call_output"/.test(l.slice(0, 400))) {
      const id = l.match(/"call_id":"([^"]+)"/)?.[1]; const e = id && pend.get(id);
      if (e) { const tail = l.slice(0, 3000); if (/Script failed|exited with code [1-9]|Exit code:? [1-9]/.test(tail)) { e.err = true; const at = tail.indexOf('output'); e.errText = tail.slice(at, at + 400); } }
      continue;
    }
    const d = safeJSON(l); if (!d) continue;
    const ts = d.timestamp; if (ts) { start ??= ts; end = ts; }
    const p = d.payload || {};
    if (d.type === 'session_meta') { cwd ??= p.cwd; continue; }
    if (p.type === 'message') {
      const x = (p.content || []).map((c) => c.text || '').join(' ').trim();
      if (!x) continue;
      if (p.role === 'user') { if (HARNESS.test(x) || x.startsWith('<')) continue; ev.push({ k: 'ask', ts, text: x.slice(0, 600), who: /^Automation:/.test(x) ? 'schedule' : HOOKISH.test(x) ? 'hook' : 'human' }); }
      else if (p.role === 'assistant' && x.length > 25) ev.push({ k: 'say', ts, text: x.slice(0, 400), ...(x.length > 400 ? { full: x.slice(0, FULL) } : {}) });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      if (/^(sleep|wait|list_agents|request_user_input)/.test(p.name || '')) continue;
      const src = String(p.input ?? p.arguments ?? JSON.stringify(p.action ?? ''));
      const cmds = [...src.matchAll(/cmd\\?"?\s*:\s*\\?"((?:[^"\\]|\\.)*)/g)].map((m) => m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'));
      const patch = [...src.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\s\\]+)/g)].map((m) => m[1]);
      const e = patch.length ? { tool: 'apply_patch', target: patch[0] } : cmds.length ? { tool: 'Bash', target: cmds[0] } : { tool: p.name || 'tool', target: src.slice(0, 160) };
      const ee = { k: 'tool', ts, client: 'codex', rawTool: p.name, err: false, denied: false, errText: '', ...e, target: e.target.slice(0, 240) };
      pend.set(p.call_id, ee); ev.push(ee);
    } else if (/_call_output$/.test(p.type || '')) {
      const e = pend.get(p.call_id); if (!e) continue;
      const o = typeof p.output === 'string' ? p.output : (p.output || []).map((x) => x.text || '').join(' ');
      const head3 = o.slice(0, 3000);
      if (!/^Script failed|exited with code [1-9]|Exit code:? [1-9]|"exit_code":\s*[1-9]/.test(head3) && SHIP.test(e.target)) e.out = head3.slice(0, 300);
      if (CHECK.test(e.target)) e.outTail = o.slice(-400);
      if (/^Script failed|exited with code [1-9]|Exit code:? [1-9]|"exit_code":\s*[1-9]/.test(head3)) {
        e.err = true;
        const m = head3.match(/(Script error:[^\n]*|exited with code \d+[^\n]*|Exit code:? \d+[^\n]*)/);
        const at = head3.indexOf('Output:'); const body = at >= 0 ? head3.slice(at + 7, at + 320) : head3.slice(0, 320);
        e.errText = (m && /Script error:\s*\S/.test(m[1]) ? m[1].replace('Script error:', '').trim() + '\n' : '') + body.trim() + (m && !/Script error/.test(m[1]) ? ` (${m[1].trim()})` : '');
        e.denied = /rejected by (the )?user|approval (was )?(denied|rejected)|sandbox.*denied|Operation not permitted/i.test(o);
      }
    }
  }
  // Structured items when the rollout has them (current Codex), raw items otherwise (older rollouts).
  const useItems = items.ev.length > 0;
  return { client: 'codex', start, end, cwd: cwd || items.cwd, model, mode: topMode(modes), ev: useItems ? items.ev : ev, reasoning: useItems ? items.reasoning : reasoning,
    usage: usage ? { input: usage.input_tokens | 0, cached: usage.cached_input_tokens | 0, output: usage.output_tokens | 0, reasoning: usage.reasoning_output_tokens | 0 } : null, usageEvents: useItems ? usageEvents : [], interrupts, format: useItems ? 'items' : 'raw' };
}
