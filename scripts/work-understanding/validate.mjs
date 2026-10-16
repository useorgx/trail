import { corpusManifest } from './corpus.mjs';
const report = corpusManifest(process.argv[2]);
console.log(JSON.stringify(report, null, 2));
if (report.issues.length) process.exitCode = 1;
