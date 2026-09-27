// The one sentence a first run ends on. It has to be about how *you* work: a permission wall only matters to someone
// who runs agents unattended, so the headline follows the dominant permission mode and falls back to what every
// mode has (work called done without a check, changes of course, relearned failures).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wallById } from './walls.mjs';
import { claudeRetention } from './privacy.mjs';

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

/** @returns {{kind:string, text:string, n:number}|null} */
export function headline(sessions) {
  if (!sessions.length) return null;
  const modes = {}; for (const s of sessions) if (s.mode) modes[s.mode] = (modes[s.mode] || 0) + 1;
  const unattended = ((modes.dontAsk || 0) + (modes.bypassPermissions || 0)) / Math.max(1, sessions.length);
  // Named walls, counted only in sessions that ran in a mode where that wall can happen.
  const wallSessions = new Map();
  for (const s of sessions) { if (!['dontAsk', 'bypassPermissions'].includes(s.mode) && s.client !== 'codex') continue; for (const w of s.walls || []) if (w.named && w.sig !== 'denied-other') wallSessions.set(w.sig, (wallSessions.get(w.sig) || 0) + 1); }
  const [topSig, topN] = [...wallSessions.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (topSig && topN >= 5 && unattended >= 0.2) return { kind: 'wall', n: topN, text: `Your agents hit the same failure, “${wallById(topSig)?.name || topSig}”, in ${topN} separate sessions. Each session started from zero.` };
  const goals = sessions.flatMap((s) => s.goals || []);
  // Only what the transcript shows: work that edited code files, then ended with no test/typecheck/lint/build after the edit.
  const changed = goals.filter((g) => g.checkedAfterChange != null && g.status === 'done');
  const unchecked = changed.filter((g) => !g.checkedAfterChange);
  if (changed.length >= 10 && unchecked.length / changed.length >= 0.3) return { kind: 'unchecked', n: unchecked.length, text: `In ${unchecked.length} of ${changed.length} finished pieces of work that changed code (${pct(unchecked.length, changed.length)}%), no test, typecheck, lint or build ran after the last code change.` };
  const backs = goals.reduce((a, g) => a + (g.backtracks?.length || 0), 0); const withBacks = goals.filter((g) => g.backtracks?.length).length;
  if (withBacks >= 10) return { kind: 'backtracks', n: backs, text: `Your agents changed course ${backs} times across ${withBacks} pieces of work; \`trail goals\` shows where and why.` };
  if (topSig && topN >= 3) return { kind: 'wall', n: topN, text: `Your agents hit the same failure, “${wallById(topSig)?.name || topSig}”, in ${topN} separate sessions.` };
  return null;
}

/** Claude Code sessions whose transcripts its cleanup will delete within `days` (trail keeps their outlines). */
export function expiringSoon(sessions, days = 7) {
  const keep = claudeRetention(); if (!keep) return 0;
  const cutoff = Date.now() - (keep - days) * 864e5; const root = path.join(os.homedir(), '.claude', 'projects');
  let n = 0; for (const s of sessions) { if (s.client !== 'claude' || !s.file?.startsWith(root)) continue; try { if (fs.statSync(s.file).mtimeMs < cutoff) n++; } catch {} }
  return n;
}
