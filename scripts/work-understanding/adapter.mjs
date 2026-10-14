// Exchange adapter: no model, source scanning, writes, or transcript text in reports.
// Callers supply frozen predicate results; free-text prohibitions are never silently model-graded.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = ['type', 'status', 'identity', 'text', 'choice', 'rationale', 'actor', 'scope', 'alternatives', 'steps', 'field', 'fields', 'recipient', 'revision', 'occurred_at_utc', 'canonical_event_identity', 'missing'];
export function compareCase(reference, output = {}, { predicateManifest = {}, adapterManifest = {} } = {}) {
  const output_validation = validateOutput(output);
  output = record(output) ? output : {};
  const events = new Map(reference.input.events.map((e) => [e.event_id, e]));
  const allEntities = Array.isArray(output.entities) ? output.entities : [], allEdges = Array.isArray(output.edges) ? output.edges : [];
  const entities = output_validation.length ? [] : allEntities; const edges = output_validation.length ? [] : allEdges;
  const refsValid = (item) => Array.isArray(item.source_refs) && item.source_refs.length > 0 && item.source_refs.every((r) =>
    r && typeof r.quote === 'string' && r.quote.length > 0 && events.get(r.event_id)?.text.includes(r.quote));
  const match = (gold, got) => Object.keys(gold).filter((key) => !['id', 'source_refs'].includes(key)).every((key) => same(gold[key], got[key])) && refsValid(got)
    && got.source_refs.every((r) => gold.source_refs.some((g) => g.event_id === r.event_id));
  const unused = new Set(entities.map((_, i) => i)); const matches = new Map(); const missing = [];
  for (const gold of reference.expected.entities) {
    const i = [...unused].find((i) => match(gold, entities[i]));
    if (i === undefined) missing.push(gold.id); else { unused.delete(i); matches.set(gold.id, entities[i].id); }
  }
  const unusedEdges = new Set(edges.map((_, i) => i)); const missingEdges = [];
  for (const gold of reference.expected.edges) {
    const i = matches.has(gold.from_id) && matches.has(gold.to_id) ? [...unusedEdges].find((i) => edges[i].from_id === matches.get(gold.from_id) && edges[i].to_id === matches.get(gold.to_id) && edges[i].relation === gold.relation && refsValid(edges[i]) && edges[i].source_refs.every((r) => gold.source_refs.some((g) => g.event_id === r.event_id))) : undefined;
    if (i === undefined) missingEdges.push({ from_id: gold.from_id, relation: gold.relation, to_id: gold.to_id }); else unusedEdges.delete(i);
  }
  const supported = new Set(Array.isArray(adapterManifest.supported_types) ? adapterManifest.supported_types : []);
  const capability_gaps = reference.expected.entities.filter((e) => missing.includes(e.id) && !supported.has(e.type)).map((e) => ({ id: e.id, type: e.type }));
  // Predicate IDs are stable case/index locators. A separate human-reviewed mapping must bind them to executable checks.
  const forbidden = reference.expected.forbidden_inferences.map((_, i) => {
    const id = `${reference.case_id}:forbidden:${i + 1}`; const r = output.forbidden_checks?.[id];
    return { id, status: !output_validation.length && predicateManifest[id] && r?.mapping_version === predicateManifest[id] && typeof r.violated === 'boolean' ? (r.violated ? 'attested_violation' : 'attested_clear') : 'unadjudicated' };
  });
  return { case_id: reference.case_id, capability_track: reference.capability_track, label_status: 'assistant_authored_draft',
    matched_entities: matches.size, required_entities: reference.expected.entities.length, missing_entities: missing,
    capability_gaps, regression_candidates: missing.filter((id) => !capability_gaps.some((g) => g.id === id)),
    output_validation,
    unmatched_output_entities: output_validation.length ? allEntities.map((_, index) => ({ index, provenance_valid: false })) : [...unused].map((index) => ({ index, provenance_valid: refsValid(entities[index]) })),
    missing_edges: missingEdges, unmatched_output_edges: output_validation.length ? allEdges.length : unusedEdges.size,
    semantic_support: 'requires_adjudication',
    capability_manifest: Array.isArray(adapterManifest.supported_types) ? 'independently_supplied' : 'unavailable',
    forbidden_evaluation: 'attestations_only_not_executable_independent_predicates',
    invalid_provenance: [...allEntities, ...allEdges].filter((e) => !e || !refsValid(e)).length, forbidden,
    safety_gate: output_validation.length ? 'invalid_output' : 'unadjudicated' };
}

