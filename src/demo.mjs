// `trail --demo`: the whole experience on a made-up history, for people with no agent sessions yet (or a reviewer
// on a clean machine). Writes synthetic session records to a throwaway TRAIL_HOME and opens the explorer there.
// Nothing is read from your machine and nothing is written outside the temp folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const PROJECTS = ['checkout-web', 'billing-api', 'mobile-app', 'infra', 'docs-site'];
const ASKS = ['fix the flaky checkout test', 'add retries to the payment webhook', 'upgrade next to the latest version', 'why is the build failing on main', 'rename the user table column and migrate', 'ship the pricing page copy change', 'nightly dependency audit', 'investigate slow dashboard queries', 'add dark mode to settings', 'write the release notes for v2.4'];
const WALLS = [
  { sig: 'denied-chain', named: true, sample: 'Permission to use Bash with command cd api && pnpm test has been denied.', tool: 'Bash', target: 'cd api && pnpm test' },
  { sig: 'no-module', named: true, sample: "Error: Cannot find module 'vitest'", tool: 'Bash', target: 'pnpm vitest run' },
  { sig: 'denied-gh-api', named: true, sample: 'Permission to use Bash with command gh api repos/o/r/pulls has been denied.', tool: 'Bash', target: 'gh api repos/o/r/pulls' },
  { sig: 'port', named: true, sample: 'Error: listen EADDRINUSE: address already in use :::3000', tool: 'Bash', target: 'pnpm dev' },
];

function session(k) {
  const start = new Date(Date.now() - (30 - k * 0.6) * 864e5 + Math.floor(rnd() * 8) * 36e5);
  const project = pick(PROJECTS); const client = rnd() < 0.6 ? 'claude' : 'codex'; const scheduled = rnd() < 0.2;
  const mode = scheduled ? 'dontAsk' : client === 'codex' ? 'default' : pick(['default', 'acceptEdits', 'auto']);
  const n = 1 + Math.floor(rnd() * 3); const threads = []; const goals = []; const walls = []; let at = 0; let tools = 0, errs = 0, denied = 0;
  for (let i = 0; i < n; i++) {
    const ask = scheduled ? '[scheduled] nightly dependency audit' : pick(ASKS);
    const len = 6 + Math.floor(rnd() * 30); let moves = '';
    for (let m = 0; m < len; m++) moves += pick('pppprrcchh');
    const wallHit = rnd() < (scheduled ? 0.7 : 0.25) ? pick(WALLS) : null;
    if (wallHit) { moves = moves.slice(0, 4) + (wallHit.sig.startsWith('denied') ? 'DD' : 'XX') + moves.slice(4); walls.push({ ...wallHit, n: 2 }); errs += 2; if (wallHit.sig.startsWith('denied')) denied += 2; }
    const shipped = rnd() < 0.45; if (shipped) moves += 's';
    const back = rnd() < 0.4 ? [{ i: at + 5, why: 'tests still failing after the first fix', what: 'switched to fixing the fixture instead of the code' }] : [];
    const t0 = new Date(start.getTime() + i * 25 * 6e4).toISOString(), t1 = new Date(start.getTime() + (i * 25 + len) * 6e4).toISOString();
    const status = shipped ? 'outcome' : pick(['outcome', 'outcome?', 'open', 'abandoned']);
    threads.push({ id: `T${i + 1}`, origin: scheduled ? 'schedule' : 'ask', title: ask, ask, notes: [], moves, backs: back, status, claim: shipped ? [`PR #${1200 + k * 3 + i}`] : [], subj: [project], errs: (moves.match(/[XD]/g) || []).length, t0, t1, spans: [[at, at + len]], p_abandon: status === 'abandoned' ? 0.8 : 0.1 });
    const checked = /h[^c]*s?$/.test(moves); const kind = shipped ? (checked ? 'shipped_checked' : 'shipped_unchecked') : status === 'abandoned' ? 'abandoned' : status === 'open' ? 'open' : checked ? 'verified_change' : 'reported_change';
    const statusOf = { shipped_checked: 'done', shipped_unchecked: 'done', verified_change: 'done', reported_change: 'done', abandoned: 'dropped', open: 'open' }[kind];
    goals.push({ id: `G${i + 1}`, root: `T${i + 1}`, title: ask, origin: scheduled ? 'schedule' : 'ask', threads: [`T${i + 1}`], episodes: wallHit ? [wallHit.sig.startsWith('denied') ? 'wall' : 'recovery'] : [], spans: [[at, at + len]], outcome: { kind, at: at + len }, status: statusOf, backtracks: back.map((b) => ({ at: b.i, trigger: 'error', by: 'say', seen: 'rule' })), conf: { outcome: 0.8, boundary: 0.9, backtracks: 0.7 }, checkedAfterChange: /c/.test(moves) ? checked : undefined });
    at += len + 1; tools += len;
  }
  return { id: `demo-${String(k).padStart(3, '0')}`, client, file: null, project, cwd: `/demo/${project}`, model: client === 'claude' ? 'claude-sonnet-5' : 'gpt-5.6-sol', mode, start: start.toISOString(), end: new Date(start.getTime() + at * 6e4).toISOString(), asks: n, tools, errs, denied, compactions: 0, steers: { human: n, cont: Math.floor(rnd() * 2) }, walls, threads, goals, lang: { reasoning: 0, full: 0 }, tags: {} };
}

/** Write the demo corpus to a temp TRAIL_HOME and run the explorer there. */
export async function demo(binPath) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-demo-')); fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  for (let k = 0; k < 48; k++) { const s = session(k); fs.writeFileSync(path.join(home, 'sessions', s.id + '.json'), JSON.stringify(s)); }
  fs.writeFileSync(path.join(home, 'index.json'), JSON.stringify({ version: 'demo', files: {} }));
  console.log('  Demo: 48 made-up sessions across 5 projects. Nothing on your machine was read. (Exit with q.)');
  await new Promise((res) => { const p = spawn(process.execPath, [binPath, 'explore'], { stdio: 'inherit', env: { ...process.env, TRAIL_HOME: home, TRAIL_DEMO: '1' } }); p.on('close', res); });
  fs.rmSync(home, { recursive: true, force: true });
  console.log('  That was a demo. Run `npx @useorgx/trail` to see your own agents’ work (it stays on your machine).');
}
