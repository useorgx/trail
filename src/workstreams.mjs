// Workstreams: pieces of work (receipts) joined across sessions into the larger effort they belong to.
// Object-centric, after OCEL 2.0: two receipts belong together when they touch the same object (a pull request, a
// branch, a rarely-touched file, an id pasted into the ask) or when one says it continues the other. Text similarity
// alone never joins two receipts; it only proposes a link for a person to confirm.
// Every link keeps its relationship, confidence and the evidence behind it, so a smarter linker (or a person) can
// replace one link without rebuilding the rest.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EXT } from './receipt.mjs';

export const LINKER = 'trail-links/1';
const DAY = 864e5;
const JOIN = 0.7; // links at or above this join workstreams; below it they are suggestions to review

// ---- the objects a receipt touches -----------------------------------------------------------------------------------
const gitRootCache = new Map();
/** The repository a working directory belongs to: worktrees fold into their main checkout. */
export function repoOf(cwd) {
  if (!cwd) return null;
  const folded = String(cwd).replace(/\/\.(claude|codex|cursor)\/worktrees\/[^/]+.*$/, '').replace(/\/worktrees\/[^/]+$/, '');
  if (gitRootCache.has(folded)) return gitRootCache.get(folded).name;
  let dir = folded, root = null;
  for (let i = 0; i < 8 && dir && dir !== '/' && !root; i++) { try { if (fs.existsSync(path.join(dir, '.git'))) root = dir; } catch {} dir = path.dirname(dir); }
  const out = { name: path.basename(root || folded) || null, root: root || folded }; gitRootCache.set(folded, out); return out.name;
}
/** The repository root path for a working directory (worktrees folded), for turning file paths into repo paths. */
export function repoRootOf(cwd) { if (!cwd) return null; repoOf(cwd); const folded = String(cwd).replace(/\/\.(claude|codex|cursor)\/worktrees\/[^/]+.*$/, '').replace(/\/worktrees\/[^/]+$/, ''); return gitRootCache.get(folded)?.root || null; }

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TICKET = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;
const PR_TEXT = /(?:\bPR\s*#|\bpull\/|gh pr (?:view|merge|checkout|checks|diff|edit|comment|ready|review) )(\d{1,7})\b/gi;
const BRANCH = /git (?:checkout -[bB]|switch -[cC]|push (?:-u |--set-upstream )?origin|worktree add \S+ -b) ([\w./-]{3,120})/g;
const COMMON_BRANCH = /^(main|master|develop|dev|HEAD|origin|staging|production|trunk)$/;
const NOT_TICKETS = /^(UTF|ISO|SHA|RFC|HTTP|TLS|SSL|AES|RSA|GPT|CVE|ES|TS|MD|EOF|API|AWR)-/;

/** Objects a receipt touched or named: pull requests, branches, files, ids, tickets. */
export function objectsOf(r) {
  const ext = r.extensions?.[EXT] || {}; const repo = ext.repo || repoOf(ext.cwd) || ext.project || null;
  const ask = String(r.intent?.objective || r.intent?.summary || ''); const cmds = (r.actions || []).map((a) => a.summary || '').join('\n');
  const out = new Map(); const add = (type, id, strength) => { const k = `${type}:${id}`; if (!out.has(k)) out.set(k, { type, id, strength }); };
  for (const a of r.artifacts || []) {
    if (a.kind === 'pull_request') add('pr', `${repo}#${a.ref.id}`, 'produced');
    else if (a.ref?.type === 'file') add('file', a.ref.id, a.role);
  }
  for (const a of r.actions || []) if (/\.edit$/.test(a.type) && a.status === 'completed') for (const t of a.target_refs || []) if (t.type === 'file' && !/(package(-lock)?\.json|\.lock)$/.test(t.id)) add('file', t.id, 'edited');
  // A PR named in the ask or a command counts, unless the piece of work names many (a review sweep, a routine listing PRs).
  const named = [...new Set([...(ask + '\n' + cmds).matchAll(PR_TEXT)].map((m) => m[1]))];
  if (named.length <= 3) for (const n of named) add('pr', `${repo}#${n}`, 'named');
  for (const m of cmds.matchAll(BRANCH)) if (!COMMON_BRANCH.test(m[1]) && !m[1].startsWith('-')) add('branch', `${repo}@${m[1]}`, 'worked_on');
  for (const m of ask.matchAll(UUID)) add('id', m[0].toLowerCase(), 'named');
  for (const m of ask.matchAll(TICKET)) if (!NOT_TICKETS.test(m[1] + '-')) add('ticket', m[1], 'named');
  return { repo, objects: [...out.values()] };
}

// ---- text: only for suggestions ---------------------------------------------------------------------------------------
const STOP = new Set('the a an and or to of in on for with this that it is are be as at by from we i you your our my me do does did can could should would will just also then than so if not no yes but all any some into out up about what how why when where which who there here have has had was were been its it\'s let lets please make sure now use using get got one two new'.split(' '));
export const tokens = (s) => String(s || '').toLowerCase().replace(/https?:\S+/g, ' ').replace(/[^a-z0-9#._/-]+/g, ' ').split(/\s+/).map((w) => w.replace(/^[._/-]+|[._/-]+$/g, '')).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
function tfidf(docs) {
  const df = new Map(); for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const N = docs.length;
  return docs.map((d) => { const tf = new Map(); for (const w of d) tf.set(w, (tf.get(w) || 0) + 1); const v = new Map(); let n = 0;
    for (const [w, c] of tf) { const x = (1 + Math.log(c)) * Math.log((N + 1) / (df.get(w) + 0.5)); v.set(w, x); n += x * x; }
    n = Math.sqrt(n) || 1; for (const [w, x] of v) v.set(w, x / n); return v; });
}
const cosine = (a, b) => { let s = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a]; for (const [w, v] of x) { const u = y.get(w); if (u) s += u * v; } return s; };

// ---- continuation: the ask says it picks up earlier work --------------------------------------------------------------
const CONTINUES = /\b(continued from a previous conversation|continue (where|from|the|with|working)|pick(ing)? up (where|from|the)|resume|carry on|follow[- ]up (on|to)|as (discussed|planned) (earlier|before|yesterday)|last session|previous session|yesterday'?s)\b/i;
const REFERENTIAL = /^\s*(yes|yep|ok(ay)?|do it|go( ahead)?|continue|proceed|ship it|merge( it)?|next|keep going|and|also|now)\b/i;

/**
 * Join receipts into workstreams.
 * @param {any[]} receipts  Agent Work Receipts from trail (order does not matter)
 * @returns {{ linker:string, built_at:string, workstreams:any[], links:any[], suggestions:any[], byReceipt:Record<string,string> }}
 */
export function buildWorkstreams(receipts, { decisions = {} } = {}) {
  const R = receipts.filter((r) => r?.receipt_id).map((r) => ({ r, t: Date.parse(r.timestamps?.started_at) || 0, session: r.lineage?.run_ref?.id, ...objectsOf(r) }))
    .sort((a, b) => a.t - b.t);
  const idx = new Map(R.map((x, i) => [x.r.receipt_id, i]));
  // How common each object is: a file touched in 40 pieces of work (package.json, a router) links nothing.
  const seen = new Map(); for (const x of R) for (const o of x.objects) { const k = `${o.type}:${o.id}`; (seen.get(k) || seen.set(k, []).get(k)).push(x); }
  const links = []; const linkKey = new Set();
  const link = (a, b, relationship, confidence, evidence) => {
    if (a === b) return; const [p, c] = R[a].t <= R[b].t ? [a, b] : [b, a]; const k = `${p}>${c}`;
    const prev = links.find((l) => l.k === k); if (prev) { if (confidence > prev.confidence) Object.assign(prev, { relationship, confidence, evidence }); else if (!prev.also.includes(relationship) && prev.relationship !== relationship) prev.also.push(relationship); return; }
    linkKey.add(k); links.push({ k, from: R[p].r.receipt_id, to: R[c].r.receipt_id, relationship, confidence: +confidence.toFixed(2), evidence, also: [], by: LINKER });
  };

  // 1. Shared objects. Pull requests, branches, ids and tickets are specific by nature; files only when rare.
  const WEIGHT = { pr: 0.92, branch: 0.85, id: 0.9, ticket: 0.85 };
  for (const [k, xs] of seen) {
    if (xs.length < 2) continue; const [type] = k.split(':');
    if (type === 'file') {
      if (xs.length > 6) continue; // common file: no signal
      const conf = 0.55 + 0.25 / xs.length; // 2 receipts → 0.675; joins only with a second shared file (below)
      for (let i = 1; i < xs.length; i++) { const a = idx.get(xs[i - 1].r.receipt_id), b = idx.get(xs[i].r.receipt_id); if (R[b].t - R[a].t < 21 * DAY) link(a, b, 'same_files', conf, [k.slice(5)]); }
      continue;
    }
    if (xs.length > 25) continue; // an id pasted everywhere is a workspace id, not a piece of work
    // Only the receipt that produced the PR, or ones within a few days of each other, join through it: a PR mentioned
    // again three weeks later is a reference, and chaining through it would glue unrelated efforts together.
    for (let i = 1; i < xs.length; i++) {
      const a = xs[i - 1], b = xs[i]; const gap = b.t - a.t; const oa = a.objects.find((o) => `${o.type}:${o.id}` === k), ob = b.objects.find((o) => `${o.type}:${o.id}` === k);
      const produced = oa?.strength === 'produced' || ob?.strength === 'produced';
      if (gap > (produced ? 10 : 4) * DAY) continue;
      link(idx.get(a.r.receipt_id), idx.get(b.r.receipt_id), `same_${type}`, produced || type !== 'pr' ? WEIGHT[type] : 0.74, [k.slice(type.length + 1)]);
    }
  }
  // Two or more rare files in common is as specific as a branch.
  for (const l of links) if (l.relationship === 'same_files') {
    const a = R[idx.get(l.from)], b = R[idx.get(l.to)];
    const shared = a.objects.filter((o) => o.type === 'file' && (seen.get(`file:${o.id}`) || []).length <= 6 && b.objects.some((p) => p.type === 'file' && p.id === o.id)).map((o) => o.id);
    if (shared.length >= 2) Object.assign(l, { confidence: Math.min(0.88, 0.7 + 0.06 * shared.length), evidence: shared.slice(0, 5) });
  }

  // 2. Continuation: the next ask in the same session that refers back ("yes, merge it"), or an ask that says it continues.
  const vecs = tfidf(R.map((x) => tokens(`${x.r.intent?.summary} ${x.r.intent?.objective || ''}`)));
  for (let i = 0; i < R.length; i++) {
    const x = R[i]; const ask = String(x.r.intent?.objective || '');
    const prevSame = (() => { for (let j = i - 1; j >= 0 && j > i - 400; j--) if (R[j].session === x.session) return j; return -1; })();
    if (prevSame >= 0 && (REFERENTIAL.test(ask) || ask.length < 60)) link(prevSame, i, 'continues', 0.8, ['short follow-up in the same session']);
    else if (prevSame >= 0) { const s = cosine(vecs[prevSame], vecs[i]); if (s >= 0.3) link(prevSame, i, 'continues', 0.6 + Math.min(0.25, s / 2), [`same session, similar ask (${s.toFixed(2)})`]); }
    if (CONTINUES.test(ask)) {
      // The earlier work it continues: the most similar receipt in the same repo in the week before.
      let best = -1, bs = 0; for (let j = i - 1; j >= 0 && x.t - R[j].t < 7 * DAY; j--) { if (R[j].session === x.session || (x.repo && R[j].repo !== x.repo)) continue; const s = cosine(vecs[j], vecs[i]) + (R[j].t > x.t - DAY ? 0.1 : 0); if (s > bs) { bs = s; best = j; } }
      if (best >= 0) link(best, i, 'continues', bs >= 0.25 ? 0.78 : 0.62, [`the ask says it continues earlier work (similarity ${bs.toFixed(2)})`]);
    }
  }

  // 3. Similar intent in the same repo within a week: never joins, only suggests.
  const suggestions = [];
  const byRepo = new Map(); R.forEach((x, i) => { if (x.repo) (byRepo.get(x.repo) || byRepo.set(x.repo, []).get(x.repo)).push(i); });
  for (const list of byRepo.values()) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length && R[list[b]].t - R[list[a]].t < 7 * DAY; b++) {
    const i = list[a], j = list[b]; if (R[i].session === R[j].session || linkKey.has(`${i}>${j}`)) continue;
    if (vecs[i].size < 4 || vecs[j].size < 4) continue; // too few words to judge
    const s = cosine(vecs[i], vecs[j]); if (s >= 0.42) suggestions.push({ from: R[i].r.receipt_id, to: R[j].r.receipt_id, relationship: 'similar_intent', confidence: +(0.35 + s / 3).toFixed(2), evidence: [`similar asks (${s.toFixed(2)})`], by: LINKER });
  }

  // A person's calls on links win: "unrelated" removes a link, "same effort" adds one at full confidence.
  for (const [k, d] of Object.entries(decisions)) {
    const [from, to] = k.split('>'); if (!idx.has(from) || !idx.has(to)) continue;
    for (let i = links.length - 1; i >= 0; i--) if ((links[i].from === from && links[i].to === to) || (links[i].from === to && links[i].to === from)) links.splice(i, 1);
    if (d === 'same_effort') link(idx.get(from), idx.get(to), 'confirmed', 1, ['confirmed by a person']);
  }
  for (let i = suggestions.length - 1; i >= 0; i--) if (decisions[`${suggestions[i].from}>${suggestions[i].to}`]) suggestions.splice(i, 1);

  // Union-find over the joining links.
  const parent = R.map((_, i) => i); const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const joining = links.filter((l) => l.confidence >= JOIN);
  for (const l of joining) { const a = find(idx.get(l.from)), b = find(idx.get(l.to)); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
  const groups = new Map(); R.forEach((x, i) => { const g = find(i); (groups.get(g) || groups.set(g, []).get(g)).push(i); });

  const workstreams = []; const byReceipt = {};
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const rs = members.map((i) => R[i]); const ids = new Set(rs.map((x) => x.r.receipt_id));
    const inner = joining.filter((l) => ids.has(l.from) && ids.has(l.to));
    const objCount = new Map(); for (const x of rs) for (const o of x.objects) if (o.type !== 'file' || (seen.get(`file:${o.id}`) || []).length <= 6) objCount.set(`${o.type}:${o.id}`, (objCount.get(`${o.type}:${o.id}`) || 0) + 1);
    const objects = [...objCount].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => ({ key: k, receipts: n }));
    const last = rs[rs.length - 1].r; const statuses = {}; for (const x of rs) statuses[x.r.outcome.status] = (statuses[x.r.outcome.status] || 0) + 1;
    const unmet = rs.flatMap((x) => (x.r.extensions?.[EXT]?.criteria || []).filter((c) => c.status === 'unmet').map((c) => ({ receipt: x.r.receipt_id, criterion: c.text })));
    const id = 'ws_' + crypto.createHash('sha256').update(rs[0].r.receipt_id).digest('hex').slice(0, 12);
    const title = workstreamTitle(rs.map((x) => x.r));
    const confidence = inner.length ? +(inner.reduce((a, l) => a + l.confidence, 0) / inner.length).toFixed(2) : null;
    workstreams.push({ id, title, repo: mostCommon(rs.map((x) => x.repo).filter(Boolean)), receipts: rs.map((x) => x.r.receipt_id), sessions: new Set(rs.map((x) => x.session)).size,
      started_at: rs[0].r.timestamps.started_at, last_at: last.timestamps.completed_at, status: rollup(last.outcome.status, unmet.length), outcomes: statuses,
      objects, unmet_criteria: unmet.slice(0, 20), cost_usd: +rs.reduce((a, x) => a + (x.r.cost?.total || 0), 0).toFixed(2),
      confidence, weakest_link: inner.length ? +Math.min(...inner.map((l) => l.confidence)).toFixed(2) : null, relationships: countBy(inner.map((l) => l.relationship)) });
    for (const x of rs) byReceipt[x.r.receipt_id] = id;
  }
  workstreams.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
  return { linker: LINKER, built_at: new Date().toISOString(), workstreams, links: links.map(({ k, ...l }) => l), suggestions: suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 500), byReceipt };
}

