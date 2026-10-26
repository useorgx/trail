// `trail sync`: send thread outlines (never transcripts) to OrgX as orgx-trail-threads/v1.
// Default privacy is metadata_only: no titles, no commit messages, unnamed error signatures hashed.
// --with-titles sends the bounded tier (adds thread titles). --dry-run shows exactly what would be sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { loadSessions, loadAdoptions, loadSignals, HOME, VERSION } from './store.mjs';
import { modelInfo } from './model.mjs';
import { corpus } from './metrics.mjs';
import { wallById } from './walls.mjs';
import { orgxArtifactRefs } from './orgx-outputs.mjs';
import { piiEnabled, maskPii } from './pii.mjs';
import { receiptFingerprint, withIntegrity } from './integrity.mjs';
import { redactDeep } from './redact.mjs';
import { withProcessLock } from './process-lock.mjs';

const SYNC_STATE = path.join(HOME, 'sync.json');
const SYNC_LOCK = path.join(HOME, 'sync.lock');
const saveSyncState = (state) => {
  const temporary = `${SYNC_STATE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, SYNC_STATE);
};
const CHUNK = 200;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ACK_FIELDS = ['sessions', 'receipts', 'receiptRevisions', 'signalsSent'];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function syncRoot(base) {
  const url = new URL(baseUrl(base));
  if (url.username || url.password || url.search || url.hash) throw new Error('OrgX base URL must not contain credentials, a query, or a fragment.');
  return url.href.replace(/\/+$/, '');
}
function syncState(root, key) {
  let stored;
  try { stored = JSON.parse(fs.readFileSync(SYNC_STATE, 'utf8')); } catch {}
  // Legacy acknowledgements have no destination/account evidence. Re-send them
  // safely using the existing server idempotency keys instead of guessing.
  const destinations = object(stored?.destinations);
  const scope = key ? sha(JSON.stringify(['trail-sync/v2', root, key])) : null;
  const previous = scope ? object(destinations[scope]) : {};
  const state = Object.fromEntries(ACK_FIELDS.map((field) => [field, object(previous[field])]));
  return { state, scopeKnown: scope !== null, save: () => {
    destinations[scope] = state;
    saveSyncState({ version: 2, destinations });
  } };
}
// Previews never prompt the keychain or need a login. Without an explicit key,
// show a conservative backlog rather than applying an unknown account's acks.
const previewKey = () => process.env.ORGX_API_KEY?.trim() || null;
import { CLIENTS } from './clients.mjs';
const CLIENT = Object.fromEntries(Object.entries(CLIENTS).map(([k, v]) => [k, v.contract]));
const ORIGIN = (t) => (t.origin === 'surprise' ? ({ wall: 'wall', recovery: 'recovery' }[t.kind] || 'found') : ({ ask: 'asked', plan: 'plan', schedule: 'scheduled', agent: 'plan' }[t.origin] || 'asked'));
const STATUS = { outcome: 'done', abandoned: 'dropped', open: 'open', parked: 'parked', 'outcome?': 'unclear' };

export { credential, baseUrl } from './credentials.mjs';
import { credential, baseUrl, authHeaders } from './credentials.mjs';

const iso = (t, d) => { const x = Date.parse(t || d); return Number.isFinite(x) ? new Date(x).toISOString() : new Date(0).toISOString(); };
const clampMoves = (m) => (m.length <= 400 ? m : m.slice(0, 200) + m.slice(-200));
const outlineThreadId = (id) => {
  if (typeof id !== 'string' || !/^T\d{1,16}$/.test(id) || !Number.isSafeInteger(Number(id.slice(1)))) throw new Error('Cannot sync an outline with an invalid stable thread identity.');
  return id;
};

export function toSession(s, bounded) {
  return {
    session_hash: sha(`${s.client}:${s.id}`),
    client: CLIENT[s.client] || 'other',
    repo: String(s.project || 'unknown').replace(/[\/\\]/g, '-').slice(0, 120),
    started_at: iso(s.start), ended_at: iso(s.end, s.start),
    tool_calls: s.tools | 0, failed_calls: s.errs | 0, denied_calls: s.denied | 0,
    human_steers: s.steers?.human | 0, continues: s.steers?.cont | 0,
    threads: s.threads.slice(0, 500).map((t) => ({
      id: outlineThreadId(t.id), origin: ORIGIN(t), status: STATUS[t.status] || 'unclear',
      moves: clampMoves(t.moves.replace(/[^prchsdXD]/g, '')), backtracks: t.backs.length,
      // Only references travel: PR numbers and typed OrgX artifact observations.
      // Commit messages and free text stay on the machine.
      claims: (t.claim || []).filter((c) => /^PR #\d{1,7}$/.test(c)).slice(0, 10),
      ...(orgxArtifactRefs(t.orgx_artifacts).length ? { orgx_artifacts: orgxArtifactRefs(t.orgx_artifacts) } : {}),
      started_at: iso(t.t0, s.start), ended_at: iso(t.t1, s.end || s.start),
      p_dropped: t.p_abandon ?? null,
      ...(bounded && t.title ? { title: String(t.title).slice(0, 120) } : {}),
    })),
    walls: (s.walls || []).slice(0, 200).map((w) => ({ sig: w.named || bounded ? String(w.sig).slice(0, 140) : `sig:${sha(w.sig).slice(0, 16)}`, named: !!w.named, calls: Math.max(1, w.n | 0) })),
  };
}

const fingerprint = (s) => {
  const base = `${s.tools}:${s.threads.length}:${s.end}`;
  const refs = s.threads.map((t) => orgxArtifactRefs(t.orgx_artifacts));
  return refs.some((items) => items.length) ? `${base}:${sha(JSON.stringify(refs)).slice(0, 16)}` : base;
};

export function sync(options = {}) { return options.dryRun ? performOutlineSync(options) : withProcessLock(SYNC_LOCK, () => performOutlineSync(options)); }
async function performOutlineSync({ dryRun = false, withTitles = false, base, limit, fetchImpl = fetch } = {}) {
  const bounded = !!withTitles;
  const root = syncRoot(base);
  const cred = dryRun ? null : credential();
  if (!dryRun && cred?.blocked) throw new Error('Your OrgX key is in the keychain, but macOS needs your OK before trail can read it. Run this in your own terminal and choose "Always Allow" when macOS asks, or set ORGX_API_KEY.');
  if (!dryRun && !cred?.key) throw new Error('No OrgX key found. Run `trail connect` to sign in, or set ORGX_API_KEY.');
  const { state, save, scopeKnown } = syncState(root, dryRun ? previewKey() : cred.scope || cred.key);
  const sessions = loadSessions().filter((s) => s.threads.length && state.sessions[s.id] !== fingerprint(s));
  let todo = limit ? sessions.slice(-limit) : sessions;
  // Titles are the only text a bounded upload carries: with personal-data masking on, they go through
  // OpenAI Privacy Filter locally first (throws = nothing sent).
  if (bounded && piiEnabled()) {
    const titles = todo.flatMap((s) => s.threads.map((t) => t.title || ''));
    const masked = maskPii(titles); let k = 0;
    todo = todo.map((s) => ({ ...s, threads: s.threads.map((t) => ({ ...t, title: masked[k++] })) }));
  }
  // Each adopted fix travels with its measured effect (same scope, same mode; confounded ones say so). Counts only.
  const allSessions = loadSessions(); const K = corpus(allSessions, loadAdoptions());
  const adoptions = loadAdoptions().map((a) => {
    const w = K.walls.find((x) => x.sig === a.sig); const e = w?.adopted;
    const effect = e ? { mode: String(e.mode || 'unknown').slice(0, 40), before_sessions: e.before.sessions, before_hit: e.before.hit, after_sessions: e.after.sessions, after_hit: e.after.hit, confounded: !!e.confounded } : undefined;
    const named = !!wallById(a.sig);
    return { sig: named || bounded ? a.sig : `sig:${sha(a.sig).slice(0, 16)}`, adopted_at: iso(a.at), scope: /\/\.(claude|codex)\//.test(a.target) ? 'global' : 'repo', repo: /\/\.(claude|codex)\//.test(a.target) ? null : path.basename(path.dirname(a.target)).slice(0, 120), ...(effect ? { effect } : {}) };
  });
  const mi = modelInfo();
  const envelope = (chunk, withAdoptions) => ({ schema_version: 'orgx-trail-threads/v1', privacy: bounded ? 'bounded' : 'metadata_only',
    source: { tool: '@useorgx/trail', version: VERSION, classifier: { sha: VERSION, model: mi?.name ?? null } },
    sessions: chunk.map((s) => toSession(s, bounded)), adoptions: withAdoptions ? adoptions : [] });
  const chunks = []; let chunk = [], artifactIds = new Set();
  for (const session of todo) {
    const ids = session.threads.flatMap((thread) => orgxArtifactRefs(thread.orgx_artifacts).map((ref) => ref.artifact_id));
    if (new Set(ids).size > 1000) throw new Error('A session exceeds the 1,000 observed OrgX output references supported by one upload. Nothing was sent.');
    if (chunk.length >= CHUNK || new Set([...artifactIds, ...ids]).size > 1000) { chunks.push(chunk); chunk = []; artifactIds = new Set(); }
    chunk.push(session); for (const id of ids) artifactIds.add(id);
  }
  if (chunk.length) chunks.push(chunk);
  if (!chunks.length && adoptions.length) chunks.push([]);
  const url = `${root}/api/v1/trail/uploads`;
  if (dryRun) {
    const first = chunks[0] ? envelope(chunks[0].slice(0, 1), false) : null;
    return { dryRun: true, url, scopeKnown, privacy: bounded ? 'bounded' : 'metadata_only', sessions: todo.length, requests: chunks.length, threads: todo.reduce((a, s) => a + s.threads.length, 0), adoptions: adoptions.length, example: first?.sessions[0] ?? null };
  }
  let sent = 0, threads = 0; let workspace = null;
  for (let i = 0; i < chunks.length; i++) {
    const res = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', ...authHeaders(cred) }, body: JSON.stringify(envelope(chunks[i], i === 0)) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OrgX refused the upload (${res.status}): ${body.error || 'unknown error'}${body.issues ? ' ' + JSON.stringify(body.issues.slice(0, 2)) : ''}`);
    sent += chunks[i].length; threads += body.data?.threads ?? 0; workspace = body.data?.workspaceId ?? workspace;
    for (const s of chunks[i]) state.sessions[s.id] = fingerprint(s);
    save();
  }
  return { dryRun: false, url, credential: cred.from, sessions: sent, threads, workspace, privacy: bounded ? 'bounded' : 'metadata_only' };
}

