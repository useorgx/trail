import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const home = fs.mkdtempSync(path.join(os.tmpdir(),'trail-inspection-'));
process.env.TRAIL_HOME = home; process.env.TRAIL_NO_KEYCHAIN = '1'; process.env.TRAIL_NO_OPEN = '1';
const { syntheticReceipt } = await import('./fixtures/inspection.mjs');
const { projectReviewedWork, ledger, rowOf, withGraph, reviewQueue } = await import('../src/ledger.mjs');
const { receiptDetail, workstreamDetail, search } = await import('../src/search.mjs');
const { writeReceipts } = await import('../src/store.mjs');
const { saveTaxonomy } = await import('../src/taxonomy.mjs');
const { validateAgentWorkReceipt } = await import('@useorgx/agent-work-receipt');
const { buildReceipt, EXT } = await import('../src/receipt.mjs');
const tax = (r, patch) => ({ version:'trail-taxonomy/1',revision:7,overrides:{[r.receipt_id]:{...patch,by:'human',at:'2026-10-14T11:00:00Z'}} });

test('T35: reviewed outcome and criterion agree across row/detail/search/export/workstream', () => {
  const a = syntheticReceipt('earlier'), r = syntheticReceipt();
  a.timestamps.started_at='2026-10-13T10:00:00Z'; a.timestamps.completed_at='2026-10-13T10:01:00Z';
  for (const x of [a,r]) x.artifacts.push({ id:'shared-pr',kind:'pull_request',name:'PR #55',role:'output',ref:{system:'github',type:'pull_request',id:'55'} });
  writeReceipts('synthetic',[a,r]); saveTaxonomy(tax(r,{outcome:'blocked',criteria:{c2:'unmet'}}));
  const L=ledger({fresh:true}); const row=rowOf(r,L), d=receiptDetail(r.receipt_id,L), exported=withGraph(r,L);
  assert.equal(row.outcome,'blocked'); assert.equal(d.outcome_detail.status,'blocked'); assert.equal(exported.outcome.status,'blocked');
  assert.equal(d.criteria[1].status,'unmet'); assert.equal(exported.outcome.criteria_results[1].status,'unmet');
  assert.equal(search('outcome:blocked unmet:typecheck',{L}).total,1);
  assert.equal(search('outcome:succeeded unmet:typecheck',{L}).total,0);
  const w=workstreamDetail(row.workstream,L); assert.equal(w.status,'blocked'); assert.equal(w.members.find((m)=>m.id===r.receipt_id).criteria.unmet,1);
  assert.equal(d.inspection.original.outcome.status,'succeeded'); assert.equal(d.inspection.original.criteria[1].status,'unknown');
  assert.equal(d.acceptance.status,'pending'); assert.equal(exported.outcome.acceptance.status,'pending');
  assert.equal(d.review_revision,7); assert.ok(validateAgentWorkReceipt(exported).ok, JSON.stringify(validateAgentWorkReceipt(exported).issues));
});
test('one corrected field leaves the other review questions open; projection is pure', () => {
  const r=syntheticReceipt(); const before=JSON.stringify(r); const t=tax(r,{criteria:{c1:'met'}});
  const projected=projectReviewedWork(r,t); assert.equal(JSON.stringify(r),before);
  const q=reviewQueue({receipts:[r],tax:t},{limit:20}); assert.ok(q.some((x)=>x.kind==='outcome')); assert.ok(q.some((x)=>x.criterion==='c2'));
  assert.equal(projected.r.verification.status,r.verification.status); assert.equal(projected.inspection.acceptance.workspace_judgment,'unavailable');
});
test('ambiguous suffix is refused for receipt and workstream', () => {
  const a=syntheticReceipt('a'), b=syntheticReceipt('b'); const L={receipts:[a,b],byId:new Map(),built:{workstreams:[{id:'ws_a_end'},{id:'ws_b_end'}]}};
  assert.throws(()=>receiptDetail('T1',L),{code:'AMBIGUOUS_ID'}); assert.throws(()=>workstreamDetail('end',L),{code:'AMBIGUOUS_ID'});
});
test('contrary local criterion corrections do not leave inferred success or permit conflicting wire claims', () => {
  const r=syntheticReceipt(),t=tax(r,{criteria:{c2:'unmet'}}),p=projectReviewedWork(r,t);
  assert.equal(p.r.outcome.status,'partially_succeeded');assert.equal(p.inspection.original.outcome.status,'succeeded');assert.equal(p.inspection.conflicts.length,1);
  const explicit=tax(r,{outcome:'succeeded',criteria:{c2:'unmet'}});
  assert.equal(projectReviewedWork(r,explicit).r.outcome.status,'succeeded','preserve both explicit local calls for review');
  assert.throws(()=>withGraph(r,{tax:explicit,labels:{},built:{byReceipt:{}}}),/Conflicting local/);
});
test('coverage discloses exact cap boundaries and never reconstructs missing source totals', () => {
  const at='2026-10-14T10:00:00Z';
  const build=(tools,messages=0)=>{const st=[{at:0,kind:'ask',text:'Inspect synthetic work',ts:at},...tools.map((x,i)=>({at:i+1,kind:'tool',ts:at,tool:'Bash',action:'run',target:'synthetic',result:'ok',...x})),...Array.from({length:messages},(_,i)=>({at:tools.length+i+1,kind:'say',text:'Recorded statement',ts:at}))];return buildReceipt({client:'synthetic',id:'caps'}, {root:'T1',spans:[[0,st.length]],outcome:{kind:'open'},conf:{}},st,{ask:'Inspect synthetic work'});};
  for(const n of [299,300,301]){const r=build(Array.from({length:n},()=>({})));const c=r.extensions[EXT].coverage;assert.equal(c.sections.actions.total,n);assert.equal(c.sections.actions.returned,Math.min(n,300));assert.equal(c.sections.actions.truncated,n>300);}
  for(const n of [99,100,101]){const r=build(Array.from({length:n},(_,i)=>({action:'edit',target:`src/f${i}.ts`})));assert.equal(r.extensions[EXT].coverage.sections.edited_files.returned,Math.min(n,100));}
  for(const n of [399,400,401]){const r=build([],n-1);assert.equal(r.extensions[EXT].coverage.sections.conversation.total,n);assert.equal(r.extensions[EXT].coverage.sections.conversation.truncated,n>400);}
  const r=syntheticReceipt();delete r.extensions[EXT].coverage;assert.equal(projectReviewedWork(r).inspection.coverage.sections.actions.total,null);
});
test('read API uses the same projection, reports pagination, and retains launch guard', async () => {
  const {serve}=await import('../src/serve.mjs');const {server,url}=await serve({port:47472});
  try{const u=new URL(url);u.pathname='/api/v1/receipts';u.searchParams.set('limit','1');
    assert.equal((await fetch('http://127.0.0.1:47472/api/v1/receipts')).status,403);
    const page=await (await fetch(u)).json();assert.equal(page.coverage.returned,1);assert.equal(page.coverage.truncated,true);assert.equal(page.coverage.next_offset,1);
    u.pathname='/api/v1/receipt';u.searchParams.set('id',syntheticReceipt().receipt_id);const d=await (await fetch(u)).json();assert.equal(d.outcome,'blocked');assert.equal(d.criteria[1].status,'unmet');
    assert.equal((await fetch(u,{method:'POST'})).status,405);
    u.pathname='/receipts.html';assert.equal((await fetch(u)).status,200);
  }finally{server.close();}
});
test('CLI preserves default detail JSON and adds plain summary and source views', () => {
  const cli=new URL('../bin/trail.mjs',import.meta.url).pathname,id=syntheticReceipt().receipt_id;
  const run=(...args)=>execFileSync(process.execPath,[cli,'receipts',id,...args],{encoding:'utf8',env:process.env});
  assert.equal(JSON.parse(run()).outcome,'blocked'); assert.match(run('--view','summary','--plain'),/local human correction/);
  const view=JSON.parse(run('--view','source','--evidence','ev-2','--json'));assert.equal(view.evidence[0].source_availability,'not_loaded');
  assert.throws(()=>run('--view','source','--evidence','missing'));
});
