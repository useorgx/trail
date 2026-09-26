// One worker = one transcript at a time: read → threads → model → compact session record.
import { parentPort } from 'node:worker_threads';
import path from 'node:path';
import { setByteListener } from './adapters.mjs';
import { readSession } from './clients.mjs';
import { threadify } from './classify.mjs';
import { decide } from './decide.mjs';

let acc = 0;
setByteListener((n) => { acc += n; if (acc > 8e6) { parentPort.postMessage({ progress: acc }); acc = 0; } });


parentPort.on('message', async ({ file, client }) => {
  acc = 0;
  try {
    const s = await readSession(file, client);
    const r = threadify(s);
    const sess = {
      id: s.id || path.basename(file).replace(/\.jsonl$/, '').slice(-36), client, file,
      project: (s.cwd || '').split('/').filter(Boolean).slice(-1)[0] || '—', cwd: s.cwd, model: s.model, mode: s.mode,
      start: s.start, end: s.end, asks: s.ev.filter((e) => e.k === 'ask').length,
      tools: r.tools, errs: r.errs, denied: r.denied, compactions: r.compactions, steers: r.steers, walls: r.walls,
      threads: r.threads.map((t) => decide({ id: t.id, origin: t.origin, kind: t.kind, title: t.title, ask: t.ask, notes: t.notes, moves: t.moves, backs: t.backs, status: t.status, claim: t.claim, subj: t.subj, errs: t.errs, parent: t.parent, t0: t.t0, t1: t.t1, spans: t.spans || [], feat: t.feat })),
    };
    parentPort.postMessage({ ok: true, sess });
  } catch (err) { parentPort.postMessage({ ok: false, error: String(err).slice(0, 200) }); }
});
