// Cross-process ownership for the hook worker, CLI and live watcher sharing the same private store.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Linux containers can retain a dead worker as a zombie, or reuse its PID after
// restoring an image. kill(pid, 0) alone does not establish lock ownership.
export function processOwner(pid = process.pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, startTime: fields[19], bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), state: fields[0] };
  } catch { return { pid }; }
}
export function ownerAlive(owner) {
  const current = processOwner(owner.pid);
  if (['Z', 'X'].includes(current.state)) return false;
  if (owner.startTime && current.startTime && owner.startTime !== current.startTime) return false;
  if (owner.bootId && current.bootId && owner.bootId !== current.bootId) return false;
  try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export async function withProcessLock(file, action, { timeoutMs = 60_000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID(); const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ ...processOwner(), token })); } finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner; try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        if (!ownerAlive(owner)) {
          try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === owner.token) fs.unlinkSync(file); } catch {}
          continue;
        }
      }
      if (Date.now() >= deadline) throw new Error('Another Trail process is syncing receipts. Retry when it finishes.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await action(); }
  finally { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch {} }
}
