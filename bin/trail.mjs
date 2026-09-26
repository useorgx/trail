#!/usr/bin/env node
// orgx trail — see what your coding agents actually did, on your machine, in seconds.
if (process.argv[2] === 'mcp') { const { serveMcp } = await import('../src/mcp.mjs'); await serveMcp(); process.exit(0); }
if (process.argv[2] === 'guard' && process.argv[3] === 'hook') {
  const { runHook } = await import('../src/guard.mjs');
  let input = ''; for await (const c of process.stdin) input += c;
  const out = await runHook(input); if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
import { scanView } from '../src/ui/scanview.mjs';
import { explore } from '../src/ui/explore.mjs';
import { watch } from '../src/ui/watch.mjs';
import { serve } from '../src/serve.mjs';
import { loadSessions, loadAdoptions, P } from '../src/store.mjs';
import { corpus } from '../src/metrics.mjs';
import { unadopt, adopt, targetsFor } from '../src/adopt.mjs';
import { actionFor, effectText, copy, wallId } from '../src/actions.mjs';
import { sync } from '../src/sync.mjs';
import { writeCard, terminal as cardTerminal } from '../src/card.mjs';
import { palette } from '../src/ui/term.mjs';
import { guardStatus, installGuard, uninstallGuard, preventedCount } from '../src/guard.mjs';
import { fileURLToPath } from 'node:url';

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
const flag = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
const opts = { since: val('since') ? new Date(val('since')) : undefined, client: val('client'), rebuild: flag('rebuild'), plain: flag('plain') };

const HELP = `orgx trail — read your Claude Code and Codex history into threads of work. Local, no model, no upload.

  trail              read new work, then open the explorer
  trail scan         read new work only (add --rebuild to reread everything)
  trail explore      open the explorer   (tabs: overview · walls · threads · sessions · quality)
  trail watch        follow the session being written right now
  trail open         open the ledger view in your browser (localhost only)
  trail summary      print the numbers as JSON
  trail walls        the walls your agents keep hitting, each with a fix   (--json for agents)
  trail adopt <id>   write a wall's fix into AGENTS.md / CLAUDE.md          (--to <file>)
  trail copy <id>    copy a wall's fix: --as prompt (default) | rule | command
  trail unadopt <id> remove a fix trail wrote into CLAUDE.md / AGENTS.md
  trail card         your trail as a shareable image + post text   (--copy · --open)
  trail mcp          trail as tools for your agents (claude mcp add trail -- npx -y @useorgx/trail mcp)
  trail guard        prevention: stop known walls before they happen   (install | uninstall | status)
  trail sync         send thread outlines (never transcripts) to your OrgX workspace
                     --dry-run shows exactly what would be sent · --with-titles adds thread titles

  --since 2026-09-01   --client claude|codex   --plain   --rebuild
  Data: ${P.sessions}`;

if (flag('help') || cmd === 'help') console.log(HELP);
else if (cmd === 'scan') await scanView(opts);
else if (cmd === 'explore') await explore();
else if (cmd === 'watch') await watch(opts);
else if (cmd === 'open') await serve({ port: +(val('port') || 4747) });
else if (cmd === 'summary') { const K = corpus(loadSessions(), loadAdoptions()); console.log(JSON.stringify({ ...K.tot, walls: K.walls.slice(0, 20).map(({ list, ...w }) => w), weeks: K.weeks }, null, 1)); }
else if (cmd === 'sync') {
  try { const r = await sync({ dryRun: flag('dry-run'), withTitles: flag('with-titles'), base: val('base'), limit: val('limit') ? +val('limit') : undefined });
    if (r.dryRun) { console.log(`Would send ${r.sessions} sessions (${r.threads} threads, ${r.adoptions} adopted fixes) in ${r.requests} request(s) to ${r.url}\nPrivacy: ${r.privacy}. Transcripts, prompts, file paths and commit messages stay on this machine.\n\nOne session exactly as it would be sent:`); console.log(JSON.stringify(r.example, null, 1)); }
    else console.log(`Sent ${r.sessions} sessions (${r.threads} threads) to ${r.url} · ${r.privacy} · key from ${r.credential}${r.workspace ? ` · workspace ${r.workspace}` : ''}`); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
else if (cmd === 'walls' || cmd === 'adopt' || cmd === 'copy') {
  const K = corpus(loadSessions(), loadAdoptions());
  const walls = K.walls.map((w) => ({ id: wallId(w.sig), name: w.name, sessions: w.sessions, calls: w.calls, first: w.first, last: w.last, clients: w.clients, action: actionFor(w), effect: w.adopted ? { ...w.adopted, summary: effectText(w.adopted).text } : null, _w: w }));
  const find = (id) => walls.find((w) => w.id === id) || walls.find((w) => w.id.startsWith(id || '§'));
  if (cmd === 'walls') {
    if (flag('json')) console.log(JSON.stringify(walls.map(({ _w, ...w }) => w), null, 1));
    else { for (const w of walls.slice(0, +(val('limit') || 15))) console.log(`${String(w.sessions).padStart(5)}  ${w.name}\n       ${w.effect ? 'adopted · ' + w.effect.summary : 'trail copy ' + w.id + '   ·   trail adopt ' + w.id}`); }
  } else {
    const w = find(argv[1]);
    if (!w) { console.error(`No wall matches "${argv[1] || ''}". See: trail walls`); process.exitCode = 1; }
    else if (cmd === 'copy') { const as = val('as') || 'prompt'; const text = w.action[as] ?? w.action.prompt; console.log(copy(text) ? `Copied the ${as} for “${w.name}”.` : text); }
    else { const to = val('to') || targetsFor(w._w)[0]?.file; const r = adopt(w._w, to); console.log(`Wrote the fix for “${w.name}” into ${r.target}\nRemove it any time: trail unadopt ${r.id}`); }
  }
}
else if (cmd === 'card') {
  const r = writeCard(val('out'));
  console.log('\n' + cardTerminal(r.d, palette(opts.plain)) + '\n');
  console.log(`  image  ${r.png || r.svgPath}\n  page   ${r.htmlPath}`);
  if (flag('copy')) console.log(copy(r.text) ? '  Copied the post text.' : `\n${r.text}`); else console.log(`\n  ${r.text.split('\n')[0]}\n  (trail card --copy puts the post text on your clipboard)`);
  if (flag('open') && process.platform === 'darwin') (await import('node:child_process')).execFile('open', [r.htmlPath]);
}
else if (cmd === 'guard') {
  const sub = argv[1] || 'status';
  if (sub === 'install') { const p = installGuard(fileURLToPath(import.meta.url)); const st = guardStatus(); console.log(`Guard installed in ${p} (a backup of the old file is in ~/.orgx/trail/backup).\nIt acts only in don't-ask sessions and guards ${st.walls} walls with evidence behind them. Remove it: trail guard uninstall`); }
  else if (sub === 'uninstall') console.log(uninstallGuard() ? 'Guard removed.' : 'Guard was not installed.');
  else { const st = guardStatus(); console.log(flag('json') ? JSON.stringify(st) : `Guard ${st.installed ? 'installed' : 'not installed'} · ${st.walls} walls guarded · trail stopped ${st.prevented} rediscoveries · ${st.settings}`); }
}
else if (cmd === 'unadopt') { const r = unadopt(argv[1]); console.log(r.length ? `Removed ${r.length} block(s): ${r.map((a) => a.target).join(', ')}` : 'Nothing adopted under that id.'); }
else if (!cmd) { await scanView(opts); if (process.stdout.isTTY && !opts.plain) { console.log('\n  Opening the explorer…'); await new Promise((r) => setTimeout(r, 700)); await explore(); } }
else { console.log(HELP); process.exitCode = 1; }
