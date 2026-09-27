// Goals: the unit a person means by "a piece of work". One goal per ask (or scheduled run, or the agent's own
// opening), with the detours threadify splits out (recoveries, walls, discoveries, plan steps) kept inside it as
// episodes. Outcome and backtracks are read from the steps (src/steps.mjs), and each points at the step that shows it.
// Threads stay as they are; goals are a layer on top, so existing views and the upload contract are unchanged.
import { isShip, isVerification } from './steps.mjs';

// Outcome of the goal, mapped onto the v1 codebook status for scoring against existing labels.
export const OUTCOME_STATUS = { shipped_checked: 'done', shipped_unchecked: 'done', verified_change: 'done', reported_change: 'done', answered: 'done', handed_back: 'parked', blocked_reported: 'parked', blocked_wall: 'dropped', abandoned: 'dropped', open: 'open', unclear: 'unclear' };

/** @param {{ev:any[]}} s session · @param {{threads:any[]}} r threadify result · @param {any[]} st steps(s, lang) */
export function buildGoals(s, r, st) {
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
    g.status = OUTCOME_STATUS[g.outcome.kind];
    g.backtracks = backtracks(mine);
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
function backtracks(mine) {
  const out = [];
  mine.forEach((x, k) => {
    if (x.tag !== 'course_change') return;
    const before = mine.slice(Math.max(0, k - 4), k);
    const trigger = before.some((b) => b.kind === 'tool' && (b.result === 'fail' || b.result === 'denied')) ? 'error' : before.some((b) => b.kind === 'ask') ? 'person' : x.kind === 'think' ? 'reasoning' : 'evidence';
    if (out.length && x.at - out[out.length - 1].at <= 2) return; // one change of course, not every sentence about it
    out.push({ at: x.at, trigger, by: x.kind });
  });
  return out;
}