/**
 * `trail connect`: sign-in belongs to the OrgX wizard, so trail never handles a password or a key itself.
 * It runs `@useorgx/wizard auth login` (browser pairing), then reads the key the wizard stored, the same way sync does.
 */
export async function connect({ base, run = spawnWizard } = {}) {
  const have = credential();
  if (have?.key) return { already: true, credential: have.from };
  if (have?.blocked) throw new Error('You are already signed in: the wizard\'s key is in your macOS keychain, but macOS has not allowed trail to read it. Run `trail sync` and choose Allow when macOS asks, or set ORGX_API_KEY.');
  console.log('Signing in with the OrgX wizard, the sign-in every OrgX tool shares. A browser window opens to pair this terminal.\n');
  const code = await run(['-y', '@useorgx/wizard@latest', 'auth', 'login', ...(base ? ['--base-url', base] : [])]);
  const got = credential();
  if (!got?.key) throw new Error(code === 0 ? 'The wizard finished but no key was found. Try `npx @useorgx/wizard auth status`.' : `The wizard sign-in did not complete (exit ${code}). Nothing was sent.`);
  return { already: false, credential: got.from };
}
function spawnWizard(args) {
  return new Promise((resolve) => { const p = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit' }); p.on('close', resolve); p.on('error', () => resolve(127)); });
}

// ---- `trail sync --receipts`: Agent Work Receipts to the OrgX work ledger -------------------------------------------
// Opt-in and separate from outlines, because receipts carry text: the ask, summaries, command lines, short output
// excerpts. Everything is secret-redacted at rest already; with personal-data masking on, the free-text fields go
// through OpenAI Privacy Filter locally before anything is sent (a failure sends nothing).
const TEXT_FIELDS = (r) => [
  [r.intent, 'summary'], [r.intent, 'objective'], [r.outcome, 'summary'],
  ...(r.intent.constraints || []).map((_, i) => [r.intent.constraints, i]), ...(r.intent.acceptance_criteria || []).map((_, i) => [r.intent.acceptance_criteria, i]),
  ...r.evidence.flatMap((e) => [[e, 'summary'], [e, 'excerpt']]), ...r.human_interventions.map((h) => [h, 'summary']),
  ...r.actions.flatMap((a) => [[a, 'summary'], [a, 'error']]),
].filter(([o, k]) => typeof o?.[k] === 'string' && o[k].length > 3);
// One key per version of a receipt: a corrected receipt is a new import (OrgX keeps the latest per receipt id), never
// an idempotency conflict with the version it replaces.
const idemKey = (id, fp) => { const k = `${String(id).replace(/[^A-Za-z0-9._:/-]/g, '-').replace(/^[^A-Za-z0-9]+/, '')}@${fp}`; return k.length <= 160 ? k : `trail:${sha(id).slice(0, 40)}@${fp}`; };
export const SETTLE_MS = 30 * 60_000;
export function withLifecycle(receipt, status, reason = status === 'final' ? 'settled' : 'goal_boundary') {
  const key = 'org.orgx.trail/v1';
  return withIntegrity({ ...receipt, extensions: { ...receipt.extensions, [key]: { ...receipt.extensions?.[key], lifecycle: { ...receipt.extensions?.[key]?.lifecycle, status, reason } } } });
}

let receiptSyncQueue = Promise.resolve();
export function syncReceipts(options = {}) {
  const result = receiptSyncQueue.then(() => options.dryRun ? performReceiptSync(options) : withProcessLock(SYNC_LOCK, () => performReceiptSync(options)));
  receiptSyncQueue = result.catch(() => {});
  return result;
}
async function performReceiptSync({ dryRun = false, base, limit = 50, since, receipts, lane = 'final', now = Date.now(), fetchImpl = fetch } = {}) {
  const { ledger, withGraph } = await import('./ledger.mjs');
  if (!['provisional', 'final'].includes(lane)) throw new Error('Receipt lane must be provisional or final.');
  const root = syncRoot(base);
  const cred = dryRun ? null : credential();
  if (!dryRun && cred?.blocked) throw new Error('Your OrgX key is in the keychain, but macOS needs your OK before trail can read it. Run this in your own terminal and choose "Always Allow", or set ORGX_API_KEY.');
  if (!dryRun && !cred?.key) throw new Error('No OrgX key found. Run `trail connect` to sign in, or set ORGX_API_KEY.');
  const { state, save, scopeKnown } = syncState(root, dryRun ? previewKey() : cred.scope || cred.key);
  const L = receipts ? null : ledger({ persist: !dryRun, fresh: dryRun });
  const source = receipts || L.receipts;
  const settled = now - SETTLE_MS;
  let todo = source.filter((r) => (!since || r.timestamps.started_at >= since) && (lane === 'provisional' || (!r.actions?.some((a) => a.status === 'running') && Date.parse(r.timestamps.completed_at) <= settled)))
    .map((r) => withLifecycle(L ? withGraph(r, L) : r, lane));
  todo = redactDeep(todo);
  if (piiEnabled() && todo.length) {
    todo = JSON.parse(JSON.stringify(todo)); const slots = todo.flatMap(TEXT_FIELDS); const masked = maskPii(slots.map(([o, k]) => o[k])); slots.forEach(([o, k], i) => { o[k] = masked[i]; });
  }
  // Hash the complete wire document after graph, review and privacy transforms. Integrity alone is excluded.
  const sourceTime = (r) => Date.parse(r.extensions?.['org.orgx.trail/v1']?.lifecycle?.material_at || r.timestamps.completed_at);
  todo = todo.map(withIntegrity).filter((r) => {
    const previous = state.receiptRevisions[r.receipt_id]; const current = sourceTime(r);
    if (previous && (previous.sourceTime > current || (previous.lane === 'final' && lane === 'provisional' && previous.sourceTime >= current))) return false;
    return state.receipts[r.receipt_id] !== receiptFingerprint(r);
  })
    .sort((a, b) => String(b.timestamps.started_at).localeCompare(String(a.timestamps.started_at)));
  const eligible = todo.length; todo = todo.slice(0, limit);
  const url = `${root}/api/v1/agent-work-receipts`;
  const privacy = piiEnabled() ? 'receipts (secrets redacted, personal data masked)' : 'receipts (secrets redacted; personal-data masking off — trail privacy --pii on)';
  state.signalsSent ||= {};
  const signals = lane === 'provisional' ? [] : unsentSignals(state);
  if (dryRun) return { dryRun: true, url, scopeKnown, privacy, lane, receipts: todo.length, pending: eligible, example: todo[0] ?? null, signals: { url: `${root}${SIGNALS_PATH}`, pending: signals.length, example: signals[0] ?? null } };
  const headers = { 'content-type': 'application/json', ...authHeaders(cred) };
  let sent = 0, duplicate = 0; const refused = [];
  // Batches of 25 when the server has the batch route; one at a time otherwise. 429s wait as long as the server asks.
  let batch = true; let rateLimits = 0;
  for (let i = 0; i < todo.length;) {
    const chunk = batch ? todo.slice(i, i + 25) : [todo[i]];
    const body = batch ? { receipts: chunk.map((r) => ({ receipt: r, idempotency_key: idemKey(r.receipt_id, receiptFingerprint(r)) })) } : { receipt: chunk[0], idempotency_key: idemKey(chunk[0].receipt_id, receiptFingerprint(chunk[0])) };
    const res = await fetchImpl(batch ? `${url}/batch` : url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers, body: JSON.stringify(body) });
    if (batch && (res.status === 404 || res.status === 405)) { batch = false; continue; }
    if (res.status === 429 && ++rateLimits > 2) { refused.push({ id: chunk[0].receipt_id, error: 'rate_limit_retry_exhausted' }); break; }
    if (res.status === 429) { const wait = Math.min(15, Math.max(0, +(res.headers.get('retry-after') || 15) || 0)); await new Promise((r) => setTimeout(r, wait * 1000)); continue; }
    const out = await res.json().catch(() => ({}));
    if (res.status === 409 && out.error?.code === 'workspace_receipt_import_limit_reached') { refused.push({ id: chunk[0].receipt_id, error: out.error.message }); break; }
    const results = batch ? (out.results || []) : [{ ...out, ok: res.ok }];
    chunk.forEach((r, k) => { const x = results[k] || {}; if (x.ok) { sent++; if (x.idempotent) duplicate++; state.receipts[r.receipt_id] = receiptFingerprint(r); state.receiptRevisions[r.receipt_id] = { sourceTime: sourceTime(r), lane }; } else refused.push({ id: r.receipt_id, status: res.status, error: x.error?.code || out.error?.code || 'refused' }); });
    save(); i += chunk.length;
    if (!res.ok && !batch && res.status >= 500) break;
  }
  const sig = await sendSignals({ root, headers, state, save, signals, fetchImpl });
  return { dryRun: false, url, credential: cred.from, lane, receipts: sent, duplicate, refused, privacy, remaining: eligible - sent, signals: sig };
}

// ---- precedent signals: the judgments a person made (corrections, rejections, denials, stated rules) --------------
// Sent with receipts (same opt-in, same key, same base URL), because they carry the person's own words. OrgX turns them
// into precedent candidates; the server is idempotent on signalId, and trail marks what it sent so it is not resent.
export const SIGNALS_PATH = '/api/v1/precedents/signals';
const SIGNAL_BATCH = 100;
function unsentSignals(state) {
  let out = loadSignals().filter((x) => !state.signalsSent?.[x.signalId]);
  if (piiEnabled() && out.length) {
    out = JSON.parse(JSON.stringify(out)); const slots = out.flatMap((x) => [[x, 'text'], ...(x.priorAction?.summary ? [[x.priorAction, 'summary']] : [])]);
    const masked = maskPii(slots.map(([o, k]) => o[k])); slots.forEach(([o, k], i) => { o[k] = masked[i]; });
  }
  return out;
}
/** POST unsent signals in batches of 100. A 404 means this OrgX does not take signals yet: keep them, no error. */
export async function sendSignals({ root, headers, state, save = () => {}, signals, fetchImpl = fetch }) {
  state.signalsSent ||= {};
  const out = { url: `${root}${SIGNALS_PATH}`, sent: 0, pending: signals.length, unsupported: false, error: null };
  let rateLimits = 0;
  for (let i = 0; i < signals.length;) {
    const chunk = signals.slice(i, i + SIGNAL_BATCH);
    let res;
    try { res = await fetchImpl(out.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers, body: JSON.stringify({ signals: chunk }) }); } catch (e) { out.error = String(e?.message || e).slice(0, 200); break; }
    if (res.status === 404) { out.unsupported = true; break; }
    if (res.status === 429 && ++rateLimits > 2) { out.error = 'rate_limit_retry_exhausted'; break; }
    if (res.status === 429) { const wait = Math.min(15, Math.max(0, +(res.headers?.get?.('retry-after') || 15) || 0)); await new Promise((r) => setTimeout(r, wait * 1000)); continue; }
    if (!res.ok) { const b = await res.json().catch(() => ({})); out.error = `${res.status} ${b.error?.code || b.error || 'refused'}`.slice(0, 200); break; }
    const at = new Date().toISOString(); for (const x of chunk) state.signalsSent[x.signalId] = at;
    out.sent += chunk.length; save(); i += chunk.length;
  }
  out.pending = signals.length - out.sent;
  return out;
}
