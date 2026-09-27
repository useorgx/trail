// The labeling bench: node lab/serve.mjs [--port 4748] [--blind] [--form v2]
// Serves one thread at a time from 127.0.0.1, behind a launch token and a Host check.
// About 1 in 10 items is a hidden repeat of something you labeled earlier (always shown blind).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { L, ensureLab, safeName, allBatchItems, appendJSONL, goldByKey } from './lib.mjs';
import { WALLS } from '../src/walls.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = +arg('port', 4748); const BLIND = process.argv.includes('--blind');
const FORM = arg('form', 'v1'); if (!['v1', 'v2'].includes(FORM)) { console.error('Unknown form. Use --form v2, or omit --form for v1.'); process.exit(2); }
// Who is labeling, stated when the bench starts. Only `human` labels count as gold; an agent driving this page
// (Codex, Claude) must be started as itself so its labels stay silver.
const AS = arg('as', ''); if (!/^(human|codex|claude|[a-z][\w.-]{1,40})$/.test(AS)) { console.error('Say who is labeling: node lab/serve.mjs --as human   (or --as codex / --as claude for an agent)'); process.exit(2); }
const token = process.env.TRAIL_TOKEN || crypto.randomBytes(12).toString('hex');
ensureLab();
const PAGE = fs.readFileSync(new URL(FORM === 'v2' ? './label-v2.html' : './label.html', import.meta.url), 'utf8');
const MODELS = ['haiku', 'sonnet', 'opus'];
const jury = (it) => MODELS.map((m) => { try { return { model: m, ...JSON.parse(fs.readFileSync(path.join(L.jury, m, safeName(it.key) + '.json'), 'utf8')).label }; } catch { return null; } }).filter(Boolean);
const vote = (xs) => { const c = {}; for (const x of xs) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]; };

function next() {
  if (FORM === 'v2') return nextV2();
  const items = allBatchItems(); const { gold, repeats, all } = goldByKey({ labeler: AS });
  // Most informative first: threads where the jury splits, then the rest. Unanimous items go fast with the prefill.
  const split = (i) => { const j = jury(i); if (j.length < 2) return 0; return ['boundary', 'origin', 'status'].reduce((a, f) => a + (new Set(j.map((x) => x[f])).size - 1), 0); };
  // Depth batches (the backtrack gold set) come first, then threads where the jury splits.
  const fresh = items.filter((i) => !gold.has(i.key)).map((i) => [i, (i.depth ? 100 : 0) + split(i)]).sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const sinceRepeat = all.length - (all.map((g) => g.repeat).lastIndexOf(true) + 1);
  const repeatable = all.filter((g) => !g.repeat).slice(0, -15).filter((g) => !repeats.some((r) => r.key === g.key));
  let it = null, repeat = false;
  if (sinceRepeat >= 9 && repeatable.length) { const g = repeatable[Math.floor(Math.random() * repeatable.length)]; it = items.find((i) => i.key === g.key); repeat = !!it; }
  if (!it) it = fresh[0];
  if (!it) return { done: true, labeled: gold.size };
  const j = jury(it); const blind = BLIND || repeat;
  const prefill = blind || !j.length ? null : { boundary: vote(j.map((x) => x.boundary)), origin: vote(j.map((x) => x.origin)), status: vote(j.map((x) => x.status)), title: j.find((x) => x.model === 'opus')?.title || j[0].title };
  return { key: it.key, repeat, blind, depth: !!it.depth, project: it.project, client: it.client, start: it.start, split: it.split, siblings: it.siblings, pred: it.pred,
    evidence: fs.readFileSync(path.join(L.evidence, safeName(it.key) + '.txt'), 'utf8'), jury: blind ? [] : j, prefill,
    labeler: AS, progress: { labeled: gold.size, left: fresh.length, repeats: repeats.length, total: items.length } };
}

