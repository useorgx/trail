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
import { unadopt, adopt, adoptPreview, targetsFor } from '../src/adopt.mjs';
import { actionFor, effectText, copy, wallId } from '../src/actions.mjs';
import { sync, connect } from '../src/sync.mjs';
import { experiments, METRICS } from '../src/experiments.mjs';
import { bench } from '../src/bench.mjs';
import { shareFor } from '../src/share.mjs';
import { writeCard, terminal as cardTerminal } from '../src/card.mjs';
import { palette } from '../src/ui/term.mjs';
import { creditsText } from '../src/credits.mjs';
import { guardStatus, installGuard, uninstallGuard, preventedCount } from '../src/guard.mjs';
import { fileURLToPath } from 'node:url';

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
const flag = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
const opts = { since: val('since') ? new Date(val('since')) : undefined, client: val('client'), rebuild: flag('rebuild'), plain: flag('plain') };

const HELP = `orgx trail — see what your coding agents did and where they got stuck. Local, no model, no upload.

  trail              read new work, then open the explorer
  trail scan         read new work only (add --rebuild to reread everything)
  trail --demo       try it on a made-up history (reads nothing from your machine)
  trail explore      open the explorer
  trail watch        follow the session being written right now
  trail open         open the ledger view in your browser (localhost only)
  trail summary      print the numbers as JSON
  trail deepen       get surer outcomes: Jev reads each step and piece of work · opt-in · quote shown first
                     pay with OrgX credits after trail connect, or use your own key with --key-file
  trail receipts     one Agent Work Receipt per piece of work: asked, done, checked, delivered   (<id> for one · --json)
  trail workstreams  pieces of work joined across sessions by shared PRs, branches, files, continuations   (<id> · --all)
  trail search <q>   search the ledger: text plus filters like outcome:blocked type:fix repo:x pr:12 conf:<0.6 unmet:tests
  trail review       questions about your own receipts only you can settle; answer with trail label
  trail taxonomy     the work types trail labels with, and what OrgX grows from them
  trail goals        show each piece of work, its detours, its result, and each change of course   (--json)
  trail walls        find a wall: a failure your agents keep hitting in separate sessions   (--json for agents)
  trail adopt <id>   write a selected fix into AGENTS.md / CLAUDE.md        (--to <file>)
  trail copy <id>    copy a selected fix: --as prompt (default) | rule | command
  trail unadopt <id> remove a fix trail wrote into CLAUDE.md / AGENTS.md
  trail experiments  did your AGENTS.md / CLAUDE.md edits change agent behavior? (95% intervals)
  trail bench        test whether a model would repeat known failures (--models haiku,sonnet · --limit 10)
  trail share <id>   a public page for a fix, measured across everyone who adopted it (--copy)
  trail card         create a shareable summary image + post text   (--copy · --open)
  trail archive      keep transcripts after Claude Code deletes them (30 days by default)   (--client claude|codex|all)
  trail privacy      what trail keeps, where, who can read it, and what each command sends   (--pii on|off)
  trail credits      the people whose work trail is built on, and where each idea lives in trail
  trail mcp          give your agents tools for reading trail data (claude mcp add trail -- npx -y @useorgx/trail mcp)
  trail guard        stop known repeat failures before they happen   (install | uninstall | status)
  trail connect      sign in to OrgX through the OrgX wizard (the one sign-in every OrgX tool shares)
  trail sync         send session outlines (never transcripts) to your OrgX workspace
                     --dry-run shows exactly what would be sent · --with-titles adds thread titles
                     --receipts sends Agent Work Receipts instead (includes asks and summaries; redacted; opt-in)

  Colour-blind palette: TRAIL_PALETTE=cb
  --since 2026-09-01   --client claude|codex|opencode|cursor   --plain   --rebuild
  Data: ${P.sessions}`;

