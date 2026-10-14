// Synthetic before/after evidence only. Uses a new temporary store, never the user's history.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
process.env.TRAIL_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'trail-parity-'));
process.env.TRAIL_NO_KEYCHAIN='1';
const { syntheticReceipt }=await import('../test/fixtures/inspection.mjs');
const { writeReceipts }=await import('../src/store.mjs');
const { saveTaxonomy }=await import('../src/taxonomy.mjs');
const { ledger, rowOf, withGraph }=await import('../src/ledger.mjs');
const { receiptDetail, search, workstreamDetail }=await import('../src/search.mjs');
const r=syntheticReceipt(),a=syntheticReceipt('earlier');
a.timestamps.started_at='2026-10-13T10:00:00Z';a.timestamps.completed_at='2026-10-13T10:01:00Z';
for(const x of [a,r])x.artifacts.push({id:'synthetic-pr',kind:'pull_request',role:'output',name:'PR #55',ref:{system:'github',type:'pull_request',id:'55'}});
writeReceipts('synthetic',[a,r]);saveTaxonomy({version:'trail-taxonomy/1',revision:7,overrides:{[r.receipt_id]:{outcome:'blocked',criteria:{c2:'unmet'},by:'human',at:'2026-10-14T11:00:00Z'}}});
const L=ledger({fresh:true}),row=rowOf(r,L),d=receiptDetail(r.receipt_id,L),exported=withGraph(r,L),w=workstreamDetail(row.workstream,L);
console.log(JSON.stringify({synthetic:true,source_head:execFileSync('git',['rev-parse','HEAD'],{cwd:new URL('..',import.meta.url),encoding:'utf8'}).trim(),
  original:{outcome:r.outcome.status,criterion:r.extensions['org.orgx.trail/v1'].criteria[1].status,acceptance:r.outcome.acceptance.status},
  resolved:{row:row.outcome,detail:d.outcome_detail.status,export:exported.outcome.status,workstream:w.status,
    detail_criterion:d.criteria[1].status,export_criterion:exported.outcome.criteria_results[1].status,
    corrected_search_matches:search('outcome:blocked unmet:typecheck',{L}).total,stale_search_matches:search('outcome:succeeded unmet:typecheck',{L}).total,
    acceptance:d.acceptance.status,review_revision:d.review_revision},coverage:d.coverage,
  limits:['local correction only; no authenticated workspace acceptance','not an extraction accuracy or sync-convergence measurement']},null,2));
