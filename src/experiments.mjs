// `trail experiments`: every edit to an instruction file is a natural experiment.
// For each change to AGENTS.md / CLAUDE.md in a repo (and each fix trail adopted), compare that repo's sessions
// in the weeks before and after, in the same permission mode, with bootstrap 95% confidence intervals.
// It reports "no detectable change" when the interval spans zero, and "confounded" when the mode mix moved.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadSessions, loadAdoptions } from './store.mjs';

const WINDOW = 21 * 864e5; const MIN_N = 5; const RESAMPLES = 2000;
const METRICS = {
  wall_share: { label: 'calls lost to failures and denials', better: 'down', f: (s) => (s.tools ? (s.errs || 0) / s.tools : null) },
  outcome_rate: { label: 'threads reaching an outcome', better: 'up', f: (s) => (s.threads.length ? s.threads.filter((t) => t.status === 'outcome').length / s.threads.length : null) },
  steer_rate: { label: 'your messages that steered or corrected', better: 'down', f: (s) => { const a = (s.steers?.human || 0) + (s.steers?.cont || 0); return a ? s.steers.human / a : null; } },
  backtracks: { label: 'backtracks per thread', better: 'down', f: (s) => (s.threads.length ? s.threads.reduce((x, t) => x + t.backs.length, 0) / s.threads.length : null) },
};

// Deterministic PRNG so the same history always gives the same interval.
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
export function bootstrapDiff(before, after, seed = 7) {
  const r = rng(seed); const diffs = [];
  for (let i = 0; i < RESAMPLES; i++) {
    const b = before.map(() => before[Math.floor(r() * before.length)]); const a = after.map(() => after[Math.floor(r() * after.length)]);
    diffs.push(mean(a) - mean(b));
  }
  diffs.sort((x, y) => x - y);
  return { diff: mean(after) - mean(before), lo: diffs[Math.floor(RESAMPLES * 0.025)], hi: diffs[Math.floor(RESAMPLES * 0.975)] };
}

function edits() {
  const byRepo = new Map(); for (const s of loadSessions()) if (s.cwd) (byRepo.get(s.cwd) || byRepo.set(s.cwd, []).get(s.cwd)).push(s);
  const out = [];
  for (const [cwd, ss] of byRepo) {
    if (ss.length < 2 * MIN_N || !fs.existsSync(path.join(cwd, '.git'))) continue;
    let log = '';
    try { log = execFileSync('git', ['-C', cwd, 'log', '--format=%H|%cI|%s', '-n', '40', '--', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'orgx/AGENTS.md', 'orgx/CLAUDE.md'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString(); } catch { continue; }
    for (const l of log.split('\n').filter(Boolean)) { const [sha, at, subject] = l.split('|'); out.push({ cwd, repo: path.basename(cwd), at, what: subject, ref: sha.slice(0, 9), kind: 'instruction edit', sessions: ss }); }
  }
  for (const a of loadAdoptions()) { const cwd = /\/\.(claude|codex)\//.test(a.target) ? null : path.dirname(a.target); out.push({ cwd, repo: cwd ? path.basename(cwd) : 'all repos', at: a.at, what: `trail fix: ${a.id}`, ref: a.id, kind: 'trail adoption', sessions: null }); }
  return out;
}

function grouped(list) {
  const out = []; const byRepo = new Map();
  for (const e of list.sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const key = e.cwd || 'global'; const g = byRepo.get(key);
    if (g && Date.parse(e.at) - Date.parse(g.at_last) < 3 * 864e5) { g.what.push(e.what); g.ref += `,${e.ref}`; g.at_last = e.at; continue; }
    const ng = { ...e, what: [e.what], at_last: e.at }; byRepo.set(key, ng); out.push(ng);
  }
  return out.map((g) => ({ ...g, what: g.what.length > 1 ? `${g.what.length} edits together: ${g.what.join(' · ')}` : g.what[0] }));
}

export function experiments() {
  const all = loadSessions(); const rows = [];
  for (const e of grouped(edits())) {
    const t = Date.parse(e.at); const pool = (e.sessions || all.filter((s) => !e.cwd || s.cwd === e.cwd)).filter((s) => s.start);
    const before = pool.filter((s) => { const x = Date.parse(s.start); return x < t && x >= t - WINDOW; });
    const after = pool.filter((s) => { const x = Date.parse(s.start); return x >= t && x < t + WINDOW; });
    const key = (s) => `${s.client}/${s.mode || 'unknown'}`;
    const top = (arr) => { const c = {}; for (const s of arr) c[key(s)] = (c[key(s)] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]; };
    const mode = top(before); const B = before.filter((s) => key(s) === mode); const A = after.filter((s) => key(s) === mode);
    const row = { ...e, sessions: undefined, mode, n_before: B.length, n_after: A.length, confounded: after.length > 0 && top(after) !== mode && A.length < after.length / 2, metrics: {} };
    if (B.length >= MIN_N && A.length >= MIN_N) {
      for (const [k, m] of Object.entries(METRICS)) {
        const b = B.map(m.f).filter((x) => x != null), a = A.map(m.f).filter((x) => x != null);
        if (b.length < MIN_N || a.length < MIN_N) continue;
        const r = bootstrapDiff(b, a); const detectable = r.lo > 0 || r.hi < 0;
        row.metrics[k] = { ...r, before: mean(b), after: mean(a), detectable, improved: detectable && ((m.better === 'down') === (r.diff < 0)) };
      }
    }
    rows.push(row);
  }
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
export { METRICS };