if (flag('help') || cmd === 'help') console.log(HELP);
else if (flag('demo') || cmd === 'demo') { const { demo } = await import('../src/demo.mjs'); await demo(fileURLToPath(import.meta.url)); }
else if (cmd === 'scan') await scanView(opts);
else if (cmd === 'explore') await explore();
else if (cmd === 'watch') await watch(opts);
else if (cmd === 'open') await serve({ port: +(val('port') || 4747) });
else if (cmd === 'deepen') {
  // Opt-in: Jev tags each language step and reads each goal's outcome; goals are then rebuilt. Paid either with your
  // own OpenRouter key or with OrgX credits (after `trail connect`). Always shows what it will send and cost first.
  const { deepen, pickProvider } = await import('../src/deepen.mjs');
  const provider = pickProvider({ keyFile: val('key-file'), base: val('base') });
  if (!provider) { console.error('trail deepen is opt-in. Either run `trail connect` to pay with OrgX credits, or pass --key-file <env file> (or set OPENROUTER_API_KEY) to use your own OpenRouter key.'); process.exitCode = 2; }
  else try {
    const confirm = async (q) => {
      const cost = q.credits != null ? `${q.credits} credits ($${q.usd.toFixed(2)}); you have ${q.available}` : `about $${q.usd.toFixed(2)} on your OpenRouter account`;
      console.log(`\n  trail deepen via ${provider.name}: ${q.steps.toLocaleString()} steps and ${q.goals.toLocaleString()} goals · ${cost}`);
      console.log(`  Sends agent messages, reasoning and goal evidence to ${provider.name === 'OrgX credits' ? 'OrgX, which asks Jev (TypeSafe) and does not keep them' : 'OpenRouter/TypeSafe'}. Nothing else leaves this machine.`);
      if (q.enough === false) { console.log(`  Not enough credits: buy a pack at ${q.buy_url?.startsWith('http') ? q.buy_url : (val('base') || 'https://useorgx.com') + q.buy_url}`); return false; }
      if (flag('yes')) return true;
      const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
      const a = await new Promise((res) => rl.question('  Continue? [y/N] ', res)); rl.close(); return /^y(es)?$/i.test(a.trim());
    };
    const r = await deepen({ provider, limit: val('limit') ? +val('limit') : undefined, confirm, onProgress: (p) => process.stderr.write(`  ${p.done}/${p.total}${p.charged != null ? ` · ${p.charged} credits` : ` · $${(p.cost || 0).toFixed(4)}`}\r`) });
    if (r.nothing) console.log('Nothing new to deepen: every step and goal already has an answer.');
    else if (r.cancelled) console.log('Cancelled. Nothing was sent.');
    else { console.log(`\nJev answered for ${r.steps} steps and ${r.goals} goals in ${r.sessions} sessions (${r.charged != null ? `${r.charged} credits` : `$${(r.cost || 0).toFixed(4)}`}). Rebuilding goals…`); await scanView({ ...opts, plain: true }); }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
else if (cmd === 'goals') {
  // Goals: one per ask, detours inside, outcome read from the steps (src/goals.mjs).
  const C = palette(opts.plain); const lim = +(val('limit') || 15);
  const rows = []; outer: for (const s of [...loadSessions()].reverse()) for (const g of [...(s.goals || [])].reverse()) { rows.push({ s, g }); if (rows.length >= lim) break outer; }
  if (flag('json')) console.log(JSON.stringify(rows.map(({ s, g }) => ({ session: s.id, client: s.client, project: s.project, start: s.start, ...g })), null, 1));
  else {
    const col = { done: C.teal, parked: C.amber, dropped: C.coral, open: C.iris, unclear: C.dim };
    const all = loadSessions().flatMap((s) => s.goals || []); const by = {}; for (const g of all) by[g.status] = (by[g.status] || 0) + 1;
    console.log(`\n${C.b}${all.length} goals${C.r} ${C.dim}(from ${loadSessions().filter((s) => s.goals).length} sessions still on disk)${C.r}  ` + Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${col[k] || ''}${k} ${v}${C.r}`).join(' · ') + '\n');
    for (const { s, g } of rows) {
      const ep = {}; for (const e of g.episodes) ep[e] = (ep[e] || 0) + 1;
      console.log(`  ${(s.start || '').slice(5, 10)} ${String(s.project).slice(0, 14).padEnd(14)} ${col[g.status] || ''}${g.outcome.kind.replace('_', ' ').padEnd(17)}${C.r} ${String(g.title).slice(0, 52).padEnd(52)} ${C.dim}${g.cost?.usd != null ? `$${g.cost.usd.toFixed(2).padStart(6)} ` : '        '}${[...Object.entries(ep).map(([k, v]) => `${v} ${k}`), ...(g.backtracks.length ? [`${g.backtracks.length} backtrack${g.backtracks.length > 1 ? 's' : ''}`] : [])].join(' · ')}${C.r}`);
    }
    console.log('');
  }
}
else if (['receipts', 'workstreams', 'search', 'review', 'label', 'taxonomy'].includes(cmd)) {
  const { ledger, rowOf, reviewQueue, teamQuestions } = await import('../src/ledger.mjs');
  const { search, receiptDetail, workstreamDetail } = await import('../src/search.mjs');
  const { overrideLabel, loadTaxonomy, WORK_TYPES } = await import('../src/taxonomy.mjs');
  const C = palette(opts.plain); const json = flag('json'); const lim = +(val('limit') || 20);
  const OUT = { succeeded: C.teal, partially_succeeded: C.amber, blocked: C.coral, failed: C.coral, unknown: C.dim };
  const pct = (x) => (x == null ? '  —' : String(Math.round(x * 100)).padStart(3) + '%');
  const line = (x) => `  ${String(x.at).slice(5, 10)} ${String(x.repo || '—').slice(0, 12).padEnd(12)} ${OUT[x.outcome] || ''}${x.outcome.replace('_', ' ').slice(0, 13).padEnd(13)}${C.r} ${String(x.work_type || '').padEnd(11)} ${C.dim}${pct(x.confidence)}${C.r} ${String(x.summary).replace(/\s+/g, ' ').slice(0, 58).padEnd(58)} ${C.dim}${x.id.split(':').slice(-2).join(':').slice(-22)}${x.criteria.unmet ? ` · ${x.criteria.unmet} unmet` : ''}${x.workstream ? ` · ${x.workstream}` : ''}${C.r}`;
  const pos = argv.filter((a, i) => !a.startsWith('--') && !['--limit', '--name', '--into', '--since', '--client', '--export'].includes(argv[i - 1])); const sub = pos[1];
  if (cmd === 'receipts' && sub && sub !== 'list') { const d = receiptDetail(sub); if (!d) { console.error(`No receipt matches "${sub}".`); process.exitCode = 1; } else console.log(JSON.stringify(d, null, 1)); }
  else if (cmd === 'receipts' && val('export')) { const { withGraph } = await import('../src/ledger.mjs'); const L = ledger(); const out = L.receipts.slice().sort((a, b) => String(b.timestamps.started_at).localeCompare(String(a.timestamps.started_at))).slice(0, +(val('limit') || 1000)).map((r) => withGraph(r, L));
    (await import('node:fs')).writeFileSync(val('export'), JSON.stringify(out), { mode: 0o600 }); console.log(`Wrote ${out.length} receipts (as trail sync --receipts would send them, before personal-data masking) to ${val('export')}`); }
  else if (cmd === 'receipts') { const L = ledger(); const rows = L.receipts.slice().sort((a, b) => String(b.timestamps.started_at).localeCompare(String(a.timestamps.started_at))).slice(0, lim).map((r) => rowOf(r, L));
    if (json) console.log(JSON.stringify(rows, null, 1)); else { console.log(`\n${C.b}${L.receipts.length} receipts${C.r} ${C.dim}(one per piece of work · Agent Work Receipt v0.1 · trail receipts <id> for one)${C.r}\n`); rows.forEach((x) => console.log(line(x))); console.log(''); } }
  else if (cmd === 'workstreams' && sub && sub !== 'list') { const d = workstreamDetail(sub); if (!d) { console.error(`No workstream matches "${sub}".`); process.exitCode = 1; } else if (json) console.log(JSON.stringify(d, null, 1)); else { console.log(`\n${C.b}${d.title}${C.r}  ${C.dim}${d.id} · ${d.status} · ${d.receipts.length} pieces of work over ${d.sessions} sessions · linked ${Object.entries(d.relationships).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(', ')} · weakest link ${pct(d.weakest_link)}${C.r}\n  ${C.dim}objects: ${d.objects.map((o) => o.key).slice(0, 6).join(', ') || '—'}${C.r}\n`); d.members.forEach((x) => console.log(line(x))); console.log(''); } }
  else if (cmd === 'workstreams') { const L = ledger(); let ws = L.built.workstreams; if (!flag('all')) ws = ws.filter((w) => w.sessions > 1);
    if (json) console.log(JSON.stringify(ws.slice(0, lim), null, 1)); else { console.log(`\n${C.b}${ws.length} workstreams${C.r} ${C.dim}${flag('all') ? '' : 'spanning more than one session (--all for every one) · '}joined by shared PRs, branches, rare files, ids, and continuations${C.r}\n`);
      for (const w of ws.slice(0, lim)) console.log(`  ${String(w.last_at).slice(5, 10)} ${String(w.repo || '—').slice(0, 12).padEnd(12)} ${({ done: C.teal, done_with_gaps: C.amber, blocked: C.coral, dropped: C.coral })[w.status] || C.dim}${w.status.replace(/_/g, ' ').padEnd(15)}${C.r} ${String(w.receipts.length).padStart(3)} pieces ${String(w.sessions).padStart(2)} sess ${C.dim}${pct(w.weakest_link)}${C.r} ${w.title.slice(0, 60).padEnd(60)} ${C.dim}${w.id}${C.r}`); console.log(''); } }
  else if (cmd === 'search') { const q = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(arr[i - 1] === '--limit')).join(' '); const r = search(q, { limit: lim });
    if (json) console.log(JSON.stringify(r, null, 1)); else { console.log(`\n${C.b}${r.total} match${r.total === 1 ? '' : 'es'}${C.r} ${C.dim}${JSON.stringify(r.query.filters) !== '{}' ? JSON.stringify(r.query.filters) + ' ' : ''}${r.query.text ? `“${r.query.text}”` : ''}${C.r}\n`); r.results.forEach((x) => console.log(line(x))); console.log(''); } }
  else if (cmd === 'review') { const L = ledger(); const q = reviewQueue(L, { limit: lim });
    if (json) console.log(JSON.stringify(q, null, 1)); else { console.log(`\n${C.b}Review queue${C.r} ${C.dim}— questions about your own work that only you can settle. Answers stay here and win over every guess.${C.r}\n`);
      q.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)}. ${C.b}${x.question}${C.r} ${C.dim}guess: ${x.guess} (${pct(x.confidence).trim()})${C.r}\n      ${String(x.summary).replace(/\s+/g, ' ').slice(0, 100)}\n      ${C.dim}${x.kind === 'criterion' ? `trail label ${x.receipt} ${x.criterion}:met|unmet` : `trail label ${x.receipt} outcome:succeeded|failed|blocked|…`}${C.r}`));
      const t = teamQuestions(L); console.log(`\n  ${C.dim}Team questions are answered in OrgX, with everyone's receipts in view: ${t.suggested_links} possible links between efforts, ${t.area_candidates} candidate code areas, ${t.unlabelled} pieces of work with an unclear type, and which initiative each workstream serves. trail sync --receipts --dry-run shows what would go.${C.r}\n`); } }
  else if (cmd === 'label') { const [, id, ...pairs] = argv.filter((a) => !a.startsWith('--')); const patch = {}; const tax = loadTaxonomy();
    for (const p of pairs) { const [k, v] = p.split(':'); if (k === 'type') patch.work_type = v; else if (k === 'outcome') patch.outcome = v; else if (/^c\d+$/.test(k)) patch.criteria = { ...(tax.overrides[id]?.criteria || {}), ...(patch.criteria || {}), [k]: v }; }
    if (!id || !Object.keys(patch).length) { console.error('Usage: trail label <receipt-id> outcome:succeeded | c1:met | type:fix'); process.exitCode = 1; }
    else { const r = overrideLabel(id, patch, 'human', tax); console.log(`Labelled ${id}: ${JSON.stringify(r)}`); } }
  else if (cmd === 'taxonomy') { const L = ledger(); const counts = {}; for (const x of Object.values(L.labels)) counts[x.work_type.id] = (counts[x.work_type.id] || 0) + 1; const t = teamQuestions(L);
    if (json) console.log(JSON.stringify({ version: L.tax.version, work_types: WORK_TYPES.map(({ re, ...w }) => ({ ...w, receipts: counts[w.id] || 0 })), follow_up: counts.follow_up || 0, other: counts.other || 0, team: t }, null, 1));
    else { console.log(`\n${C.b}Work types${C.r} ${C.dim}(a fixed list, scored from the ask and what the agent did)${C.r}`); for (const w of WORK_TYPES) console.log(`  ${w.id.padEnd(12)} ${String(counts[w.id] || 0).padStart(5)}  ${C.dim}${w.about}${C.r}`); console.log(`  ${'follow_up'.padEnd(12)} ${String(counts.follow_up || 0).padStart(5)}  ${C.dim}short replies with nothing to inherit from${C.r}\n  ${'other'.padEnd(12)} ${String(counts.other || 0).padStart(5)}  ${C.dim}no signal${C.r}`);
      console.log(`\n  ${C.dim}Areas of your codebase are grown in OrgX from the whole team's receipts: trail sends the evidence (${t.area_candidates} candidate segments here), OrgX proposes areas, your team confirms, renames or merges them, and maps work to initiatives.${C.r}\n`); } }
}
else if (cmd === 'summary') { const K = corpus(loadSessions(), loadAdoptions()); console.log(JSON.stringify({ ...K.tot, walls: K.walls.slice(0, 20).map(({ list, ...w }) => w), weeks: K.weeks }, null, 1)); }
else if (cmd === 'connect') {
  try { const r = await connect({ base: val('base') });
    console.log(r.already ? `Already connected: using the OrgX key from ${r.credential}.` : `Connected: the wizard stored your key (${r.credential}).`);
    console.log('Nothing has been sent. `trail sync --dry-run` shows exactly what would go; `trail sync` sends it.'); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
else if (cmd === 'sync' && flag('receipts')) {
  try { const { syncReceipts } = await import('../src/sync.mjs'); const r = await syncReceipts({ dryRun: flag('dry-run'), base: val('base'), limit: val('limit') ? +val('limit') : undefined, since: val('since') });
    if (r.dryRun) { console.log(`Would send ${r.receipts} receipts to ${r.url} (${r.pending} not yet sent in total; --limit raises the batch)\nPrivacy: ${r.privacy}. Receipts include the ask, summaries, command lines and short output excerpts.\n\nOne receipt exactly as it would be sent:`); console.log(JSON.stringify(r.example, null, 1));
      if (r.signals?.pending) { console.log(`\nWould also send ${r.signals.pending} judgment signals (corrections, rejections, denials, stated rules, in your own words) to ${r.signals.url}. One exactly as it would be sent:`); console.log(JSON.stringify(r.signals.example, null, 1)); } }
    else console.log(`Sent ${r.receipts} receipts to ${r.url}${r.duplicate ? ` (${r.duplicate} were already there)` : ''} · ${r.privacy} · key from ${r.credential}${r.refused.length ? `\nRefused ${r.refused.length}: ${JSON.stringify(r.refused.slice(0, 3))}` : ''}${r.remaining ? `\n${r.remaining} still to send: run it again, or --limit N` : ''}${r.signals?.sent ? `\nSent ${r.signals.sent} judgment signals to ${r.signals.url}` : ''}${r.signals?.unsupported ? `\n${r.signals.pending} judgment signals kept on this machine: this OrgX does not take them yet` : r.signals?.error ? `\nJudgment signals not sent (${r.signals.error}); kept on this machine for next time` : ''}`); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
else if (cmd === 'sync') {
  try { const r = await sync({ dryRun: flag('dry-run'), withTitles: flag('with-titles'), base: val('base'), limit: val('limit') ? +val('limit') : undefined });
    if (r.dryRun) { console.log(`Would send ${r.sessions} sessions (${r.threads} threads, ${r.adoptions} adopted fixes) in ${r.requests} request(s) to ${r.url}\nPrivacy: ${r.privacy}. Transcripts, prompts, file paths and commit messages stay on this machine.\n\nOne session exactly as it would be sent:`); console.log(JSON.stringify(r.example, null, 1)); }
    else console.log(`Sent ${r.sessions} sessions (${r.threads} threads) to ${r.url} · ${r.privacy} · key from ${r.credential}${r.workspace ? ` · workspace ${r.workspace}` : ''}`); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
else if (cmd === 'walls' || cmd === 'adopt' || cmd === 'copy') {
  const K = corpus(loadSessions(), loadAdoptions());
  const walls = K.walls.map((w) => ({ id: wallId(w.sig), name: w.name, sessions: w.sessions, calls: w.calls, detour_usd: +(w.detourUsd || 0).toFixed(2), first: w.first, last: w.last, clients: w.clients, action: actionFor(w), effect: w.adopted ? { ...w.adopted, summary: effectText(w.adopted).text } : null, _w: w }));
  const find = (id) => walls.find((w) => w.id === id) || walls.find((w) => w.id.startsWith(id || '§'));
  if (cmd === 'walls') {
    if (flag('json')) console.log(JSON.stringify(walls.map(({ _w, ...w }) => w), null, 1));
    else {
      const { PRICE_SOURCE } = await import('../src/cost.mjs');
      for (const w of walls.slice(0, +(val('limit') || 15))) console.log(`${String(w.sessions).padStart(5)}  ${w.name}${w.detour_usd >= 0.01 ? `   ~$${w.detour_usd.toFixed(2)} in detours` : ''}\n       ${w.effect ? 'adopted · ' + w.effect.summary : 'trail copy ' + w.id + '   ·   trail adopt ' + w.id}`);
      console.log(`\n  sessions · wall · estimated cost of the recoveries it caused, at list prices (${PRICE_SOURCE})`);
    }
  } else {
    const w = find(argv[1]);
    if (!w) { console.error(`No wall matches "${argv[1] || ''}". See: trail walls`); process.exitCode = 1; }
    else if (cmd === 'copy') { const as = val('as') || 'prompt'; const text = w.action[as] ?? w.action.prompt; console.log(copy(text) ? `Copied the ${as} for “${w.name}”.` : text); }
    else {
      const to = val('to') || targetsFor(w._w)[0]?.file; const pv = adoptPreview(w._w, to);
      console.log(`\n  ${pv.replaces ? 'Replace the block in' : pv.exists ? 'Append to' : 'Create'} ${to}:\n${pv.block.trim().split('\n').map((l) => '    + ' + l).join('\n')}\n  ${pv.exists ? 'A copy of the current file is kept in ~/.orgx/trail/backup. ' : ''}Remove it any time: trail unadopt ${pv.id}   (other files: --to <path>)`);
      let ok = flag('yes'); if (!ok && process.stdin.isTTY) { const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout }); ok = /^y(es)?$/i.test((await new Promise((res) => rl.question('  Write it? [y/N] ', res))).trim()); rl.close(); }
      if (ok) { const r = adopt(w._w, to); console.log(`  Wrote the fix for “${w.name}” into ${r.target}`); } else console.log('  Nothing written.' + (process.stdin.isTTY ? '' : ' Pass --yes to write without asking.'));
    }
  }
}
else if (cmd === 'experiments') {
  const rows = experiments();
  if (flag('json')) console.log(JSON.stringify(rows, null, 1));
  else if (!rows.length) console.log('No instruction-file edits found in repos with enough sessions yet.');
  else { console.log('Each row compares the same client and permission mode in the 3 weeks before and after. These are associations, not proof of cause: anything else that changed in that window counts too.');
  for (const r of rows.filter((x) => flag('all') || x.n_before + x.n_after > 0).slice(0, +(val('limit') || 12))) {
    console.log(`\n${r.at.slice(0, 10)}  ${r.repo}  ${r.kind}: ${r.what}  (${r.ref})`);
    if (r.n_before < 5 || r.n_after < 5) { console.log(`  not enough comparable sessions yet (${r.n_before} before / ${r.n_after} after as ${r.mode}, needs 5 each)`); continue; }
    console.log(`  compared as ${r.mode}: ${r.n_before} sessions before, ${r.n_after} after`);
    if (r.confounded) console.log(`  ⚠ confounded: most sessions after this ran in a different permission mode than before`);
    for (const [k, m] of Object.entries(r.metrics)) { const f = (x) => (k === 'backtracks' ? x.toFixed(2) : `${(x * 100).toFixed(1)}%`); const d = (x) => (k === 'backtracks' ? (x >= 0 ? '+' : '') + x.toFixed(2) : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + 'pt');
      console.log(`  ${METRICS[k].label.padEnd(40)} ${f(m.before)} → ${f(m.after)}   ${d(m.diff)} [${d(m.lo)}, ${d(m.hi)}]  ${m.detectable ? (m.improved ? '✓ better' : '✗ worse') : 'no detectable change'}`); }
  } }
}
else if (cmd === 'bench') {
  const models = (val('models') || 'haiku,sonnet').split(',');
  process.stderr.write(`Asking ${models.join(', ')} how they'd start tasks that hit walls in your history (plans only, nothing runs)…\n`);
  const r = await bench({ models, limit: +(val('limit') || 10), onProgress: (d, n) => process.stderr.write(`\r  ${d}/${n}`) });
  process.stderr.write('\n');
  if (flag('json')) console.log(JSON.stringify(r, null, 1));
  else if (!r.tasks) console.log(r.note);
  else { console.log(`\n${r.tasks} tasks from your history · measured: ${r.measured} · $${r.cost.toFixed(2)}\n`); for (const x of r.table) console.log(`  ${x.model.padEnd(8)} ${x.cond.padEnd(18)} walks into a known wall on ${x.walked_in}/${x.tasks} tasks${x.unparsed ? ` (${x.unparsed} replies unparseable)` : ''}`); }
}
else if (cmd === 'share') {
  const r = shareFor(argv[1], val('base'));
  if (r.error) { console.error(r.error); process.exitCode = 1; }
  else {
    console.log(`\n  ${r.wall.name}\n  ${r.url}\n`);
    if (!r.adopted) console.log(`  You haven't adopted this fix yet, so your page shows others' results only. Adopt it: trail adopt ${r.action.id}`);
    else console.log(`  Your result: ${r.effect.text}\n  It reaches the page with your next \`trail sync\` (counts only).`);
    if (flag('copy')) console.log(copy(r.text) ? '  Copied the post text.' : `\n${r.text}`); else console.log(`\n${r.text}\n\n  (--copy puts this on your clipboard)`);
  }
}
else if (cmd === 'archive') {
  // Keep transcripts after their client deletes them (Claude Code: after 30 days by default).
  const { archive, ARCHIVE } = await import('../src/archive.mjs');
  const clients = val('client') === 'all' ? ['claude', 'codex'] : (val('client') || 'claude').split(',');
  const r = await archive({ clients, onProgress: (p) => process.stderr.write(`  ${p.copied} copied · ${(p.bytesIn / 1e6).toFixed(0)} MB → ${(p.bytesOut / 1e6).toFixed(0)} MB\r`) });
  console.log(`\n  Archived ${r.copied} new or changed transcripts (${(r.bytesIn / 1e6).toFixed(0)} MB → ${(r.bytesOut / 1e6).toFixed(0)} MB gzipped); ${r.skipped} already kept. In ${ARCHIVE}, readable by you only.`);
  console.log('  Scans read these copies once the originals are deleted. Run it again any time; it only copies what changed.' + (clients.includes('codex') ? '' : '  (Codex too: --client all)'));
}
else if (cmd === 'privacy') {
  if (val('pii')) { const { setPii, opfPath } = await import('../src/pii.mjs'); const on = val('pii') === 'on'; setPii(on); console.log(on ? `Personal-data masking is on.${opfPath() ? '' : ' Install OpenAI Privacy Filter first: pip install git+https://github.com/openai/privacy-filter (until then, sync --with-titles and deepen will refuse to send).'}` : 'Personal-data masking is off.'); }
  else { const { privacyText, privacyReport } = await import('../src/privacy.mjs'); console.log(flag('json') ? JSON.stringify(privacyReport(), null, 1) : '\n' + privacyText(palette(opts.plain)) + '\n'); }
}
else if (cmd === 'credits') console.log('\n' + creditsText(palette(opts.plain)));
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
