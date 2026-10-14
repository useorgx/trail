// Draft local fixtures only: no provider calls, spend, discovery, cache writes or runtime integration.
import { digest, representation, validateSpan, validateProposal } from './contracts.mjs';
const fail=(code)=>{const e=new Error(code);e.code=code;throw e;};
const text=(v)=>typeof v==='string'&&v.trim().length>0;
const uint=(v)=>Number.isSafeInteger(v)&&v>=0;
const freeze=(v)=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
export function semanticManifest({workspace_id,privacy_scope,privacy_version,versions,sources,spans=[],mode='read',capabilities=[]}) {
  if(![workspace_id,privacy_scope,privacy_version].every(text)||!['read','draft_proposal'].includes(mode)||!Array.isArray(sources)||sources.length>50||!Array.isArray(spans)||spans.length>100)fail('invalid_manifest');
  const required=['provider','model','prompt','schema','extractor','ontology'];if(!versions||required.some((k)=>!text(versions[k])))fail('unpinned_versions');
  if(!Array.isArray(capabilities)||capabilities.some((c)=>!['choice_classification','typed_slots'].includes(c)))fail('unsupported_capability_descriptor');
  const seen=new Set(),input=sources.map((s)=>{if(s.workspace_id!==workspace_id||!text(s.source_revision)||seen.has(s.source_event_id))fail('source_scope_or_revision');seen.add(s.source_event_id);const r=representation(s);return {source_event_id:s.source_event_id,source_revision:s.source_revision,representation_hash:r.hash,representation_version:r.version,role:s.role??null,actor_id:s.actor_id??null,source_id:s.source_id??null};});
  for(const ref of spans){const s=sources.find((s)=>s.source_event_id===ref.source_event_id);if(!s)fail('source_unavailable');validateSpan(ref,s);}
  const value={schema_version:'org.orgx.understanding/v1',workspace_id,privacy_scope,privacy_version,versions:Object.fromEntries(required.map((k)=>[k,versions[k]])),input,spans:structuredClone(spans),mode,capabilities:[...capabilities]};
  return freeze({...value,cache_key:digest(JSON.stringify(value))});
}
export function abstention(field,reason) {
  if(!text(field)||!['source_unavailable','unsupported_capability','insufficient_evidence','canceled','budget_exhausted'].includes(reason))fail('invalid_abstention');
  return {field,basis:'unknown',review:'unreviewed',reason,authority:'proposal_only'};
}
export function validateModelProposal(proposal,sources) {
  const allowed=['schema_version','entity_id','revision','type','scope','choice','status','actor_id','rationale','alternatives','epistemic','unknown_fields','supports','extractor','event_time'];
  if(Object.keys(proposal).some((k)=>!allowed.includes(k)))fail('model_cannot_supply_authority');
  return validateProposal(proposal,sources);
}
export function inputStillCurrent(manifest,sources) {
  return sources.length===manifest.input.length&&manifest.input.every((old)=>{const s=sources.find((s)=>s.source_event_id===old.source_event_id);return !!s&&s.workspace_id===manifest.workspace_id&&s.source_revision===old.source_revision&&representation(s).hash===old.representation_hash&&(s.role??null)===old.role&&(s.actor_id??null)===old.actor_id&&(s.source_id??null)===old.source_id;});
}

// Budget units are synthetic fixture units, not a provider price or actual billing record.
export function budgetFixture({max_calls,max_cost_units,max_input_tokens,max_output_tokens,max_concurrent}) {
  if(![max_calls,max_cost_units,max_input_tokens,max_output_tokens,max_concurrent].every(uint))fail('invalid_budget');
  return {limits:{max_calls,max_cost_units,max_input_tokens,max_output_tokens,max_concurrent},requests:{},planned_calls:0,spent_units:0,reserved_units:0,stop:false,reason:null};
}
export function reserveFixture(state,{request_id,input_tokens,max_output_tokens,max_cost_units,manifest_key}) {
  if(!text(request_id)||!/^\w[\w.:-]{0,159}$/.test(request_id)||['__proto__','constructor','prototype'].includes(request_id)||!text(manifest_key)||![input_tokens,max_output_tokens,max_cost_units].every(uint))fail('invalid_reservation');
  if(state.stop)fail('run_stopped');if(Object.hasOwn(state.requests,request_id))fail('request_already_reserved_or_unreconciled');
  const inFlight=Object.values(state.requests).filter((r)=>['reserved','ambiguous','cancel_requested'].includes(r.status)).length,l=state.limits;
  if(state.planned_calls>=l.max_calls||state.spent_units+state.reserved_units+max_cost_units>l.max_cost_units||input_tokens>l.max_input_tokens||max_output_tokens>l.max_output_tokens||inFlight>=l.max_concurrent)fail('budget_exhausted');
  const s=structuredClone(state);s.requests[request_id]={status:'reserved',max_cost_units,manifest_key};s.planned_calls++;s.reserved_units+=max_cost_units;return s;
}
export function cancelFixture(state) {const s=structuredClone(state);s.stop=true;s.reason='canceled';for(const r of Object.values(s.requests))if(r.status==='reserved')r.status='cancel_requested';return s;}
export function settleFixture(state,request_id,{billing,actual_cost_units}) {
  const s=structuredClone(state);if(!Object.hasOwn(s.requests,request_id))fail('unknown_request');const r=s.requests[request_id];
  if(r.status==='settled')return s;
  if(billing==='unknown'){r.status='ambiguous';s.stop=true;s.reason='billing_unknown';return s;}
  if(billing!=='known'||!uint(actual_cost_units))fail('invalid_billing');
  s.reserved_units-=r.max_cost_units;s.spent_units+=actual_cost_units;r.status='settled';r.actual_cost_units=actual_cost_units;
  if(actual_cost_units>r.max_cost_units){s.stop=true;s.reason='provider_bound_violation';}
  return s;
}
export function planFixtureCall(manifest,state,request,capability,sources) {
  if(manifest.mode==='read')return {state,planned_calls:0,abstention:abstention(capability,'unsupported_capability')};
  if(!manifest.capabilities.includes(capability))return {state,planned_calls:0,abstention:abstention(capability,'unsupported_capability')};
  if(!inputStillCurrent(manifest,sources))return {state,planned_calls:0,abstention:abstention(capability,'source_unavailable')};
  return {state:reserveFixture(state,{...request,manifest_key:manifest.cache_key}),planned_calls:1,transport:'none_fixture_only'};
}
