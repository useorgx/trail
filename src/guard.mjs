// Prevention: stop a known wall before the agent walks into it again.
//
// `trail guard install` registers a Claude Code PreToolUse hook. The hook only acts in `dontAsk` sessions
// (scheduled / unattended runs), where these calls are refused anyway: it denies the call up front with the
// rule attached, so the agent adapts immediately instead of burning a failed call and rediscovering the wall.
// It never answers "allow" (that would bypass your permissions) and does nothing in any other mode.
// Every stop is logged to ~/.orgx/trail/prevented.jsonl, which is where "trail stopped N" comes from.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME } from './store.mjs';

export const GUARD_FILE = path.join(HOME, 'guard.json');
export const PREVENTED = path.join(HOME, 'prevented.jsonl');
const MIN_SESSIONS = 3; // only guard walls with real evidence behind them

/** Which known wall an intended call would hit. Same predicates as the walls themselves, applied before the call. */
export const PREDICATES = [
  ['denied-home', (t, i) => (/^(Read|Write|Edit|MultiEdit|NotebookEdit)$/.test(t) && /\/\.claude\//.test(i.file_path || i.notebook_path || '')) || (t === 'Bash' && /(~|\$HOME|\/Users\/[^/]+)\/\.claude\//.test(i.command || ''))],
  ['denied-gh-api', (t, i) => t === 'Bash' && /\bgh (api|issue|run)\b/.test(i.command || '')],
  ['denied-chain', (t, i) => t === 'Bash' && /&&|\|\||;|\bfor\b|\bwhile\b/.test(i.command || '')],
  ['denied-web', (t) => /^(WebFetch|WebSearch)$/.test(t)],
  ['denied-mcp', (t) => /^mcp__/.test(t)],
];
export function matchWall(tool, input) { for (const [id, f] of PREDICATES) { try { if (f(tool, input || {})) return id; } catch {} } return null; }

/** Written at the end of each scan: the walls with enough evidence to guard, and their rules. */
export function buildGuard(walls) {
  const out = { version: 1, built: new Date().toISOString(), walls: {} };
  for (const w of walls) if (PREDICATES.some(([id]) => id === w.sig) && w.sessions >= MIN_SESSIONS) out.walls[w.sig] = { name: w.name, sessions: w.sessions, rule: w.rule };
  fs.writeFileSync(GUARD_FILE, JSON.stringify(out, null, 1));
  return out;
}

/** The hook itself. Reads Claude Code's PreToolUse JSON on stdin; prints a decision or nothing. Never throws. */
export async function runHook(stdinText) {
  try {
    const ev = JSON.parse(stdinText || '{}');
    if (ev.permission_mode !== 'dontAsk') return null;
    const id = matchWall(ev.tool_name, ev.tool_input);
    if (!id) return null;
    const g = JSON.parse(fs.readFileSync(GUARD_FILE, 'utf8'));
    const w = g.walls[id]; if (!w) return null;
    fs.appendFileSync(PREVENTED, JSON.stringify({ at: new Date().toISOString(), wall: id, tool: ev.tool_name, cwd: ev.cwd, session: ev.session_id }) + '\n');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `orgx trail: this is a known wall — "${w.name}" (refused in ${w.sessions} earlier sessions in this mode). ${w.rule}` } };
  } catch { return null; }
}

export function preventedCount(since) {
  try { return fs.readFileSync(PREVENTED, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => !since || x.at >= since).length; } catch { return 0; }
}

// ── install / uninstall into Claude Code settings (backed up, marked, reversible) ──
const MARK = 'orgx trail guard';
export const settingsPath = () => process.env.TRAIL_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const readSettings = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`Could not read ${p}: ${e.message}`); } };
const isOurs = (h) => h?.statusMessage === MARK;

export function guardStatus() {
  const s = readSettings(settingsPath());
  const installed = (s.hooks?.PreToolUse || []).some((m) => (m.hooks || []).some(isOurs));
  let walls = 0; try { walls = Object.keys(JSON.parse(fs.readFileSync(GUARD_FILE, 'utf8')).walls).length; } catch {}
  return { installed, settings: settingsPath(), walls, prevented: preventedCount() };
}

export function installGuard(binPath) {
  const p = settingsPath(); const s = readSettings(p);
  if (fs.existsSync(p)) { fs.mkdirSync(path.join(HOME, 'backup'), { recursive: true }); fs.copyFileSync(p, path.join(HOME, 'backup', `claude-settings.${Date.now()}.json`)); }
  s.hooks ||= {}; s.hooks.PreToolUse = (s.hooks.PreToolUse || []).map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) })).filter((m) => m.hooks.length);
  s.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: `"${process.execPath}" "${binPath}" guard hook`, timeout: 5, statusMessage: MARK }] });
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  return p;
}

export function uninstallGuard() {
  const p = settingsPath(); const s = readSettings(p);
  if (!s.hooks?.PreToolUse) return false;
  const before = JSON.stringify(s.hooks.PreToolUse);
  s.hooks.PreToolUse = s.hooks.PreToolUse.map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) })).filter((m) => m.hooks.length);
  if (!s.hooks.PreToolUse.length) delete s.hooks.PreToolUse;
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  return before !== JSON.stringify(s.hooks.PreToolUse || []);
}
