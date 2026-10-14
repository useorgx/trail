// Draft, inert contract exercises. Not imported by scan, reads, sync or the distributed package.
// Inputs must already be privacy-authorized redacted representations with supplied persistent IDs.
import crypto from 'node:crypto';
export const DRAFT_CONTRACT = 'org.orgx.understanding/v1';
export const digest = (value) => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(v);
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const time = (v) => v === null || v === undefined ? null : typeof v === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : fail('invalid_timestamp');

export function representation(event) {
  if (!id(event.source_event_id) || typeof event.redacted_text !== 'string') fail('invalid_source');
  const bytes = Buffer.from(event.redacted_text, 'utf8'); if (bytes.length > 65536) fail('source_limit');
  return { version: 'redacted-representation/1', hash: digest(bytes), bytes };
}
export function cite(event, start = 0, end = Buffer.byteLength(event.redacted_text)) {
  const r = representation(event);
  const ref = { source_event_id: event.source_event_id, representation_hash: r.hash, start, end, offset_unit: 'utf8_byte', quote_hash: digest(r.bytes.subarray(start,end)) };
  validateSpan(ref,event); return ref;
}
export function validateSpan(ref,event) {
  const r = representation(event);
  if (ref.source_event_id !== event.source_event_id || ref.representation_hash !== r.hash || ref.offset_unit !== 'utf8_byte') fail('representation_mismatch');
  if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0 || ref.end <= ref.start || ref.end > r.bytes.length) fail('span_bounds');
  const bytes = r.bytes.subarray(ref.start,ref.end);
  try { new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { fail('span_utf8_boundary'); }
  if (digest(bytes) !== ref.quote_hash) fail('quote_mismatch'); return true;
}

export function validateProposal(proposal, sources) {
  if (proposal.schema_version !== DRAFT_CONTRACT || !id(proposal.entity_id) || !Number.isSafeInteger(proposal.revision) || proposal.revision < 1) fail('invalid_assertion_identity');
  const e=proposal.epistemic || {};
  if (!['observed','inferred','unknown'].includes(e.basis) || e.review !== 'unreviewed' || !['current','conflict','superseded','retracted'].includes(e.resolution)) fail('producer_cannot_supply_judgment');
  if (!id(proposal.scope?.workspace_id)) fail('workspace_scope_required');
  if (!['intent','criterion','decision','artifact','artifact_version','routine_candidate','skill_deployment','quality_bar_deployment'].includes(proposal.type)) fail('unknown_assertion_type');
  if (proposal.type === 'routine_candidate' && proposal.status !== 'draft') fail('routine_candidate_must_be_inert');
  if (!Array.isArray(proposal.supports) || proposal.supports.length > 20) fail('invalid_supports');
  for (const ref of proposal.supports) { const event=sources.find((e)=>e.source_event_id===ref.source_event_id); if(!event)fail('source_unavailable');
    if(event.workspace_id !== proposal.scope.workspace_id)fail('cross_workspace_support');validateSpan(ref,event); }
  if (!proposal.supports.length && (e.basis !== 'unknown' || proposal.unknown_fields?.supports !== 'source_unavailable')) fail('ungrounded_assertion');
  if (proposal.type === 'decision' && (!proposal.choice || proposal.rationale === undefined || proposal.alternatives === undefined)) fail('decision_missing_explicit_unknowns');
  if (['skill_deployment','quality_bar_deployment'].includes(proposal.type)) fail('operational_layer_requires_separate_contract');
  return { valid:true, validation:'structural_and_exact_span_only', semantic_support:'requires_adjudication', authority:'proposal_only' };
}

// Bounded mechanical candidate for the explicit fixture family; not a general semantic extractor.
export function explicitChoiceCandidate(event, { entity_id, workspace_id }) {
  const m=event.role==='user' && event.trusted_as_instruction!==false && /^Choose option ([A-Za-z0-9-]+)\.$/.exec(event.redacted_text);
  if(!m)return null;
  return { schema_version:DRAFT_CONTRACT,entity_id,revision:1,type:'decision',scope:{workspace_id},
    choice:`Option ${m[1]}`,status:'committed',actor_id:event.actor_id ?? null,rationale:null,alternatives:null,
    epistemic:{basis:'inferred',review:'unreviewed',resolution:'current'},
    unknown_fields:{rationale:'not_stated',alternatives:'not_stated',...(event.actor_id?{}:{actor_id:'ambiguous_actor'})},
    supports:[cite(event)],extractor:{name:'explicit-choice-fixture-rule',version:'draft/1'},event_time:event.event_time ?? null };
}

