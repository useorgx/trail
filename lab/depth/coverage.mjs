// What share of each transcript does trail's reader use? Counts characters by kind for a recent sample.
// Usage: node lab/depth/coverage.mjs [perClient=40]
import fs from 'node:fs'; import readline from 'node:readline';
import { discover } from '../../src/store.mjs';
const N = +(process.argv[2] || 40);
const files = discover().filter((f) => f.client === 'claude' || f.client === 'codex').sort((a, b) => b.mtimeMs - a.mtimeMs);
const pick = (c) => files.filter((f) => f.client === c && f.size > 20e3 && f.size < 60e6).slice(0, N);
const tot = {};
const add = (c, k, n) => { const t = (tot[c] ||= {}); t[k] = (t[k] || 0) + n; };
for (const c of ['claude', 'codex']) for (const f of pick(c)) {
  add(c, 'sessions', 1);
  const rl = readline.createInterface({ input: fs.createReadStream(f.file), crlfDelay: Infinity });
  for await (const l of rl) {
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (c === 'claude') {
      const content = d.message?.content; if (!Array.isArray(content)) { if (typeof content === 'string') add(c, d.type === 'user' ? 'user_text' : 'assistant_text', content.length); continue; }
      for (const b of content) {
        if (b.type === 'thinking') { const n = (b.thinking || '').length; add(c, 'thinking_blocks', 1); if (n) { add(c, 'thinking_visible_blocks', 1); add(c, 'thinking_chars', n); } }
        else if (b.type === 'redacted_thinking') add(c, 'thinking_redacted_blocks', 1);
        else if (b.type === 'text') add(c, d.type === 'user' ? 'user_text' : 'assistant_text', (b.text || '').length);
        else if (b.type === 'tool_use') add(c, 'tool_input', JSON.stringify(b.input || {}).length);
        else if (b.type === 'tool_result') add(c, 'tool_output', typeof b.content === 'string' ? b.content.length : JSON.stringify(b.content || '').length);
      }
    } else {
      const p = d.payload || {};
      if (p.type === 'reasoning') {
        add(c, 'reasoning_items', 1);
        const sum = (p.summary || []).map((s) => s.text || '').join(' '); const raw = (p.content || []).map((s) => s.text || '').join(' ');
        if (sum) { add(c, 'reasoning_summary_items', 1); add(c, 'reasoning_summary_chars', sum.length); }
        if (raw) { add(c, 'reasoning_raw_items', 1); add(c, 'reasoning_raw_chars', raw.length); }
        if (p.encrypted_content) add(c, 'reasoning_encrypted_items', 1);
      } else if (p.type === 'message') add(c, p.role === 'user' ? 'user_text' : p.role === 'assistant' ? 'assistant_text' : 'system_text', (p.content || []).map((x) => x.text || '').join(' ').length);
      else if (/call$/.test(p.type || '')) add(c, 'tool_input', String(p.arguments ?? p.input ?? '').length);
      else if (/_call_output$/.test(p.type || '')) add(c, 'tool_output', (typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '')).length);
    }
  }
}
console.log(JSON.stringify(tot, null, 1));
