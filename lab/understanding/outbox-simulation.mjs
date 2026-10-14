// Inert protocol simulation. JSON snapshots are NOT filesystem crash durability or real server reconciliation.
// Uses existing portable receipt canonicalization; no IO, credentials, HTTP, DB or application integration.
import crypto from 'node:crypto';
import { receiptFingerprint } from '../../src/integrity.mjs';
const hash=(v)=>crypto.createHash('sha256').update(v).digest('hex');
const scopeKey=(workspace,id)=>hash(JSON.stringify([workspace,id]));
const copy=(s)=>structuredClone(s);
const fail=(code)=>{const e=new Error(code);e.code=code;throw e;};
const nonempty=(s)=>typeof s==='string'&&s.trim().length>0;
const operationKey=(i)=>`trail:${hash(JSON.stringify([i.workspace_id,i.producer_id,i.receipt_id,i.producer_revision,i.expected_server_revision,i.privacy_version,i.wire_bytes_hash])).slice(0,40)}:${i.wire_hash}`;
export const emptySimulation=()=>({items:{},server:{},tombstones:{},effects:0,notices:[]});

export function enqueueSimulation(state,{workspace_id,producer_id,receipt,producer_revision,expected_server_revision,privacy_version}) {
  if(!nonempty(workspace_id)||!nonempty(producer_id)||!nonempty(receipt?.receipt_id)||!nonempty(privacy_version)||!Number.isSafeInteger(producer_revision)||producer_revision<1||!Number.isSafeInteger(expected_server_revision)||expected_server_revision<0)fail('invalid_operation');
  const s=copy(state),wire_bytes=JSON.stringify(receipt),wire_hash=receiptFingerprint(receipt),wire_bytes_hash=hash(wire_bytes),entity=scopeKey(workspace_id,receipt.receipt_id);
  const operation_key=operationKey({workspace_id,producer_id,receipt_id:receipt.receipt_id,producer_revision,expected_server_revision,privacy_version,wire_hash,wire_bytes_hash});
  const old=s.items[operation_key];if(old&&old.wire_bytes!==wire_bytes)fail('key_reused_with_different_bytes');
  if(!old)s.items[operation_key]={operation_key,entity,workspace_id,producer_id,receipt_id:receipt.receipt_id,producer_revision,expected_server_revision,privacy_version,wire_bytes,wire_hash,wire_bytes_hash,status:'pending',attempts:0,retry_at:null,ack:null};
  return {state:s,operation_key};
}

export function simulatedAdmission(state,key,{lose_response=false,now=null}={}) {
  const s=copy(state),item=s.items[key];if(!item)fail('unknown_operation');
  if(['paused_auth','paused_quota','quarantined','conflict','canceled'].includes(item.status))fail('operation_paused');
  if(item.status==='acknowledged')return {state:s,ack:item.ack};
  if(item.retry_at!==null&&(!Number.isFinite(now)||now<item.retry_at))fail('retry_not_ready');
  if(item.attempts>=3)fail('attempt_cap');item.attempts++;
  if(receiptFingerprint(JSON.parse(item.wire_bytes))!==item.wire_hash||hash(item.wire_bytes)!==item.wire_bytes_hash||key!==operationKey(item)||item.receipt_id!==JSON.parse(item.wire_bytes).receipt_id||item.entity!==scopeKey(item.workspace_id,item.receipt_id))fail('immutable_payload_changed');
  const current=s.server[item.entity],tombstone=s.tombstones[item.entity];
  // No restoration command/authority exists in this fixture. A tombstone blocks all new
  // admission, including an equal or newer predecessor, until a separately reviewed restore contract exists.
  if(tombstone){item.status='conflict';return {state:s,refusal:'tombstone_requires_authorized_restore'};}
  let ack=current?.operations?.[key];
  if(!ack){
    const producer=hash(item.producer_id);
    if((current?.server_revision??0)!==item.expected_server_revision || item.producer_revision!==(current?.producer_revisions?.[producer]??0)+1){item.status='conflict';return {state:s,refusal:'revision_conflict'};}
    ack={operation_key:key,workspace_id:item.workspace_id,producer_id:item.producer_id,receipt_id:item.receipt_id,producer_revision:item.producer_revision,wire_hash:item.wire_hash,server_receipt_id:`synthetic:${item.entity}`,server_revision:(current?.server_revision??0)+1};
    s.server[item.entity]={...current,producer_revisions:{...current?.producer_revisions,[producer]:item.producer_revision},server_revision:ack.server_revision,operations:{...current?.operations,[key]:ack}};s.effects++;
  }
  item.status=lose_response?'ambiguous':'in_flight';return {state:s,...(lose_response?{refusal:'response_unknown'}:{ack})};
}

