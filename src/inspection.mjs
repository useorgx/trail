// Read-only terminal views. Exact evidence locators are displayed, never opened as arbitrary file paths.
export function inspectionView(detail, { view = 'summary', criterion, evidence } = {}) {
  if (!['summary', 'evidence', 'source'].includes(view)) throw new Error('Use --view summary, evidence, or source.');
  const c = criterion ? detail.criteria.find((c) => c.id === criterion) : null;
  if (criterion && !c) throw new Error(`No criterion ${criterion} in this receipt.`);
  let selected = detail.evidence.filter((e) => (!c || c.evidence_ids.includes(e.id)) && (!evidence || e.id === evidence));
  if (evidence && !selected.length) throw new Error(`No evidence ${evidence} for this selection.`);
  if (view === 'source' && !evidence) throw new Error('Use --evidence <id> with --view source.');
  return { schema_version: detail.inspection.schema_version, id: detail.id, review_revision: detail.review_revision,
    view, ...(view === 'summary' ? { receipt: detail } : { criterion: c, evidence: selected.map((e) => ({ ...e,
      source_availability: 'not_loaded', excerpt_scope: 'stored_receipt_excerpt', verification_scope: 'named event; does not establish deployment or acceptance' })) }), coverage: detail.coverage };
}

export function formatInspection(value, { width = process.stdout.columns || 80 } = {}) {
  const lines = []; const r = value.receipt;
  if (r) {
    lines.push(r.summary, `Receipt: ${r.id}`, `Result: ${r.outcome.replaceAll('_', ' ')} (${r.outcome_basis.replaceAll('_', ' ')})`,
      `Recorded checks: ${r.verification}; see evidence for scope`,
      `Acceptance: ${r.acceptance.status} (producer reported; workspace judgment unavailable)`, '', 'Criteria');
    for (const c of r.criteria) lines.push(`${c.status.toUpperCase()}  ${c.text} [${c.id}] — ${c.evidence_ids.length ? `${c.evidence_ids.length} evidence reference(s)` : 'No evidence attached'}`);
    for (const a of r.artifacts) lines.push(`Artifact: ${a.name} (producer reports ${a.role}; delivery not established here; ${a.ref?.id || 'identity unavailable'})`);
  } else for (const e of value.evidence) lines.push(`${e.id} · ${e.kind} · ${e.observed_at || 'Time unknown'}`, e.summary,
    e.excerpt || 'Excerpt not included in this record', `Source: ${e.ref ? `${e.ref.system}/${e.ref.type}/${e.ref.id}` : 'Not included in this record'}`, 'Source availability: not loaded; stored excerpt only', e.verification_scope, '');
  lines.push(`Coverage: ${value.coverage.status} for ${value.coverage.scope}; original source coverage ${value.coverage.source_status || 'unknown'}`);
  for (const [name, s] of Object.entries(value.coverage.sections || {})) lines.push(`${name.replaceAll('_', ' ')}: ${s.returned} of ${s.total ?? 'unknown'}${s.truncated ? ' (omitted by receipt limit)' : ''}`);
  const cols = Math.max(24, width); const wrap = (line) => {
    const words = line.split(/\s+/); const out = []; let current = '';
    for (let word of words) {
      if (current && current.length + word.length + 1 > cols) { out.push(current); current = ''; }
      while (word.length > cols) { if (current) { out.push(current); current = ''; } out.push(word.slice(0, cols)); word = word.slice(cols); }
      if (word) current += (current ? ' ' : '') + word;
    }
    out.push(current); return out.join('\n');
  };
  return lines.map(wrap).join('\n');
}
