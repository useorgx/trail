// Close the loop: write a wall's lesson into the instructions your agents actually read,
// then measure whether they stop hitting it. Every write is a marked block you can remove.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wallById } from './walls.mjs';
import { loadAdoptions, saveAdoptions } from './store.mjs';

export function ruleFor(wall) {
  const named = wallById(wall.sig);
  if (named) return named.rule;
  return `Known failure, seen in ${wall.sessions} earlier sessions: \`${wall.sig.replace(/`/g, "'")}\`. If you hit it, stop and change approach instead of retrying the same call.`;
}

/** Candidate instruction files, most specific first. */
export function targetsFor(wall) {
  const out = []; const H = os.homedir();
  const topProject = Object.entries(wall.projects || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  const cwd = (wall.list || []).map((x) => x.cwd).find(Boolean);
  if (cwd && fs.existsSync(cwd)) { out.push({ label: `${topProject} · AGENTS.md`, file: path.join(cwd, 'AGENTS.md') }); out.push({ label: `${topProject} · CLAUDE.md`, file: path.join(cwd, 'CLAUDE.md') }); }
  out.push({ label: 'All Claude Code sessions · ~/.claude/CLAUDE.md', file: path.join(H, '.claude', 'CLAUDE.md') });
  out.push({ label: 'All Codex sessions · ~/.codex/AGENTS.md', file: path.join(H, '.codex', 'AGENTS.md') });
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48).replace(/^-|-$/g, '');
const blockRe = (id) => new RegExp(`\\n?<!-- orgx-trail:${id} [^>]*-->[\\s\\S]*?<!-- /orgx-trail:${id} -->\\n?`, 'g');

export function adopt(wall, target, rule = ruleFor(wall)) {
  const id = slug(wall.sig); const at = new Date().toISOString();
  const block = `\n<!-- orgx-trail:${id} adopted ${at.slice(0, 10)} · seen in ${wall.sessions} sessions · remove with: trail unadopt ${id} -->\n- ${rule}\n<!-- /orgx-trail:${id} -->\n`;
  let cur = ''; try { cur = fs.readFileSync(target, 'utf8'); } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, cur.replace(blockRe(id), '').replace(/\s*$/, '\n') + block);
  const ads = loadAdoptions().filter((a) => !(a.sig === wall.sig && a.target === target));
  ads.push({ sig: wall.sig, id, at, target, rule, sessionsBefore: wall.sessions }); saveAdoptions(ads);
  return { id, target };
}

export function unadopt(idOrSig) {
  const ads = loadAdoptions(); const keep = []; const removed = [];
  for (const a of ads) {
    if (a.id !== idOrSig && a.sig !== idOrSig) { keep.push(a); continue; }
    try { const cur = fs.readFileSync(a.target, 'utf8'); fs.writeFileSync(a.target, cur.replace(blockRe(a.id), '\n')); } catch {}
    removed.push(a);
  }
  saveAdoptions(keep); return removed;
}
