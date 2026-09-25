// Re-render frozen evidence for existing batches after an evidence-format change, and drop jury labels made on the old
// evidence (they judged different text). Gold labels are never touched. Usage: node lab/refreeze.mjs --version 2
import fs from 'node:fs';
import path from 'node:path';
import { L, safeName, readSession, renderEvidence } from './lib.mjs';
const version = +(process.argv[process.argv.indexOf('--version') + 1] || 2);
let n = 0, dropped = 0; const cache = new Map();
for (const f of fs.readdirSync(L.batches).filter((x) => x.endsWith('.json'))) {
  const p = path.join(L.batches, f); const b = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const it of b.items) {
    let s = cache.get(it.file); if (!s) { s = await readSession(it.file, it.client); cache.set(it.file, s); if (cache.size > 20) cache.delete(cache.keys().next().value); }
    fs.writeFileSync(path.join(L.evidence, safeName(it.key) + '.txt'), renderEvidence(s, it.spans)); n++;
    for (const m of fs.existsSync(L.jury) ? fs.readdirSync(L.jury) : []) { const j = path.join(L.jury, m, safeName(it.key) + '.json'); if (fs.existsSync(j)) { fs.renameSync(j, j + `.v${version - 1}`); dropped++; } }
  }
  b.evidenceVersion = version; fs.writeFileSync(p, JSON.stringify(b, null, 1));
}
console.log(`re-rendered ${n} evidence files (v${version}); set aside ${dropped} jury labels made on older evidence`);
