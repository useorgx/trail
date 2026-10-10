// The work ledger: receipts, joined into workstreams, labelled by the ontology, with a queue of the calls a person
// should make. Everything here is derived from the receipts on disk and can be rebuilt at any time; only a person's
// decisions (taxonomy.json) are kept as state.
import fs from 'node:fs';
import { allReceipts, P_WORKSTREAMS } from './store.mjs';
import { EXT } from './receipt.mjs';
import { buildWorkstreams, parentsFor, JOIN_THRESHOLD } from './workstreams.mjs';
import { loadTaxonomy, labelAll, LOW } from './taxonomy.mjs';
import { withIntegrity } from './integrity.mjs';

let cache = null;
/** Build (or reuse) the ledger. `persist` writes workstreams.json. */
export function ledger({ persist = false, fresh = false } = {}) {
  if (cache && !fresh && !persist) return cache;
  const receipts = allReceipts();
  const tax = loadTaxonomy();
  const built = buildWorkstreams(receipts);
  const labels = labelAll(receipts, built, tax);
  const parents = parentsFor(built);
  const byId = new Map(receipts.map((r) => [r.receipt_id, r]));
  const L = { receipts, byId, built, tax, labels, parents };
  if (persist) { try { fs.writeFileSync(P_WORKSTREAMS(), JSON.stringify({ linker: built.linker, built_at: built.built_at, workstreams: built.workstreams, links: built.links, suggestions: built.suggestions }), { mode: 0o600 }); } catch {} }
  cache = L; return L;
}

const ext = (r) => r.extensions?.[EXT] || {};
/** The single confidence a person cares about for a receipt: the weakest of outcome, criteria and label. */
export function overallConfidence(r, lab) {
  const c = ext(r).confidence || {}; const xs = [c.outcome, c.criteria, lab?.work_type?.confidence].filter((x) => typeof x === 'number');
  return xs.length ? +Math.min(...xs).toFixed(2) : null;
}

/** A compact row: what a list, a search result or an agent needs to decide whether to open the receipt. */
/** A person's answers from the review queue, applied over trail's guesses (outcome, criteria). */
function reviewed(r, L) {
  const o = L.tax.overrides[r.receipt_id]; if (!o || (!o.outcome && !o.criteria)) return { r, e: ext(r) };
  const e = { ...ext(r), criteria: (ext(r).criteria || []).map((c) => (o.criteria?.[c.id] ? { ...c, status: o.criteria[c.id], confidence: 1, by: o.by } : c)) };
  const ACC = { succeeded: 'accepted', partially_succeeded: 'changes_requested', failed: 'rejected', abandoned: 'rejected', blocked: 'changes_requested' };
  const outcome = o.outcome ? { ...r.outcome, status: o.outcome === 'abandoned' ? 'failed' : o.outcome, acceptance: { status: ACC[o.outcome] || 'pending', actor: { type: 'human', id: 'workspace-member' }, occurred_at: o.at, notes: 'Answered in the trail review queue.' } } : r.outcome;
  return { r: { ...r, outcome, extensions: { ...r.extensions, [EXT]: e } }, e };
}

export function rowOf(r0, L) {
  const { r, e } = reviewed(r0, L); const lab = L.labels[r.receipt_id]; const ws = L.built.byReceipt[r.receipt_id];
  const crit = e.criteria || [];
  return {
    id: r.receipt_id, at: r.timestamps.started_at, client: r.actor.id, repo: e.repo || e.project || null,
    summary: r.intent.summary, outcome: r.outcome.status, outcome_kind: e.outcome_kind, verification: r.verification.status,
    work_type: lab?.work_type?.id ?? null, work_type_confidence: lab?.work_type?.confidence ?? null,
    workstream: ws || null,
    criteria: { met: crit.filter((c) => c.status === 'met').length, unmet: crit.filter((c) => c.status === 'unmet').length, unknown: crit.filter((c) => c.status === 'unknown').length },
    prs: r.artifacts.filter((a) => a.kind === 'pull_request').map((a) => a.ref.id), files: r.artifacts.filter((a) => a.ref?.type === 'file').length,
    cost_usd: r.cost?.total ?? 0, confidence: overallConfidence(r, lab), reviewed: !!L.tax.overrides[r.receipt_id],
  };
}

