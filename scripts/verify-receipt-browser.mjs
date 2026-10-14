import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
// Optional local browser QA. Uses installed Playwright; never installs it or contacts a model.
const {chromium}=await import(process.env.TRAIL_PLAYWRIGHT_MODULE || 'playwright');
process.env.TRAIL_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'trail-browser-'));
process.env.TRAIL_NO_OPEN='1';process.env.TRAIL_NO_KEYCHAIN='1';
const {syntheticReceipt}=await import('../test/fixtures/inspection.mjs');
const {writeReceipts}=await import('../src/store.mjs');
const {saveTaxonomy}=await import('../src/taxonomy.mjs');
const {serve}=await import('../src/serve.mjs');
const r=syntheticReceipt();r.intent.summary='<script>alert(1)</script> Synthetic retry fix';
writeReceipts('synthetic',[r]);saveTaxonomy({version:'trail-taxonomy/1',revision:7,overrides:{[r.receipt_id]:{outcome:'blocked',criteria:{c1:'unmet',c2:'unmet'},by:'human',at:'2026-10-14T11:00:00Z'}}});
const {server,url}=await serve({port:47473});
const browser=await chromium.launch({executablePath:process.env.TRAIL_CHROMIUM || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const reports=[];
try {
 for(const width of [1280,390,320]){
  const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',(e)=>errors.push(e.message));
  const u=new URL(url);u.pathname='/receipts.html';await page.goto(u.href);
  await page.locator('a.row').click();await page.locator('#detail h2').waitFor();
  assert.match(await page.locator('#detail').innerText(),/blocked/);
  assert.match(await page.locator('#detail').innerText(),/Acceptance: pending/);
  assert.equal(await page.locator('#detail script').count(),0);
  await page.locator('summary').filter({hasText:'UNMET · Typecheck'}).click();
  assert.ok(await page.getByText('No supporting evidence attached.').isVisible());
  await page.locator('summary').filter({hasText:'UNMET · Tests'}).click();
  assert.ok(await page.getByText('Measured proof: pass',{exact:false}).isVisible());
  assert.ok(await page.getByText('Criterion source quotation:',{exact:true}).first().isVisible());
  assert.match(await page.locator('#detail').innerText(),/original criterion status: met/);
  await page.locator('#query').fill('outcome:blocked unmet:typecheck');await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('1 of 1'));
  await page.getByRole('button',{name:'Clear',exact:true}).click();await page.goBack();
  await page.waitForFunction(()=>document.querySelector('#query').value.includes('outcome:blocked'));
  await page.reload();await page.locator('#detail h2').waitFor();
  assert.ok(await page.getByRole('heading',{name:'Objective',exact:true}).isVisible());
  await page.getByRole('link',{name:'Back to receipts',exact:true}).click();
  await page.getByText('Select a receipt to inspect its evidence.').waitFor({state:width>700?'visible':'attached'});assert.equal(await page.locator('#detail h2').count(),0);
  await page.goBack();await page.locator('#detail h2').waitFor();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);assert.deepEqual(errors,[]);
  if(process.env.TRAIL_QA_SCREENSHOTS) await page.screenshot({path:path.join(process.env.TRAIL_QA_SCREENSHOTS,`trail-inspection-${width}.png`),fullPage:true});
  reports.push({width,overflow,page_errors:errors.length,correction_visible:true,acceptance_separate:true,back_reload_preserved:true,inert_untrusted_title:true});await page.close();
 }
 const report={source:'synthetic_receipt',reports};if(process.argv[2]) fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();await new Promise((resolve)=>server.close(resolve));}