const record = (v) => v && typeof v === 'object' && !Array.isArray(v);
const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(v);
export function validateOutput(output) {
  const issues = [], issue = (path, code) => issues.push({ path, code });
  if (!record(output)) return [{ path: 'output', code: 'object_required' }];
  if (Object.keys(output).some((k) => !['entities','edges','supported_types','forbidden_checks','adapter_coverage','baseline'].includes(k))) issue('output','unknown_field');
  const entities = output.entities ?? [], edges = output.edges ?? [], ids = new Set();
  if (!Array.isArray(entities) || !Array.isArray(edges)) return [...issues, { path: 'output', code: 'arrays_required' }];
  const refs = (item, p) => {
    if (!Array.isArray(item.source_refs) || !item.source_refs.length) { issue(p, 'source_refs_required'); return; }
    for (const r of item.source_refs) if (!record(r) || Object.keys(r).some((k) => !['event_id','quote','basis'].includes(k)) || !validId(r.event_id) || typeof r.quote !== 'string' || !r.quote || !['observed','inferred'].includes(r.basis)) issue(p,'invalid_source_ref');
  };
  entities.forEach((e, i) => { const p = `entities/${i}`; if (!record(e)) { issue(p,'object_required'); return; }
    if (!validId(e.id) || ids.has(e.id)) issue(p,'invalid_or_duplicate_id'); ids.add(e.id);
    if (typeof e.type !== 'string' || !e.type || typeof e.status !== 'string' || !e.status) issue(p,'type_status_required');
    if (Object.keys(e).some((k) => !['id','source_refs','native_kind',...keys].includes(k))) issue(p,'unknown_entity_field'); refs(e,p);
  });
  edges.forEach((e, i) => { const p = `edges/${i}`; if (!record(e)) { issue(p,'object_required'); return; }
    if (Object.keys(e).some((k) => !['from_id','relation','to_id','source_refs'].includes(k))) issue(p,'unknown_edge_field');
    if (!validId(e.from_id) || !validId(e.to_id) || !ids.has(e.from_id) || !ids.has(e.to_id) || e.from_id === e.to_id) issue(p,'invalid_edge_endpoints');
    if (typeof e.relation !== 'string' || !e.relation) issue(p,'relation_required'); refs(e,p);
  });
  if (output.supported_types !== undefined && (!Array.isArray(output.supported_types) || output.supported_types.some((x) => typeof x !== 'string'))) issue('supported_types','string_array_required');
  if (output.forbidden_checks !== undefined && !record(output.forbidden_checks)) issue('forbidden_checks','object_required');
  return issues;
}

export function safeAdapterCoverage(value, reference) {
  if (!record(value)) return null;
  const events = new Set(reference.input.events.map((e) => e.event_id)), count = (x) => Number.isSafeInteger(x) && x >= 0 ? x : null;
  return { available_events: count(value.available_events), processed_events: count(value.processed_events), missing_native_commands: count(value.missing_native_commands),
    source_complete: typeof value.source_complete === 'boolean' ? value.source_complete : null,
    omitted: Array.isArray(value.omitted) ? value.omitted.filter((e) => record(e) && events.has(e.event_id) && e.reason === 'native_primitive_adapter_does_not_support_role').map((e) => ({ event_id: e.event_id, reason: e.reason })) : [],
    source_event_completeness: Array.isArray(value.source_event_completeness) ? value.source_event_completeness.filter((e) => record(e) && events.has(e.event_id)).map((e) => ({ event_id: e.event_id, complete: typeof e.complete === 'boolean' ? e.complete : null })) : [] };
}
