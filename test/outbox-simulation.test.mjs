import {test} from 'node:test';import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {buildReceipt} from '../src/receipt.mjs';
import {emptySimulation,enqueueSimulation,simulatedAdmission,acknowledgeSimulation,acknowledgeBatchSimulation,failureSimulation,eligibleSimulation,applySyntheticTombstone} from '../lab/understanding/outbox-simulation.mjs';
const receipt=(summary='Synthetic request')=>buildReceipt({client:'synthetic',id:'outbox'}, {root:'T1',spans:[[0,0]],outcome:{kind:'open'},conf:{}},[{at:0,kind:'ask',who:'human',ts:'2026-10-14T10:00:00Z',text:summary}],{ask:summary});
const enqueue=(s=emptySimulation(),opts={})=>enqueueSimulation(s,{workspace_id:'workspace:A',producer_id:'producer:synthetic',receipt:receipt(),producer_revision:1,expected_server_revision:0,privacy_version:'privacy:1',...opts});
test('timeout after synthetic commit retries identical bytes/key and has one logical effect',()=>{
  const {state,operation_key:k}=enqueue(),first=simulatedAdmission(state,k,{lose_response:true});assert.equal(first.state.effects,1);
  const restarted=JSON.parse(JSON.stringify(first.state)),second=simulatedAdmission(restarted,k),done=acknowledgeSimulation(second.state,second.ack);
  assert.equal(done.effects,1);assert.equal(done.items[k].status,'acknowledged');assert.equal(done.items[k].wire_bytes,state.items[k].wire_bytes);
  assert.deepEqual(acknowledgeSimulation(done,second.ack),done);
});
test('partial/reordered batch acks are matched by operation identity; missing records remain pending',()=>{
  const a=enqueue(),b=enqueue(a.state,{receipt:{...receipt(),receipt_id:'synthetic:other'}}),one=simulatedAdmission(b.state,a.operation_key),two=simulatedAdmission(one.state,b.operation_key);
  const partial=acknowledgeBatchSimulation(two.state,[two.ack]);assert.equal(partial.items[a.operation_key].status,'in_flight');assert.equal(partial.items[b.operation_key].status,'acknowledged');
  const done=acknowledgeBatchSimulation(partial,[one.ack,two.ack]);assert.equal(done.effects,2);assert.equal(done.items[a.operation_key].status,'acknowledged');
});
test('malformed, cross-tenant, wrong hash/revision and positional acks never dequeue work',()=>{
  const a=enqueue(),sent=simulatedAdmission(a.state,a.operation_key);
  for(const bad of [null,{},0,{...sent.ack,workspace_id:'workspace:B'},{...sent.ack,producer_revision:2},{...sent.ack,wire_hash:'wrong'},{...sent.ack,server_receipt_id:''}])assert.notEqual(acknowledgeSimulation(sent.state,bad).items[a.operation_key].status,'acknowledged');
  assert.notEqual(acknowledgeBatchSimulation(sent.state,{0:sent.ack}).items[a.operation_key].status,'acknowledged');
});
test('payload/key binding, privacy versions and workspace scopes remain immutable and distinct',()=>{
  const a=enqueue();assert.match(a.operation_key,/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/);
  const altered=structuredClone(a.state);altered.items[a.operation_key].wire_bytes=JSON.stringify(receipt('Changed request'));assert.throws(()=>simulatedAdmission(altered,a.operation_key),{code:'immutable_payload_changed'});
  const changed=enqueue(emptySimulation(),{receipt:receipt('Changed request')});altered.items[a.operation_key].wire_hash=changed.state.items[changed.operation_key].wire_hash;assert.throws(()=>simulatedAdmission(altered,a.operation_key),{code:'immutable_payload_changed'});
  const integrityOnly=structuredClone(a.state),wire=JSON.parse(integrityOnly.items[a.operation_key].wire_bytes);wire.integrity.content_hash.value='changed';integrityOnly.items[a.operation_key].wire_bytes=JSON.stringify(wire);integrityOnly.items[a.operation_key].wire_bytes_hash=crypto.createHash('sha256').update(integrityOnly.items[a.operation_key].wire_bytes).digest('hex');assert.throws(()=>simulatedAdmission(integrityOnly,a.operation_key),{code:'immutable_payload_changed'});
  assert.notEqual(enqueue(a.state,{workspace_id:'workspace:B'}).operation_key,a.operation_key);assert.notEqual(enqueue(a.state,{privacy_version:'privacy:2'}).operation_key,a.operation_key);
});
test('a new synthetic producer revision preserves prior judgment history rather than overwriting it',()=>{
 const a=enqueue(),one=simulatedAdmission(a.state,a.operation_key),s=structuredClone(one.state),entity=s.items[a.operation_key].entity;
 s.server[entity].human_history=[{actor_id:'synthetic-reviewer',reviewed_revision:1,status:'accepted'}];
 const b=enqueue(s,{producer_revision:2,expected_server_revision:1,receipt:receipt('Later evidence')}),two=simulatedAdmission(b.state,b.operation_key);
 assert.deepEqual(two.state.server[entity].human_history,s.server[entity].human_history);assert.equal(two.state.server[entity].server_revision,2);
});
test('stale/reordered producer revisions conflict rather than replacing newer state',()=>{
  const a=enqueue(),accepted=simulatedAdmission(a.state,a.operation_key),b=enqueue(accepted.state,{producer_revision:2,expected_server_revision:1,receipt:receipt('Newer request')}),newer=simulatedAdmission(b.state,b.operation_key);
  const stale=enqueue(newer.state,{producer_revision:1,expected_server_revision:0,receipt:receipt('Late old request')});assert.equal(simulatedAdmission(stale.state,stale.operation_key).refusal,'revision_conflict');
});
test('source absence is not deletion and synthetic tombstones block old replicas/acks',()=>{
  const a=enqueue(),sent=simulatedAdmission(a.state,a.operation_key),t=applySyntheticTombstone(sent.state,{workspace_id:'workspace:A',receipt_id:receipt().receipt_id,server_revision:2});
  assert.notEqual(acknowledgeSimulation(t,sent.ack).items[a.operation_key].status,'acknowledged');assert.equal(simulatedAdmission(t,a.operation_key).refusal,'tombstone_predecessor');
  assert.equal(JSON.parse(JSON.stringify(sent.state)).items[a.operation_key].status,'in_flight','omitting a source scan performs no deletion transition');
});
test('Retry-After seconds/date, restart, attempt caps and refusals remain bounded',()=>{
  const a=enqueue(),sent=simulatedAdmission(a.state,a.operation_key,{lose_response:true}),now=Date.parse('2026-10-14T10:00:00Z');
  for(const retry_after of ['120','Wed, 14 Oct 2026 10:02:00 GMT']){const s=failureSimulation(sent.state,a.operation_key,{status:429,retry_after,now});assert.equal(s.items[a.operation_key].retry_at,now+120000);assert.equal(eligibleSimulation(JSON.parse(JSON.stringify(s)),a.operation_key,now),false);assert.throws(()=>simulatedAdmission(s,a.operation_key,{now}),{code:'retry_not_ready'});}
  for(const [status,expected]of [[401,'paused_auth'],[403,'paused_auth'],[402,'paused_quota'],[422,'quarantined'],[409,'conflict']]){const s=failureSimulation(sent.state,a.operation_key,{status,now});assert.equal(s.items[a.operation_key].status,expected);assert.equal(eligibleSimulation(s,a.operation_key,now),false);assert.equal(failureSimulation(s,a.operation_key,{status:500,now}).items[a.operation_key].status,expected,'a late transient failure cannot resume a paused operation');}
  for(const retry_after of ['9'.repeat(400),'99999999999999999999'])assert.equal(Number.isFinite(failureSimulation(sent.state,a.operation_key,{status:429,retry_after,now}).items[a.operation_key].retry_at),true);
  let s=sent.state;for(let i=0;i<2;i++)s=simulatedAdmission(s,a.operation_key,{lose_response:true}).state;assert.equal(eligibleSimulation(s,a.operation_key,now),false);assert.throws(()=>simulatedAdmission(s,a.operation_key),{code:'attempt_cap'});
});
