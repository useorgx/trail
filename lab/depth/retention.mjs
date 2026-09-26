// How much of the language in a session does trail's reader keep (asks + assistant text), vs what exists?
import { discover } from '../../src/store.mjs'; import { readSession } from '../../src/clients.mjs';
const N = +(process.argv[2] || 40);
const files = discover().filter((f) => f.client === 'claude' || f.client === 'codex').sort((a, b) => b.mtimeMs - a.mtimeMs);
for (const c of ['claude', 'codex']) {
  let say = 0, ask = 0, sayN = 0, clipped = 0, tools = 0;
  for (const f of files.filter((x) => x.client === c && x.size > 20e3 && x.size < 60e6).slice(0, N)) {
    const s = await readSession(f.file, c);
    for (const e of s.ev) { if (e.k === 'say') { say += e.text.length; sayN++; if (e.text.length >= 400) clipped++; } else if (e.k === 'ask') ask += e.text.length; else if (e.k === 'tool') tools++; }
  }
  console.log(c, { kept_assistant_chars: say, assistant_msgs: sayN, clipped_at_400: clipped, kept_ask_chars: ask, tool_events: tools });
}
