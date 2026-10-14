// Inert candidate/quality-bar fixtures. No human authentication, deployment, installation or execution.
import { digest } from './contracts.mjs';
const fail=(code)=>{const e=new Error(code);e.code=code;throw e;};
const text=(v)=>typeof v==='string'&&v.trim().length>0;
const strings=(v)=>Array.isArray(v)&&v.every(text);
const sameScope=(a,b)=>a?.workspace_id===b?.workspace_id&&a?.repository_id===b?.repository_id;
const allowed=(v,keys)=>!Object.keys(v).some((k)=>!keys.includes(k));
const knownScope=(v)=>text(v?.workspace_id)&&text(v?.repository_id);
const qualified=(e,scope)=>sameScope(e.scope,scope)&&e.event_role==='tool'&&e.result==='success'&&e.coverage==='complete'&&!e.retracted&&!e.corrected&&text(e.source_revision)&&text(e.artifact_revision);

export function routineCandidateFixture(input,examples) {
  const keys=['candidate_id','revision','scope','trigger','prerequisites','steps','inputs','outputs','exclusions','tool_requirements','dependencies'];
  if(!allowed(input,keys)||!text(input.candidate_id)||!Number.isSafeInteger(input.revision)||input.revision<1||!knownScope(input.scope)||!text(input.trigger)||!['prerequisites','steps','inputs','outputs','exclusions','tool_requirements'].every((k)=>strings(input[k]))||!input.steps.length)fail('invalid_or_authority_bearing_candidate');
  if(!input.dependencies||Array.isArray(input.dependencies)||!['tool','quality_bar'].every((k)=>text(input.dependencies[k]))||Object.values(input.dependencies).some((v)=>!text(v)))fail('unpinned_dependencies');
  const ids=new Set();for(const e of examples){if(!text(e.example_id)||!text(e.family_id)||!text(e.provider_event_id)||ids.has(e.example_id))fail('invalid_example_identity');ids.add(e.example_id);}
  const selected=examples.filter((e)=>sameScope(e.scope,input.scope)),families=new Set(),transport=new Set();
  for(const e of selected.filter((e)=>qualified(e,input.scope)))if(!transport.has(e.provider_event_id)){transport.add(e.provider_event_id);families.add(e.family_id);}
  const counterexamples=selected.filter((e)=>!qualified(e,input.scope)).map((e)=>({example_id:e.example_id,reason:e.retracted?'retracted':e.corrected?'corrected':e.coverage!=='complete'?'partial_or_unknown_coverage':e.event_role!=='tool'?'non_tool_claim':e.result!=='success'?'failed_denied_or_unknown':'missing_revision'}));
  const value={schema_version:'org.orgx.understanding/v1',type:'routine_candidate',status:'draft',...structuredClone(input),
    source_versions:selected.map((e)=>({example_id:e.example_id,source_revision:e.source_revision??null,artifact_revision:e.artifact_revision??null,provider_event_id:e.provider_event_id,family_id:e.family_id})),counterexamples,
    declared_independent_families:families.size,evaluation_status:'not_evaluated',review_status:'unreviewed',activation_status:'unsupported',
    readiness:families.size>=2&&!counterexamples.length?'request_evaluation':'insufficient_or_conflicting_evidence'};
  return {...value,content_hash:digest(JSON.stringify(value))};
}
export function candidateInvalidationFixture(candidate,examples,current) {
  const reasons=[];if(!sameScope(candidate.scope,current.scope))reasons.push('scope_changed');
  for(const[k,v]of Object.entries(candidate.dependencies))if(current.dependencies?.[k]!==v)reasons.push('dependency_changed');
  if(examples.filter((e)=>sameScope(e.scope,candidate.scope)).some((e)=>!candidate.source_versions.some((old)=>old.example_id===e.example_id)))reasons.push('new_relevant_evidence');
  for(const old of candidate.source_versions){const e=examples.find((e)=>e.example_id===old.example_id);
    if(!e)reasons.push('source_unavailable');else if(e.retracted||e.corrected||e.source_revision!==old.source_revision||e.artifact_revision!==old.artifact_revision||e.provider_event_id!==old.provider_event_id||e.family_id!==old.family_id||!qualified(e,candidate.scope))reasons.push('source_corrected_retracted_or_changed');}
  if(current.evaluation_regression===true)reasons.push('evaluation_regression');
  return {eligible_for_suggestion:!reasons.length,eligible_for_activation:false,reasons:[...new Set(reasons)],rollback:'future_selection_only; external actions require separate authorization'};
}
export function promotionPlanFixture(candidate,{evaluation,current,examples}) {
  const invalidation=candidateInvalidationFixture(candidate,examples,current);
  if(!invalidation.eligible_for_suggestion)return {status:'invalidated',...invalidation};
  if(candidate.readiness!=='request_evaluation'||evaluation?.candidate_hash!==candidate.content_hash||!sameScope(evaluation?.scope,candidate.scope)||evaluation?.held_out_families!==true)return {status:'insufficient_evaluation',eligible_for_activation:false};
  return {status:'request_authorized_human_review',candidate_hash:candidate.content_hash,eligible_for_activation:false,approval:'not_recorded',activation:'unsupported'};
}
export function qualityBarFixture(input) {
  if(!allowed(input,['set_id','version','scope','criteria','review_condition'])||!text(input.set_id)||!Number.isSafeInteger(input.version)||input.version<1||!knownScope(input.scope)||!Array.isArray(input.criteria)||!input.criteria.length)fail('invalid_or_authority_bearing_bar');
  const ids=new Set();for(const c of input.criteria){if(!allowed(c,['id','text','required','acceptance_test','evidence_type','verifier','applicability'])||!text(c.id)||ids.has(c.id)||!text(c.text)||typeof c.required!=='boolean'||!text(c.acceptance_test)||!text(c.evidence_type)||!text(c.verifier)||!text(c.applicability))fail('unobservable_or_duplicate_criterion');ids.add(c.id);}
  const value={schema_version:'org.orgx.understanding/v1',type:'criterion_set',status:'draft',...structuredClone(input),agreement:'not_authenticated'};
  return {...value,content_hash:digest(JSON.stringify(value))};
}
export function barApplicabilityFixture(work,bar) {
  if(!sameScope(work.scope,bar.scope))return {status:'out_of_scope',breach_asserted:false};
  if(work.agreed_bar?.set_id!==bar.set_id||work.agreed_bar?.version!==bar.version||work.agreed_bar?.content_hash!==bar.content_hash)return {status:'not_the_agreed_version',breach_asserted:false};
  return {status:'draft_comparison_only',breach_asserted:false,agreement_authority:'requires_separate_authenticated_record'};
}