export function orderEvents(events, { asKnownAt } = {}) {
  if(events.length>500)fail('event_limit');const ids=new Set();
  for(const e of events){if(!id(e.source_event_id)||ids.has(e.source_event_id))fail('duplicate_event_identity');ids.add(e.source_event_id);time(e.event_time);time(e.recorded_at);if((e.caused_by || []).length>20)fail('causal_parent_limit');}
  const cutoff=asKnownAt===undefined?null:time(asKnownAt);
  const selected=events.filter((e)=>cutoff===null || time(e.recorded_at)!==null && time(e.recorded_at)<=cutoff);
  const omitted=events.filter((e)=>!selected.includes(e)).map((e)=>({id:e.source_event_id,reason:e.recorded_at?'not_known_as_of':'unknown_recorded_time'}));
  const byId=new Map(selected.map((e)=>[e.source_event_id,e])),incoming=new Map(selected.map((e)=>[e.source_event_id,0])),children=new Map(),unresolved=[];
  for(const e of selected)for(const p of e.caused_by || []){if(!byId.has(p)){unresolved.push({child:e.source_event_id,parent:p});continue;}
    incoming.set(e.source_event_id,incoming.get(e.source_event_id)+1);children.set(p,[...(children.get(p)||[]),e.source_event_id]);}
  const trusted=(e)=>e.clock_reliability==='trusted'?time(e.event_time):null;
  const compare=(a,b)=>{const ta=trusted(a),tb=trusted(b);if((ta===null)!==(tb===null))return ta===null?1:-1;if(ta!==tb)return ta-tb;
    const source=String(a.source_id || '').localeCompare(String(b.source_id || ''));if(source)return source;
    const sa=Number.isSafeInteger(a.source_sequence)?a.source_sequence:Infinity,sb=Number.isSafeInteger(b.source_sequence)?b.source_sequence:Infinity;if(sa!==sb)return sa-sb;
    return a.source_event_id.localeCompare(b.source_event_id);};
  const ready=selected.filter((e)=>incoming.get(e.source_event_id)===0),ordered=[];
  while(ready.length){ready.sort(compare);const e=ready.shift();ordered.push(e);
    for(const child of children.get(e.source_event_id)||[]){incoming.set(child,incoming.get(child)-1);if(incoming.get(child)===0)ready.push(byId.get(child));}}
  if(ordered.length!==selected.length)fail('causal_cycle');
  const clock_conflicts=[];for(const e of selected)for(const parent of e.caused_by||[]){const p=byId.get(parent);if(p && trusted(p)!==null && trusted(e)!==null && trusted(p)>trusted(e))clock_conflicts.push({parent,child:e.source_event_id});}
  return { ordered:ordered.map((e)=>({...e,event_time:e.event_time ?? null,time_basis:trusted(e)===null?'unknown_or_untrusted':'supplied_trusted',causality_basis:'explicit_parents_only'})),
    coverage:{scope:'provided_events',available_events:events.length,returned_events:ordered.length,status:omitted.length||unresolved.length?'partial':'complete'},omitted,unresolved,clock_conflicts,
    concurrent_order:'ID tie-breaks are display order, not inferred causality' };
}

export function canonicalArtifactKey(ref) {
  if(!id(ref.repository_id)||typeof ref.host!=='string'||!ref.host.trim()||typeof ref.kind!=='string'||!ref.kind.trim()||typeof ref.object_id!=='string'||!ref.object_id.trim())fail('canonical_repository_identity_required');
  return JSON.stringify([ref.host.toLowerCase(),ref.repository_id,ref.kind,ref.object_id]);
}
export function checkApplies(check,artifact) {
  const known=(r)=>typeof r==='string' && r.trim().length>0 && !['unknown','pending','unresolved'].includes(r.toLowerCase());
  return check.status==='passed' && known(check.revision) && known(artifact.revision) && check.revision===artifact.revision && check.artifact_key===canonicalArtifactKey(artifact);
}
export function recordedTransition(event) {
  const transitions={pr_create:'created',pr_merge:'merged',deploy:'deployed',patch:'modified'};
  if(event.role!=='tool' || event.result!=='success' || event.exit_code!==undefined && event.exit_code!==0)return {status:'unknown',reason:'no_successful_tool_record'};
  return {status:typeof event.operation==='string' && Object.hasOwn(transitions,event.operation)?transitions[event.operation]:'unknown',basis:'recorded_tool_metadata',authority:'does_not_establish_acceptance_or_permission'};
}
