#!/usr/bin/env node
// orgx trail — see what your coding agents actually did, on your machine, in seconds.
import { scanView } from '../src/ui/scanview.mjs';
import { explore } from '../src/ui/explore.mjs';
import { watch } from '../src/ui/watch.mjs';
import { serve } from '../src/serve.mjs';
import { loadSessions, loadAdoptions, P } from '../src/store.mjs';
import { corpus } from '../src/metrics.mjs';
import { unadopt } from '../src/adopt.mjs';
import { sync } from '../src/sync.mjs';

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
  trail unadopt <id> remove a fix trail wrote into CLAUDE.md / AGENTS.md
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
else if (cmd === 'unadopt') { const r = unadopt(argv[1]); console.log(r.length ? `Removed ${r.length} block(s): ${r.map((a) => a.target).join(', ')}` : 'Nothing adopted under that id.'); }
else if (!cmd) { await scanView(opts); if (process.stdout.isTTY && !opts.plain) { console.log('\n  Opening the explorer…'); await new Promise((r) => setTimeout(r, 700)); await explore(); } }
else { console.log(HELP); process.exitCode = 1; }