function nextV2() {
  const items = allBatchItems().filter((i) => i.depth); const { gold, repeats, all } = goldByKey({ labeler: AS, form: 'v2' });
  const fresh = items.filter((i) => !gold.has(i.key));
  const sinceRepeat = all.length - (all.map((g) => g.repeat).lastIndexOf(true) + 1);
  const repeatable = all.filter((g) => !g.repeat).slice(0, -15).filter((g) => !repeats.some((r) => r.key === g.key));
  let it = null, repeat = false;
  if (sinceRepeat >= 9 && repeatable.length) { const g = repeatable[Math.floor(Math.random() * repeatable.length)]; it = items.find((i) => i.key === g.key); repeat = !!it; }
  if (!it) it = fresh[0];
  if (!it) return { done: true, labeled: gold.size };
  return { key: it.key, repeat, blind: BLIND || repeat, depth: true, project: it.project, client: it.client, start: it.start, split: it.split, siblings: it.siblings, pred: it.pred,
    evidence: fs.readFileSync(path.join(L.evidence, safeName(it.key) + '.txt'), 'utf8'), walls: WALLS.map(({ id, name }) => ({ id, name })), labeler: AS,
    progress: { labeled: gold.size, left: fresh.length, repeats: repeats.length, total: items.length } };
}

const SEGMENTATIONS = ['starts_here', 'merge_prev', 'merge_next', 'split_at', 'noise'];
const OUTCOMES = ['shipped_checked', 'shipped_unchecked', 'answered', 'handed_back', 'continued_elsewhere', 'abandoned', 'blocked_wall', 'unclear'];
const ABANDONED_REASONS = ['gave_up', 'superseded', 'person_redirected', 'out_of_scope'];
const ORIGINS = ['asked', 'plan', 'found', 'recovery', 'wall', 'scheduled'];
const TRIGGERS = ['error', 'evidence', 'reasoning', 'person'];
const exactObject = (x, required, optional = []) => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const keys = Object.keys(x); return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
};
const cleanText = (x, max, required = false) => typeof x === 'string' && x.length <= max && (!required || x.trim().length > 0);
const eventNumbers = (it) => new Set([...fs.readFileSync(path.join(L.evidence, safeName(it.key) + '.txt'), 'utf8').matchAll(/^\[(\d+)\][ ~]/gm)].map((m) => +m[1]));
const eventIn = (events, n) => Number.isInteger(n) && events.has(n);

function validateV2(b) {
  const allowed = ['key', 'segmentation', 'outcome', 'backtracks', 'lesson', 'origin', 'title', 'note', 'seconds', 'repeat', 'blind'];
  if (!exactObject(b, ['key', 'segmentation', 'outcome', 'backtracks', 'lesson', 'origin', 'title', 'note', 'seconds'], ['repeat', 'blind']) || Object.keys(b).some((k) => !allowed.includes(k))) throw new Error('bad body shape');
  const it = allBatchItems().find((x) => x.depth && x.key === b.key); if (!it) throw new Error('key is not a depth item');
  const events = eventNumbers(it);
  if (!exactObject(b.segmentation, ['value', 'split_at']) || !SEGMENTATIONS.includes(b.segmentation.value) || !Array.isArray(b.segmentation.split_at)) throw new Error('bad segmentation');
  if (b.segmentation.value === 'split_at') {
    if (!b.segmentation.split_at.length || b.segmentation.split_at.some((n) => !eventIn(events, n)) || new Set(b.segmentation.split_at).size !== b.segmentation.split_at.length) throw new Error('bad split_at events');
  } else if (b.segmentation.split_at.length) throw new Error('split_at events require split_at segmentation');
  if (!exactObject(b.outcome, ['value', 'event', 'abandoned_reason']) || !OUTCOMES.includes(b.outcome.value)) throw new Error('bad outcome');
  const eventOptional = ['unclear', 'continued_elsewhere'].includes(b.outcome.value);
  if (b.outcome.event != null && !eventIn(events, b.outcome.event)) throw new Error('outcome event is not in evidence');
  if (!eventOptional && !eventIn(events, b.outcome.event)) throw new Error('outcome requires an event');
  if (b.outcome.value === 'abandoned') { if (!ABANDONED_REASONS.includes(b.outcome.abandoned_reason)) throw new Error('abandoned requires a reason'); }
  else if (b.outcome.abandoned_reason != null) throw new Error('abandoned reason requires abandoned outcome');
  if (!Array.isArray(b.backtracks)) throw new Error('bad backtracks');
  for (const x of b.backtracks) {
    if (!exactObject(x, ['event', 'from', 'to', 'trigger']) || !eventIn(events, x.event) || !cleanText(x.from, 120, true) || !cleanText(x.to, 120, true) || !TRIGGERS.includes(x.trigger)) throw new Error('bad backtrack');
  }
  if (!exactObject(b.lesson, ['reusable', 'text', 'wall']) || typeof b.lesson.reusable !== 'boolean' || !cleanText(b.lesson.text, 240)) throw new Error('bad lesson');
  const wallIds = new Set(WALLS.map((w) => w.id).concat('new'));
  if (b.lesson.wall != null && !wallIds.has(b.lesson.wall)) throw new Error('bad lesson wall');
  if (b.lesson.reusable && !cleanText(b.lesson.text, 240, true)) throw new Error('reusable lesson requires text');
  if (!b.lesson.reusable && (b.lesson.text || b.lesson.wall != null)) throw new Error('non-reusable lesson cannot carry text or wall');
  if (!ORIGINS.includes(b.origin)) throw new Error('bad origin');
  if (!exactObject(b.title, ['action', 'text']) || !['keep', 'rename'].includes(b.title.action) || !cleanText(b.title.text, 120) || (b.title.action === 'rename' && !b.title.text.trim())) throw new Error('bad title');
  if (!cleanText(b.note, 500) || !Number.isFinite(b.seconds) || b.seconds < 0 || b.seconds > 86400) throw new Error('bad note or seconds');
  if (b.repeat != null && typeof b.repeat !== 'boolean') throw new Error('bad repeat');
  if (b.blind != null && typeof b.blind !== 'boolean') throw new Error('bad blind');
  return b;
}

