// GitHub Copilot (VS Code), Gemini CLI and Factory Droid, read into the same event stream as the other clients.
// Formats follow SpecStory's documented, tested providers (github.com/specstoryai/getspecstory, Apache-2.0):
// COPILOTIDE-FORMAT.md and the geminicli / droidcli parsers. Copilot is also checked against real sessions on this
// machine; Gemini CLI and Droid are covered by fixtures built from those schemas until real sessions are available.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS } from './classify.mjs';

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const iso = (x) => { if (x == null) return null; const d = new Date(typeof x === 'number' ? x : String(x)); return isNaN(d) ? null : d.toISOString(); };
const clip = (s, n) => String(s ?? '').slice(0, n);
const argTarget = (a = {}) => clip(a.command ?? a.filePath ?? a.file_path ?? a.absolute_path ?? a.path ?? a.target_file ?? a.pattern ?? a.query ?? a.url ?? a.dir_path ?? '', 240);
const say = (ev, ts, x) => { x = String(x || '').trim(); if (x.length > 25) ev.push({ k: 'say', ts, text: x.slice(0, 400), ...(x.length > 400 ? { full: x.slice(0, 6000) } : {}) }); };
const ask = (ev, ts, x) => { x = String(x || '').trim(); if (x && !HARNESS.test(x)) ev.push({ k: 'ask', ts, text: x.slice(0, 600), who: 'human' }); };

// ---- GitHub Copilot in VS Code ------------------------------------------------------------------------------
const VSCODE_DIRS = ['Code', 'Code - Insiders', 'VSCodium'];
const userDir = (name) => (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', name, 'User')
  : process.platform === 'win32' ? path.join(process.env.APPDATA || '', name, 'User') : path.join(os.homedir(), '.config', name, 'User'));

