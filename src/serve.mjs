// `trail open`: the ledger view in your browser, served from this machine only.
// Bound to 127.0.0.1, guarded by a per-launch token and a Host check (no DNS rebinding).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSessions, loadAdoptions, P } from './store.mjs';
import { corpus } from './metrics.mjs';
import { ruleFor } from './adopt.mjs';
import { actionFor, effectText } from './actions.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');

export function ledgerData() {
  const sessions = loadSessions(); const K = corpus(sessions, loadAdoptions());
  const projects = {}; const threads = [];
  for (const s of sessions) {
    projects[s.project] = (projects[s.project] || 0) + s.threads.length;
    for (const t of s.threads) threads.push([s.id, t.id, s.client, s.project, Date.parse(t.t0 || s.start) || 0, Date.parse(t.t1 || s.end || s.start) || 0, t.status, t.origin === 'surprise' ? (t.kind || 'found') : t.origin, t.title, t.moves.slice(0, 160), t.backs.length, t.p_abandon ?? -1]);
  }
  return { threads, projects, tot: K.tot, weeks: K.weeks, walls: K.walls.slice(0, 40).map((w) => ({ sig: w.sig, name: w.name, sessions: w.sessions, calls: w.calls, first: w.first, last: w.last, weeks: w.weeks, clients: w.clients, projects: w.projects, samples: w.samples, rule: ruleFor(w), adopted: w.adopted || null, effect: effectText(w.adopted), action: actionFor(w) })) };
}

export async function serve({ port = 4747 } = {}) {
  const token = process.env.TRAIL_TOKEN || crypto.randomBytes(12).toString('hex');
  const okHost = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!okHost(req.headers.host) || u.searchParams.get('k') !== token) { res.writeHead(403).end('forbidden'); return; }
    const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body); };
    if (u.pathname === '/') send('text/html; charset=utf-8', fs.readFileSync(WEB, 'utf8'));
    else if (u.pathname === '/data.json') send('application/json', JSON.stringify(ledgerData()));
    else if (u.pathname === '/thread') {
      const sid = (u.searchParams.get('s') || '').replace(/[^\w-]/g, ''); const tid = (u.searchParams.get('t') || '').replace(/[^\w]/g, '');
      try { const s = JSON.parse(fs.readFileSync(path.join(P.sessions, sid + '.json'), 'utf8')); const t = s.threads.find((x) => x.id === tid); const { feat, ...rest } = t || {}; send('application/json', JSON.stringify({ ...rest, project: s.project, client: s.client, sessionThreads: s.threads.map((x) => [x.id, x.title, x.status, x.origin]) })); }
      catch { res.writeHead(404).end('{}'); }
    } else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${port}/?k=${token}`;
  console.log(`  Ledger view: ${url}\n  Served from this machine only. Ctrl-C to stop.`);
  if (process.env.TRAIL_NO_OPEN) return { server, url };
  if (process.platform === 'darwin') execFile('open', [url]); else if (process.platform === 'linux') execFile('xdg-open', [url], () => {});
  return { server, url };
}
