// Blind pairwise judgment: for each thread, is the insight from the shallow view or the deep view more specific and useful?
import fs from 'node:fs'; import { spawn } from 'node:child_process';
const pairs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).filter((p) => p.shallow && p.deep);
let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const items = pairs.map((p, i) => { const flip = rnd() < 0.5; return { i, flip, X: flip ? p.deep : p.shallow, Y: flip ? p.shallow : p.deep }; });
const SYSTEM = 'You compare two one-sentence lessons a teammate could take from the same piece of AI agent work. For each pair, pick the one that is more specific and more useful to act on (names the actual cause, file, command or decision), or "same" if neither is better. Reply ONLY with JSON: {"picks":[{"i":<number>,"pick":"X"|"Y"|"same"}]}';
function ask(prompt) { return new Promise((res) => { const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const p = spawn('claude', ['-p', '--model', 'sonnet', '--output-format', 'json', '--system-prompt', SYSTEM, '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config'], { env });
  let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('close', () => { try { const j = JSON.parse(o); res({ picks: JSON.parse(j.result.match(/\{[\s\S]*\}/)[0]).picks, cost: j.total_cost_usd }); } catch { res({ picks: [], cost: 0 }); } }); p.stdin.end(prompt); }); }
const out = []; let cost = 0;
for (let k = 0; k < items.length; k += 10) { const batch = items.slice(k, k + 10);
  for (let tries = 0; tries < 3; tries++) { const r = await ask(batch.map((b) => `Pair ${b.i}\nX: ${b.X}\nY: ${b.Y}`).join('\n\n')); cost += r.cost; if (r.picks.length) { out.push(...r.picks); break; } } }
const t = { deep: 0, shallow: 0, same: 0 };
for (const p of out) { const it = items.find((x) => x.i === p.i); if (!it) continue; if (p.pick === 'same') t.same++; else t[(p.pick === 'X') === it.flip ? 'deep' : 'shallow']++; }
console.log({ judged: out.length, ...t, deep_share_of_decided: +(t.deep / (t.deep + t.shallow)).toFixed(2), cost: +cost.toFixed(2) });
