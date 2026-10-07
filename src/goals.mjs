// Goals: the unit a person means by "a piece of work". One goal per ask (or scheduled run, or the agent's own
// opening), with the detours threadify splits out (recoveries, walls, discoveries, plan steps) kept inside it as
// episodes. Outcome and backtracks are read from the steps (src/steps.mjs), and each points at the step that shows it.
// Threads stay as they are; goals are a layer on top, so existing views and the upload contract are unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isShip, isVerification } from './steps.mjs';
import { HOME } from './store.mjs';
import { isCorrection } from './precedent.mjs';

// Jev's independent read of each goal's outcome, from `trail deepen` (opt-in). When it agrees with the steps, the
// call is trusted; when it disagrees, the goal is marked unsure. Keyed by session, root thread and the goal's spans.
export const GOAL_JEV = path.join(HOME, 'goals-jev.json');
export const goalKey = (sessionId, g) => `${sessionId}:${g.root}:${crypto.createHash('sha1').update(JSON.stringify(g.spans)).digest('hex').slice(0, 10)}`;
let JEVG;
const jevGoal = (k) => { if (JEVG === undefined) { try { JEVG = JSON.parse(fs.readFileSync(GOAL_JEV, 'utf8')); } catch { JEVG = null; } } return JEVG?.[k]; };

// How sure each outcome is, from the strength of the evidence behind it. Used to answer or abstain: a caller
// that wants to be right on everything it answers skips calls below its threshold and says "unsure" instead.
const OUTCOME_CONF = { shipped_checked: 0.95, shipped_unchecked: 0.85, verified_change: 0.85, blocked_reported: 0.8, blocked_wall: 0.8, handed_back: 0.75, open: 0.7, answered: 0.6, reported_change: 0.6, abandoned: 0.55, unclear: 0.2 };
// Outcome of the goal, mapped onto the v1 codebook status for scoring against existing labels.
export const OUTCOME_STATUS = { shipped_checked: 'done', shipped_unchecked: 'done', verified_change: 'done', reported_change: 'done', answered: 'done', handed_back: 'parked', blocked_reported: 'parked', blocked_wall: 'dropped', abandoned: 'dropped', open: 'open', unclear: 'unclear' };

/** @param {{ev:any[]}} s session · @param {{threads:any[]}} r threadify result · @param {any[]} st steps(s, lang) */
export function buildGoals(s, r, st, { sessionId } = {}) {
  const byId = new Map(r.threads.map((t) => [t.id, t]));
  const rootOf = (t, seen = new Set()) => {
    if (seen.has(t.id)) return t; seen.add(t.id);
    const up = (t.home && byId.get(t.home)) || (t.origin === 'plan' && t.parent && byId.get(t.parent));
    return up ? rootOf(up, seen) : t;
  };
  const goals = new Map();
  for (const t of r.threads) {
    const root = rootOf(t); let g = goals.get(root.id);
    if (!g) goals.set(root.id, (g = { id: 'G' + (goals.size + 1), root: root.id, title: root.title, origin: root.origin, threads: [], episodes: [], own: new Set() }));
    g.threads.push(t.id);
    if (t !== root) g.episodes.push({ kind: t.kind || t.origin, title: t.title, thread: t.id });
    for (const [a, b] of t.spans || []) for (let i = a; i <= b; i++) g.own.add(i);
  }
  const lastEvent = s.ev.length - 1; const list = [...goals.values()];
  for (const g of list) {
    const idx = [...g.own].sort((a, b) => a - b); g.spans = [];
    for (const i of idx) { const last = g.spans[g.spans.length - 1]; if (last && last[1] === i - 1) last[1] = i; else g.spans.push([i, i]); }
    const first = idx[0] ?? 0, last = idx[idx.length - 1] ?? 0;
    // Steps inside the goal: tool and message steps it owns, plus reasoning placed before one of its events.
    const mine = st.filter((x) => g.own.has(x.at) || (x.kind === 'think' && x.at >= first && x.at <= last + 1 && g.own.has(Math.min(x.at, last))));
    g.outcome = outcome(mine, last === lastEvent);
    // Observable, whatever the output said: did any test/typecheck/lint/build run after the last change?
    const tl = mine.filter((x) => x.kind === 'tool'); const lastChange = Math.max(-1, ...tl.filter((x) => x.action === 'edit' && x.code).map((x) => x.at));
    if (lastChange >= 0) g.checkedAfterChange = tl.some((x) => ['test', 'typecheck', 'lint', 'build'].includes(x.action) && x.result !== 'fail' && x.result !== 'denied' && x.at > lastChange);
    g.status = OUTCOME_STATUS[g.outcome.kind];
    g.backtracks = backtracks(mine);
    // Confidence per call. Outcome: its evidence kind, raised when Jev tagged the deciding message with confidence.
    const decider = mine.find((x) => x.at === g.outcome.at && x.kind === 'say');
    const talk = mine.filter((x) => x.kind === 'say' || x.kind === 'think').length;
    g.conf = {
      outcome: +Math.min(0.98, OUTCOME_CONF[g.outcome.kind] + (decider?.by === 'jev' && decider.tag === decider.rule ? 0.1 : 0)).toFixed(2), // replaced below when Jev has read the goal
      boundary: g.episodes.length === 0 ? 0.9 : g.episodes.every((e) => e.kind === 'recovery' || e.kind === 'wall') ? 0.85 : 0.7,
      backtracks: g.backtracks.length ? Math.max(...g.backtracks.map((b) => (b.seen === 'both' ? 0.9 : b.seen === 'jev' ? 0.75 : 0.6))) : talk >= 3 ? 0.7 : 0.5,
    };
    // Two independent reads: the steps and Jev. Agreement is the strongest signal we have that a call is right
    // (lab, vs Codex labels: agree 79-82% right; agree with Jev >= 0.8 sure, 92-100% on ~13% of goals).
    const j = sessionId && jevGoal(goalKey(sessionId, g));
    if (j) { g.jev = { status: j[0], conf: j[1] }; g.agree = j[0] === g.status; g.conf.outcome = g.agree ? (j[1] >= 0.8 ? 0.97 : 0.85) : 0.35; g.verified = g.agree && j[1] >= 0.8; }
    delete g.own;
  }
  return list;
}

