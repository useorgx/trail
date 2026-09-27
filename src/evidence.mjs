// Evidence text for a set of event spans: numbered events a reviewer (person, Jev, a model) reads to judge a
// thread or goal. Shared by the lab (frozen at sampling) and `trail deepen` (goal outcomes).

/**
 * Render the events a thread owns, numbered, with a little lead-in context. Capped, middle elided.
 * With `language` (from readLanguage), reasoning is interleaved by time as [r] lines and agent messages are shown whole.
 */
export function renderEvidence(s, spans, cap = 14000, language = null) {
  const own = new Set(); for (const [a, b] of spans) for (let i = a; i <= b; i++) own.add(i);
  const first = spans[0]?.[0] ?? 0; const last = spans[spans.length - 1]?.[1] ?? first; const lines = [];
  const after = new Set(); for (let i = last + 1, n = 0; i < s.ev.length && n < 3; i++, n++) after.add(i);
  const think = (language || []).filter((x) => x.k === 'think'); let ti = 0; let prevTs = -Infinity;
  const fullSay = (e) => { if (!language) return e.text; const t = Date.parse(e.ts); const m = language.find((x) => x.k === 'say' && Math.abs(x.ts - t) < 2000 && x.text.replace(/\s+/g, ' ').startsWith(e.text.replace(/\s+/g, ' ').slice(0, 60))); return m ? m.text : e.text; };
  for (let i = Math.max(0, first - 3); i < s.ev.length; i++) {
    if (!own.has(i) && i >= first && !after.has(i)) continue;
    const e = s.ev[i]; const mark = own.has(i) ? ' ' : '~';
    const at = Date.parse(e.ts);
    if (own.has(i) && Number.isFinite(at)) { while (ti < think.length && think[ti].ts <= at) { if (think[ti].ts > prevTs) lines.push(`[r] REASONING: ${think[ti].text.replace(/\s+/g, ' ').slice(0, 900)}`); ti++; } prevTs = at; }
    else if (Number.isFinite(at)) { while (ti < think.length && think[ti].ts <= at) ti++; prevTs = at; }
    let line;
    if (e.k === 'ask') line = `[${i}]${mark}PERSON${e.who !== 'human' ? ` (${e.who})` : ''}: ${e.text}`;
    else if (e.k === 'say') line = `[${i}]${mark}AGENT: ${own.has(i) ? fullSay(e) : e.text}`;
    else if (e.k === 'compact') line = `[${i}]${mark}(context compacted)`;
    else line = `[${i}]${mark}TOOL ${e.tool}: ${e.target}${e.err ? `  => ${e.denied ? 'DENIED' : 'FAILED'}: ${String(e.errText).replace(/\s+/g, ' ').slice(0, 220)}` : ''}${e.out ? `  => ${String(e.out).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
    lines.push(line.replace(/\s+/g, ' ').slice(0, language ? 1500 : 700));
  }
  // Say plainly where the thread stops relative to the session, so "still open" vs "moved on" is decidable.
  const remaining = s.ev.length - 1 - last;
  lines.push(remaining <= 0 ? `[end] The session transcript ends at this thread's last event [${last}].` : `[end] This thread's last event is [${last}]. The session continued for ${remaining} more events (other threads; the first ${Math.min(3, remaining)} are shown with ~).`);
  let text = lines.join('\n');
  if (text.length > cap) { const head = text.slice(0, cap * 0.55); const tail = text.slice(-cap * 0.4); text = `${head}\n… [${lines.length} events total; middle omitted] …\n${tail}`; }
  return text;
}
