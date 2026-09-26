// Read Claude Code and Codex transcripts into one normalized event stream.
// Streaming and selective: huge tool outputs are sniffed, never fully parsed.
import fs from 'node:fs';
import readline from 'node:readline';
import { HARNESS } from './classify.mjs';

let onBytes = null;
export const setByteListener = (fn) => { onBytes = fn; };

async function* lines(file) {
  const input = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  if (onBytes) input.on('data', (b) => onBytes(b.length));
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const l of rl) yield l;
}
/** The permission mode a session mostly ran in (the one that decides which walls can happen). */
const topMode = (m) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const safeJSON = (l) => { try { return JSON.parse(l); } catch { return null; } };
const SHIP = /\bgit (commit|push)|gh pr (create|merge)/;
const HOOKISH = /^\s*(Stop hook|<ci-monitor|Auto-fix|\[SYSTEM NOTIFICATION)/i;

export async function readClaude(file) {
  const ev = []; const pend = new Map(); let start = null, end = null, cwd = null, model = null; const modes = {};
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
      } else if (d.type === 'assistant' && b.type === 'text' && (b.text || '').length > 25) {
        ev.push({ k: 'say', ts, text: b.text.slice(0, 400) });
      } else if (d.type === 'assistant' && b.type === 'tool_use') {
        const i = b.input || {}; const rawTool = b.name; const tool = rawTool.split('__').pop();
        const target = String(i.file_path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.skill ?? i.description ?? i.path ?? i.action ?? '').slice(0, 240);
        const e = { k: 'tool', ts, tool, rawTool, target, err: false, denied: false, errText: '' };
        pend.set(b.id, e); ev.push(e);
      }
    }
  }
  return { client: 'claude', start, end, cwd, model, mode: topMode(modes), ev };
}

export async function readCodex(file) {
  const ev = []; const pend = new Map(); let start = null, end = null, cwd = null, model = null; const modes = {};
  for await (const l of lines(file)) {
    const head = l.slice(0, 220);
    if (/"type":"(token_count|world_state|token_usage_record|turn_context|inter_agent)/.test(head) || /"type":"reasoning"/.test(l.slice(0, 400))) continue;
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
      else if (p.role === 'assistant' && x.length > 25) ev.push({ k: 'say', ts, text: x.slice(0, 400) });
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
      if (/^Script failed|exited with code [1-9]|Exit code:? [1-9]|"exit_code":\s*[1-9]/.test(head3)) {
        e.err = true;
        const m = head3.match(/(Script error:[^\n]*|exited with code \d+[^\n]*|Exit code:? \d+[^\n]*)/);
        const at = head3.indexOf('Output:'); const body = at >= 0 ? head3.slice(at + 7, at + 320) : head3.slice(0, 320);
        e.errText = (m && /Script error:\s*\S/.test(m[1]) ? m[1].replace('Script error:', '').trim() + '\n' : '') + body.trim() + (m && !/Script error/.test(m[1]) ? ` (${m[1].trim()})` : '');
        e.denied = /rejected by (the )?user|approval (was )?(denied|rejected)|sandbox.*denied|Operation not permitted/i.test(o);
      }
    }
  }
  return { client: 'codex', start, end, cwd, model, mode: topMode(modes), ev };
}
