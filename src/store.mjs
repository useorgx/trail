// Where trail keeps what it learned. Everything stays under ~/.orgx/trail unless TRAIL_HOME is set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverOpenCode, discoverCursor } from './adapters-sqlite.mjs';

export const VERSION = 'trail-1.0';
export const HOME = process.env.TRAIL_HOME || path.join(os.homedir(), '.orgx', 'trail');
export const P = {
  index: path.join(HOME, 'index.json'),
  sessions: path.join(HOME, 'sessions'),
  adoptions: path.join(HOME, 'adoptions.json'),
  labels: path.join(HOME, 'labels.jsonl'),
  summary: path.join(HOME, 'summary.json'),
  language: path.join(HOME, 'language'),
};
export function ensure() { fs.mkdirSync(P.sessions, { recursive: true }); fs.mkdirSync(P.language, { recursive: true }); }
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
export function loadIndex(rebuild) { const i = rebuild ? null : readJSON(P.index, null); return i && i.version === VERSION ? i : { version: VERSION, files: {} }; }
export function saveIndex(i) { fs.writeFileSync(P.index, JSON.stringify(i)); }
export function writeSession(s) { fs.writeFileSync(path.join(P.sessions, s.id + '.json'), JSON.stringify(s)); }
/**
 * The language the session record leaves out: reasoning (Claude thinking, Codex summaries) and full agent messages.
 * Kept per session beside the record so the explorer never loads it; step tagging and deep views read it on demand.
 * `reasoning[].i` is the event the reasoning precedes; `full` is [eventIndex, text] for messages longer than the cut.
 */
export function writeLanguage(id, lang) { fs.mkdirSync(P.language, { recursive: true }); fs.writeFileSync(path.join(P.language, id + '.json'), JSON.stringify(lang)); }
export const loadLanguage = (id) => readJSON(path.join(P.language, id + '.json'), { reasoning: [], full: [] });
export function loadSessions() {
  let names = []; try { names = fs.readdirSync(P.sessions); } catch { return []; }
  const out = [];
  for (const n of names) { if (!n.endsWith('.json')) continue; const s = readJSON(path.join(P.sessions, n), null); if (s) out.push(s); }
  return out.sort((a, b) => String(a.start).localeCompare(String(b.start)));
}
export const loadAdoptions = () => readJSON(P.adoptions, []);
export const saveAdoptions = (a) => fs.writeFileSync(P.adoptions, JSON.stringify(a, null, 1));
export function loadLabels() { try { return fs.readFileSync(P.labels, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
export const appendLabel = (l) => fs.appendFileSync(P.labels, JSON.stringify(l) + '\n');

/** Find transcripts written by each supported client. */
export function discover({ since, client } = {}) {
  const out = []; const H = os.homedir();
  const walk = (dir, pred, cl) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'subagents' && e.name !== 'tool-results') walk(p, pred, cl); }
      else if (pred(e.name)) { const st = fs.statSync(p); if (!since || st.mtime >= since) out.push({ file: p, client: cl, size: st.size, mtimeMs: st.mtimeMs }); }
    }
  };
  if (!client || client === 'claude') walk(path.join(H, '.claude', 'projects'), (n) => n.endsWith('.jsonl'), 'claude');
  if (!client || client === 'codex') walk(path.join(H, '.codex', 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), 'codex');
  if (!client || client === 'opencode') out.push(...discoverOpenCode(since));
  if (!client || client === 'cursor') out.push(...discoverCursor(since));
  return out;
}
