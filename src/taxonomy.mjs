// What kind of work each receipt was. Trail (open, local) owns a small fixed list of work types scored from the ask
// and the step mix, with a confidence, and records the raw evidence a code-area ontology needs (the meaningful path
// segments each piece of work touched). Growing that ontology — proposing areas, confirming, merging, mapping work
// to initiatives and tasks, upgrading labels with a stronger model — happens in OrgX across everyone's receipts:
// one machine's history is too small to name the parts of a codebase, and naming them is a team's decision.
// Every label says who made it (`rules`, `model:<name>`, `human`). Human beats model beats rules.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './store.mjs';
import { EXT } from './receipt.mjs';
import { repoOf, repoRootOf, tokens } from './workstreams.mjs';

export const TAXONOMY_VERSION = 'trail-taxonomy/1';
const FILE = () => path.join(HOME, 'taxonomy.json');
export const LOW = 0.55; // below this an assignment goes to the review queue

// ---- work types ------------------------------------------------------------------------------------------------------
export const WORK_TYPES = [
  { id: 'fix', name: 'Fix', about: 'Something is broken and the work repairs it.', re: /\b(fix|bug|broken|error|fails?|failing|crash|regression|not working|doesn'?t work|isn'?t|wrong|issue|exception|traceback|undefined|null|500|404)\b/i },
  { id: 'feature', name: 'Build', about: 'New behaviour or a new surface.', re: /\b(implement|add|build|create|new|support|enable|introduce|scaffold|make (a|an|the))\b/i },
  { id: 'improve', name: 'Improve', about: 'Existing behaviour made better: UX, speed, quality, consistency.', re: /\b(improve|better|polish|refine|clean ?up|consisten|spacing|layout|faster|optimi[sz]e|simplif|upgrade|enhance|tighten)\b/i },
  { id: 'refactor', name: 'Refactor', about: 'Structure changed without changing behaviour.', re: /\b(refactor|restructure|extract|rename|move|split|consolidate|dedupe|reorgani[sz]e|migrate to)\b/i },
  { id: 'investigate', name: 'Investigate', about: 'A question answered or a cause found; the deliverable is understanding.', re: /^\s*(why|what|how|where|when|which|is|are|does|do|can|could|should)\b|\?\s*$|\b(investigate|diagnos|root cause|figure out|look into|explain|understand|trace)\b/i },
  { id: 'review', name: 'Review', about: 'Existing work examined against a bar: audits, critiques, verification.', re: /\b(audit|review|critique|assess|evaluate|verify|check (that|if|whether)|grade|score)\b/i },
  { id: 'ship', name: 'Ship', about: 'Getting finished work out: commit, PR, merge, deploy, publish, release.', re: /\b(merge|deploy|publish|release|ship|push|commit|open (a )?pr|tag|rollout|go live)\b/i },
  { id: 'design', name: 'Design', about: 'Visual or interaction design: mockups, styles, motion, assets.', re: /\b(design|mockup|figma|visual|aesthetic|color|colour|font|typography|animation|motion|video|reel|image|logo|icon|css|style)\b/i },
  { id: 'write', name: 'Write', about: 'Prose is the deliverable: docs, posts, decks, emails, specs.', re: /\b(write|draft|docs?|readme|post|tweet|thread|linkedin|blog|copy|deck|slides|email|spec|memo|brief|outline|summar)\b/i },
  { id: 'data', name: 'Data', about: 'Queries, migrations, analysis, datasets.', re: /\b(sql|query|queries|migration|schema|table|dataset|csv|xlsx|analy[sz]|metrics?|dashboard|supabase|postgres)\b/i },
  { id: 'ops', name: 'Operate', about: 'Environment, config, infrastructure, CI, dependencies.', re: /\b(config|env|setup|set up|install|ci|pipeline|workflow|docker|vps|dns|domain|cron|launchd|key|secret|permission|credential|auth(entication)?)\b/i },
  { id: 'research', name: 'Research', about: 'Outside information gathered and weighed: web, papers, competitors.', re: /\b(research|compare|competitor|market|state of the art|sota|papers?|survey|benchmark|options|alternatives)\b/i },
  { id: 'routine', name: 'Routine', about: 'Scheduled or automated work that runs without a person asking.', re: /^\s*\[scheduled\]/i },
];
const LEAD = { fix: 'fix', debug: 'fix', resolve: 'fix', repair: 'fix', patch: 'fix', implement: 'feature', troubleshoot: 'fix', revamp: 'improve', rethink: 'improve', redesign: 'design', rework: 'improve', put: 'improve', change: 'improve', adjust: 'improve', tweak: 'improve', remove: 'improve', delete: 'improve', replace: 'improve', integrate: 'feature', wire: 'feature', connect: 'ops', plan: 'research', brainstorm: 'research', explore: 'research', critique: 'review', grade: 'review', add: 'feature', build: 'feature', create: 'feature', make: 'feature', scaffold: 'feature', set: 'ops', improve: 'improve', polish: 'improve', refine: 'improve', clean: 'improve', tighten: 'improve', simplify: 'improve', optimize: 'improve', update: 'improve', refactor: 'refactor', rename: 'refactor', extract: 'refactor', move: 'refactor', split: 'refactor', consolidate: 'refactor', why: 'investigate', what: 'investigate', how: 'investigate', where: 'investigate', is: 'investigate', are: 'investigate', does: 'investigate', do: 'investigate', did: 'investigate', should: 'investigate', investigate: 'investigate', explain: 'investigate', check: 'investigate', find: 'investigate', diagnose: 'investigate', audit: 'review', review: 'review', critique: 'review', assess: 'review', evaluate: 'review', verify: 'review', test: 'review', merge: 'ship', deploy: 'ship', publish: 'ship', release: 'ship', ship: 'ship', push: 'ship', commit: 'ship', design: 'design', animate: 'design', style: 'design', write: 'write', draft: 'write', document: 'write', summarize: 'write', research: 'research', compare: 'research', search: 'research', run: 'ops', install: 'ops', setup: 'ops', configure: 'ops', migrate: 'data', query: 'data', analyze: 'data' };
const PREAMBLE = /^\s*((yes|yeah|ok(ay)?|so|now|please|pls|also|and|then|great|cool|perfect|nice|alright|all right)[,.!]?\s+|(can|could|would|will) (you|we)\s+|(should|shall) we\s+|let'?s\s+|lets\s+|i (want|need) you to\s+|we (need|should|have) to\s+|go ahead and\s+|help me\s+|try to\s+)+/i;
export function leadVerb(ask) { const w = String(ask || '').replace(PREAMBLE, '').trim().split(/[\s,.:;!?]+/)[0]?.toLowerCase().replace(/[^a-z]/g, ''); return LEAD[w] || null; }
const BUG_REPORT = /\b(still (not|no|isn'?t|doesn'?t|broken|showing)|is(n'?t| not) (working|showing|loading|saving)|doesn'?t (work|show|load|save)|not (working|showing|loading|saving|updating)|should (be|show|not)|instead of|keeps? (failing|crashing|logging)|is showing|shows? (the )?wrong|getting (an? )?error|returns? (only|nothing|empty|\d{3}))\b/i;
const PASTED_ERROR = /(Error|Exception|Traceback|ERR!|TypeError|ReferenceError|at .+:\d+:\d+|\bline \d+\b|Failed to|Uncaught)/;
const FOLLOW_UP = /^\s*(yes|yep|ok(ay)?|sure|do it|go( ahead)?|continue|proceed|next|keep going|apply|aplly|all of (them|it)|do (all|both|the rest)|\d+\.?\s*$|[1-9](\s*[-–,&]\s*[1-9])+\b)/i;

/** Scores for each work type from the ask and what the agent actually did. */
export function scoreWorkType(r) {
  const ask = String(r.intent?.objective || r.intent?.summary || ''); const head = ask.slice(0, 400);
  const acts = {}; for (const a of r.actions || []) { const k = String(a.type).split('.').pop(); acts[k] = (acts[k] || 0) + 1; }
  const n = Math.max(1, (r.actions || []).length); const frac = (...ks) => ks.reduce((s, k) => s + (acts[k] || 0), 0) / n;
  const s = Object.fromEntries(WORK_TYPES.map((t) => [t.id, 0]));
  for (const t of WORK_TYPES) { const m = head.match(new RegExp(t.re.source, 'gi')); if (m) s[t.id] += 0.6 + 0.4 * Math.min(2, m.length - 1); }
  // The leading verb of an imperative ask is the strongest single signal of what kind of work was wanted.
  const lead = leadVerb(ask); if (lead) s[lead] += 2.2;
  if (PASTED_ERROR.test(ask)) s.fix += 2.2;
  if (BUG_REPORT.test(head)) s.fix += 1.4;
  if (r.extensions?.[EXT]?.origin === 'schedule' || /^\s*\[scheduled\]/i.test(ask)) s.routine += 6;
  // What was done confirms or contradicts what was asked.
  const edits = frac('edit'), reads = frac('read', 'search', 'git_read'), ships = frac('commit', 'ship', 'deploy'), web = frac('web');
  if (edits === 0 && (reads > 0.3 || n <= 2)) { s.investigate += 1.2; s.review += 0.6; s.fix *= 0.7; s.feature *= 0.6; }
  if (edits > 0.25) { s.feature += 0.4; s.fix += 0.3; s.improve += 0.3; s.investigate *= 0.6; }
  if (ships > 0 && edits < 0.05) s.ship += 1.5;
  if (web > 0.2) s.research += 1.5;
  if ((r.artifacts || []).some((a) => /\.(md|mdx|txt|docx)$/.test(a.ref?.id || '') && a.role === 'output') && edits > 0) s.write += 0.6;
  if ((r.artifacts || []).some((a) => /\.(css|scss|svg|png|jpg|mp4|tsx)$/.test(a.ref?.id || '') && a.role === 'output')) s.design += 0.3;
  return s;
}

/** The work type with its confidence: how far the winner is ahead, and how much signal there was at all. */
export function classifyWorkType(r) {
  const ask = String(r.intent?.objective || '');
  if (FOLLOW_UP.test(ask) && ask.length < 80) return { id: 'follow_up', confidence: 0.3, by: 'rules', why: 'A short reply to the previous step; its type comes from the work it continues.' };
  const s = scoreWorkType(r); const ranked = Object.entries(s).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked; const total = ranked.reduce((a, [, v]) => a + v, 0);
  if (!top || top[1] < 0.8) return { id: 'other', confidence: 0.2, by: 'rules', why: 'No work-type signal in the ask or the steps.', runner_up: null };
  const margin = (top[1] - (second?.[1] || 0)) / (top[1] || 1); const strength = Math.min(1, top[1] / 3);
  const confidence = +Math.max(0.2, Math.min(0.95, 0.35 + 0.4 * margin + 0.25 * strength - (total > 12 ? 0.05 : 0))).toFixed(2);
  return { id: top[0], confidence, by: 'rules', runner_up: second && second[1] > 0 ? second[0] : null, why: `asked + did: ${ranked.filter(([, v]) => v > 0).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}` };
}

// ---- areas: grown from the files each piece of work changed -----------------------------------------------------------
const GENERIC = new Set('src app apps lib libs packages package components component pages page server client api v1 v2 utils util helpers common shared core internal public static assets styles test tests __tests__ spec specs e2e scripts script tools bin dist build out node_modules users code documents private tmp var home hopeatina desktop downloads scratchpad index route routes hooks types dev'.split(' '));
/** The meaningful directory segments of a changed file, inside its repository. */
export function areaCandidates(file, repo, root) {
  let p = String(file || '');
  // Only files inside the repository (or one of its worktrees) have an area; ~/.claude, /tmp and friends do not.
  const wt = p.match(/\/\.(claude|codex|cursor)\/worktrees\/[^/]+\/(.*)$/);
  if (wt) p = wt[2]; else if (root && p.startsWith(root + '/')) p = p.slice(root.length + 1); else if (p.startsWith('/') || p.startsWith('~')) return [];
  const segs = p.split('/').slice(0, -1).filter((x) => x && !x.startsWith('.') && !x.startsWith('[') && !x.startsWith('(') && !GENERIC.has(x.toLowerCase()) && x !== repo && !/^\d/.test(x) && x.length < 40);
  return segs.slice(0, 2);
}
const fileOf = (a) => (a.ref?.type === 'file' ? a.ref.id : null);

// ---- local corrections ----------------------------------------------------------------------------------------------
export function loadTaxonomy() {
  try { const t = JSON.parse(fs.readFileSync(FILE(), 'utf8')); if (t.version === TAXONOMY_VERSION) return { overrides: {}, ...t }; } catch {}
  return { version: TAXONOMY_VERSION, revision: 0, overrides: {} };
}
export function saveTaxonomy(t) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(t, null, 1), { mode: 0o600 }); }

