// `trail archive`: keep your agents' transcripts after their clients delete them. Claude Code removes transcripts
// older than cleanupPeriodDays (default 30). The archive keeps a gzipped copy of each transcript file, readable by you
// only, under ~/.orgx/trail/archive/<client>/<same relative path>.gz; scans read the copy once the original is gone.
// Raw copies (not redacted): they are your own transcripts, kept on your machine, like the originals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// Not imported from store.mjs (which imports this module): same rule, TRAIL_HOME or ~/.orgx/trail.
export const ARCHIVE = path.join(process.env.TRAIL_HOME || path.join(os.homedir(), '.orgx', 'trail'), 'archive');
export const ROOTS = { claude: () => process.env.TRAIL_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects'), codex: () => process.env.TRAIL_CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions') };
const MATCH = { claude: (n) => n.endsWith('.jsonl'), codex: (n) => n.startsWith('rollout-') && n.endsWith('.jsonl') };

function walk(dir, pred, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, pred, out); else if (pred(e.name)) out.push(p); }
  return out;
}
export const archivePathFor = (client, file) => path.join(ARCHIVE, client, path.relative(ROOTS[client](), file) + '.gz');

/** Copy new or changed transcripts. @returns {{copied:number, skipped:number, bytesIn:number, bytesOut:number}} */
export async function archive({ clients = ['claude'], onProgress } = {}) {
  const r = { copied: 0, skipped: 0, bytesIn: 0, bytesOut: 0 };
  fs.mkdirSync(ARCHIVE, { recursive: true, mode: 0o700 }); try { fs.chmodSync(ARCHIVE, 0o700); } catch {}
  for (const client of clients) {
    for (const file of walk(ROOTS[client](), MATCH[client])) {
      const dest = archivePathFor(client, file); const st = fs.statSync(file);
      let prev = null; try { prev = fs.statSync(dest); } catch {}
      // The copy carries the transcript's mtime; setting it goes through float seconds, so allow 1 ms of rounding.
      if (prev && prev.mtimeMs + 1 >= st.mtimeMs) { r.skipped++; continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      const tmp = dest + '.tmp';
      await pipeline(fs.createReadStream(file), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp, { mode: 0o600 }));
      fs.renameSync(tmp, dest); fs.utimesSync(dest, st.atime, st.mtime);
      r.copied++; r.bytesIn += st.size; r.bytesOut += fs.statSync(dest).size; onProgress?.(r);
    }
  }
  return r;
}

/** Archived transcripts whose originals are gone, as discover() entries (read like any other transcript). */
export function archivedOnly({ since } = {}) {
  const out = [];
  for (const client of Object.keys(ROOTS)) {
    const base = path.join(ARCHIVE, client);
    for (const gz of walk(base, (n) => n.endsWith('.jsonl.gz'))) {
      const original = path.join(ROOTS[client](), path.relative(base, gz).replace(/\.gz$/, ''));
      if (fs.existsSync(original)) continue; // the live file is read instead
      const st = fs.statSync(gz); if (since && st.mtime < since) continue;
      out.push({ file: gz, client, size: st.size, mtimeMs: st.mtimeMs, archived: true });
    }
  }
  return out;
}
