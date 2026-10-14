import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCorpus, validateCorpus, corpusManifest } from '../scripts/work-understanding/corpus.mjs';
import { compareCase } from '../scripts/work-understanding/adapter.mjs';

const cases = readCorpus();
test('all 42 draft synthetic cases have unique identities and exact resolvable evidence', () => {
  assert.deepEqual(validateCorpus(cases), []);
  assert.deepEqual(corpusManifest().tracks, { current_contract: 30, extended_semantics: 12 });
  assert.equal(corpusManifest().human_adjudicated, false);
});
test('validator fails on empty corpus, broken quote, dangling edge and duplicate event', () => {
  assert.ok(validateCorpus([]).length);
  for (const mutate of [
    (c) => { c.expected.entities[0].source_refs[0].quote = 'not present'; },
    (c) => { c.expected.edges[0].to_id = 'missing'; },
    (c) => { c.input.events.push(c.input.events[0]); },
  ]) { const c = structuredClone(cases[0]); mutate(c); assert.ok(validateCorpus([c], { expectedCount: 1 }).length); }
});
test('adapter matches facts using renamed entity IDs and resolvable edge endpoints', () => {
  const c = cases[7]; const remap = (id) => `native:${id}`;
  const out = { supported_types: ['goal', 'action', 'artifact'],
    entities: c.expected.entities.map((e) => ({ ...e, id: remap(e.id) })),
    edges: c.expected.edges.map((e) => ({ ...e, from_id: remap(e.from_id), to_id: remap(e.to_id) })) };
  const report = compareCase(c, out);
  assert.equal(report.matched_entities, 3); assert.deepEqual(report.missing_edges, []);
  assert.equal(report.safety_gate, 'unadjudicated', 'matching gold cannot grade free-text prohibitions');
  out.entities.push(out.entities[0]); assert.equal(compareCase(c, out).unmatched_output_entities.length, 1);
});
test('unsupported capability differs from regression and cannot pass safety by abstaining', () => {
  const c = cases[39]; const report = compareCase(c, { supported_types: ['abstention'] });
  assert.equal(report.capability_gaps[0].type, 'decision'); assert.deepEqual(report.regression_candidates, ['ab']);
  assert.equal(report.safety_gate, 'unadjudicated');
  const checked = Object.fromEntries(c.expected.forbidden_inferences.map((_, i) => [`${c.case_id}:forbidden:${i + 1}`, { mapping_version: 'test-only/1', violated: i === 0 }]));
  assert.equal(compareCase(c, { forbidden_checks: checked }).safety_gate, 'failed');
});
test('diagnostic reports omit restricted source text and reject invented references', () => {
  const c = cases[41]; const entity = structuredClone(c.expected.entities[2]); entity.source_refs[0].event_id = 'invented';
  const report = compareCase(c, { entities: [entity] }); assert.equal(report.invalid_provenance, 1);
  assert.ok(!JSON.stringify(report).includes('CONDITION_PLACEHOLDER'));
  assert.ok(!JSON.stringify(report).includes('Summarize the attached'));
});
