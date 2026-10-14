// Frozen native primitives only; no test-specific semantic enrichment and no Jev cache access.
// Compact cases frequently omit native command/adapter fields: that is an explicit replay gap.
import { stepFacts } from '../../src/steps.mjs';
import { extractIntent, checkCriteria } from '../../src/receipt.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
export const BASELINE = { source_commit: '7090314ac1e5355bd0249d33a7b9b02299ab0011', adapter_version: 'native-primitives/1',
  adapter_manifest: { supported_types: ['action','criterion','constraint'] },
  primitive_sha256: { 'steps.mjs':'a876360ad9b40cb6c0a7855c30a33eabda98a99ab8e3e410632d665bfc464312', 'receipt.mjs':'f24049772c4bfc3767cc150c01f8650e7612670238bc53e32d0ea958119fd715' },
  vocabulary: { met: 'satisfied', unmet: 'unsatisfied', pass: 'succeeded', ok: 'succeeded', fail: 'failed', pending: 'pending_or_unknown', denied: 'denied' } };
export function extractBaseline(c) {
  assertPrimitiveVersions();
  const entities = [], native = []; const refs = (e) => [{ event_id: e.event_id, quote: e.text, basis: 'observed' }];
  const omitted = [];
  for (const e of c.input.events) {
    if (e.role === 'tool') {
      const f=stepFacts({ tool:e.tool || 'tool', target:e.command || '', out:e.text,
        denied:e.result==='denied',err:typeof e.exit_code === 'number' && e.exit_code !== 0 || ['failure','failed'].includes(e.result),pending:['pending','unknown','timeout'].includes(e.result) });
      native.push({ at:native.length, kind:'tool', target:e.command || '', tool:e.tool || 'tool', out:e.text, ...f, source:e });
      entities.push({id:`action:${e.event_id}`,type:'action',status:['unknown','timeout'].includes(e.result)?'unknown':BASELINE.vocabulary[f.result],source_refs:refs(e)});
    } else if (e.role === 'user') native.push({at:native.length,kind:'ask',text:e.text,source:e});
    else if (e.role === 'assistant') native.push({at:native.length,kind:'say',text:e.text,source:e});
    else omitted.push({event_id:e.event_id,reason:'native_primitive_adapter_does_not_support_role'});
  }
  for (const e of c.input.events.filter((e)=>e.role==='user')) {
    const intent=extractIntent(e.text);
    for (const criterion of checkCriteria(intent.criteria,native,(s)=>s.source.event_id)) {
      entities.push({id:`criterion:${e.event_id}:${criterion.id}`,type:'criterion',status:BASELINE.vocabulary[criterion.status] || criterion.status,
        text:criterion.text,source_refs:[...refs(e),...criterion.evidence_ids.filter((id)=>id!==e.event_id).map((id)=>c.input.events.find((event)=>event.event_id===id)).filter(Boolean).flatMap(refs)],native_kind:criterion.kind});
    }
    for (const [i,text] of intent.constraints.entries()) entities.push({id:`constraint:${e.event_id}:${i}`,type:'constraint',status:'active',text,source_refs:refs(e)});
  }
  return {entities,edges:[],supported_types:['action','criterion','constraint'],forbidden_checks:{},
    adapter_coverage:{available_events:c.input.events.length,processed_events:c.input.events.length-omitted.length,omitted,
      missing_native_commands:c.input.events.filter((e)=>e.role==='tool' && !e.command).length,
      source_complete:c.input.events.some((e)=>e.source_complete===false)?false:c.input.events.every((e)=>e.source_complete===true)?true:null,
      source_event_completeness:c.input.events.map((e)=>({event_id:e.event_id,complete:e.source_complete ?? null}))},baseline:BASELINE};
}
export function assertPrimitiveVersions(actual = Object.fromEntries(Object.keys(BASELINE.primitive_sha256).map((name)=>[name,crypto.createHash('sha256').update(fs.readFileSync(new URL(`../../src/${name}`,import.meta.url))).digest('hex')]))) {
  for(const [name,hash] of Object.entries(BASELINE.primitive_sha256)) if(actual[name]!==hash) throw new Error(`Frozen primitive version changed: ${name}; create a new experiment version.`);
}