/** A person's (or a model's) correction to one of their receipts. Human beats model beats rules. */
export function overrideLabel(receiptId, label, by = 'human', tax = loadTaxonomy()) {
  const rank = (b) => (b === 'human' ? 3 : String(b).startsWith('model:') ? 2 : 1);
  const cur = tax.overrides[receiptId]; if (cur && rank(cur.by) > rank(by)) return cur;
  tax.overrides[receiptId] = { ...(cur || {}), ...label, by, at: new Date().toISOString() }; tax.revision = (tax.revision || 0) + 1; saveTaxonomy(tax); return tax.overrides[receiptId];
}

/** The meaningful directory segments of every file a piece of work changed, counted. OrgX grows areas from these. */
export function areaCandidatesOf(r) {
  const ext = r.extensions?.[EXT] || {}; const repo = ext.repo || repoOf(ext.cwd); if (!repo) return [];
  const root = repoRootOf(ext.cwd); const c = {};
  for (const a of r.artifacts || []) { const f = fileOf(a); if (f) for (const s of areaCandidates(f, repo, root)) c[s] = (c[s] || 0) + 1; }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([segment, files]) => ({ segment, files }));
}

/**
 * Label every receipt's work type, with follow-ups inheriting from the work they continue (the strongest joining
 * link into them). Area candidates ride along as evidence for OrgX, not as a label.
 */
