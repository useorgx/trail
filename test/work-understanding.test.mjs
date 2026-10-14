import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCorpus, validateCorpus, corpusManifest } from '../scripts/work-understanding/corpus.mjs';
import { compareCase } from '../scripts/work-understanding/adapter.mjs';
import { extractBaseline } from '../scripts/work-understanding/baseline.mjs';

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
  assert.equal(compareCase(c, { forbidden_checks: checked }).safety_gate, 'unadjudicated', 'predictions cannot supply their own grading authority');
  const predicateManifest=Object.fromEntries(Object.keys(checked).map((id)=>[id,'test-only/1']));
  assert.equal(compareCase(c, { forbidden_checks: checked }, { predicateManifest }).safety_gate, 'failed');
});
test('unrelated but valid source quotes and missing edge endpoints cannot match required facts', () => {
  const c=cases[7],wrong=structuredClone(c.expected.entities[2]);wrong.source_refs=c.expected.entities[0].source_refs.slice(0,1);
  const report=compareCase(c,{entities:[wrong],edges:[{relation:'output_of',source_refs:c.expected.edges[0].source_refs}]});
  assert.equal(report.matched_entities,0);assert.equal(report.unmatched_output_edges,1);
});
test('diagnostic reports omit restricted source text and reject invented references', () => {
  const c = cases[41]; const entity = structuredClone(c.expected.entities[2]); entity.source_refs[0].event_id = 'invented';
  const report = compareCase(c, { entities: [entity] }); assert.equal(report.invalid_provenance, 1);
  assert.ok(!JSON.stringify(report).includes('CONDITION_PLACEHOLDER'));
  assert.ok(!JSON.stringify(report).includes('Summarize the attached'));
});
test('frozen primitives keep failed result context above quoted passing output; role omissions are explicit', () => {
  const output=extractBaseline(cases[38]);assert.equal(output.entities.find((e)=>e.type==='action').status,'failed');
  const quoted=extractBaseline(cases[2]);assert.ok(!quoted.entities.some((e)=>e.type==='action'));
  assert.equal(quoted.adapter_coverage.omitted.length,1);assert.equal(compareCase(cases[2],quoted).safety_gate,'unadjudicated');
});
