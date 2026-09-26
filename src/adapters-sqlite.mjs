// OpenCode and Cursor keep sessions in SQLite, not JSONL. Read them read-only into the same event stream as
// adapters.mjs. Ported from @useorgx/wizard's ai-client-sqlite-store (same tables, same read-only rule), keeping
// what trail needs that the wizard drops: the command or path each tool touched, its error text, and denials.
// Needs node:sqlite (Node 22.5+). Without it these clients are skipped, never guessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HARNESS } from './classify.mjs';

let sqlite;
function db(file) {
  if (sqlite === undefined) {
    // node:sqlite prints an ExperimentalWarning on first load; it is noise for a CLI user.
    const emit = process.emitWarning; process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
    try { sqlite = createRequire(import.meta.url)('node:sqlite'); } catch { sqlite = null; } finally { process.emitWarning = emit; }
  }
  if (!sqlite) return null;
  // Scan workers open the same OpenCode database at once; SQLite answers "database is locked" while another
  // reader sets up WAL. Wait for it (busy timeout) and retry briefly instead of dropping the session.
  for (let i = 0; ; i++) {
    try { return new sqlite.DatabaseSync(file, { readOnly: true, timeout: 5000 }); }
    catch (e) { if (i >= 20 || !/locked|busy/i.test(e.message)) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1)); }
  }
}
const obj = (s) => { try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch { return null; } };
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
/** Tool names normalized to the Claude Code names the walls and move alphabet already know. */
const TOOL = { bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', multiedit: 'Edit', patch: 'apply_patch', glob: 'Glob', grep: 'Grep', list: 'Glob', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Task', todowrite: 'TodoWrite',
  run_terminal_cmd: 'Bash', read_file: 'Read', edit_file: 'Edit', search_replace: 'Edit', write_file: 'Write', list_dir: 'Glob', grep_search: 'Grep', codebase_search: 'Grep', file_search: 'Glob', web_search: 'WebSearch' };
const targetOf = (i = {}) => String(i.command ?? i.filePath ?? i.file_path ?? i.target_file ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.description ?? '').slice(0, 240);
// OpenCode's permission refusal, and Cursor's; both phrased as a person rejecting the call.
const DENIED = /rejected permission|permission (was )?denied|user rejected|not allowed to (run|use)/i;

export const OPENCODE_DB = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
export const CURSOR_CHATS = () => path.join(os.homedir(), '.cursor', 'chats');

/** One cache entry per OpenCode session: `<db>#<session id>`, changed when the session's time_updated moves. */
export function discoverOpenCode(since) {
  const file = OPENCODE_DB(); if (!fs.existsSync(file)) return [];
  const d = db(file); if (!d) return [];
  try {
    return d.prepare('SELECT id, time_updated FROM session WHERE time_updated >= ?').all(since ? since.getTime() : 0)
      .map((r) => ({ file: `${file}#${r.id}`, client: 'opencode', size: 0, mtimeMs: Number(r.time_updated) || 0 }));
  } catch { return []; } finally { d.close(); }
}

