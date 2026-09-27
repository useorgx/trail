// Search over the work ledger, built for agents as much as people: free text ranked by BM25 plus exact filters, and
// every result says why it matched. An agent narrows with filters, opens a receipt, follows its workstream and links.
//
//   trail search "receipt upload" outcome:blocked repo:orgx type:fix since:2026-09-01 conf:<0.6 unmet:tests pr:3137
//
// Filters: outcome, verification (verified), type, area, repo, client, ws (workstream id), pr, file, since, until,
// conf (<n or >n), unmet (criterion kind, or `any`), status (workstream rollup). Unknown key:value pairs are text.
import { EXT } from './receipt.mjs';
import { tokens } from './workstreams.mjs';
import { ledger, rowOf } from './ledger.mjs';

const FIELDS = { summary: 3, objective: 1.5, outcome: 1.2, criteria: 1, artifacts: 1.2, workstream: 1, actions: 0.4 };
const KEYS = new Set(['outcome', 'verification', 'verified', 'type', 'area', 'repo', 'client', 'ws', 'workstream', 'pr', 'file', 'since', 'until', 'conf', 'unmet', 'status']);

export function parseQuery(q) {
  const filters = {}; const text = [];
  for (const m of String(q || '').matchAll(/(\w+):("[^"]*"|\S+)|"([^"]+)"|(\S+)/g)) {
    if (m[1] && KEYS.has(m[1].toLowerCase())) filters[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, '');
    else text.push(m[3] || m[0]);
  }
  return { filters, text: text.join(' ') };
}

let index = null;
function buildIndex(L) {
  const docs = L.receipts.map((r) => {
    const e = r.extensions?.[EXT] || {}; const ws = L.built.byReceipt[r.receipt_id]; const w = ws && L.built.workstreams.find((x) => x.id === ws);
    const f = {
      summary: tokens(r.intent.summary), objective: tokens(r.intent.objective), outcome: tokens(r.outcome.summary),
      criteria: tokens((e.criteria || []).map((c) => c.text).join(' ')), artifacts: tokens(r.artifacts.map((a) => `${a.name} ${a.ref?.id || ''}`).join(' ')),
      workstream: tokens(w?.title || ''), actions: tokens(r.actions.slice(0, 60).map((a) => a.summary).join(' ')),
    };
    const tf = new Map(); let len = 0;
    // Each field counts a term once (weighted): a long command log repeating a word must not outrank the ask.
    for (const [k, ws] of Object.entries(f)) for (const t of new Set(ws)) { tf.set(t, (tf.get(t) || 0) + FIELDS[k]); len += FIELDS[k]; }
    return { r, tf, len };
  });
  const df = new Map(); for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  return { L, docs, df, avg };
}

function matches(r, row, f, L) {
  const e = r.extensions?.[EXT] || {};
  if (f.outcome && !row.outcome.startsWith(f.outcome) && row.outcome_kind !== f.outcome) return false;
  if ((f.verification || f.verified) && row.verification !== (f.verification || f.verified)) return false;
  if (f.type && row.work_type !== f.type) return false;
  if (f.area && !String(row.area || '').toLowerCase().includes(f.area.toLowerCase())) return false;
  if (f.repo && String(row.repo || '').toLowerCase() !== f.repo.toLowerCase()) return false;
  if (f.client && row.client !== f.client) return false;
  const wsf = f.ws || f.workstream; if (wsf && row.workstream !== wsf) return false;
  if (f.pr && !row.prs.includes(f.pr.replace(/^#/, '')) && !r.actions.some((a) => new RegExp(`\\b${f.pr.replace(/^#/, '')}\\b`).test(a.summary))) return false;
  if (f.file && !r.artifacts.some((a) => String(a.ref?.id || '').includes(f.file)) && !r.actions.some((a) => (a.target_refs || []).some((t) => t.id.includes(f.file)))) return false;
  if (f.since && row.at < f.since) return false;
  if (f.until && row.at > f.until) return false;
  if (f.conf) { const m = f.conf.match(/^([<>]=?)?(\d*\.?\d+)$/); if (m) { const v = +m[2]; const c = row.confidence ?? 1; if (m[1]?.startsWith('<') ? !(c < v || (m[1] === '<=' && c === v)) : !(c > v || (m[1] === '>=' && c === v))) return false; } }
  if (f.unmet) { const un = (e.criteria || []).filter((c) => c.status === 'unmet'); if (f.unmet === 'any' ? !un.length : !un.some((c) => c.kind === f.unmet)) return false; }
  if (f.status) { const w = row.workstream && L.built.workstreams.find((x) => x.id === row.workstream); if (!w || w.status !== f.status) return false; }
  return true;
}

/**
 * @param {string} q  query with free text and key:value filters
 * @returns {{ query:any, total:number, results:any[] }}
 */
export function search(q, { limit = 20, L = ledger() } = {}) {
  if (!index || index.L !== L) index = buildIndex(L);
  const { filters, text } = parseQuery(q); const terms = [...new Set(tokens(text))];
  const k1 = 1.2, b = 0.75, N = index.docs.length; const out = [];
  for (const d of index.docs) {
    const row = rowOf(d.r, L); if (!matches(d.r, row, filters, L)) continue;
    let score = 0; const hit = [];
    for (const t of terms) { const f = d.tf.get(t); if (!f) continue; const idf = Math.log(1 + (N - index.df.get(t) + 0.5) / (index.df.get(t) + 0.5)); score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / index.avg)); hit.push(t); }
    if (terms.length && !hit.length) continue;
    // Coordination: a receipt matching every term beats one that matches a single rare term many times.
    if (terms.length > 1) score *= (hit.length / terms.length) ** 2;
    out.push({ ...row, score: +score.toFixed(3), matched: hit });
  }
  out.sort((a, b) => (terms.length ? b.score - a.score : 0) || String(b.at).localeCompare(String(a.at)));
  return { query: { text, filters }, total: out.length, results: out.slice(0, limit) };
}

/** One receipt with the context an agent needs to judge it: its workstream, its neighbours, and what is uncertain. */
export function receiptDetail(id, L = ledger()) {
  const r = L.byId.get(id) || L.receipts.find((x) => x.receipt_id.endsWith(id)); if (!r) return null;
  const row = rowOf(r, L); const e = r.extensions?.[EXT] || {}; const w = row.workstream && L.built.workstreams.find((x) => x.id === row.workstream);
  const links = L.built.links.filter((l) => l.from === r.receipt_id || l.to === r.receipt_id).map((l) => ({ ...l, other: l.from === r.receipt_id ? l.to : l.from, other_summary: L.byId.get(l.from === r.receipt_id ? l.to : l.from)?.intent.summary }));
  return { ...row, intent: r.intent, outcome_detail: r.outcome, verification_detail: { status: r.verification.status, checks: r.verification.checks }, criteria: e.criteria || [], artifacts: r.artifacts, labels: L.labels[r.receipt_id], changes_of_course: e.changes_of_course || [], human_interventions: r.human_interventions.length, links, workstream: w ? { id: w.id, title: w.title, status: w.status, receipts: w.receipts.length, sessions: w.sessions } : null, uncertain: uncertainties(r, L) };
}
function uncertainties(r, L) {
  const e = r.extensions?.[EXT] || {}; const out = []; const lab = L.labels[r.receipt_id];
  if ((e.confidence?.outcome ?? 1) < 0.6) out.push(`outcome is a guess (${e.confidence.outcome})`);
  for (const c of (e.criteria || []).filter((c) => c.status === 'unknown')) out.push(`no evidence either way for: ${c.text}`);
  if (lab?.work_type?.confidence < 0.55) out.push(`work type is a guess (${lab.work_type.id}, ${lab.work_type.confidence})`);
  if (r.verification.status === 'unverified') out.push('nothing checked the change after it was made');
  return out;
}

export function workstreamDetail(id, L = ledger()) {
  const w = L.built.workstreams.find((x) => x.id === id || x.id.endsWith(id)); if (!w) return null;
  return { ...w, members: w.receipts.map((rid) => rowOf(L.byId.get(rid), L)), links: L.built.links.filter((l) => w.receipts.includes(l.to) && w.receipts.includes(l.from)) };
}
