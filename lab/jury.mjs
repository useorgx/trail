// A jury of models pre-labels each thread against the codebook, citing event numbers.
// It proposes; only a human label is gold. Usage: node lab/jury.mjs [--models haiku,sonnet,opus] [--batch batch-001.json] [--par 4]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { L, ensureLab, safeName, allBatchItems, ORIGINS, STATUSES, BOUNDARIES } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const MODELS = arg('models', 'haiku,sonnet,opus').split(','); const PAR = +arg('par', 4); const only = arg('batch');
ensureLab();
const codebook = fs.readFileSync(new URL('./codebook.md', import.meta.url), 'utf8');
const SCHEMA = JSON.stringify({ type: 'object', additionalProperties: false, required: ['boundary', 'origin', 'status', 'title_ok', 'title', 'evidence', 'confidence'], properties: {
  boundary: { type: 'string', enum: BOUNDARIES }, origin: { type: 'string', enum: ORIGINS }, status: { type: 'string', enum: STATUSES },
  title_ok: { type: 'boolean' }, title: { type: 'string', description: 'best plain title, max 10 words' },
  evidence: { type: 'string', description: 'event numbers and a few words for each label, e.g. "status: [41] PR merged; origin: [3] person asked"' },
  confidence: { type: 'integer', minimum: 1, maximum: 5 } } });
const SYSTEM = `You label one thread of AI coding-agent work using this codebook. Decide only from the events shown.\n\n${codebook}`;

function ask(model, prompt) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
    const p = spawn('claude', ['-p', '--model', model, '--output-format', 'json', '--json-schema', SCHEMA, '--system-prompt', SYSTEM, '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config'], { env });
    let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 300e3);
    p.on('close', () => { clearTimeout(timer); try { const j = JSON.parse(out); if (!j.structured_output) throw new Error(j.result || 'no output'); resolve({ label: j.structured_output, cost: j.total_cost_usd || 0 }); } catch (e) { reject(new Error((err || out || String(e)).slice(-300))); } });
    p.stdin.end(prompt);
  });
}

const items = allBatchItems().filter((i) => !only || i.batch === only);
const jobs = [];
for (const m of MODELS) { fs.mkdirSync(path.join(L.jury, m), { recursive: true }); for (const it of items) { const f = path.join(L.jury, m, safeName(it.key) + '.json'); if (!fs.existsSync(f)) jobs.push({ m, it, f }); } }
console.log(`${jobs.length} jury calls to make (${items.length} threads × ${MODELS.join('/')}, cached ones skipped)`);
let done = 0, cost = 0, failed = 0; const t0 = Date.now();
async function worker() {
  while (jobs.length) {
    const { m, it, f } = jobs.shift();
    const evidence = fs.readFileSync(path.join(L.evidence, safeName(it.key) + '.txt'), 'utf8');
    const prompt = `Session in ${it.project} (${it.client}). Other threads in this session: ${it.siblings.join(' | ')}\n\nEvents this thread owns ("~" = context before it, not part of it):\n${evidence}`;
    try { const r = await ask(m, prompt); cost += r.cost; fs.writeFileSync(f, JSON.stringify({ model: m, at: new Date().toISOString(), ...r })); }
    catch (e) { failed++; if (failed <= 3) console.error(`  ${m} ${it.key}: ${e.message.slice(0, 160)}`); }
    done++; if (done % 10 === 0) process.stdout.write(`\r  ${done} done · $${cost.toFixed(2)} · ${failed} failed · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
await Promise.all(Array.from({ length: PAR }, worker));
console.log(`\n  finished: ${done} calls · $${cost.toFixed(2)} · ${failed} failed`);
