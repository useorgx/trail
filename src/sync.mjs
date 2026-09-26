// `trail sync`: send thread outlines (never transcripts) to OrgX as orgx-trail-threads/v1.
// Default privacy is metadata_only: no titles, no commit messages, unnamed error signatures hashed.
// --with-titles sends the bounded tier (adds thread titles). --dry-run shows exactly what would be sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadSessions, loadAdoptions, HOME, VERSION } from './store.mjs';
import { modelInfo } from './model.mjs';

const SYNC_STATE = path.join(HOME, 'sync.json');
const CHUNK = 200;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const CLIENT = { claude: 'claude-code', codex: 'codex' };
const ORIGIN = (t) => (t.origin === 'surprise' ? ({ wall: 'wall', recovery: 'recovery' }[t.kind] || 'found') : ({ ask: 'asked', plan: 'plan', schedule: 'scheduled', agent: 'plan' }[t.origin] || 'asked'));
const STATUS = { outcome: 'done', abandoned: 'dropped', open: 'open', parked: 'parked', 'outcome?': 'unclear' };

/** The key the OrgX wizard already stored: env first, then the macOS keychain entry the wizard writes. */
export function credential() {
  if (process.env.ORGX_API_KEY) return { key: process.env.ORGX_API_KEY.trim(), from: 'ORGX_API_KEY' };
  if (process.platform === 'darwin') {
    const args = ['find-generic-password', '-s', '@useorgx/wizard', '-a', 'orgx-api-key'];
    try {
      const key = execFileSync('security', [...args, '-w'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).toString().trim();
      if (key) return { key, from: 'keychain (@useorgx/wizard)' };
    } catch {
      // The entry can exist while macOS refuses to hand it to a different program until you allow it.
      try { execFileSync('security', args, { stdio: 'ignore' }); return { key: null, from: 'keychain', blocked: true }; } catch {}
    }
  }
  return null;
}
export function baseUrl(flag) {
  if (flag) return flag.replace(/\/$/, '');
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'useorgx', 'wizard', 'auth.json'), 'utf8')).baseUrl.replace(/\/$/, ''); } catch { return 'https://useorgx.com'; }
}

const iso = (t, d) => { const x = Date.parse(t || d); return Number.isFinite(x) ? new Date(x).toISOString() : new Date(0).toISOString(); };
const clampMoves = (m) => (m.length <= 400 ? m : m.slice(0, 200) + m.slice(-200));

export function toSession(s, bounded) {
  return {
    session_hash: sha(`${s.client}:${s.id}`),
    client: CLIENT[s.client] || 'other',
    repo: String(s.project || 'unknown').replace(/[\/\\]/g, '-').slice(0, 120),
    started_at: iso(s.start), ended_at: iso(s.end, s.start),
    tool_calls: s.tools | 0, failed_calls: s.errs | 0, denied_calls: s.denied | 0,
    human_steers: s.steers?.human | 0, continues: s.steers?.cont | 0,
    threads: s.threads.slice(0, 500).map((t, i) => ({
      id: /^T\d{1,5}$/.test(t.id) ? t.id : `T${i + 1}`, origin: ORIGIN(t), status: STATUS[t.status] || 'unclear',
      moves: clampMoves(t.moves.replace(/[^prchsdXD]/g, '')), backtracks: t.backs.length,
      // Only references travel: PR numbers. Commit messages and free text stay on the machine.
      claims: (t.claim || []).filter((c) => /^PR #\d{1,7}$/.test(c)).slice(0, 10),
      started_at: iso(t.t0, s.start), ended_at: iso(t.t1, s.end || s.start),
      p_dropped: t.p_abandon ?? null,
      ...(bounded && t.title ? { title: String(t.title).slice(0, 120) } : {}),
    })),
    walls: (s.walls || []).slice(0, 200).map((w) => ({ sig: w.named || bounded ? String(w.sig).slice(0, 140) : `sig:${sha(w.sig).slice(0, 16)}`, named: !!w.named, calls: Math.max(1, w.n | 0) })),
  };
}

const fingerprint = (s) => `${s.tools}:${s.threads.length}:${s.end}`;

export async function sync({ dryRun = false, withTitles = false, base, limit } = {}) {
  const bounded = !!withTitles;
  const state = (() => { try { return JSON.parse(fs.readFileSync(SYNC_STATE, 'utf8')); } catch { return { sessions: {} }; } })();
  const sessions = loadSessions().filter((s) => s.threads.length && state.sessions[s.id] !== fingerprint(s));
  const todo = limit ? sessions.slice(-limit) : sessions;
  const adoptions = loadAdoptions().map((a) => ({ sig: a.sig, adopted_at: iso(a.at), scope: /\/\.(claude|codex)\//.test(a.target) ? 'global' : 'repo', repo: /\/\.(claude|codex)\//.test(a.target) ? null : path.basename(path.dirname(a.target)).slice(0, 120) }));
  const mi = modelInfo();
  const envelope = (chunk, withAdoptions) => ({ schema_version: 'orgx-trail-threads/v1', privacy: bounded ? 'bounded' : 'metadata_only',
    source: { tool: '@useorgx/trail', version: VERSION, classifier: { sha: VERSION, model: mi?.name ?? null } },
    sessions: chunk.map((s) => toSession(s, bounded)), adoptions: withAdoptions ? adoptions : [] });
  const chunks = []; for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));
  if (!chunks.length && adoptions.length) chunks.push([]);
  const url = `${baseUrl(base)}/api/v1/trail/uploads`;
  if (dryRun) {
    const first = chunks[0] ? envelope(chunks[0].slice(0, 1), false) : null;
    return { dryRun: true, url, privacy: bounded ? 'bounded' : 'metadata_only', sessions: todo.length, requests: chunks.length, threads: todo.reduce((a, s) => a + s.threads.length, 0), adoptions: adoptions.length, example: first?.sessions[0] ?? null };
  }
  const cred = credential();
  if (cred?.blocked) throw new Error('Your OrgX key is in the keychain, but macOS needs your OK before trail can read it. Run this in your own terminal and choose "Always Allow" when macOS asks, or set ORGX_API_KEY.');
  if (!cred) throw new Error('No OrgX key found. Run `npx @useorgx/wizard` to sign in, or set ORGX_API_KEY.');
  let sent = 0, threads = 0; let workspace = null;
  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.key}` }, body: JSON.stringify(envelope(chunks[i], i === 0)) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OrgX refused the upload (${res.status}): ${body.error || 'unknown error'}${body.issues ? ' ' + JSON.stringify(body.issues.slice(0, 2)) : ''}`);
    sent += chunks[i].length; threads += body.data?.threads ?? 0; workspace = body.data?.workspaceId ?? workspace;
    for (const s of chunks[i]) state.sessions[s.id] = fingerprint(s);
    fs.writeFileSync(SYNC_STATE, JSON.stringify(state));
  }
  return { dryRun: false, url, credential: cred.from, sessions: sent, threads, workspace, privacy: bounded ? 'bounded' : 'metadata_only' };
}
