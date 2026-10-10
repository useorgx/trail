// Append-only JSONL capture. The parsers keep pending calls across tails; only affected goals are rebuilt.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { readClaude, readCodex } from './adapters.mjs';
import { readSession, clientLabel, CLIENTS } from './clients.mjs';
import { threadify, CONTINUE } from './classify.mjs';
import { isCorrection, extractSignals } from './precedent.mjs';
import { steps } from './steps.mjs';
import { buildGoals } from './goals.mjs';
import { buildReceipt, receiptIdOf } from './receipt.mjs';
import { writeReceipts, appendSignals, loadGoverned } from './store.mjs';
import { spanCost } from './cost.mjs';
import { repoOf } from './workstreams.mjs';
import { withLifecycle, SETTLE_MS } from './sync.mjs';
import { receiptFingerprint } from './integrity.mjs';
const materialFingerprint = (receipt) => {
  const key = 'org.orgx.trail/v1'; const { lifecycle, ...extension } = receipt.extensions?.[key] || {};
  return receiptFingerprint({ ...receipt, extensions: { ...receipt.extensions, [key]: extension } });
};

export class ByteTail {
  constructor(file) { this.file = file; this.reset(); }
  reset() { this.offset = 0; this.pending = ''; this.decoder = new StringDecoder('utf8'); this.identity = null; this.mtime = null; }
  read() {
    const stat = fs.statSync(this.file); const identity = `${stat.dev}:${stat.ino}`;
    const reset = this.identity !== null && (identity !== this.identity || stat.size < this.offset || (stat.size === this.offset && stat.mtimeMs !== this.mtime));
    if (reset) this.reset();
    this.identity = identity; this.mtime = stat.mtimeMs;
    const bytes = stat.size - this.offset;
    if (!bytes) return { lines: [], bytes: 0, offset: this.offset, reset };
    const buffer = Buffer.allocUnsafe(bytes); const fd = fs.openSync(this.file, 'r'); let read = 0;
    try { while (read < bytes) { const n = fs.readSync(fd, buffer, read, bytes - read, this.offset + read); if (!n) break; read += n; } } finally { fs.closeSync(fd); }
    this.offset += read;
    const text = this.pending + this.decoder.write(buffer.subarray(0, read));
    const lines = text.split('\n'); this.pending = lines.pop();
    return { lines, bytes: read, offset: this.offset, reset };
  }
}

