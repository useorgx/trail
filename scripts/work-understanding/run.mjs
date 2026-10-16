import fs from 'node:fs';
import { readCorpus, corpusManifest } from './corpus.mjs';
import { compareCase, safeAdapterCoverage } from './adapter.mjs';
import { extractBaseline, BASELINE } from './baseline.mjs';
const manifest=corpusManifest();
if(manifest.issues.length){console.error(JSON.stringify(manifest));process.exit(1);}
const supplied=process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2],'utf8')) : null;
const adapterManifest=process.argv[3]?JSON.parse(fs.readFileSync(process.argv[3],'utf8')):supplied?{}:BASELINE.adapter_manifest;
const reports=readCorpus().map((c)=>{const output=supplied?.[c.case_id] ?? (supplied ? {} : extractBaseline(c));return {...compareCase(c,output,{adapterManifest}),adapter_coverage:safeAdapterCoverage(output?.adapter_coverage,c)};});
console.log(JSON.stringify({manifest,mode:supplied?'supplied_predictions':'native_primitive_diagnostic',baseline:supplied?null:BASELINE,
  accuracy_claim:false,semantic_safety_gate:'unadjudicated',reports},null,2));
