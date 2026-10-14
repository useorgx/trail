import {test} from 'node:test';import assert from 'node:assert/strict';
import {routineCandidateFixture,candidateInvalidationFixture,promotionPlanFixture,qualityBarFixture,barApplicabilityFixture} from '../lab/understanding/reuse-candidates.mjs';
const scope={workspace_id:'workspace:A',repository_id:'repo:atlas'},dependencies={tool:'tool/1',quality_bar:'bar/1'};
const draft=()=>({candidate_id:'routine:release',revision:1,scope,trigger:'Atlas release only',prerequisites:['Approved release task'],steps:['Run smoke tests','Tag only after a recorded pass'],inputs:['Release commit'],outputs:['Check record','Tag reference'],exclusions:['One-time docs exception requires separate scope'],tool_requirements:['Release tools require per-action authorization'],dependencies});
const example=(id,family=id)=>({example_id:id,family_id:family,provider_event_id:'event:'+id,scope,event_role:'tool',result:'success',coverage:'complete',source_revision:'source/1',artifact_revision:'commit:'+id});
const examples=[example('a'),example('b')],current={scope,dependencies};
test('one example, copied families and duplicate transport do not establish repeated independent reuse',()=>{
 for(const xs of [[example('a')],[example('a','same'),example('b','same')],[example('a'),{...example('b'),provider_event_id:'event:a'}]]){const c=routineCandidateFixture(draft(),xs);assert.equal(c.readiness,'insufficient_or_conflicting_evidence');assert.equal(c.activation_status,'unsupported');}
});
test('successful repetition creates only an inert evaluation candidate; scope and exceptions stay bounded',()=>{
 const c=routineCandidateFixture(draft(),examples);assert.equal(c.readiness,'request_evaluation');assert.equal(c.status,'draft');assert.equal(c.review_status,'unreviewed');assert.deepEqual(c.exclusions,draft().exclusions);
 assert.equal(candidateInvalidationFixture(c,examples,{scope:{...scope,repository_id:'repo:beacon'},dependencies}).eligible_for_suggestion,false);
 assert.throws(()=>routineCandidateFixture({...draft(),approved_by:'producer'},examples),{code:'invalid_or_authority_bearing_candidate'});
});
test('assistant claims, denied/failed runs, missing revisions and partial evidence are counterexamples, not support',()=>{
 for(const patch of [{event_role:'assistant'},{result:'denied'},{result:'failure'},{result:'unknown'},{coverage:'partial'},{source_revision:null},{artifact_revision:null}]){
 const c=routineCandidateFixture(draft(),[example('a'),{...example('b'),...patch}]);assert.equal(c.readiness,'insufficient_or_conflicting_evidence');assert.equal(c.counterexamples.length,1);}
});
test('source deletion/correction/retraction, tool drift and evaluation regression invalidate selection without erasing history',()=>{
 const c=routineCandidateFixture(draft(),examples),original=JSON.stringify(c);
 for(const xs of [[],[example('a'),{...example('b'),retracted:true}],[example('a'),{...example('b'),corrected:true}],[example('a'),{...example('b'),source_revision:'source/2'}]])assert.equal(candidateInvalidationFixture(c,xs,current).eligible_for_suggestion,false);
 assert.equal(candidateInvalidationFixture(c,examples,{...current,dependencies:{...dependencies,tool:'tool/2'}}).eligible_for_suggestion,false);
 assert.equal(candidateInvalidationFixture(c,examples,{...current,evaluation_regression:true}).eligible_for_suggestion,false);assert.equal(JSON.stringify(c),original);
 assert.equal(candidateInvalidationFixture(c,[...examples,{...example('later'),result:'failure'}],current).eligible_for_suggestion,false);
 assert.equal(candidateInvalidationFixture(c,[example('a'),{...example('b'),family_id:'a'}],current).eligible_for_suggestion,false);
});
test('evaluation binds exact candidate hash/scope and held-out families; even a positive plan grants no activation',()=>{
 const c=routineCandidateFixture(draft(),examples),evaluation={candidate_hash:c.content_hash,scope,held_out_families:true};
 assert.equal(promotionPlanFixture(c,{evaluation,current,examples}).status,'request_authorized_human_review');assert.equal(promotionPlanFixture(c,{evaluation,current,examples}).eligible_for_activation,false);
 for(const e of [{...evaluation,candidate_hash:'wrong'},{...evaluation,scope:{...scope,workspace_id:'workspace:B'}},{...evaluation,held_out_families:false}])assert.equal(promotionPlanFixture(c,{evaluation:e,current,examples}).status,'insufficient_evaluation');
});
test('quality bars require observable criteria and cannot carry producer approval or retroactive breach',()=>{
 const input={set_id:'bar:release',version:1,scope,criteria:[{id:'c1',text:'Smoke tests pass',required:true,acceptance_test:'Named smoke suite succeeds at the release revision',evidence_type:'check_output',verifier:'named_check_runner',applicability:'Atlas release only'}],review_condition:'Tool or release process changes'},bar=qualityBarFixture(input);
 assert.throws(()=>qualityBarFixture({...input,agreed_by:'claimed-human'}),{code:'invalid_or_authority_bearing_bar'});
 assert.throws(()=>qualityBarFixture({...input,criteria:[{...input.criteria[0],acceptance_test:''}]}),{code:'unobservable_or_duplicate_criterion'});
 const work={scope,agreed_bar:{set_id:bar.set_id,version:bar.version,content_hash:bar.content_hash}};assert.equal(barApplicabilityFixture(work,bar).status,'draft_comparison_only');
 assert.equal(barApplicabilityFixture(work,qualityBarFixture({...input,version:2})).breach_asserted,false);assert.equal(barApplicabilityFixture(work,qualityBarFixture({...input,version:2})).status,'not_the_agreed_version');
});
