// Precedent candidates: the moments a person judged the agent's work — a correction ("no, use X instead"), a tool
// call they rejected, a call a permission rule denied, a standing rule they stated ("always …", "never …").
// Read straight from the session's events with rules, never a model: conservative on purpose, because each signal
// can become a precedent that governs later work. Wire shape: JudgmentSignal (OrgX POST /api/v1/precedents/signals).
// No imports beyond node:crypto, so the classifier can use it without an import cycle.
import crypto from 'node:crypto';

export const SIGNAL_KINDS = ['correction', 'rejection', 'denial', 'override', 'explicit_rule'];
export const PRECEDENT_EXT = 'com.useorgx.precedent/v1';

// A standing rule: said at the start of a message, or "from now on" / "going forward" anywhere in it.
const RULE_LEAD = /^\s*(?:(?:ok(?:ay)?|so|also|and|please|btw|fyi|note|remember|important)[,:!.]?\s+)*(?:always|never|from now on|going forward|in (?:the )?future|as a rule|every time you|whenever you)\b/i;
const RULE_ANY = /\b(?:from now on|going forward|in (?:the )?future,? (?:always|never|don'?t|do not|use)|as a (?:general )?rule)\b/i;
const RULE_WORD = /\b(?:always|never|from now on|going forward)\b/i;
// A correction: the person pushing back on what the agent just did, in the first words of the message.
const CORRECTION_LEAD = /^\s*(?:(?:hey|hmm+|wait|ok(?:ay)?|oh|ugh|um+|err?)[,.!]*\s+)?(?:no\b(?![,.]?\s+(?:worries|problem|rush|need|thanks))|nope\b|nah\b|wrong\b|stop\b|don'?t\b|dont\b|do not\b|actually\b|not that\b|not like that\b|that'?s (?:not|wrong|incorrect)\b|that is (?:not|wrong|incorrect)\b|this is (?:wrong|not what)\b|instead\b|undo\b|revert (?:that|this|it|the)\b|please (?:don'?t|do not|stop|undo|revert)\b|you (?:shouldn'?t|should not|should have|broke|missed|forgot)\b|why did you\b|i (?:said|told you|didn'?t ask|did not ask)\b|use \S.{0,80}\binstead\b)/i;

/** 'explicit_rule' | 'correction' | null for one message from a person. Rules over the words, nothing else. */
export function classifyJudgment(text) {
  const t = String(text || '').trim();
  if (t.length < 2 || t.startsWith('[')) return null;
  const correction = CORRECTION_LEAD.test(t);
  if (RULE_LEAD.test(t) || RULE_ANY.test(t) || (correction && RULE_WORD.test(t))) return 'explicit_rule';
  return correction ? 'correction' : null;
}
/** A short message that steers the work in progress: it folds into the current goal instead of starting a new one. */
export const isCorrection = (text) => String(text || '').length <= 600 && classifyJudgment(text) !== null;

// Claude Code's words when the person rejects a tool call (or interrupts one), and the reason they gave, if any.
export const USER_REJECTED = /The user doesn'?t want to (?:proceed with this tool use|take this action)|\[Request interrupted by user(?: for tool use)?\]|rejected by (?:the )?user|user (?:rejected|declined|denied|skipped|cancell?ed) (?:the |this )?(?:permission|tool|command|call|edit|change|action|request)|(?:tool (?:use|call)|command|edit) was (?:rejected|declined) by (?:the )?user|User chose (?:not to|to skip)/i;
export function rejectionFeedback(text) {
  const m = String(text || '').match(/(?:the user said|with the following feedback):\s*([\s\S]+)/i);
  return m ? m[1].replace(/\s*<\/?(?:user|feedback)[^>]*>\s*/g, ' ').trim() || null : null;
}

/**
 * A tool call the person refused. It counts as a denial (the call did not run because someone said no), and keeps
 * `rejected` plus the person's own words when they gave a reason, so the judgment can become a precedent candidate.
 */
export function markRejected(e, text) {
  e.err = true; e.denied = true; e.rejected = true;
  if (!e.errText) e.errText = String(text || 'Rejected by the user').slice(0, 400);
  const fb = rejectionFeedback(text); if (fb) e.feedback = fb.slice(0, 2000);
}

// Never cut through a surrogate pair.
export const clipText = (s, n) => {
  const x = String(s ?? '').trim();
  if (x.length <= n) return x;
  let cut = x.slice(0, n); if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); return cut;
};
const iso = (t) => { if (!t) return null; const d = new Date(t); return isNaN(d) ? null : d.toISOString(); };
export const signalIdOf = ({ sessionId, kind, observedAt, text }) => 'sig_' + crypto.createHash('sha256').update(`${sessionId ?? ''}|${kind}|${observedAt}|${text}`).digest('hex').slice(0, 32);

const PATHISH = /^(?:\/|~\/|\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.\w{1,8}$|^\/[\w.@-]+(?:\/[\w.@-]+)+$/;
const relTo = (p, cwd) => (cwd && p.startsWith(cwd.replace(/\/$/, '') + '/') ? p.slice(cwd.replace(/\/$/, '').length + 1) : p);

/**
 * Judgment signals in one normalized session. Pure: the caller stores and sends them.
 * @param {{ev:any[], cwd?:string, start?:string, end?:string}} s
 * @param {{sessionId?:string|null, harness:string, repo?:string|null, receiptIdAt?:(i:number)=>string|null}} o
 */
export function extractSignals(s, { sessionId = null, harness, repo = null, receiptIdAt = () => null } = {}) {
  const ev = s.ev || []; const out = []; const used = new Set(); const deniedSeen = new Set();
  const fallbackTs = iso(s.start) || iso(s.end);
  const scope = (i, extra) => {
    const paths = []; const tools = [];
    const add = (arr, v, n) => { if (v && !arr.includes(v) && arr.length < n) arr.push(v); };
    if (extra) { add(tools, extra.tool, 20); if (PATHISH.test(String(extra.target || '').trim())) add(paths, relTo(String(extra.target).trim(), s.cwd), 20); }
    for (let k = i - 1; k >= Math.max(0, i - 30); k--) {
      const e = ev[k]; if (e?.k !== 'tool') continue;
      add(tools, e.tool, 20); const t = String(e.target || '').trim(); if (PATHISH.test(t)) add(paths, relTo(t, s.cwd), 20);
    }
    return { repo: repo || null, paths, toolNames: tools };
  };
  const prior = (i) => {
    for (let k = i - 1; k >= 0; k--) {
      const e = ev[k];
      if (e?.k === 'tool') return { toolName: e.tool || null, summary: clipText(e.target, 500) || null };
      if (e?.k === 'say') return { toolName: null, summary: clipText(String(e.text || '').replace(/\s+/g, ' '), 500) || null };
      if (e?.k === 'ask') return null;
    }
    return null;
  };
  const push = (i, kind, text, priorAction, extra) => {
    const observedAt = iso(ev[i]?.ts) || fallbackTs; const words = clipText(text, 2000);
    if (!observedAt || !words) return;
    const sig = { signalId: '', kind, source: 'trail', harness, sessionId: sessionId ?? null, observedAt, text: words, priorAction, scopeHints: scope(i, extra), receiptId: receiptIdAt(i) ?? null };
    sig.signalId = signalIdOf(sig); out.push(sig);
  };
  // The next thing the person said after a rejected call, if nothing else happened first: that is their reason.
  const followUp = (i) => {
    for (let k = i + 1; k < ev.length; k++) {
      const e = ev[k];
      if (e.k === 'ask') return e.who === 'human' ? k : -1;
      if (e.k === 'tool') return -1;
    }
    return -1;
  };
  let activity = false;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.k === 'tool') {
      const act = { toolName: e.tool || null, summary: clipText(e.target, 500) || null };
      if (e.rejected) {
        let words = e.feedback || null;
        if (!words) { const k = followUp(i); if (k >= 0) { words = ev[k].text; used.add(k); } }
        push(i, 'rejection', words || `[rejected] ${e.tool}${e.target ? `: ${e.target}` : ''}`, act, e);
      } else if (e.denied) {
        // A permission rule says the same thing every time it fires: one signal per rule and tool per session.
        const key = `${e.tool}|${String(e.errText || '').split('\n')[0].slice(0, 120)}`;
        if (!deniedSeen.has(key)) { deniedSeen.add(key); push(i, 'denial', `[denied] ${String(e.errText || '').replace(/\s+/g, ' ').trim() || e.tool}`, act, e); }
      }
      activity = true; continue;
    }
    if (e.k === 'say') { activity = true; continue; }
    if (e.k !== 'ask' || e.who !== 'human' || used.has(i)) continue;
    const kind = classifyJudgment(e.text);
    if (kind === 'explicit_rule' || (kind === 'correction' && activity)) push(i, kind, e.text, prior(i));
  }
  return out;
}

/** Lineage edges and the extension for a receipt the given precedents governed; both empty when nothing is known. */
export function precedentLineage(governedBy, signalIds) {
  const gov = (Array.isArray(governedBy) ? governedBy : []).filter((g) => g && typeof g.claimId === 'string' && g.claimId.trim()).slice(0, 200)
    .map((g) => ({ claimId: g.claimId.trim().slice(0, 512), version: g.version ?? null }));
  const sigs = [...new Set((signalIds || []).filter(Boolean))].slice(0, 1000);
  const references = gov.map((g) => ({ relationship: 'governed_by', ref: { system: 'orgx', type: 'precedent', id: g.claimId, ...(g.version != null && String(g.version).trim() ? { version: String(g.version).slice(0, 200) } : {}) } }));
  return { references, extension: gov.length || sigs.length ? { governedBy: gov, signals: sigs } : null };
}
