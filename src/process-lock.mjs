// Cross-process ownership for the hook worker, CLI and live watcher sharing the same private store.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function withProcessLock(file, action, { timeoutMs = 60_000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID(); const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner; try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (probe) {
          if (probe.code === 'ESRCH') {
            try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === owner.token) fs.unlinkSync(file); } catch {}
            continue;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error('Another Trail process is syncing receipts. Retry when it finishes.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await action(); }
  finally { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch {} }
}
