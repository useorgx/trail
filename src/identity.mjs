// Stable thread aliases belong to source events, not the classifier's current thread count.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { HOME, P } from './store.mjs';
import { withProcessLock } from './process-lock.mjs';
import { redactDeep } from './redact.mjs';
import { ARCHIVE, ROOTS } from './archive.mjs';

const ROOT = path.join(HOME, 'thread-identities');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const NATIVE_PREFIX = `${hash('native-source-events')}:0:`;
const nativeOpening = (event) => typeof event?.source_id === 'string' && event.source_id.length > 0;
const bindingKey = (prefix, candidate) => (candidate.native ? NATIVE_PREFIX : prefix) + candidate.digest;
// Older uploads accepted zero and leading zeroes. Preserve those exact aliases; new allocations stay positive.
const aliasNumber = (value) => typeof value === 'string' && /^T\d+$/.test(value) && Number.isSafeInteger(Number(value.slice(1))) ? Number(value.slice(1)) : null;
const safeId = (id) => typeof id === 'string' && id.length > 0 && !/[\/\\\0]/.test(id) && id !== '.' && id !== '..';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const persisted = new Map(); const ephemeral = new Map();
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read stable thread identity state: ${path.basename(file)}.`, { cause: error }); }
}
function atomic(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
const stamp = (file) => { try { const s = fs.statSync(file); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const fresh = (client, id) => ({ version: 1, client, id, next: 1, bindings: {}, epochs: {}, reserved: [], conflicts: [], migrated: false });
function validate(state, client, id) {
  if (state?.version !== 1 || state.client !== client || state.id !== id || !Number.isSafeInteger(state.next) || state.next < 1 || !object(state.bindings) || !object(state.epochs) || !Array.isArray(state.reserved) || state.reserved.some((a) => aliasNumber(a) === null || aliasNumber(a) >= state.next) || !Array.isArray(state.conflicts)) throw new Error('Invalid stable thread identity state; existing aliases were left untouched.');
  const used = new Map(); const reserved = new Set(state.reserved);
  for (const [key, alias] of Object.entries(state.bindings)) {
    if (!/^[a-f0-9]{64}:\d+:[a-f0-9]{64}$/.test(key) || aliasNumber(alias) === null || !reserved.has(alias) || (used.has(alias) && used.get(alias) !== key)) throw new Error('Conflicting stable thread identity state; existing aliases were left untouched.');
    used.set(alias, key);
  }
  return state;
}
/** Only fields fixed at invocation/message creation participate; outputs and inferred classifications do not. */
function opening(event, at) {
  // Native records survive late materialization/reordering and updates to synthetic event timestamps or text.
  if (nativeOpening(event)) return hash(['native', event.k, event.source_id]);
  return hash([at, ...['k', 'ts', 'who', 'text', 'tool', 'rawTool', 'target'].map((key) => event[key] ?? null)]);
}
function logicalSource(file, client) {
  const resolved = path.resolve(file); const root = ROOTS[client];
  if (root) {
    const relative = path.relative(path.join(ARCHIVE, client), resolved);
    if (relative.endsWith('.jsonl.gz') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return { file: resolved, logical: path.resolve(root(), relative.slice(0, -3)), archived: true };
    }
  }
  return { file, logical: resolved, archived: false };
}
async function contentHash(file, { gzip = false, length, prefixLength } = {}) {
  const digest = crypto.createHash('sha256'); const prefix = crypto.createHash('sha256'); let bytes = 0;
  if (length !== 0) {
    const input = fs.createReadStream(file, length === undefined ? {} : { start: 0, end: length - 1 });
    const stream = gzip ? input.pipe(zlib.createGunzip()) : input;
    if (gzip) input.on('error', (error) => stream.destroy(error));
    for await (const chunk of stream) {
      if (prefixLength !== undefined && bytes < prefixLength) prefix.update(chunk.subarray(0, prefixLength - bytes));
      bytes += chunk.length; digest.update(chunk);
    }
  }
  return { content_hash: digest.digest('hex'), content_size: bytes, ...(prefixLength !== undefined && bytes >= prefixLength ? { prefix_hash: prefix.digest('hex') } : {}) };
}
async function sourceStat(source, client, representation, previous) {
  // SQLite readers address a conversation as <database>#<session>; its file is the database itself.
  const split = source.file.lastIndexOf('#');
  const physical = ['opencode', 'cursor-ide'].includes(client) && split >= 0 ? source.file.slice(0, split) : source.file;
  const s = fs.statSync(physical);
  const current = { identity: `${s.dev}:${s.ino}`, size: s.size, mtime: s.mtimeMs, representation };
  if (source.archived) {
    const sameArchive = previous?.transport === 'archive' && previous.identity === current.identity && previous.size === current.size && previous.mtime === current.mtime;
    const content = sameArchive && /^[a-f0-9]{64}$/.test(previous.content_hash) && Number.isSafeInteger(previous.content_size) && previous.content_size >= 0
      ? { content_hash: previous.content_hash, content_size: previous.content_size } : await contentHash(physical, { gzip: true, ...(previous?.transport === 'archive' ? { prefixLength: previous.content_size } : {}) });
    const { prefix_hash, ...stored } = content;
    const continued = previous?.transport === 'archive' && content.content_size >= previous.content_size && (content.content_hash === previous.content_hash || prefix_hash === previous.content_hash);
    return { current: { ...current, transport: 'archive', ...stored }, restored: false, continued };
  }
  let restored = false;
  if (previous?.transport === 'archive' && /^[a-f0-9]{64}$/.test(previous.content_hash) && Number.isSafeInteger(previous.content_size) && previous.content_size >= 0 && current.size >= previous.content_size) {
    const prefix = await contentHash(physical, { length: previous.content_size });
    restored = prefix.content_size === previous.content_size && prefix.content_hash === previous.content_hash;
  }
  return { current, restored };
}
function generation(previous, current, appendOnly, restored, continued) {
  if (!previous) return 0;
  if (!Number.isSafeInteger(previous.generation) || previous.generation < 0 || typeof previous.identity !== 'string' || typeof previous.representation !== 'string') throw new Error('Invalid source generation; existing thread aliases were left untouched.');
  const archivedReset = current.transport === 'archive' && (previous.transport === 'archive' ? !continued : current.content_size < previous.size || (current.content_size === previous.size && Math.abs(current.mtime - previous.mtime) > 1));
  const rawReset = current.transport !== 'archive' && !restored && (previous.transport === 'archive' || previous.identity !== current.identity || current.size < previous.size || (current.size === previous.size && current.mtime !== previous.mtime));
  const replaced = previous.representation !== current.representation || (appendOnly && (archivedReset || rawReset));
  return previous.generation + Number(replaced);
}
const sameTime = (a, b) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
const normalized = (text) => typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : null;

// Migration reads only this session's files once. Old aliases are reserved even when no exact anchor survives.
function legacy(client, id, events) {
  const reserved = new Set(); const candidates = [];
  if (!safeId(id)) return { reserved, candidates };
  const reserve = (alias) => { if (aliasNumber(alias) !== null) reserved.add(alias); };
  const add = (alias, at, observed, excerpt, limit, exactNative = false) => {
    reserve(alias); const event = events[at];
    if (aliasNumber(alias) === null || !Number.isSafeInteger(at) || at < 0 || !event) return;
    // Receipt request evidence records the source ask, never an inferred title.
    const exactRequest = excerpt !== undefined && event.k === 'ask' && normalized(redactDeep(limit ? normalized(event.text)?.slice(0, limit) : event.text)) === normalized(excerpt);
    if (excerpt !== undefined && !exactRequest) return;
    // Cursor agent assigns the conversation's mutable updatedAt to every blob part, including old requests.
    const cursorSyntheticTime = client === 'cursor' && typeof event.source_id === 'string' && event.source_id.startsWith('cursor-blob:') && exactRequest;
    if (!sameTime(event.ts, observed) && !cursorSyntheticTime && !exactNative) return;
    candidates.push({ alias, at, native: nativeOpening(event), digest: opening(event, at) });
  };
  const readLegacy = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
  const receiptPrefix = `trail:${client}:${id}:`;
  const reserveReceipt = (reference) => { if (typeof reference === 'string' && reference.startsWith(receiptPrefix)) reserve(reference.slice(receiptPrefix.length)); };
  // An annotation can outlive its receipt/session file. Reserve its target without inventing a source binding.
  for (const file of [P.labels, P.signals]) {
    let lines = []; try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch {}
    for (const line of lines) {
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (value?.session === id && value.client === client) reserve(value.thread);
      reserveReceipt(value?.receipt_id); reserveReceipt(value?.receiptId);
    }
  }
  for (const reference of Object.keys(readLegacy(P.governed, {}) || {})) reserveReceipt(reference);
  for (const reference of Object.keys(readLegacy(path.join(HOME, 'taxonomy.json'), {})?.overrides || {})) reserveReceipt(reference);
  const saved = readLegacy(path.join(P.sessions, `${id}.json`), null);
  if (saved?.id === id && saved.client === client) {
    const nativeAt = new Map();
    if ((saved.threads || []).some((thread) => typeof thread.source_id === 'string' && thread.source_id.length)) events.forEach((event, at) => {
      if (!nativeOpening(event)) return;
      if (!nativeAt.has(event.source_id)) nativeAt.set(event.source_id, []); nativeAt.get(event.source_id).push(at);
    });
    for (const thread of saved.threads || []) {
      reserve(thread.id);
      const at = Array.isArray(thread.spans?.[0]) ? thread.spans[0][0] : thread.at;
      const native = nativeAt.get(thread.source_id);
      if (native?.length) for (const index of native) add(thread.id, index, thread.t0, undefined, undefined, true);
      else if (events[at]?.k === 'ask' && typeof thread.ask === 'string') add(thread.id, at, thread.t0, thread.ask, 300);
    }
    for (const goal of saved.goals || []) { reserve(goal.root); for (const alias of goal.threads || []) reserve(alias); }
  }
  let names = []; try { names = fs.readdirSync(P.receipts); } catch {}
  const manifest = readLegacy(path.join(P.checkpoints, `session-${crypto.createHash('sha256').update(id).digest('hex')}.json`), null);
  const active = manifest?.version === 1 && manifest.session_id === id && Array.isArray(manifest.active) ? new Set(manifest.active) : null;
  for (const name of names) {
    const checkpoint = name.startsWith(`${id}--checkpoint-`) && /^\d+\.json$/.test(name.slice(`${id}--checkpoint-`.length));
    if (name !== `${id}.json` && (!checkpoint || (active && !active.has(name)))) continue;
    const receipts = readLegacy(path.join(P.receipts, name), []); if (!Array.isArray(receipts)) continue;
    for (const receipt of receipts) {
      const run = receipt?.lineage?.run_ref;
      if (run?.id !== id || run.system !== client) continue;
      const prefix = `trail:${client}:${id}:`; const suffix = typeof receipt.receipt_id === 'string' && receipt.receipt_id.startsWith(prefix) ? receipt.receipt_id.slice(prefix.length) : null;
      const alias = receipt.extensions?.['org.orgx.trail/v1']?.root_thread || suffix;
      reserve(alias); reserve(suffix);
      for (const evidence of receipt.evidence || []) {
        const ref = evidence.ref; const eventPrefix = `${id}#`;
        if (evidence.kind !== 'request' || ref?.system !== client || ref.type !== 'transcript_event' || typeof ref.id !== 'string' || !ref.id.startsWith(eventPrefix)) continue;
        const index = ref.id.slice(eventPrefix.length); if (!/^(0|[1-9]\d*)$/.test(index)) continue;
        add(alias, Number(index), evidence.observed_at, evidence.excerpt);
        if (aliasNumber(suffix) !== null && suffix !== alias) add(suffix, Number(index), evidence.observed_at, evidence.excerpt);
      }
    }
  }
  return { reserved, candidates };
}
function migrate(state, client, id, events, prefix) {
  const old = legacy(client, id, events); const byAlias = new Map(); const byOpening = new Map();
  for (const candidate of old.candidates) {
    const key = bindingKey(prefix, candidate);
    if (!byAlias.has(candidate.alias)) byAlias.set(candidate.alias, new Set()); byAlias.get(candidate.alias).add(key);
    if (!byOpening.has(key)) byOpening.set(key, new Set()); byOpening.get(key).add(candidate.alias);
  }
  const conflicts = [];
  for (const [key, aliases] of byOpening) if (aliases.size > 1) conflicts.push({ kind: 'legacy_alias_conflict', at: old.candidates.find((c) => bindingKey(prefix, c) === key).at, aliases: [...aliases].sort() });
  for (const [alias, keys] of byAlias) if (keys.size > 1) conflicts.push({ kind: 'legacy_source_conflict', aliases: [alias], indices: old.candidates.filter((c) => c.alias === alias).map((c) => c.at).filter((at, i, xs) => xs.indexOf(at) === i).sort((a, b) => a - b) });
  for (const candidate of old.candidates) {
    const key = bindingKey(prefix, candidate);
    if (byAlias.get(candidate.alias).size === 1 && byOpening.get(key).size === 1) state.bindings[key] = candidate.alias;
  }
  state.reserved = [...old.reserved]; state.next = Math.max(state.next, ...[...old.reserved].map((alias) => aliasNumber(alias) + 1));
  state.conflicts.push(...conflicts); state.migrated = true;
}