export function discoverCopilot(since) {
  const out = [];
  for (const name of VSCODE_DIRS) {
    const ws = path.join(userDir(name), 'workspaceStorage'); let dirs = []; try { dirs = fs.readdirSync(ws); } catch { continue; }
    const places = dirs.map((d) => path.join(ws, d, 'chatSessions')).concat(path.join(userDir(name), 'globalStorage', 'emptyWindowChatSessions'));
    for (const dir of places) {
      let files = []; try { files = fs.readdirSync(dir); } catch { continue; }
      const ids = new Set(files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)));
      for (const f of files) {
        if (!(f.endsWith('.jsonl') || (f.endsWith('.json') && !ids.has(f.slice(0, -5))))) continue; // .jsonl wins over .json
        const p = path.join(dir, f); const st = fs.statSync(p); if (!since || st.mtime >= since) out.push({ file: p, client: 'copilot', size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  return out;
}
/** Replay a .jsonl session: kind 0 = snapshot, 1 = replace at key path, 2 = append to the array at key path. */
function replay(file) {
  if (file.endsWith('.json')) return readJSON(file);
  let st = null;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.kind === 0) { st = r.v; continue; } if (!st) return null;
    const k = r.k || []; let o = st; for (const p of k.slice(0, -1)) { o = o?.[p]; if (o == null) break; } if (o == null) continue;
    const last = k[k.length - 1];
    if (r.kind === 1) o[last] = r.v;
    else if (r.kind === 2) { if (!Array.isArray(o[last])) o[last] = []; if (r.i != null) o[last].length = Number(r.i); o[last].push(...(Array.isArray(r.v) ? r.v : [r.v])); }
  }
  return st;
}
const COPILOT_TOOL = { read_file: 'Read', apply_patch: 'apply_patch', insert_edit_into_file: 'Edit', create_file: 'Write', grep_search: 'Grep', file_search: 'Glob', semantic_search: 'Grep', list_dir: 'Glob', run_in_terminal: 'Bash', manage_todo_list: 'TodoWrite', fetch_webpage: 'WebFetch' };
export async function readCopilot(file) {
  const s = replay(file) || {}; const ev = []; const reasoning = [];
  const ws = path.join(path.dirname(path.dirname(file)), 'workspace.json'); const folder = readJSON(ws)?.folder;
  let model = null;
  for (const q of s.requests || []) {
    const ts = iso(q.timestamp); model = q.modelId || model;
    ask(ev, ts, q.message?.text);
    // Same toolCallId appears once per state change: keep the first position, the last data.
    const tools = new Map(); const order = []; let text = '';
    const flush = () => { say(ev, ts, text); text = ''; };
    for (const p of q.response || []) {
      if (!p || typeof p !== 'object') continue;
      if (!p.kind && typeof p.value === 'string') { if (p.value.trim() !== '```') text += p.value; continue; }
      if (p.kind === 'thinking') { const t = typeof p.value === 'string' ? p.value : Array.isArray(p.value) ? p.value.join('') : ''; if (t.trim()) reasoning.push({ i: ev.length, ts, text: t.slice(0, 6000) }); continue; }
      if (p.kind === 'toolInvocationSerialized') { if (!tools.has(p.toolCallId)) { flush(); order.push(p.toolCallId); ev.push({ placeholder: p.toolCallId }); } tools.set(p.toolCallId, p); continue; }
      if (p.kind === 'textEditGroup') { flush(); const f = p.uri?.path || p.uri?.fsPath || ''; ev.push({ k: 'tool', ts, client: 'copilot', tool: 'Edit', rawTool: 'textEditGroup', target: clip(f, 240), err: false, denied: false, errText: '' }); }
    }
    flush();
    // Tool names/arguments come positionally from result.metadata.toolCallRounds (IDs don't match across the two).
    const calls = (q.result?.metadata?.toolCallRounds || []).flatMap((r) => r.toolCalls || []);
    order.forEach((id, n) => {
      const inv = tools.get(id); const call = calls[n]; const raw = call?.name || inv.toolId || 'unknown';
      let args = {}; try { args = JSON.parse(call?.arguments || inv.resultDetails?.input || '{}'); } catch {}
      const details = inv.resultDetails; const failed = details?.isError === true || inv.isConfirmed === false;
      const e = { k: 'tool', ts, client: 'copilot', tool: COPILOT_TOOL[raw] || (raw.startsWith('mcp_') ? raw : raw), rawTool: raw, target: argTarget(args), err: failed, denied: inv.isConfirmed === false, errText: failed ? clip(JSON.stringify(details?.output ?? details ?? ''), 400) : '' };
      const at = ev.findIndex((x) => x.placeholder === id); if (at >= 0) ev[at] = e;
    });
  }
  const events = ev.filter((e) => !e.placeholder);
  return { client: 'copilot', id: 'copilot-' + (s.sessionId || path.basename(file).replace(/\.jsonl?$/, '')), start: iso(s.creationDate) || events[0]?.ts || null, end: iso(s.lastMessageDate) || events.at(-1)?.ts || null, cwd: folder?.startsWith('file://') ? decodeURIComponent(folder.slice(7)) : null, model, mode: null, ev: events, reasoning };
}

// ---- Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.json -----------------------------------------------
const GEMINI_TMP = () => path.join(process.env.TRAIL_GEMINI_HOME || path.join(os.homedir(), '.gemini'), 'tmp');
export function discoverGemini(since) {
  const out = []; let dirs = []; try { dirs = fs.readdirSync(GEMINI_TMP()); } catch { return out; }
  for (const d of dirs) {
    const chats = path.join(GEMINI_TMP(), d, 'chats'); let files = []; try { files = fs.readdirSync(chats); } catch { continue; }
    for (const f of files) if (f.startsWith('session-') && f.endsWith('.json')) { const p = path.join(chats, f); const st = fs.statSync(p); if (!since || st.mtime >= since) out.push({ file: p, client: 'gemini', size: st.size, mtimeMs: st.mtimeMs }); }
  }
  return out;
}
const GEMINI_TOOL = { run_shell_command: 'Bash', read_file: 'Read', read_many_files: 'Read', write_file: 'Write', replace: 'Edit', edit: 'Edit', search_file_content: 'Grep', glob: 'Glob', list_directory: 'Glob', web_fetch: 'WebFetch', google_web_search: 'WebSearch' };
const geminiText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('') : '');
export async function readGemini(file) {
  const s = readJSON(file) || {}; const ev = []; const reasoning = []; let model = null; const usageEvents = [];
  const root = (() => { try { return fs.readFileSync(path.join(path.dirname(path.dirname(file)), '.project_root'), 'utf8').trim(); } catch { return null; } })();
  for (const m of s.messages || []) {
    const ts = iso(m.timestamp);
    if (m.type === 'user') { ask(ev, ts, geminiText(m.content)); continue; }
    if (m.type !== 'gemini') continue; model = m.model || model;
    for (const t of m.thoughts || []) { const x = [t.subject, t.description].filter(Boolean).join(': '); if (x) reasoning.push({ i: ev.length, ts, text: x.slice(0, 6000) }); }
    say(ev, ts, geminiText(m.content));
    for (const c of m.toolCalls || []) {
      const resp = JSON.stringify((c.result || []).map((r) => r.functionResponse?.response ?? r) ?? '');
      const err = c.status === 'error' || /"error"/.test(resp.slice(0, 200)); const denied = c.status === 'cancelled';
      const e = { k: 'tool', ts: iso(c.timestamp) || ts, client: 'gemini', tool: GEMINI_TOOL[c.name] || c.name, rawTool: c.name, target: argTarget(c.args), err: err || denied, denied, errText: err || denied ? clip(resp, 400) : '' };
      if (!e.err && e.tool === 'Bash') e.outTail = resp.slice(-400);
      ev.push(e);
    }
    if (m.tokens) usageEvents.push({ i: ev.length - 1, ts, model: m.model, input: m.tokens.input | 0, cached: m.tokens.cached | 0, output: (m.tokens.output | 0) + (m.tokens.thoughts | 0) });
  }
  const usage = usageEvents.length ? usageEvents.reduce((a, u) => ({ input: a.input + u.input, cached: a.cached + u.cached, output: a.output + u.output }), { input: 0, cached: 0, output: 0 }) : null;
  return { client: 'gemini', id: 'gemini-' + (s.sessionId || path.basename(file, '.json')), start: iso(s.startTime) || ev[0]?.ts || null, end: iso(s.lastUpdated) || ev.at(-1)?.ts || null, cwd: root, model, mode: null, ev, reasoning, usage, usageEvents };
}

