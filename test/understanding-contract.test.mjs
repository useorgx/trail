import {test} from 'node:test';import assert from 'node:assert/strict';
import {digest,cite,validateSpan,validateProposal,explicitChoiceCandidate,orderEvents,canonicalArtifactKey,checkApplies,recordedTransition} from '../lab/understanding/contracts.mjs';
const event=(id,text='Choose option B.')=>({source_event_id:id,workspace_id:'workspace:synthetic',source_id:'source:synthetic',role:'user',redacted_text:text});
test('redacted UTF-8 spans bind exact representation and reject old offsets, wrong hashes and split Unicode',()=>{
  const e=event('e1','😀 Choice B'),ref=cite(e);assert.ok(validateSpan(ref,e));
  assert.throws(()=>validateSpan({...ref,start:1},e),{code:'span_utf8_boundary'});
  assert.throws(()=>validateSpan({...ref,quote_hash:digest('wrong')},e),{code:'quote_mismatch'});
  assert.throws(()=>validateSpan(ref,{...e,redacted_text:'[redacted] Choice B'}),{code:'representation_mismatch'});
});
test('explicit choice keeps missing rationale/alternatives/actor unknown and grants no judgment or operational authority',()=>{
  const e=event('e1'),p=explicitChoiceCandidate(e,{entity_id:'decision:synthetic',workspace_id:e.workspace_id});
  assert.equal(p.rationale,null);assert.equal(p.alternatives,null);assert.equal(p.actor_id,null);assert.equal(validateProposal(p,[e]).authority,'proposal_only');
  assert.throws(()=>validateProposal({...p,epistemic:{...p.epistemic,review:'accepted'}},[e]),{code:'producer_cannot_supply_judgment'});
  assert.throws(()=>validateProposal({...p,type:'skill_deployment'},[e]),{code:'operational_layer_requires_separate_contract'});
  assert.throws(()=>validateProposal({...p,scope:{workspace_id:'workspace:other'}},[e]),{code:'cross_workspace_support'});
});
test('quotes, hypothetical choices, denied sources and attachment instructions abstain',()=>{
  for(const e of [event('e1','If needed, choose option B.'),event('e2','"Choose option B."'),{...event('e3'),role:'attachment'},{...event('e4'),trusted_as_instruction:false}])assert.equal(explicitChoiceCandidate(e,{entity_id:'decision:test',workspace_id:e.workspace_id}),null);
});
test('chronology preserves null times and explicit causality despite clock skew, and rejects cycles',()=>{
  const a={...event('e1'),event_time:'2026-10-14T11:00:00Z',clock_reliability:'trusted'},b={...event('e2'),event_time:'2026-10-14T10:00:00Z',clock_reliability:'trusted',caused_by:['e1']},c=event('e3');
  const r=orderEvents([b,c,a]);assert.ok(r.ordered.findIndex((e)=>e.source_event_id==='e1')<r.ordered.findIndex((e)=>e.source_event_id==='e2'));assert.equal(r.ordered.find((e)=>e.source_event_id==='e3').event_time,null);assert.equal(r.clock_conflicts.length,1);
  assert.throws(()=>orderEvents([{...a,caused_by:['e2']},b]),{code:'causal_cycle'});
  assert.deepEqual(orderEvents([a,b,c]).ordered.map((e)=>e.source_event_id),r.ordered.map((e)=>e.source_event_id));
});
test('as-known filtering differs from event time; unavailable recorded time is an explicit gap',()=>{
  const r=orderEvents([{...event('e1'),event_time:'2026-10-01T10:00:00Z',recorded_at:'2026-10-14T11:00:00Z'},event('e2')],{asKnownAt:'2026-10-14T10:00:00Z'});
  assert.equal(r.ordered.length,0);assert.equal(r.coverage.status,'partial');assert.deepEqual(r.omitted.map((x)=>x.reason),['not_known_as_of','unknown_recorded_time']);
});
test('mixed trusted and unknown clocks have deterministic display order across input permutations',()=>{
  const a={...event('a'),event_time:'2026-10-14T11:00:00Z',clock_reliability:'trusted'},b={...event('c'),event_time:'2026-10-14T10:00:00Z',clock_reliability:'trusted'},c=event('b');
  const expected=orderEvents([a,b,c]).ordered.map((e)=>e.source_event_id);
  for(const xs of [[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]])assert.deepEqual(orderEvents(xs).ordered.map((e)=>e.source_event_id),expected);
});
test('artifact proof binds hosting/repository/object/revision; mentions and failed actions never become transitions',()=>{
  const a={host:'github.com',repository_id:'repo:atlas',kind:'pr',object_id:'17',revision:'aaaaaaa'},b={...a,repository_id:'repo:beacon'};
  assert.notEqual(canonicalArtifactKey(a),canonicalArtifactKey(b));assert.throws(()=>canonicalArtifactKey({kind:'file',object_id:'src/a.ts'}),{code:'canonical_repository_identity_required'});
  const check={status:'passed',revision:'aaaaaaa',artifact_key:canonicalArtifactKey(a)};assert.equal(checkApplies(check,a),true);assert.equal(checkApplies(check,{...a,revision:'bbbbbbb'}),false);
  assert.equal(recordedTransition({role:'assistant',operation:'deploy',result:'success'}).status,'unknown');assert.equal(recordedTransition({role:'tool',operation:'deploy',result:'success',exit_code:1}).status,'unknown');
  assert.equal(recordedTransition({role:'tool',operation:'pr_create',result:'success'}).status,'created');
});