export function discoverCursor(since) {
  const out = []; const root = CURSOR_CHATS();
  let ws = []; try { ws = fs.readdirSync(root); } catch { return out; }
  for (const w of ws) {
    let chats = []; try { chats = fs.readdirSync(path.join(root, w)); } catch { continue; }
    for (const c of chats) {
      const file = path.join(root, w, c, 'store.db'); let st; try { st = fs.statSync(file); } catch { continue; }
      if (!since || st.mtime >= since) out.push({ file, client: 'cursor', size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

export async function readOpenCode(ref) {
  const [file, id] = ref.split('#'); const d = db(file); const ev = [];
  if (!d) return { client: 'opencode', id, start: null, end: null, cwd: null, model: null, mode: null, ev };
  try {
    const s = d.prepare('SELECT directory, model, time_created, time_updated FROM session WHERE id = ?').get(id) || {};
    const rows = d.prepare(`SELECT m.data AS m, p.data AS p, p.time_created AS t FROM message m JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ? ORDER BY m.time_created, p.time_created, p.id`).all(id);
    for (const r of rows) {
      const m = obj(r.m) || {}; const p = obj(r.p); if (!p) continue; const ts = iso(Number(r.t));
      if (p.type === 'text' && m.role === 'user') { const x = String(p.text || '').trim(); if (x && !p.synthetic && !HARNESS.test(x)) ev.push({ k: 'ask', ts, text: x.slice(0, 600), who: 'human' }); }
      else if (p.type === 'text' && m.role === 'assistant' && String(p.text || '').length > 25) ev.push({ k: 'say', ts, text: p.text.slice(0, 400) });
      else if (p.type === 'compaction') ev.push({ k: 'compact', ts });
      else if (p.type === 'tool') {
        const st = p.state || {}; const raw = String(p.tool || 'tool'); const err = st.status === 'error'; const errText = err ? String(st.error || '').slice(0, 400) : '';
        const e = { k: 'tool', ts: iso(st.time?.start) || ts, client: 'opencode', tool: TOOL[raw] || raw, rawTool: raw, target: targetOf(st.input), err, denied: err && DENIED.test(errText), errText };
        if (!err && e.tool === 'Bash' && /\bgit (commit|push)|gh pr (create|merge)/.test(e.target)) e.out = String(st.output || '').slice(0, 300);
        ev.push(e);
      }
    }
    const model = obj(s.model); const at = ev.map((e) => e.ts).filter(Boolean);
    return { client: 'opencode', id, start: iso(Number(s.time_created)) || at[0] || null, end: iso(Number(s.time_updated)) || at.at(-1) || null, cwd: s.directory || null, model: model?.id || null, mode: null, ev };
  } finally { d.close(); }
}

// Cursor stores messages as content-addressed blobs with no per-message time, so every event carries the
// session's updatedAt. Ordering inside the session is exact (rowid); times are session-level.
export async function readCursor(file) {
  const dir = path.dirname(file); const meta = obj((() => { try { return fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'); } catch { return '{}'; } })()) || {};
  const start = iso(meta.createdAtMs), end = iso(meta.updatedAtMs) || start; const ev = []; const pend = new Map(); let askMode = false;
  const d = db(file); if (!d) return { client: 'cursor', id: path.basename(dir), start, end, cwd: meta.cwd || null, model: null, mode: null, ev };
  try {
    for (const r of d.prepare("SELECT CAST(data AS TEXT) AS data FROM blobs WHERE json_valid(CAST(data AS TEXT)) = 1 ORDER BY rowid").all()) {
      const m = obj(r.data); if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool')) continue;
      const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text' && m.role === 'user') {
          // Cursor wraps the person's words in <user_query>; everything else in a user turn is injected context.
          const raw = String(p.text || ''); if (/Ask mode is active/.test(raw)) askMode = true;
          const x = (raw.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1] ?? (raw.trim().startsWith('<') ? '' : raw)).trim();
          if (x && !HARNESS.test(x)) ev.push({ k: 'ask', ts: end, text: x.slice(0, 600), who: 'human' });
        }
        else if (p.type === 'text' && m.role === 'assistant' && String(p.text || '').length > 25) ev.push({ k: 'say', ts: end, text: p.text.slice(0, 400) });
        else if (p.type === 'tool-call') {
          const raw = String(p.toolName || 'tool'); const e = { k: 'tool', ts: end, client: 'cursor', tool: TOOL[raw] || raw, rawTool: raw, target: targetOf(p.args ?? p.input), err: false, denied: false, errText: '' };
          if (p.toolCallId) pend.set(p.toolCallId, e); ev.push(e);
        } else if (p.type === 'tool-result') {
          const e = pend.get(p.toolCallId); if (!e) continue; const res = p.result;
          const failed = (res && typeof res === 'object' && (res.isError === true || res.success === false || typeof res.error === 'string')) || (typeof res === 'string' && /^(error|failed|exception)\b/i.test(res.trim()));
          if (failed) { e.err = true; e.errText = (typeof res === 'string' ? res : String(res.error ?? JSON.stringify(res))).slice(0, 400); e.denied = DENIED.test(e.errText); }
        }
      }
    }
    // Cursor's Ask mode is read-only, the closest match to Claude Code's plan mode.
    return { client: 'cursor', id: path.basename(dir), start, end, cwd: meta.cwd || null, model: null, mode: askMode ? 'plan' : null, ev };
  } finally { d.close(); }
}
