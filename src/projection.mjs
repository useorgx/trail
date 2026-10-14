// Pure local read model. A local correction is not authenticated workspace acceptance.
import { EXT } from './receipt.mjs';
import { REVIEW_EXT } from './review.mjs';

export const INSPECTION_VERSION = 'org.orgx.trail.inspection/v1';
export function projectReviewedWork(receipt, tax = { overrides: {} }) {
  const original = structuredClone(receipt); const r = structuredClone(receipt);
  const e = r.extensions?.[EXT] || {}; const o = tax.overrides?.[r.receipt_id];
  const corrections = []; const basis = o?.by === 'human' ? 'local_human_correction' : 'inferred';
  const statusProvenance = (path, method, declared = false) => {
    r.provenance = [...(r.provenance || []).filter((p) => p.path !== path), { path, basis: declared ? 'declared' : 'inferred', method }];
  };
  const correction = (field, before, after) => corrections.push({ field, original: before, resolved: after,
    by: o.by, at: o.at ?? null, scope: 'local_receipt', review_revision: tax.revision ?? null });
  if (o?.outcome) {
    const status = o.outcome === 'abandoned' ? 'failed' : o.outcome;
    correction('/outcome/status', r.outcome.status, status);
    r.outcome = { ...r.outcome, status, metadata: { ...r.outcome.metadata, local_correction: true } };
    delete r.outcome.metadata.confidence; r.outcome.metadata.provenance = basis;
    e.confidence = { ...e.confidence, outcome: null };
    statusProvenance('/outcome/status', basis, o.by === 'human');
    e.outcome_kind = o.outcome;
    r.outcome.metadata.kind = o.outcome;
  }
  e.criteria = (e.criteria || []).map((c) => {
    const status = o?.criteria?.[c.id]; if (!status) return c;
    correction(`/criteria/${c.id}/status`, c.status, status);
    const corrected = { ...c, status, by: o.by, basis }; delete corrected.confidence;
    statusProvenance(`/extensions/org.orgx.trail~1v1/criteria/${e.criteria.indexOf(c)}/status`, basis, o.by === 'human');
    return corrected;
  });
  if (o?.criteria) {
    r.outcome.criteria_results = (r.outcome.criteria_results || []).map((c, i) => {
      if (!o.criteria[c.criterion_id]) return c;
      const corrected = { ...c, status: o.criteria[c.criterion_id], decided_by: { type: o.by === 'human' ? 'human' : 'agent', id: o.by === 'human' ? 'local-workspace-member' : o.by } };
      delete corrected.confidence; statusProvenance(`/outcome/criteria_results/${i}/status`, basis, o.by === 'human'); return corrected;
    });
    const remaining = e.criteria.map((c) => c.confidence).filter((c) => typeof c === 'number');
    e.confidence = { ...e.confidence, criteria: remaining.length ? Math.min(...remaining) : null };
  }
  const unmetRequired = e.criteria.filter((c) => c.status === 'unmet' && r.intent?.criteria?.find((x) => x.id === c.id)?.required !== false);
  const conflicts = r.outcome.status === 'succeeded' && unmetRequired.length ? [{ kind: 'outcome_criteria',
    outcome: 'succeeded', criterion_ids: unmetRequired.map((c) => c.id), resolution: 'unresolved' }] : [];
  // An inferred success yields to contrary reviewed criteria. Conflicting explicit local calls stay inspectable.
  if (conflicts.length && !o?.outcome) {
    r.outcome.status = 'partially_succeeded'; r.outcome.metadata = { ...r.outcome.metadata }; delete r.outcome.metadata.confidence;
    r.outcome.metadata.provenance = 'inferred_conflict'; e.confidence = { ...e.confidence, outcome: null };
    r.outcome.metadata.kind = 'inferred_conflict'; e.outcome_kind = 'inferred_conflict';
    statusProvenance('/outcome/status', 'local_outcome_criteria_conflict');
  }
  e.read_projection = { outcome_basis: o?.outcome ? basis : conflicts.length ? 'inferred_conflict' : 'inferred', conflicts };
  if (corrections.length) e.local_review = { authority: 'local_only', revision: tax.revision ?? null, corrections,
    original: { outcome: original.outcome, criteria: original.extensions?.[EXT]?.criteria || [], provenance: original.provenance || [], confidence: original.extensions?.[EXT]?.confidence || {} } };
  // Keep the four proof lenses distinct. Correcting status never synthesizes a passing measurement.
  const review = r.extensions?.[REVIEW_EXT];
  if (review) review.criteria = (review.criteria || []).map((c) => o?.criteria?.[c.criterion_id] ? {
    ...c, local_correction: { status: o.criteria[c.criterion_id], by: o.by, at: o.at ?? null },
  } : c);
  r.extensions = { ...r.extensions, [EXT]: e };
  const coverage = e.coverage || { status: 'unknown', scope: 'stored receipt', source_status: 'unknown',
    reason: 'legacy_record_has_no_coverage_manifest', sections: {
      actions: { returned: r.actions?.length ?? 0, total: null, limit: 300 },
      edited_files: { returned: (r.artifacts || []).filter((a) => a.ref?.type === 'file').length, total: null, limit: 100 },
      conversation: { returned: review?.conversation?.length ?? 0, total: null, limit: 400 },
    } };
  return { r, e, inspection: { schema_version: INSPECTION_VERSION,
    original: { outcome: original.outcome, criteria: original.extensions?.[EXT]?.criteria || [], provenance: original.provenance || [], confidence: original.extensions?.[EXT]?.confidence || {} },
    resolved: { outcome: r.outcome, criteria: e.criteria }, corrections,
    review_revision: tax.revision ?? null, outcome_basis: o?.outcome ? basis : conflicts.length ? 'inferred_conflict' : 'inferred',
    acceptance: { status: r.outcome?.acceptance?.status ?? 'unknown', basis: 'producer_reported',
      origin: /trail review queue/i.test(r.outcome?.acceptance?.notes || '') ? 'legacy_outcome_mapping' : 'producer_record',
      local_correction_is_acceptance: false, workspace_judgment: 'unavailable' },
    coverage, conflicts, conflict_detection: 'local_outcome_criteria_only',
    sync: { status: 'unknown', reason: 'workspace_acknowledgment_not_loaded' } } };
}