export function labelAll(receipts, built, tax = loadTaxonomy()) {
  const labels = {};
  const parent = {}; for (const l of built?.links || []) if (l.confidence >= 0.7 && (!parent[l.to] || l.confidence > parent[l.to].confidence)) parent[l.to] = l;
  const order = [...receipts].sort((a, b) => String(a.timestamps.started_at).localeCompare(String(b.timestamps.started_at)));
  for (const r of order) {
    let wt = classifyWorkType(r); const pl = parent[r.receipt_id];
    if ((wt.id === 'follow_up' || wt.confidence < LOW) && pl) {
      const p = labels[pl.from];
      if (p && !['follow_up', 'other'].includes(p.work_type.id) && (wt.id === 'follow_up' || p.work_type.confidence > wt.confidence)) wt = { id: p.work_type.id, confidence: +(Math.min(p.work_type.confidence, pl.confidence) * 0.9).toFixed(2), by: 'rules', why: `inherited from the work it continues (${pl.relationship})`, inherited_from: pl.from };
    }
    const o = tax.overrides?.[r.receipt_id];
    labels[r.receipt_id] = { work_type: o?.work_type ? { id: o.work_type, confidence: 1, by: o.by } : wt, area_candidates: areaCandidatesOf(r) };
  }
  return labels;
}