// ---- Factory Droid: ~/.factory/sessions/**/<id>.jsonl -------------------------------------------------------
const FACTORY = () => path.join(process.env.TRAIL_FACTORY_HOME || path.join(os.homedir(), '.factory'), 'sessions');
export function discoverDroid(since) {
  const out = [];
  const walk = (dir) => { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) { const st = fs.statSync(p); if (!since || st.mtime >= since) out.push({ file: p, client: 'droid', size: st.size, mtimeMs: st.mtimeMs }); } } };
  walk(FACTORY()); return out;
}
const DROID_TOOL = { Execute: 'Bash', Read: 'Read', Edit: 'Edit', MultiEdit: 'Edit', Create: 'Write', Grep: 'Grep', Glob: 'Glob', LS: 'Glob', WebSearch: 'WebSearch', FetchUrl: 'WebFetch', TodoWrite: 'TodoWrite' };
export async function readDroid(file) {
  const ev = []; const reasoning = []; const pend = new Map(); let start = null, end = null, cwd = null, model = null, id = path.basename(file, '.jsonl');
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue; let d; try { d = JSON.parse(l); } catch { continue; }
    if (d.type === 'session_start') { id = d.id || d.session?.id || id; cwd = d.cwd || d.workspace_root || d.session?.cwd || d.session?.workspace_root || null; start ??= iso(d.created_at || d.session?.created_at); continue; }
    if (d.type !== 'message') continue;
    const ts = iso(d.timestamp); if (ts) { start ??= ts; end = ts; }
    const m = d.message || {}; model = m.model || model;
    for (const c of m.content || []) {
      if (m.role === 'user' && c.type === 'text') ask(ev, ts, c.text);
      else if (m.role === 'user' && c.type === 'tool_result') { const e = pend.get(c.tool_use_id); if (!e) continue; const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? ''); if (c.is_error) { e.err = true; e.errText = txt.slice(0, 400); e.denied = /denied|rejected|not allowed/i.test(txt); } else if (e.tool === 'Bash') e.outTail = txt.slice(-400); }
      else if (m.role === 'assistant' && c.type === 'text') say(ev, ts, c.text);
      else if (m.role === 'assistant' && c.type === 'thinking' && c.thinking) reasoning.push({ i: ev.length, ts, text: String(c.thinking).slice(0, 6000) });
      else if (m.role === 'assistant' && c.type === 'tool_use') { let input = c.input; if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } } const e = { k: 'tool', ts, client: 'droid', tool: DROID_TOOL[c.name] || c.name, rawTool: c.name, target: argTarget(input || {}), err: false, denied: false, errText: '' }; pend.set(c.id, e); ev.push(e); }
    }
  }
  return { client: 'droid', id: 'droid-' + id, start, end, cwd, model, mode: null, ev, reasoning };
}
