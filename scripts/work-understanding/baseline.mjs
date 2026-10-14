// Frozen native primitives only; no test-specific semantic enrichment and no Jev cache access.
// Compact cases frequently omit native command/adapter fields: that is an explicit replay gap.
import { stepFacts } from '../../src/steps.mjs';
import { extractIntent, checkCriteria } from '../../src/receipt.mjs';
export const BASELINE = { source_commit: '7090314ac1e5355bd0249d33a7b9b02299ab0011', adapter_version: 'native-primitives/1',
  vocabulary: { met: 'satisfied', unmet: 'unsatisfied', pass: 'succeeded', ok: 'succeeded', fail: 'failed', pending: 'pending_or_unknown', denied: 'blocked' } };
export function extractBaseline(c) {
  const entities = [], native = []; const refs = (e) => [{ event_id: e.event_id, quote: e.text, basis: 'observed' }];
  const omitted = [];
  for (const e of c.input.events) {
    if (e.role === 'tool') {
      const f=stepFacts({ tool:e.tool || 'tool', target:e.command || '', out:e.text,
        err:typeof e.exit_code === 'number' && e.exit_code !== 0 || e.result === 'failure', pending:e.result === 'pending' });
      native.push({ at:native.length, kind:'tool', target:e.command || '', tool:e.tool || 'tool', out:e.text, ...f, source:e });
      entities.push({id:`action:${e.event_id}`,type:'action',status:BASELINE.vocabulary[f.result],source_refs:refs(e)});
    } else if (e.role === 'user') native.push({at:native.length,kind:'ask',text:e.text,source:e});
    else if (e.role === 'assistant') native.push({at:native.length,kind:'say',text:e.text,source:e});
    else omitted.push({event_id:e.event_id,reason:'native_primitive_adapter_does_not_support_role'});
  }
  for (const e of c.input.events.filter((e)=>e.role==='user')) {
    const intent=extractIntent(e.text);
    for (const criterion of checkCriteria(intent.criteria,native,(s)=>s.source.event_id)) {
      entities.push({id:`criterion:${e.event_id}:${criterion.id}`,type:'criterion',status:BASELINE.vocabulary[criterion.status] || criterion.status,
        text:criterion.text,source_refs:refs(e),native_kind:criterion.kind});
    }
    for (const [i,text] of intent.constraints.entries()) entities.push({id:`constraint:${e.event_id}:${i}`,type:'constraint',status:'active',text,source_refs:refs(e)});
  }
  return {entities,edges:[],supported_types:['action','criterion','constraint'],forbidden_checks:{},
    adapter_coverage:{available_events:c.input.events.length,processed_events:c.input.events.length-omitted.length,omitted,
      missing_native_commands:c.input.events.filter((e)=>e.role==='tool' && !e.command).length,
      source_complete:c.input.source_complete ?? null},baseline:BASELINE};
}