/** A receipt ready to leave the machine: lineage from the work graph, labels in the trail extension. */
export function withGraph(r0, L) {
  const { r, e } = reviewed(r0, L); const lab = L.labels[r.receipt_id]; const ws = L.built.byReceipt[r.receipt_id];
  const parents = (L.parents[r.receipt_id] || []).map((p) => ({ system: 'orgx-trail', type: 'agent_work_receipt', id: p.id, metadata: { relationship: p.relationship, confidence: p.confidence, linker: L.built.linker } }));
  const links = L.built.links.filter((l) => l.to === r.receipt_id || l.from === r.receipt_id).slice(0, 20);
  return withIntegrity({
    ...r,
    lineage: { ...r.lineage, parent_receipt_refs: parents, ...(ws ? { workstream_ref: { system: 'orgx-trail', type: 'workstream', id: ws } } : {}),
      references: [...r.lineage.references, ...links.filter((l) => l.to === r.receipt_id && l.confidence >= JOIN_THRESHOLD).map((l) => ({ relationship: l.relationship, ref: { system: 'orgx-trail', type: 'agent_work_receipt', id: l.from }, confidence: l.confidence }))].slice(0, 200) },
    extensions: { ...r.extensions, [EXT]: { ...e,
      workstream: ws ? { id: ws, title: L.built.workstreams.find((w) => w.id === ws)?.title || null } : null,
      labels: lab ? { work_type: lab.work_type, area_candidates: lab.area_candidates, taxonomy: L.tax.version } : null,
      // Possible links trail would not make on words alone: OrgX puts these in front of the team to decide.
      suggested_links: L.built.suggestions.filter((x) => x.to === r.receipt_id).slice(0, 5).map(({ from, relationship, confidence, evidence }) => ({ from, relationship, confidence, evidence })),
      links: links.map((l) => ({ from: l.from, to: l.to, relationship: l.relationship, confidence: l.confidence, evidence: l.evidence })),
    } },
  });
}

/**
 * Questions about your own receipts that only you can settle: did it get done, was each criterion met. Answers stay
 * local and win over trail's guesses; synced receipts carry them as acceptance. Team-level questions (is this a real
 * area of the codebase, are these two efforts the same, which initiative is this) are asked in OrgX, where the
 * answers are shared and the whole team's receipts are in view.
 */
export function reviewQueue(L, { limit = 50 } = {}) {
  const items = [];
  for (const r of L.receipts) {
    const e = ext(r); const substantial = r.actions.length >= 5 || r.artifacts.length > 0;
    if (!substantial || L.tax.overrides[r.receipt_id]?.by === 'human') continue;
    const oc = e.confidence?.outcome;
    if (typeof oc === 'number' && oc < 0.6 && ['succeeded', 'partially_succeeded', 'unknown'].includes(r.outcome.status)) items.push({ kind: 'outcome', receipt: r.receipt_id, question: 'Did this piece of work get done?', guess: r.outcome.status, confidence: oc, answers: ['succeeded', 'partially_succeeded', 'failed', 'blocked', 'abandoned'], value: (1 - oc) * (1 + r.artifacts.length / 5), at: r.timestamps.started_at, summary: r.intent.summary });
    for (const c of (e.criteria || []).filter((c) => c.status === 'unknown')) items.push({ kind: 'criterion', receipt: r.receipt_id, criterion: c.id, question: `Was this met: “${c.text}”?`, guess: 'unknown', confidence: c.confidence, answers: ['met', 'unmet'], value: 0.6, at: r.timestamps.started_at, summary: r.intent.summary });
  }
  // Recent work first within equal value: it is what you still remember.
  return items.sort((a, b) => b.value - a.value || String(b.at).localeCompare(String(a.at))).slice(0, limit).map(({ value, ...x }) => x);
}

/** What only OrgX can answer from here: counts that show what a team view would add. */
export function teamQuestions(L) {
  const cands = new Set(); for (const x of Object.values(L.labels)) for (const c of x.area_candidates || []) cands.add(c.segment);
  return { suggested_links: L.built.suggestions.length, area_candidates: cands.size, unlabelled: Object.values(L.labels).filter((x) => x.work_type.confidence < LOW).length };
}