export const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const hostOk = req.headers.host === `127.0.0.1:${PORT}` || req.headers.host === `localhost:${PORT}`;
  if (!hostOk || u.searchParams.get('k') !== token) { res.writeHead(403).end('forbidden'); return; }
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); }
  else if (u.pathname === '/next') json(next());
  else if (u.pathname === '/label' && req.method === 'POST') {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      try { const raw = JSON.parse(body);
        if (FORM === 'v2') {
          const b = validateV2(raw); appendJSONL(L.gold, { form: 'v2', labeler: AS, key: b.key, at: new Date().toISOString(), seconds: b.seconds,
            segmentation: b.segmentation, outcome: b.outcome, backtracks: b.backtracks, lesson: b.lesson, origin: b.origin, title: b.title, note: b.note,
            repeat: !!b.repeat, blind: !!b.blind });
        } else {
          const b = raw; if (!b.key || !b.origin || !b.status || !b.boundary) throw new Error('missing field');
          if (b.backtracks != null && !['0', '1', '2', '3+'].includes(b.backtracks)) throw new Error('bad backtracks');
          appendJSONL(L.gold, { key: b.key, labeler: AS, at: new Date().toISOString(), boundary: b.boundary, origin: b.origin, status: b.status, title_ok: !!b.title_ok, title: String(b.title || '').slice(0, 120), note: String(b.note || '').slice(0, 500), ...(b.backtracks != null ? { backtracks: b.backtracks } : {}), repeat: !!b.repeat, blind: !!b.blind, prefill: b.prefill || null, seconds: +b.seconds || null });
        }
        json({ ok: true }); } catch (e) { res.writeHead(400).end(String(e)); }
    });
  } else res.writeHead(404).end();
});
// A no-listen mode lets contract tests exercise the real handler where local sockets are unavailable.
if (!process.env.TRAIL_NO_LISTEN) server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/?k=${token}`;
  const bench = FORM === 'v2' ? 'Labeling bench v2' : 'Labeling bench';
  console.log(`  ${bench} (${AS}${AS === 'human' ? ', counts as gold' : ', silver: never scored as your judgment'}): ${url}\n  Labels → ${L.gold}`);
  if (!process.env.TRAIL_NO_OPEN && process.platform === 'darwin') execFile('open', [url]);
});