export class LiveSession {
  constructor(file, client, { persist = true } = {}) {
    this.file = file; this.client = client; this.persist = persist;
    this.incremental = ['claude', 'codex'].includes(client) && file.endsWith('.jsonl');
    this.tail = this.incremental ? new ByteTail(file) : null; this.reset();
  }
  reset(preserveParser = false) { if (!preserveParser) this.parser = {}; this.seen = 0; this.windows = []; this.positions = new WeakMap(); this.events = null; this.session = null; }
  async update() {
    let bytes = 0; let offset = 0; let session;
    if (this.tail) {
      const tail = this.tail.read(); bytes = tail.bytes; offset = tail.offset;
      if (tail.reset) this.reset();
      if (!tail.lines.length) return { changed: false, bytes, offset, checkpoints: [] };
      session = await (this.client === 'claude' ? readClaude : readCodex)(this.file, { state: this.parser, lines: tail.lines });
    } else {
      // Mutable JSON snapshots and SQLite exports use their native reader, while keeping the same receipt pipeline.
      session = await readSession(this.file, this.client); this.reset();
    }
    if (this.events && session.ev !== this.events) this.reset(true); // Codex switches representation; pending parser state survives.
    this.events = session.ev; this.session = session;
    const initial = this.seen === 0;
    const affected = new Set();
    for (const event of this.parser.dirty || []) {
      const at = this.positions.get(event); if (at === undefined) continue;
      const window = this.windows.findLast((w) => w.start <= at); if (window) affected.add(window);
    }
    for (let i = this.seen; i < session.ev.length; i++) {
      const event = session.ev[i]; this.positions.set(event, i);
      let active = this.windows.at(-1);
      let previous = i - 1;
      while (previous >= 0 && ['say', 'compact'].includes(session.ev[previous].k)) previous--;
      const boundary = event.k === 'ask' && !CONTINUE.test(event.text) && !(active && event.who === 'human' && (isCorrection(event.text) || session.ev[previous]?.rejected));
      if (!active || boundary) {
        if (active) { active.end = i; affected.add(active); }
        active = { start: i, end: null, result: null, receipts: [] }; this.windows.push(active);
      }
      affected.add(active);
    }
    this.seen = session.ev.length;
    // Reasoning and result-only records can change a goal without adding an event.
    if (this.windows.length) affected.add(this.windows.at(-1));
    const id = session.id || path.basename(this.file).replace(/\.gz$/, '').replace(/\.jsonl$/, '').slice(-36);
    const meta = { ...session, id, client: this.client, label: clientLabel(this.client), repo: repoOf(session.cwd), project: path.basename(session.cwd || '') };
    const governed = loadGoverned();
    const checkpoints = []; let threadBase = 0; let goalBase = 0;
    for (const window of this.windows) {
      if (affected.has(window)) {
        const end = window.end ?? session.ev.length;
        const slice = { ...session, ev: session.ev.slice(window.start, end) };
        const lang = { reasoning: (session.reasoning || []).filter((r) => r.i >= window.start && r.i <= end).map((r) => ({ ...r, i: r.i - window.start })), full: [] };
        const st = steps(slice, lang); const result = threadify(slice);
        const localGoals = buildGoals(slice, result, st);
        const threadId = (t) => t ? `T${Number(t.slice(1)) + threadBase}` : t;
        for (const t of result.threads) { t.id = threadId(t.id); t.home = threadId(t.home); t.parent = threadId(t.parent); t.spans = (t.spans || []).map(([a, b]) => [a + window.start, b + window.start]); }
        for (const step of st) step.at += window.start;
        for (const goal of localGoals) {
          goal.id = `G${Number(goal.id.slice(1)) + goalBase}`; goal.root = threadId(goal.root); goal.threads = goal.threads.map(threadId);
          goal.spans = goal.spans.map(([a, b]) => [a + window.start, b + window.start]);
          if (goal.outcome.at !== null) goal.outcome.at += window.start;
          goal.backtracks = goal.backtracks.map((b) => ({ ...b, at: b.at + window.start }));
          goal.episodes = goal.episodes.map((e) => ({ ...e, thread: threadId(e.thread) }));
          const cost = spanCost(session.usageEvents || [], goal.spans, session.model, this.client); if (cost) goal.cost = cost;
        }
        const previousThreadCount = window.result?.threads.length;
        window.result = result; window.goals = localGoals; window.pending = slice.ev.some((e) => e.pending);
        const goalAt = new Map(); for (const goal of localGoals) for (const [a, b] of goal.spans) for (let i = a; i <= b; i++) goalAt.set(i, goal);
        const contract = CLIENTS[this.client]?.contract; const harness = contract && contract !== 'other' ? contract : this.client;
        const signals = extractSignals(slice, { sessionId: id, harness, repo: meta.repo, receiptIdAt: (i) => { const goal = goalAt.get(i + window.start); return goal ? receiptIdOf(meta, goal.root) : null; } });
        if (this.persist) appendSignals(signals);
        const receipts = localGoals.map((goal) => {
          const rid = receiptIdOf(meta, goal.root);
          return withLifecycle(buildReceipt(meta, goal, st, result.threads.find((t) => t.id === goal.root), { threads: result.threads, governedBy: governed[rid] ?? governed[id] ?? session.governedBy, signals: signals.filter((s) => s.receiptId === rid).map((s) => s.signalId) }), 'provisional');
        });
        const materiallyChanged = receipts.some((receipt, i) => !window.receipts[i] || materialFingerprint(receipt) !== materialFingerprint(window.receipts[i]));
        if (materiallyChanged) window.activityAt = initial ? Math.max(...receipts.map((r) => Date.parse(r.timestamps.completed_at))) : Date.now();
        window.receipts = receipts.map((receipt) => withLifecycle({ ...receipt, extensions: { ...receipt.extensions, 'org.orgx.trail/v1': { ...receipt.extensions['org.orgx.trail/v1'], lifecycle: { ...receipt.extensions['org.orgx.trail/v1'].lifecycle, material_at: new Date(window.activityAt).toISOString() } } } }, 'provisional'));
        // A late failure can introduce a detour in an older goal. Rebase later IDs to keep them unique.
        if (previousThreadCount !== undefined && previousThreadCount !== result.threads.length) {
          for (const following of this.windows.slice(this.windows.indexOf(window) + 1)) affected.add(following);
        }
        if (this.persist) writeReceipts(`${id}--checkpoint-${window.start}`, window.receipts);
        checkpoints.push(...window.receipts);
      }
      threadBase += window.result?.threads.length || 0; goalBase += window.goals?.length || 0;
    }
    return { changed: true, bytes, offset, session, checkpoints, windows: this.windows };
  }
  settled(now = Date.now(), settleMs = SETTLE_MS) {
    return this.windows.filter((w) => !w.pending && w.activityAt + settleMs <= now).flatMap((w) => w.receipts).map((r) => withLifecycle(r, 'final'));
  }
  nextSettle(now = Date.now(), settleMs = SETTLE_MS) {
    const times = this.windows.filter((w) => !w.pending).map((w) => w.activityAt + settleMs).filter((t) => t > now);
    return times.length ? Math.min(...times) : null;
  }
}

