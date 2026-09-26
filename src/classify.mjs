// Tier 0: turn a normalized event stream into threads, with no model.
// Everything here is deterministic and runs in microseconds per session.
import os from 'node:os';
import { WALLS, signature } from './walls.mjs';

export const HARNESS = /^(Base directory for this skill|Approach this as|Skill \/|The previous response failed|<(command-|local-command|task-notification|system-reminder|environment_context|recommended_p|codex_internal|user_instructions|in-app-brows|permissions instructions)|Caveat:|\[Request interrupted|# AGENTS\.md)/;
export const CONTINUE = /^\s*(continue|go on|keep going|go|proceed|yes|yep|ok(ay)?|do it|go ahead|try again|continue from where you left off\.?|resume)[.!]?\s*$/i;
// A discovery needs a problem, not just the word "found": "found the file" is reading; "found a leak" is a discovery.
const PROBLEM = String.raw`(bug|issue|problem|leak|leaking|regression|incident|race|vulnerabilit\w*|security hole|mismatch|contradiction|inconsisten\w*|drift|outage|corrupt\w*|broken)`;
export const SURPRISE_SAY = new RegExp(String.raw`\b(found|discovered|uncovered|spotted|noticed|caught)\b[^.!?\n]{0,60}\b${PROBLEM}\b|\broot cause\b|\bturns out\b[^.!?\n]{0,80}\b(broken|wrong|missing|never|not)\b|\b(is|was|are|were) (silently )?broken\b|\b(production|prod) (incident|regression|bug)\b|\bthis is a (real )?(bug|regression|incident|leak)\b`, 'i');
const PLAN_SAY = /^(now|next|then|first|finally)[, ]+(let me|i('| wi)ll|i'm going to)\b|^let me now\b/i;
const BACK_SAY = /\b(instead|fall ?back|falling back|switch(ing)? to|different approach|didn'?t work|doesn'?t work|revert(ing|ed)?|rolling back|abandon(ing)?|work ?around|route around)\b/i;
const ABANDON_SAY = /\b(BLOCKED|blocked (by|on)|unable to|can(no|')t (access|read|run|write|proceed|reach|verify)|not (possible|available|accessible)|giving up|no way to|skipping (this|it))\b/i;
// Feature regexes shared with the trainer (scripts/train.py) — keep identical.
export const F_AB = /\b(BLOCKED|blocked|unable to|can(no|')t|not (possible|available|accessible)|giving up|denied|skip)/gi;
export const F_SU = /\b(found|discovered|turns out|unexpected|root cause|real (issue|problem)|bug|incident|regression|broken|leak|storm|wedged|stuck)\b/gi;
export const F_DONE = /\b(merged|deployed|published|shipped|pushed|done|complete|landed|posted|created PR|opened PR)\b/gi;
// Tool slips: the agent misusing its own tools. Real, but not discoveries.
const SLIP_TOOL = /^(Edit|MultiEdit|Write|Read|computer|navigate|find|ToolSearch|Skill)$/;
const SLIP_TEXT = /String to replace|has not been read|No site is open|File does not exist|not found in file|InputValidationError|must be unique|Script error: (SyntaxError|ReferenceError|TypeError)|apply_patch verification failed|invalid patch/i;

export function lane(tool, target) {
  const t = target || '';
  if (/^(Read|Grep|Glob|WebFetch|WebSearch|ToolSearch|Skill|LS)$/.test(tool)) return 'probe';
  if (/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/.test(tool)) return 'change';
  if (/^(Agent|Task|Workflow|SendMessage|spawn_agent)$/.test(tool)) return 'delegate';
  if (/Browser|playwright|screenshot/i.test(tool)) return 'check';
  if (/execute_sql/.test(tool)) return /^\s*(select|with|explain)\b/i.test(t) ? 'probe' : 'change';
  if (tool === 'Artifact' || /\bgit (commit|push)|gh pr (create|merge)|\bdeploy\b|vercel --prod|npm publish/.test(t)) return 'ship';
  if (/\b(tsc|typecheck|vitest|jest|pytest|playwright test|pnpm (test|check|lint)|npm (test|run (test|lint|check))|cargo test|go test|node --test)\b/.test(t)) return 'check';
  if (/^\s*(cat|sed -n|grep|rg|ls|head|tail|find|wc|git (log|show|diff|status|blame)|gh pr (view|diff|list|checks))\b/.test(t)) return 'probe';
  return 'run';
}
export const LANE_CODE = { probe: 'p', run: 'r', change: 'c', check: 'h', ship: 's', delegate: 'd' };

const USER = os.userInfo().username;
export function subject(target) {
  const t = target || '';
  const p = t.match(/(?:^|\s)(\/[^\s'"`]+|[\w.-]+\/[\w./-]+\.\w+)/);
  if (p) {
    const segs = p[1].split('/').filter((s) => s && s !== USER && !/^(Users|home|private|tmp|src|lib|app|components|Code|scratchpad|node_modules|claude-\d+)$/.test(s) && !/^[0-9a-f-]{20,}$/.test(s));
    return segs.slice(-2, -1)[0] || segs.slice(-1)[0] || 'files';
  }
  const w = t.trim().split(/\s+/);
  if (/^(git|gh|pnpm|npm|npx|docker|psql|supabase|vercel|curl)$/.test(w[0])) return w[0] + (w[1] && !w[1].startsWith('-') ? ' ' + w[1] : '');
  return w[0] ? w[0].slice(0, 16) : '—';
}

export function firstSentence(s, n = 72) {
  const x = String(s).replace(/<\/?[\w-]+(\s[^>]*)?>/g, ' ').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim().replace(/^(ok|okay|so|hey|please|can you|could you|i want to|let'?s|we need to|now)[, ]+/i, '');
  const cut = x.split(/(?<=[.!?])\s|\n/)[0] || x;
  return cut.length > n ? cut.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : cut;
}

/** The sentence that carries the discovery, not whatever sentence came first. */
function discoverySentence(text) {
  const parts = String(text).replace(/<\/?[\w-]+(\s[^>]*)?>/g, ' ').split(/(?<=[.!?:])\s+|\n+/);
  const hit = parts.find((p) => SURPRISE_SAY.test(p) && p.trim().length > 12) || parts[0] || text;
  return firstSentence(hit.replace(/^[-*\s]+/, ''));
}
function classifyError(e) {
  const x = e.errText || '';
  if (/ENOSPC|No space/i.test(x)) return 'a full disk';
  if (/Cannot find module|MODULE_NOT_FOUND/.test(x)) return 'missing modules';
  if (/error TS\d+|Type error/.test(x)) return 'type errors';
  if (/heap out of memory/i.test(x)) return 'an out-of-memory build';
  if (/EADDRINUSE/.test(x)) return 'a port conflict';
  if (/fail(ed|ing)? (test|spec)|FAIL /i.test(x)) return 'failing tests';
  return `${e.tool} failures in ${subject(e.target)}`;
}

/** @param {{ev: any[]}} s normalized session */
export function threadify(s) {
  const T = []; let cur = null; let parent = null; let tools = 0; let deniedWall = false;
  const steers = { human: 0, cont: 0, hook: 0, schedule: 0 };
  const recentErrs = []; const walls = new Map();
  const open = (origin, title, i) => { cur = { id: 'T' + (T.length + 1), origin, title, at: i, moves: [], backs: [], errs: 0, subj: new Map(), claim: [], notes: [], t0: s.ev[i]?.ts, t1: s.ev[i]?.ts }; T.push(cur); return cur; };
  const own = new Array(s.ev.length);
  for (let i = 0; i < s.ev.length; i++) {
    if (i > 0) own[i - 1] = cur;
    const e = s.ev[i];
    if (cur && e.ts) cur.t1 = e.ts;
    if (e.k === 'ask') {
      if (e.who === 'human') { if (T.length) CONTINUE.test(e.text) ? steers.cont++ : steers.human++; } else steers[e.who] = (steers[e.who] || 0) + 1;
      if (CONTINUE.test(e.text) && cur) continue;
      parent = open(e.who === 'schedule' ? 'schedule' : 'ask', firstSentence(e.text), i);
      cur.ask = e.text.replace(/\s+/g, ' ').slice(0, 300);
      continue;
    }
    if (e.k === 'say') {
      if (!cur) parent = open('agent', firstSentence(e.text), i);
      cur.notes.push(e.text.replace(/\s+/g, ' ').slice(0, 200));
      if (SURPRISE_SAY.test(e.text) && cur.moves.length > 2 && cur.kind !== 'found') { const home = cur.kind === 'recovery' ? cur.resume || cur : cur; cur = open('surprise', discoverySentence(e.text), i); cur.resume = home; cur.kind = 'found'; }
      else if (PLAN_SAY.test(e.text) && cur.moves.length > 6 && cur.origin !== 'surprise') { const t = open('plan', firstSentence(e.text.replace(PLAN_SAY, '').trim() || e.text), i); t.parent = parent?.id; }
      if (ABANDON_SAY.test(e.text)) cur.blocked = true;
      if (BACK_SAY.test(e.text) && recentErrs.length) { cur.backs.push({ i, why: firstSentence(errLine(recentErrs.at(-1)), 90), what: firstSentence(e.text, 90) }); recentErrs.length = 0; }
      continue;
    }
    if (e.k !== 'tool') continue;
    tools++;
    if (!cur) parent = open('agent', 'Untitled work', i);
    e.lane = lane(e.tool, e.target);
    const sj = subject(e.target); cur.subj.set(sj, (cur.subj.get(sj) || 0) + 1);
    cur.moves.push(e.err ? (e.denied ? 'D' : 'X') : LANE_CODE[e.lane]);
    if (e.err) {
      e.slip = SLIP_TOOL.test(e.tool) || SLIP_TEXT.test(e.errText);
      cur.errs++; recentErrs.push(e); if (recentErrs.length > 4) recentErrs.shift();
      const named = WALLS.find((w) => w.detect(e));
      const sig = named ? named.id : e.slip ? null : signature(e);
      if (sig) { const w = walls.get(sig) || { sig, named: !!named, tool: e.tool, n: 0, sample: errLine(e).slice(0, 200), target: e.target.slice(0, 120) }; w.n++; walls.set(sig, w); }
    } else if (recentErrs.length && e.lane === recentErrs.at(-1).lane && e.tool === recentErrs.at(-1).tool && e.target !== recentErrs.at(-1).target && i - s.ev.indexOf(recentErrs.at(-1)) < 5) {
      cur.backs.push({ i, why: firstSentence(errLine(recentErrs.at(-1)), 90), what: `retried as a different ${e.tool} call` }); recentErrs.length = 0;
    } else if (recentErrs.length && i - s.ev.indexOf(recentErrs.at(-1)) > 8) recentErrs.length = 0;
    if (e.lane === 'ship') {
      const pr = (e.target + ' ' + (e.out || '')).match(/#(\d{2,6})|pull\/(\d+)/); const cm = e.target.match(/commit[^"']*-m\s+["']([^"'\n]{4,80})/);
      cur.claim.push(pr ? 'PR #' + (pr[1] || pr[2]) : cm ? `commit “${cm[1]}”` : e.tool === 'Artifact' ? 'published an artifact' : firstSentence(e.target, 40));
    }
    if (e.denied && !deniedWall && cur.origin !== 'surprise') {
      deniedWall = true; const home = cur; home.moves.pop();
      cur = open('surprise', `Work around ${e.tool} calls denied by permissions`, i); cur.resume = home; cur.kind = 'wall'; cur.moves.push('D');
    } else if (recentErrs.filter((x) => !x.denied && !x.slip).length >= 2 && cur.origin !== 'surprise') {
      const home = cur; cur = open('surprise', `Recover from ${classifyError(recentErrs.at(-1))}`, i); cur.resume = home; cur.kind = 'recovery'; recentErrs.length = 0;
    }
    // A wall hands control back on the first call that works; that call belongs to the original task.
    if (cur.kind === 'wall' && !e.err && cur.resume) { cur.resume.moves.push(cur.moves.pop()); cur.routed = true; cur = cur.resume; }
    // A recovery hands back once it ships (the ship serves the original ask) or once a check passes after its fix.
    else if (cur.origin === 'surprise' && cur.resume && !e.err && cur.moves.length >= 2) {
      if (e.lane === 'ship') { cur.resume.moves.push(cur.moves.pop()); const cl = cur.claim.pop(); if (cl) cur.resume.claim.push(cl); cur.status = 'outcome'; cur = cur.resume; }
      else if (e.lane === 'check' && /[cr]/.test(cur.moves.join('').slice(0, -1))) { cur.recovered = true; cur = cur.resume; }
    }
  }
  if (s.ev.length) own[s.ev.length - 1] = cur;
  // Event spans each thread owns: the evidence a reviewer (human or model) reads.
  for (let i = 0; i < own.length; i++) { const t = own[i]; if (!t) continue; const sp = (t.spans ||= []); const last = sp[sp.length - 1]; if (last && last[1] === i - 1) last[1] = i; else sp.push([i, i]); }
  const threads = T.filter((t) => t.moves.length || t.origin === 'ask' || t.origin === 'schedule');
  const lastT = cur; threads.forEach((t, k) => finish(t, t === lastT, threads.length));
  const errs = s.ev.filter((e) => e.err).length, denied = s.ev.filter((e) => e.denied).length;
  return { threads, walls: [...walls.values()], steers, tools, errs, denied, compactions: s.ev.filter((e) => e.k === 'compact').length };
}

function errLine(e) { return String(e.errText || '').replace(/^[\s"{[]+/, '').replace(/\\n/g, ' ').replace(/\s+/g, ' '); }

function finish(t, isLast, n) {
  const m = t.moves.join('');
  t.status = t.routed || t.recovered ? 'outcome'
    : t.blocked && !/s/.test(m) ? 'abandoned'
    : /s/.test(m) ? 'outcome'
    : /c[^XD]*$/.test(m) && /h/.test(m) ? 'outcome'
    : /[XD]{2,}$/.test(m.slice(-6)) || (m.length && (m.match(/[XD]/g) || []).length / m.length > 0.5) ? 'abandoned'
    : isLast ? 'open' : 'outcome?';
  t.moves = m;
  t.subj = [...t.subj.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
  t.claim = [...new Set(t.claim)].slice(0, 3);
  t.notes = t.notes.length > 4 ? [...t.notes.slice(0, 2), ...t.notes.slice(-2)] : t.notes;
  t.feat = features(t, isLast, n);
  delete t.resume; delete t.routed; delete t.recovered;
}

/** Feature vector for the decision model. Order is part of the model contract. */
export function features(t, isLast, n) {
  const m = t.moves; const L = Math.max(m.length, 1);
  const notes = t.notes.join(' '); const last = t.notes.slice(-2).join(' ');
  const cnt = (re, x) => (x.match(re) || []).length;
  return [m.length, ...'prchsdXD'.split('').map((ch) => m.split(ch).length - 1).map((c) => +(c / L).toFixed(4)),
    (m.slice(-8).match(/[XD]/g) || []).length, t.backs.length, t.errs, +(t.origin === 'schedule'), +isLast, n, +(t.claim.length > 0),
    cnt(F_AB, last), cnt(F_AB, notes), cnt(F_SU, notes), cnt(F_DONE, last), +(t.status === 'abandoned'), +(t.status === 'outcome')];
}
export const FEATURE_NAMES = ['moves', 'p', 'r', 'c', 'h', 's', 'd', 'X', 'D', 'tail_fail', 'backs', 'errs', 'scheduled', 'is_last', 'n_threads', 'has_claim', 'ab_last', 'ab_all', 'su_all', 'done_last', 'rule_abandoned', 'rule_outcome'];
