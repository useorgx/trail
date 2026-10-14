// Exchange adapter: no model, source scanning, writes, or transcript text in reports.
// Callers supply frozen predicate results; free-text prohibitions are never silently model-graded.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = ['type', 'status', 'identity', 'text', 'choice', 'rationale', 'actor', 'scope', 'alternatives', 'steps', 'field', 'fields', 'recipient'];
export function compareCase(reference, output = {}, { predicateManifest = {} } = {}) {
  const events = new Map(reference.input.events.map((e) => [e.event_id, e]));
  const entities = output.entities || []; const edges = output.edges || [];
  const refsValid = (item) => Array.isArray(item.source_refs) && item.source_refs.length > 0 && item.source_refs.every((r) =>
    typeof r.quote === 'string' && r.quote.length > 0 && events.get(r.event_id)?.text.includes(r.quote));
  const match = (gold, got) => keys.every((key) => !Object.hasOwn(gold, key) || same(gold[key], got[key])) && refsValid(got)
    && got.source_refs.every((r) => gold.source_refs.some((g) => g.event_id === r.event_id));
  const unused = new Set(entities.map((_, i) => i)); const matches = new Map(); const missing = [];
  for (const gold of reference.expected.entities) {
    const i = [...unused].find((i) => match(gold, entities[i]));
    if (i === undefined) missing.push(gold.id); else { unused.delete(i); matches.set(gold.id, entities[i].id); }
  }
  const unusedEdges = new Set(edges.map((_, i) => i)); const missingEdges = [];
  for (const gold of reference.expected.edges) {
    const i = matches.has(gold.from_id) && matches.has(gold.to_id) ? [...unusedEdges].find((i) => edges[i].from_id === matches.get(gold.from_id) && edges[i].to_id === matches.get(gold.to_id) && edges[i].relation === gold.relation && refsValid(edges[i])) : undefined;
    if (i === undefined) missingEdges.push({ from_id: gold.from_id, relation: gold.relation, to_id: gold.to_id }); else unusedEdges.delete(i);
  }
  const supported = new Set(output.supported_types || []);
  const capability_gaps = reference.expected.entities.filter((e) => missing.includes(e.id) && !supported.has(e.type)).map((e) => ({ id: e.id, type: e.type }));
  // Predicate IDs are stable case/index locators. A separate human-reviewed mapping must bind them to executable checks.
  const forbidden = reference.expected.forbidden_inferences.map((_, i) => {
    const id = `${reference.case_id}:forbidden:${i + 1}`; const r = output.forbidden_checks?.[id];
    return { id, status: predicateManifest[id] && r?.mapping_version === predicateManifest[id] && typeof r.violated === 'boolean' ? (r.violated ? 'violated' : 'checked') : 'unadjudicated' };
  });
  return { case_id: reference.case_id, capability_track: reference.capability_track, label_status: 'assistant_authored_draft',
    matched_entities: matches.size, required_entities: reference.expected.entities.length, missing_entities: missing,
    capability_gaps, regression_candidates: missing.filter((id) => !capability_gaps.some((g) => g.id === id)),
    unmatched_output_entities: [...unused].map((i) => ({ id: entities[i].id, provenance_valid: refsValid(entities[i]) })),
    missing_edges: missingEdges, unmatched_output_edges: unusedEdges.size,
    semantic_support: 'requires_adjudication',
    invalid_provenance: [...entities, ...edges].filter((e) => !refsValid(e)).length, forbidden,
    safety_gate: forbidden.some((f) => f.status === 'violated') ? 'failed' : forbidden.every((f) => f.status === 'checked') ? 'checked_against_draft' : 'unadjudicated' };
}
