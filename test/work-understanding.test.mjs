import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCorpus, validateCorpus, corpusManifest } from '../scripts/work-understanding/corpus.mjs';
import { compareCase } from '../scripts/work-understanding/adapter.mjs';
import { extractBaseline, assertPrimitiveVersions, BASELINE } from '../scripts/work-understanding/baseline.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  out.entities.push(out.entities[0]); assert.equal(compareCase(c, out).safety_gate, 'invalid_output'); assert.equal(compareCase(c, out).matched_entities, 0);
});
test('unsupported capability differs from regression and cannot pass safety by abstaining', () => {
  const c = cases[39]; const report = compareCase(c, { supported_types: ['decision'] }, { adapterManifest: { supported_types: ['abstention'] } });
  assert.equal(report.capability_gaps[0].type, 'decision'); assert.deepEqual(report.regression_candidates, ['ab']);
  assert.equal(report.safety_gate, 'unadjudicated');
  const checked = Object.fromEntries(c.expected.forbidden_inferences.map((_, i) => [`${c.case_id}:forbidden:${i + 1}`, { mapping_version: 'test-only/1', violated: i === 0 }]));
  assert.equal(compareCase(c, { forbidden_checks: checked }).safety_gate, 'unadjudicated', 'predictions cannot supply their own grading authority');
  const predicateManifest=Object.fromEntries(Object.keys(checked).map((id)=>[id,'test-only/1']));
  assert.equal(compareCase(c, { forbidden_checks: checked }, { predicateManifest }).safety_gate, 'unadjudicated');
  assert.equal(compareCase(c, { forbidden_checks: checked }, { predicateManifest }).forbidden[0].status, 'attested_violation');
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
test('all expected revision, UTC time, transport identity and missing-region attributes participate in matching', () => {
  for(const [caseId,field] of [['T20','revision'],['T21','occurred_at_utc'],['T18','canonical_event_identity'],['T16','missing']]) {
    const c=cases.find((x)=>x.case_id===caseId),gold=c.expected.entities.find((e)=>Object.hasOwn(e,field));
    for(const mutation of ['missing','wrong']) {const got=structuredClone(gold);if(mutation==='missing')delete got[field];else got[field]='wrong';
      assert.equal(compareCase(c,{entities:[got]}).matched_entities,0,`${caseId}.${field} ${mutation}`);}
  }
});
test('edges require their own supporting event; duplicate, empty IDs and unresolved endpoints reject outputs', () => {
  const c=cases[7],good={entities:structuredClone(c.expected.entities),edges:structuredClone(c.expected.edges)};
  const wrong=structuredClone(good);wrong.edges[0].source_refs=[c.expected.entities[0].source_refs[0]];
  assert.equal(compareCase(c,wrong).missing_edges.length,1);
  for(const mutate of [(o)=>{for(const e of o.entities)e.id='collapsed';for(const e of o.edges)e.from_id=e.to_id='collapsed';},(o)=>{o.entities[0].id='';},(o)=>{o.edges[0].to_id='missing';}]) {
    const o=structuredClone(good);mutate(o);assert.equal(compareCase(c,o).matched_entities,0);assert.equal(compareCase(c,o).safety_gate,'invalid_output');
  }
});
test('baseline preserves denial, timeout/unknown uncertainty, per-event partial coverage and native check evidence', () => {
  assert.equal(extractBaseline(cases[14]).entities.find((e)=>e.type==='action').status,'denied');
  for(const result of ['timeout','unknown']){const c=structuredClone(cases[38]);c.input.events[1].result=result;delete c.input.events[1].exit_code;assert.equal(extractBaseline(c).entities.find((e)=>e.type==='action').status,'unknown');}
  for(const n of [15,16])assert.equal(extractBaseline(cases[n]).adapter_coverage.source_complete,false);
  const c=structuredClone(cases[4]);c.input.events[1].command='npm test';const criterion=extractBaseline(c).entities.find((e)=>e.type==='criterion');
  assert.deepEqual(criterion.source_refs.map((r)=>r.event_id),['e1','e2']);
  assert.throws(()=>assertPrimitiveVersions({...BASELINE.primitive_sha256,'steps.mjs':'drift'}),/Frozen primitive version changed/);
});
test('supplied predictions cannot leak coverage/ID text or choose the capability denominator', () => {
  const c=cases[7],o={entities:[{...c.expected.entities[0],id:'PRIVATE TRANSCRIPT SENTINEL'}],supported_types:['goal'],adapter_coverage:{raw:'PRIVATE TRANSCRIPT SENTINEL',omitted:[{event_id:'e1',reason:'PRIVATE TRANSCRIPT SENTINEL'}],available_events:'PRIVATE TRANSCRIPT SENTINEL'}};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trail-predictions-')),file=path.join(dir,'predictions.json');fs.writeFileSync(file,JSON.stringify({T08:o}));
  const text=execFileSync(process.execPath,[new URL('../scripts/work-understanding/run.mjs',import.meta.url).pathname,file],{encoding:'utf8'});
  assert.ok(!text.includes('PRIVATE TRANSCRIPT SENTINEL'));
  const r=JSON.parse(text).reports.find((r)=>r.case_id==='T08');assert.equal(r.capability_manifest,'unavailable');assert.equal(r.safety_gate,'invalid_output');
});
