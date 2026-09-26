// Every insight ends in something you can do. One action, three forms:
//   rule    — the line a person reads (and that gets written into AGENTS.md / CLAUDE.md)
//   prompt  — paste into any agent: it makes the change itself
//   command — run it: trail makes the change, removable later
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { ruleFor } from './adopt.mjs';

export const wallId = (sig) => String(sig).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48).replace(/^-|-$/g, '');

export function actionFor(wall) {
  const id = wallId(wall.sig); const rule = ruleFor(wall);
  return {
    id, rule,
    prompt: `Add this rule to this repo's AGENTS.md (create it if missing), in its own short section, then show me the diff:\n\n- ${rule}\n\nWhy: my agents hit "${wall.name}" in ${wall.sessions} earlier sessions (found by orgx trail).`,
    command: `npx @useorgx/trail adopt ${id}`,
  };
}

/** Plain words for how an adopted fix is doing, shared by the terminal, the browser, the card and `trail share`. */
export function effectText(e) {
  if (!e) return null;
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  if (e.confounded) return { tone: 'amber', text: `can't tell yet: sessions switched from ${e.mode} to ${e.modeAfter} mode since adopting, so the before/after isn't comparable` };
  if (!e.enough) return { tone: 'dim', text: `measuring: ${e.after.sessions} comparable session${e.after.sessions === 1 ? '' : 's'} since adopting (needs 5)` };
  return { tone: e.afterRate < e.beforeRate ? 'teal' : 'coral', text: `hit in ${pct(e.beforeRate)} of ${e.mode} sessions before (${e.before.sessions}) → ${pct(e.afterRate)} after (${e.after.sessions})` };
}

/** Copy to the clipboard: OSC 52 (works over SSH and in most modern terminals) plus pbcopy/xclip where present. */
export function copy(text) {
  let ok = false;
  if (process.platform === 'darwin') { try { execFileSync('pbcopy', { input: text }); ok = true; } catch {} }
  else if (process.platform === 'linux') { for (const [c, a] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]) { try { execFileSync(c, a, { input: text }); ok = true; break; } catch {} } }
  if (!ok || process.env.SSH_TTY) {
    try { const seq = `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`; if (process.stdout.isTTY) process.stdout.write(seq); else fs.writeFileSync('/dev/tty', seq); ok = true; } catch {}
  }
  return ok;
}
