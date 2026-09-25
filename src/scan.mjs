// Scan transcripts in parallel, reading only what changed since the last scan.
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { discover, loadIndex, saveIndex, writeSession, ensure } from './store.mjs';

const WORKER = new URL('./worker.mjs', import.meta.url);

/** @param {{since?:Date, client?:string, rebuild?:boolean, onSession?:(s:any)=>void, onProgress?:(p:any)=>void}} o */
export async function scan(o = {}) {
  ensure();
  const index = loadIndex(o.rebuild);
  const all = discover(o);
  const todo = all.filter((f) => { const c = index.files[f.file]; return !c || c.size !== f.size || c.mtimeMs !== f.mtimeMs; });
  todo.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first: the view fills with recent work immediately
  const bytes = todo.reduce((a, f) => a + f.size, 0);
  const st = { files: all.length, todo: todo.length, bytes, done: 0, doneBytes: 0, streamed: 0, failures: [], t0: Date.now() };
  const N = Math.max(2, Math.min(8, os.cpus().length - 3));
  const workers = Array.from({ length: Math.min(N, Math.max(1, todo.length)) }, () => new Worker(WORKER));
  let qi = 0;
  await new Promise((resolve) => {
    let live = workers.length; if (!todo.length) return resolve();
    for (const w of workers) {
      const next = () => { if (qi >= todo.length) { live--; w.terminate(); if (!live) resolve(); return; } w.current = todo[qi++]; w.partial = 0; w.postMessage(w.current); };
      w.on('message', (m) => {
        if (m.progress) { w.partial += m.progress; st.streamed += m.progress; o.onProgress?.(st); return; }
        const f = w.current; st.done++; st.doneBytes += f.size; st.streamed -= w.partial; w.partial = 0;
        if (m.ok) { writeSession(m.sess); index.files[f.file] = { size: f.size, mtimeMs: f.mtimeMs, id: m.sess.id }; o.onSession?.(m.sess, st); }
        else st.failures.push({ file: f.file, error: m.error });
        o.onProgress?.(st); next();
      });
      w.on('error', (e) => { st.failures.push({ file: w.current?.file, error: String(e) }); next(); });
      next();
    }
  });
  saveIndex(index);
  st.secs = (Date.now() - st.t0) / 1000;
  return st;
}
