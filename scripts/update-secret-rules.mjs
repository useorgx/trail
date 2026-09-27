// Refresh src/secret-rules.json from gitleaks' default ruleset (MIT, github.com/gitleaks/gitleaks).
// gitleaks rules are Go RE2; this converts the few RE2-only constructs to JavaScript, keeps each rule's keywords
// (a cheap prefilter) and entropy threshold, and drops any rule that still won't compile, listing it.
// Usage: node scripts/update-secret-rules.mjs [path-to-gitleaks.toml]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SRC = 'https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml';
const toml = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : execFileSync('curl', ['-sL', SRC]).toString();
const commit = (() => { try { return execFileSync('git', ['ls-remote', 'https://github.com/gitleaks/gitleaks', 'HEAD']).toString().slice(0, 12); } catch { return 'unknown'; } })();

const POSIX = { alnum: 'A-Za-z0-9', alpha: 'A-Za-z', digit: '0-9', xdigit: '0-9A-Fa-f', space: '\\s', upper: 'A-Z', lower: 'a-z', punct: '!-\\/:-@\\[-`{-~', word: '\\w' };
function toJs(re) {
  let flags = 'g'; let src = re;
  if (/\(\?[a-z]*i[a-z]*\)|\(\?i:/.test(src)) flags += 'i'; // JS (Node 22) has no inline or scoped flags: lift to the whole rule
  if (/\(\?[a-z]*s[a-z]*\)/.test(src)) flags += 's';
  src = src.replace(/\(\?[imsU-]+\)/g, '').replace(/\(\?-?[imsU]+:/g, '(?:')
    .replace(/\(\?P</g, '(?<').replace(/\\z/g, '$').replace(/\\A/g, '^')
    .replace(/\[:(\^?)(\w+):\]/g, (m, neg, k) => (POSIX[k] ? POSIX[k] : m))
    .replace(/\\x\{([0-9A-Fa-f]{1,2})\}/g, '\\x$1');
  return { src, flags };
}
const str = (block, key) => block.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
const num = (block, key) => { const m = block.match(new RegExp(`^${key}\\s*=\\s*([0-9.]+)`, 'm')); return m ? +m[1] : null; };
const raw = (block, key) => block.match(new RegExp(`^${key}\\s*=\\s*'''([\\s\\S]*?)'''`, 'm'))?.[1];
// A TOML array ends at a line holding only ']' (regexes inside it contain ']' themselves).
const list = (block, key) => { const m = block.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)^\\]|^${key}\\s*=\\s*\\[([^\\n]*)\\]\\s*$`, 'm')); const body = m ? (m[1] ?? m[2]) : ''; return [...body.matchAll(/"([^"]*)"|'''([\s\S]*?)'''/g)].map((x) => x[1] ?? x[2]); };

const rules = []; const dropped = [];
for (const chunk of toml.split(/^\[\[rules\]\]\s*$/m).slice(1)) {
  const block = chunk.split(/^\[\[rules\.allowlists\]\]/m)[0];
  const id = str(block, 'id'); const re = raw(block, 'regex'); if (!id || !re) continue; // path-only rules don't apply to text
  const { src, flags } = toJs(re);
  try { new RegExp(src, flags); } catch (e) { dropped.push(`${id}: ${e.message.slice(0, 60)}`); continue; }
  rules.push({ id, re: src, flags, group: num(block, 'secretGroup') ?? 0, entropy: num(block, 'entropy'), keywords: list(block, 'keywords').map((k) => k.toLowerCase()) });
}
// Global allowlist value patterns (placeholders like ${VAR}, {{ template }}, true/false) are never redacted.
const allowBlock = toml.split(/^\[allowlist\]/m)[1]?.split(/^\[\[rules\]\]/m)[0] || '';
const allow = list(allowBlock, 'regexes').map((r) => toJs(r)).filter(({ src, flags }) => { try { new RegExp(src, flags.replace('g', '')); return true; } catch { return false; } }).map(({ src, flags }) => ({ re: src, flags: flags.replace('g', '') }));
const stopwords = list(allowBlock, 'stopwords').map((w) => w.toLowerCase());

fs.writeFileSync(new URL('../src/secret-rules.json', import.meta.url), JSON.stringify({
  source: 'gitleaks default config', url: SRC, commit, license: 'MIT, Copyright (c) 2019 Zachary Rice', fetched: new Date().toISOString().slice(0, 10),
  rules, allow, stopwords,
}));
console.log(`${rules.length} rules converted, ${dropped.length} dropped${dropped.length ? ':\n  ' + dropped.join('\n  ') : ''}; ${allow.length} allow patterns, ${stopwords.length} stopwords · gitleaks ${commit}`);
