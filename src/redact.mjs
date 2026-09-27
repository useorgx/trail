// Secrets never leave a transcript through trail. Everything trail stores, uploads or sends to Jev passes here first.
// Detection is gitleaks' default ruleset (221 provider rules with keyword prefilters and entropy thresholds; MIT,
// refreshed by scripts/update-secret-rules.mjs) plus the few formats it doesn't cover that show up in agent work.
// For names, emails, phones and addresses as well, turn on OpenAI Privacy Filter for outgoing text (src/pii.mjs).
import fs from 'node:fs';

const RULES = JSON.parse(fs.readFileSync(new URL('./secret-rules.json', import.meta.url), 'utf8'));
// Formats gitleaks doesn't ship that agents quote: OpenRouter and OrgX keys, and bare Authorization headers.
const EXTRA = [
  { id: 'openrouter-api-key', re: 'sk-or-v1-[0-9a-f]{64}', flags: 'g', group: 0, keywords: ['sk-or-'] },
  { id: 'orgx-api-key', re: '\\boxk_[A-Za-z0-9_-]{20,}', flags: 'g', group: 0, keywords: ['oxk_'] },
  { id: 'authorization-header', re: '\\b(?:authorization|x-api-key)\\s*[:=]\\s*["\']?(?:bearer|basic|token)?\\s*([A-Za-z0-9._~+/=-]{24,})', flags: 'gi', group: 1, keywords: ['authorization', 'x-api-key'] },
];
const COMPILED = [...EXTRA, ...RULES.rules].map((r) => ({ ...r, rx: new RegExp(r.re, r.flags.includes('g') ? r.flags : r.flags + 'g') }));
const ALLOW = RULES.allow.map((a) => new RegExp(a.re, a.flags));
const STOP = RULES.stopwords || [];

function entropy(s) { const c = {}; for (const ch of s) c[ch] = (c[ch] || 0) + 1; let h = 0; for (const k in c) { const p = c[k] / s.length; h -= p * Math.log2(p); } return h; }
const allowed = (secret) => ALLOW.some((a) => a.test(secret)) || STOP.some((w) => secret.toLowerCase().includes(w));

/** Every secret found in `s`, as [start, end, ruleId], non-overlapping, leftmost-longest. */
export function findSecrets(s) {
  if (typeof s !== 'string' || s.length < 8) return [];
  const lower = s.toLowerCase(); const hits = [];
  for (const r of COMPILED) {
    if (r.keywords?.length && !r.keywords.some((k) => lower.includes(k))) continue;
    r.rx.lastIndex = 0; let m;
    while ((m = r.rx.exec(s))) {
      if (m[0].length === 0) { r.rx.lastIndex++; continue; }
      // gitleaks: secretGroup if set, else the first non-empty capture group, else the whole match.
      const g = r.group && m[r.group] != null ? r.group : Math.max(0, m.findIndex((x, i) => i > 0 && x));
      const secret = m[g]; if (!secret) continue;
      if (r.entropy && entropy(secret) < r.entropy) continue;
      if (allowed(secret)) continue;
      const start = m.index + (g ? m[0].indexOf(secret) : 0); hits.push([start, start + secret.length, r.id]);
    }
  }
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]); const out = [];
  for (const h of hits) if (!out.length || h[0] >= out[out.length - 1][1]) out.push(h);
  return out;
}
export function redact(s) {
  const hits = findSecrets(s); if (!hits.length) return s;
  let out = ''; let at = 0;
  for (const [a, b, id] of hits) { out += s.slice(at, a) + `[redacted:${id}]`; at = b; }
  return out + s.slice(at);
}
/** Redact every string inside a JSON-serializable value. */
export const redactDeep = (v) => (typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(redactDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) : v);
export const RULESET = { source: RULES.source, commit: RULES.commit, rules: COMPILED.length };
