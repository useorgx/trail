// Cost of the step + goal layers: same sessions read with threads only vs threads + steps + goals.
import { discover } from '../../src/store.mjs'; import { readSession } from '../../src/clients.mjs';
import { threadify } from '../../src/classify.mjs'; import { steps } from '../../src/steps.mjs'; import { buildGoals } from '../../src/goals.mjs';
const files = discover().filter((f) => f.client === 'claude' || f.client === 'codex').sort((a, b) => b.size - a.size).slice(0, 120);
const read = []; let t = performance.now(); for (const f of files) read.push(await readSession(f.file, f.client)); const tRead = performance.now() - t;
t = performance.now(); const rs = read.map((s) => threadify(s)); const tThreads = performance.now() - t;
t = performance.now(); let nSteps = 0; read.forEach((s, k) => { const st = steps(s, { reasoning: s.reasoning || [] }); nSteps += st.length; buildGoals(s, rs[k], st); }); const tGoals = performance.now() - t;
console.log({ sessions: files.length, MB: Math.round(files.reduce((a, f) => a + f.size, 0) / 1e6), read_s: +(tRead / 1e3).toFixed(1), threads_ms: Math.round(tThreads), steps_goals_ms: Math.round(tGoals), steps: nSteps, us_per_step: +((tGoals * 1000) / nSteps).toFixed(1) });