function outcome(mine, endsSession) {
  const tools = mine.filter((x) => x.kind === 'tool');
  const lastChangeAt = Math.max(-1, ...tools.filter((x) => ['edit', 'commit'].includes(x.action)).map((x) => x.at));
  const ship = [...tools].reverse().find(isShip);
  const verifiedAfter = tools.find((x) => isVerification(x) && x.at > lastChangeAt && lastChangeAt >= 0);
  const verifiedBeforeShip = ship && tools.some((x) => isVerification(x) && x.at < ship.at && x.at > lastChangeAt - 1);
  const words = mine.filter((x) => x.kind === 'say'); const final = words[words.length - 1];
  const tail = tools.slice(-4); const lastTool = tools[tools.length - 1];
  const endsOnTool = lastTool && (!final || lastTool.at > final.at);
  if (ship) return { kind: verifiedBeforeShip ? 'shipped_checked' : 'shipped_unchecked', at: ship.at };
  if (final?.tag === 'handback') return { kind: 'handed_back', at: final.at };
  const blocked = final?.tag === 'blocked' || (tail.length >= 2 && tail.every((x) => x.result === 'denied' || x.result === 'fail'));
  // A block the agent reports back is waiting on the person (parked); one it goes silent on is dropped.
  if (blocked) return { kind: final && !endsOnTool ? 'blocked_reported' : tail.some((x) => x.result === 'denied') ? 'blocked_wall' : 'abandoned', at: (final && !endsOnTool ? final : lastTool).at };
  if (endsSession && endsOnTool) return { kind: 'open', at: lastTool.at };
  // Closing with a substantial report is how agents finish: an answer if nothing changed, a reported change otherwise.
  if (final && !endsOnTool && (final.text || '').length > 160) return { kind: lastChangeAt < 0 ? 'answered' : verifiedAfter ? 'verified_change' : 'reported_change', at: final.at };
  if (verifiedAfter) return { kind: 'verified_change', at: verifiedAfter.at };
  if (lastChangeAt < 0 && final && (final.text || '').length > 160) return { kind: 'answered', at: final.at };
  if (final && ['claim_done', 'verification'].includes(final.tag)) return { kind: lastChangeAt >= 0 ? 'verified_change' : 'answered', at: final.at };
  return { kind: endsSession ? 'open' : 'unclear', at: (final || lastTool)?.at ?? null };
}

// A backtrack is a course change in the agent's words or reasoning. Its trigger is what came just before it.
// Rules and Jev see different ones (Jev is more precise, the rules catch more), so either counts; `seen` records which.
// A person correcting the work ("no, use X instead") or refusing a call is a change of course too, triggered by them.
function backtracks(mine) {
  const out = []; let asked = false;
  mine.forEach((x, k) => {
    if (x.kind === 'ask') {
      const opener = !asked; asked = true;
      if (opener || x.who !== 'human') return;
      const prev = mine.slice(0, k).reverse().find((b) => b.kind !== 'say' && b.kind !== 'think');
      if (!isCorrection(x.text) && !(prev?.kind === 'tool' && prev.rejected)) return;
      if (out.length && x.at - out[out.length - 1].at <= 2 && out[out.length - 1].trigger === 'person') return;
      out.push({ at: x.at, trigger: 'person', by: 'ask', seen: 'rule' }); return;
    }
    if (x.tag !== 'course_change' && x.rule !== 'course_change') return;
    const before = mine.slice(Math.max(0, k - 4), k);
    const trigger = before.some((b) => b.kind === 'tool' && b.rejected) ? 'person'
      : before.some((b) => b.kind === 'tool' && b.result === 'fail') ? 'error' : before.some((b) => b.kind === 'tool' && b.result === 'denied') ? 'denied'
      : before.some((b) => b.kind === 'ask') ? 'person' : x.kind === 'think' ? 'reasoning' : 'evidence';
    if (out.length && x.at - out[out.length - 1].at <= 2) return; // one change of course, not every sentence about it
    out.push({ at: x.at, trigger, by: x.kind, seen: x.tag === x.rule ? 'both' : x.tag === 'course_change' ? x.by : 'rule' });
  });
  return out;
}
