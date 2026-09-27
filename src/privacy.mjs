// `trail privacy`: what trail keeps, where, who can read it, and exactly what each command sends. Proof over promises:
// counts come from the files on disk, not from documentation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, P } from './store.mjs';
import { RULESET } from './redact.mjs';
import { piiEnabled, opfPath } from './pii.mjs';

function scan(dir) {
  let files = 0, bytes = 0, redactions = 0, mode = null;
  try { mode = (fs.statSync(dir).mode & 0o777).toString(8); } catch { return { files, bytes, redactions, mode }; }
  for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); const st = fs.statSync(p); if (!st.isFile()) continue; files++; bytes += st.size; redactions += (fs.readFileSync(p, 'utf8').match(/\[redacted[:\]]/g) || []).length; }
  return { files, bytes, redactions, mode };
}
/** Claude Code deletes transcripts older than cleanupPeriodDays (default 30); 0 disables transcripts entirely. */
export function claudeRetention() {
  try { const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')); return typeof s.cleanupPeriodDays === 'number' ? s.cleanupPeriodDays : 30; } catch { return 30; }
}
export function privacyReport() {
  return { home: HOME, sessions: scan(P.sessions), language: scan(P.language), ruleset: RULESET, pii: { on: piiEnabled(), opf: opfPath() }, claudeRetentionDays: claudeRetention() };
}
export function privacyText(C) {
  const r = privacyReport(); const mb = (b) => `${(b / 1e6).toFixed(1)} MB`; const priv = (m) => (m === '700' ? `${C.teal}only you${C.r}` : `${C.coral}mode ${m}: others on this machine can read it${C.r}`);
  return [
    `${C.b}What trail keeps${C.r}  ${C.dim}${r.home}${C.r}`,
    `  sessions   ${r.sessions.files} outlines, ${mb(r.sessions.bytes)} · readable by ${priv(r.sessions.mode)}`,
    `  language   ${r.language.files} files of agent messages and reasoning, ${mb(r.language.bytes)} · readable by ${priv(r.language.mode)}`,
    `  secrets    ${r.sessions.redactions + r.language.redactions} redacted before storing · ${r.ruleset.rules} rules (${r.ruleset.source} ${r.ruleset.commit} + OrgX/OpenRouter keys)`,
    '',
    `${C.b}What leaves this machine${C.r}  ${C.dim}(nothing, unless you run one of these)${C.r}`,
    `  trail sync              counts, move strings and PR numbers for each thread; no text, no paths, no prompts`,
    `  trail sync --with-titles  adds thread titles${r.pii.on ? ' (masked by Privacy Filter first)' : ''}`,
    `  trail deepen            agent messages, reasoning and goal evidence, after a quote you confirm${r.pii.on ? '; personal data masked by Privacy Filter first' : ''}`,
    `  trail adopt / guard     nothing: they write a local file, with a backup`,
    '',
    `${C.b}Personal-data masking${C.r}  ${r.pii.on ? `${C.teal}on${C.r}` : 'off'} · OpenAI Privacy Filter ${r.pii.opf ? `found (${r.pii.opf})` : 'not installed'}`,
    `  ${r.pii.on ? 'Names, emails, phones, addresses and account numbers are masked locally before sync --with-titles and deepen.' : 'Turn on with `trail privacy --pii on` (needs: pip install git+https://github.com/openai/privacy-filter).'}`,
    '',
    `${C.b}Your history${C.r}  Claude Code deletes transcripts older than ${C.b}${r.claudeRetentionDays} days${C.r}${r.claudeRetentionDays === 30 ? ' (its default)' : ''}. trail keeps its own outlines after that;`,
    `  to keep the transcripts themselves, raise "cleanupPeriodDays" in ~/.claude/settings.json (0 turns transcripts off entirely).`,
  ].join('\n');
}