/** Harness Stop/AfterAgent hooks can dispatch the transcript without requiring a manual sync command. */
export async function receiptHook(input, { syncImpl, ...options } = {}) {
  const payload = typeof input === 'string' ? JSON.parse(input) : input;
  const file = payload.transcript_path || payload.transcriptPath;
  if (!file) throw new Error('Receipt hook requires transcript_path.');
  const client = payload.client || (payload.hook_event_name ? 'claude' : 'codex');
  const live = new LiveSession(file, client); const result = await live.update();
  const sync = syncImpl || (await import('./sync.mjs')).syncReceipts;
  return sync({ ...options, receipts: result.checkpoints, lane: 'provisional' });
}

/** File changes wake capture immediately; uploads are queued separately so network time cannot stall the view. */
export async function startLiveCapture(file, client, { receipts = false, base, onUpdate = () => {}, onError = () => {}, syncImpl, settleMs = SETTLE_MS, persist = true } = {}) {
  const live = new LiveSession(file, client, { persist });
  const sync = syncImpl || (await import('./sync.mjs')).syncReceipts;
  let closed = false; let working = false; let dirty = false; let settleTimer; let retryTimer;
  let queue = Promise.resolve(); let retryDelay = 1000;
  const enqueue = (documents, lane) => {
    if (!documents.length || !receipts || closed) return;
    queue = queue.then(async () => {
      if (closed) return;
      try {
        const result = await sync({ base, receipts: documents, lane, limit: documents.length, now: Date.now() + SETTLE_MS - settleMs });
        if (result.refused?.length) throw new Error(`Receipt upload refused: ${JSON.stringify(result.refused)}`);
        retryDelay = 1000;
      } catch (error) {
        onError(error); clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryDelay = Math.min(60_000, retryDelay * 2); scheduleAll(); }, retryDelay);
        retryTimer.unref?.();
      }
    });
  };
  const scheduleAll = () => {
    const documents = live.windows.flatMap((w) => w.receipts);
    const settled = new Set(live.settled(Date.now(), settleMs).map((r) => r.receipt_id));
    enqueue(documents.filter((r) => !settled.has(r.receipt_id)), 'provisional');
    enqueue(documents.filter((r) => settled.has(r.receipt_id)), 'final');
  };
  const scheduleSettle = () => {
    clearTimeout(settleTimer); const next = live.nextSettle(Date.now(), settleMs);
    if (next !== null && receipts) {
      settleTimer = setTimeout(() => { enqueue(live.settled(Date.now(), settleMs), 'final'); scheduleSettle(); }, Math.max(1, next - Date.now()));
      settleTimer.unref?.();
    }
  };
  const update = async () => {
    if (closed) return; dirty = true; if (working) return; working = true;
    try {
      while (dirty && !closed) {
        dirty = false; const result = await live.update();
        if (!result.changed) continue;
        onUpdate(result);
        const settled = new Set(live.settled(Date.now(), settleMs).map((r) => r.receipt_id));
        enqueue(result.checkpoints.filter((r) => !settled.has(r.receipt_id)), 'provisional');
        enqueue(result.checkpoints.filter((r) => settled.has(r.receipt_id)), 'final');
        scheduleSettle();
      }
    } catch (error) { onError(error); } finally { working = false; }
  };
  let watcher;
  if (live.incremental) {
    watcher = fs.watch(path.dirname(file), (_, name) => { if (!name || String(name) === path.basename(file)) void update(); });
    watcher.on('error', onError);
  } else {
    watcher = setInterval(() => void update(), 700);
  }
  await update();
  return {
    live, update, flushed: () => queue,
    close: () => { closed = true; if (watcher?.close) watcher.close(); else clearInterval(watcher); clearTimeout(settleTimer); clearTimeout(retryTimer); },
  };
}
