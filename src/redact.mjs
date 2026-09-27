// Secrets never leave a transcript through trail: agent messages and reasoning sometimes quote keys (a pasted .env,
// a curl with a bearer token). Everything trail stores, uploads or sends to Jev passes through here first.
const PATTERNS = [
  /\bsk-(?:ant-|or-v1-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenRouter, OpenAI, Stripe-style
  /\b(?:oxk|ghp|gho|ghu|ghs|github_pat|glpat|xox[abpr])_[A-Za-z0-9_-]{16,}/g, // OrgX, GitHub, GitLab, Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{24,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*[=:]\s*["']?[^\s"'#]{8,}/g,
];
export function redact(s) {
  if (typeof s !== 'string' || s.length < 16) return s;
  let out = s;
  for (const re of PATTERNS) out = out.replace(re, (m, name) => (typeof name === 'string' && /KEY|TOKEN|SECRET|PASSW/.test(name) ? `${name}=[redacted]` : /^(Bearer|Basic)/.test(m) ? `${m.split(/\s+/)[0]} [redacted]` : '[redacted]'));
  return out;
}
/** Redact every string inside a JSON-serializable value. */
export const redactDeep = (v) => (typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(redactDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) : v);