/**
 * Resolve the classifier's local IDs before building goals. `events` is the full normalized source array;
 * `offset` rebases window-local thread.at. Call with no threads on an empty reset to record its source epoch.
 * Conflicts are durable: callers must report them and leave that session's prior records untouched.
 */
export async function assignThreadIdentities({ file, client, id, events, threads, offset = 0, persist = true, representation = client }) {
  if (typeof file !== 'string' || typeof client !== 'string' || typeof id !== 'string' || !id || !Array.isArray(events) || !Array.isArray(threads) || !Number.isSafeInteger(offset) || offset < 0 || typeof representation !== 'string') throw new Error('Invalid stable thread identity input.');
  const session = hash([client, id]); const location = logicalSource(file, client); const source = hash(location.logical);
  const registry = path.join(ROOT, `${session}.json`); const sourceFile = path.join(ROOT, `${session}-${source}.source.json`);
  const candidates = threads.map((thread) => {
    const at = thread.at + offset; const event = events[at];
    if (aliasNumber(thread.id) === null || !Number.isSafeInteger(at) || at < 0 || !object(event)) throw new Error('Thread identity requires an exact opening event.');
    return { local: thread.id, at, native: nativeOpening(event), digest: opening(event, at) };
  });
  const apply = async () => {
    let state; let holder; let before;
    if (persist) {
      before = stamp(registry); holder = persisted.get(session);
      if (!holder || holder.stamp !== before) { holder = { stamp: before, state: validate(readJSON(registry, fresh(client, id)), client, id) }; persisted.set(session, holder); }
      state = holder.state;
    } else {
      holder = ephemeral.get(session); if (!holder) { holder = { state: fresh(client, id), sources: new Map() }; ephemeral.set(session, holder); } state = holder.state;
    }
    const previous = persist ? readJSON(sourceFile, null) : holder.sources.get(source);
    const observedRepresentation = !events.length && !threads.length && previous?.representation ? previous.representation : representation;
    const { current, restored, continued } = await sourceStat(location, client, observedRepresentation, previous);
    const epoch = generation(previous, current, ['claude', 'codex', 'droid'].includes(client) && location.logical.endsWith('.jsonl'), restored, continued);
    const prefix = `${source}:${epoch}:`; let dirty = false;
    const initialMigration = !state.migrated;
    if (!state.migrated) { if (persist) migrate(state, client, id, events, prefix); else state.migrated = true; dirty = true; }
    let base = state.epochs[prefix];
    if (base === undefined) { base = previous?.generation === epoch ? (previous.base ?? 0) : initialMigration ? 0 : state.next - 1; state.epochs[prefix] = base; dirty = true; }
    if (!Number.isSafeInteger(base) || base < 0) throw new Error('Invalid source alias range; existing aliases were left untouched.');
    const openings = new Map();
    for (const candidate of candidates) {
      const other = openings.get(candidate.digest);
      if (other && other.local !== candidate.local) {
        const conflict = { kind: 'duplicate_source_opening', at: candidate.at, aliases: [other.local, candidate.local].sort() };
        if (!state.conflicts.some((c) => JSON.stringify(c) === JSON.stringify(conflict))) { state.conflicts.push(conflict); dirty = true; }
      }
      openings.set(candidate.digest, candidate);
    }
    const ids = new Map(); const reserved = new Set(state.reserved);
    if (!state.conflicts.length) for (const candidate of candidates) {
      const key = bindingKey(prefix, candidate); let alias = state.bindings[key];
      if (!alias) {
        const preferred = candidate.native ? Number.parseInt(hash(['native-alias', client, id, candidate.digest]).slice(0, 13), 16) + 1 : base + candidate.at + 1;
        if (!Number.isSafeInteger(preferred + 1)) throw new Error('Stable thread alias space exhausted.');
        alias = `T${preferred}`;
        if (reserved.has(alias)) {
          if (candidate.native) {
            state.conflicts.push({ kind: 'native_alias_collision', at: candidate.at, aliases: [alias] });
            dirty = true; ids.clear(); break;
          }
          while (reserved.has(`T${state.next}`)) state.next++;
          if (!Number.isSafeInteger(state.next + 1)) throw new Error('Stable thread alias space exhausted.');
          alias = `T${state.next++}`;
        }
        state.next = Math.max(state.next, aliasNumber(alias) + 1);
        reserved.add(alias); state.bindings[key] = alias; dirty = true;
      }
      ids.set(candidate.local, alias);
    }
    if (dirty) state.reserved = [...reserved];
    if (persist) {
      if (dirty) { atomic(registry, state); holder.stamp = stamp(registry); }
      const observation = { ...current, generation: epoch, base };
      if (!previous || JSON.stringify(previous) !== JSON.stringify(observation)) atomic(sourceFile, observation);
    } else holder.sources.set(source, { ...current, generation: epoch, base });
    return { ids, conflicts: structuredClone(state.conflicts) };
  };
  if (!persist) return apply();
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  return withProcessLock(path.join(ROOT, `${session}.lock`), async () => {
    try { return await apply(); } catch (error) { persisted.delete(session); throw error; }
  });
}
