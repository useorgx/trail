// The labeling bench: node lab/serve.mjs [--port 4748] [--blind]
// Serves one thread at a time from 127.0.0.1, behind a launch token and a Host check.
// About 1 in 10 items is a hidden repeat of something you labeled earlier (always shown blind).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { L, ensureLab, safeName, allBatchItems, readJSONL, appendJSONL, goldByKey } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = +arg('port', 4748); const BLIND = process.argv.includes('--blind');
const token = process.env.TRAIL_TOKEN || crypto.randomBytes(12).toString('hex');
ensureLab();
const PAGE = fs.readFileSync(new URL('./label.html', import.meta.url), 'utf8');
const MODELS = ['haiku', 'sonnet', 'opus'];
const jury = (it) => MODELS.map((m) => { try { return { model: m, ...JSON.parse(fs.readFileSync(path.join(L.jury, m, safeName(it.key) + '.json'), 'utf8')).label }; } catch { return null; } }).filter(Boolean);
const vote = (xs) => { const c = {}; for (const x of xs) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]; };

function next() {
  const items = allBatchItems(); const { gold, repeats, all } = goldByKey();
  // Most informative first: threads where the jury splits, then the rest. Unanimous items go fast with the prefill.
  const split = (i) => { const j = jury(i); if (j.length < 2) return 0; return ['boundary', 'origin', 'status'].reduce((a, f) => a + (new Set(j.map((x) => x[f])).size - 1), 0); };
  const fresh = items.filter((i) => !gold.has(i.key)).map((i) => [i, split(i)]).sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const sinceRepeat = all.length - (all.map((g) => g.repeat).lastIndexOf(true) + 1);
  const repeatable = all.filter((g) => !g.repeat).slice(0, -15).filter((g) => !repeats.some((r) => r.key === g.key));
  let it = null, repeat = false;
  if (sinceRepeat >= 9 && repeatable.length) { const g = repeatable[Math.floor(Math.random() * repeatable.length)]; it = items.find((i) => i.key === g.key); repeat = !!it; }
  if (!it) it = fresh[0];
  if (!it) return { done: true, labeled: gold.size };
  const j = jury(it); const blind = BLIND || repeat;
  const prefill = blind || !j.length ? null : { boundary: vote(j.map((x) => x.boundary)), origin: vote(j.map((x) => x.origin)), status: vote(j.map((x) => x.status)), title: j.find((x) => x.model === 'opus')?.title || j[0].title };
  return { key: it.key, repeat, blind, project: it.project, client: it.client, start: it.start, split: it.split, siblings: it.siblings, pred: it.pred,
    evidence: fs.readFileSync(path.join(L.evidence, safeName(it.key) + '.txt'), 'utf8'), jury: blind ? [] : j, prefill,
    progress: { labeled: gold.size, left: fresh.length, repeats: repeats.length, total: items.length } };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const hostOk = req.headers.host === `127.0.0.1:${PORT}` || req.headers.host === `localhost:${PORT}`;
  if (!hostOk || u.searchParams.get('k') !== token) { res.writeHead(403).end('forbidden'); return; }
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); }
  else if (u.pathname === '/next') json(next());
  else if (u.pathname === '/label' && req.method === 'POST') {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      try { const b = JSON.parse(body); if (!b.key || !b.origin || !b.status || !b.boundary) throw new Error('missing field');
        appendJSONL(L.gold, { key: b.key, at: new Date().toISOString(), boundary: b.boundary, origin: b.origin, status: b.status, title_ok: !!b.title_ok, title: String(b.title || '').slice(0, 120), note: String(b.note || '').slice(0, 500), repeat: !!b.repeat, blind: !!b.blind, prefill: b.prefill || null, seconds: +b.seconds || null });
        json({ ok: true }); } catch (e) { res.writeHead(400).end(String(e)); }
    });
  } else res.writeHead(404).end();
});
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/?k=${token}`;
  console.log(`  Labeling bench: ${url}\n  Gold labels → ${L.gold}`);
  if (!process.env.TRAIL_NO_OPEN && process.platform === 'darwin') execFile('open', [url]);
});