const countBy = (xs) => { const o = {}; for (const x of xs) o[x] = (o[x] || 0) + 1; return o; };
const mostCommon = (xs) => { const c = countBy(xs); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
function rollup(last, unmet) { if (last === 'succeeded' && !unmet) return 'done'; if (last === 'succeeded' || last === 'partially_succeeded') return 'done_with_gaps'; if (last === 'blocked') return 'blocked'; if (last === 'failed') return 'dropped'; return 'open'; }
/** A workstream's name: the first substantial ask, which usually states the effort; later asks are follow-ups. */
function workstreamTitle(rs) {
  const named = rs.filter((r) => r.intent?.summary && r.intent.summary !== 'Untitled work');
  const first = named.find((r) => String(r.intent?.objective || '').length >= 40) || named[0] || rs[0];
  return String(first.intent?.summary || 'Untitled work').replace(/^["'\s@]+/, '').slice(0, 120);
}

/** Parent refs per receipt: the strongest joining link into it from earlier work. */
export function parentsFor(built) {
  const best = {}; for (const l of built.links) if (l.confidence >= JOIN && (!best[l.to] || l.confidence > best[l.to].confidence)) best[l.to] = l;
  const out = {}; for (const [to, l] of Object.entries(best)) out[to] = [{ system: 'orgx-trail', type: 'agent_work_receipt', id: l.from, relationship: l.relationship, confidence: l.confidence }];
  return out;
}
export const JOIN_THRESHOLD = JOIN;