export function acknowledgeSimulation(state,ack) {
  const s=copy(state);if(!ack||typeof ack!=='object'||!Object.hasOwn(s.items,ack.operation_key)){s.notices.push('unknown_or_malformed_ack');return s;}
  const item=s.items[ack.operation_key],expected=s.server[item.entity]?.operations?.[ack.operation_key];
  const keys=['operation_key','workspace_id','producer_id','receipt_id','producer_revision','wire_hash','server_receipt_id','server_revision'];
  if(!expected||keys.some((k)=>ack[k]!==expected[k])){s.notices.push('ack_binding_mismatch');return s;}
  if(s.tombstones[item.entity]?.server_revision>=ack.server_revision){s.notices.push('superseded_ack');return s;}
  if(item.status!=='acknowledged'){item.ack=copy(ack);item.status='acknowledged';}return s;
}
export function acknowledgeBatchSimulation(state,acks) {
  if(!Array.isArray(acks))return {...copy(state),notices:[...state.notices,'malformed_batch']};
  return acks.reduce(acknowledgeSimulation,state);
}

export function failureSimulation(state,key,{status,retry_after,now,jitter=0.5,quota=false}) {
  if(!Number.isFinite(now)||!Number.isFinite(jitter)||jitter<0||jitter>1)fail('invalid_retry_clock');const s=copy(state),item=s.items[key];if(!item)fail('unknown_operation');
  if(['acknowledged','paused_auth','paused_quota','quarantined','conflict','canceled','paused_attempt_cap'].includes(item.status))return s;
  if(status===401||status===403)item.status='paused_auth';
  else if(quota||status===402)item.status='paused_quota';
  else if(status===400||status===422)item.status='quarantined';
  else if(status===409)item.status='conflict';
  else if(item.attempts>=3)item.status='paused_attempt_cap';
  else {
    const parsed=typeof retry_after==='string'&&/^\d+(\.\d+)?$/.test(retry_after)?Number(retry_after):null;
    const seconds=parsed!==null&&Number.isFinite(parsed)&&Number.isSafeInteger(Math.ceil(now+parsed*1000))?parsed:null;
    const date=typeof retry_after==='string'&&seconds===null?Date.parse(retry_after):NaN;
    const backoff=Math.min(30000,1000*2**Math.max(0,item.attempts-1))*(0.5+jitter);
    item.retry_at=seconds!==null?now+seconds*1000:Number.isFinite(date)&&date>now?date:now+backoff;item.status='pending';
  }
  return s;
}
export function eligibleSimulation(state,key,now){const i=state.items[key];return !!i&&['pending','ambiguous'].includes(i.status)&&i.attempts<3&&(i.retry_at===null||i.retry_at<=now);}
export function applySyntheticTombstone(state,{workspace_id,receipt_id,server_revision}) {
  // This fixture input models an authoritative feed record, not producer-supplied permission.
  if(!nonempty(workspace_id)||!nonempty(receipt_id)||!Number.isSafeInteger(server_revision)||server_revision<1)fail('invalid_tombstone');
  const s=copy(state),entity=scopeKey(workspace_id,receipt_id),old=s.tombstones[entity];
  if(!old||server_revision>old.server_revision)s.tombstones[entity]={server_revision};return s;
}
