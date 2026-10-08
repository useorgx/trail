# orgx trail

See what your coding agents actually did, stop them repeating the same failures, and prove the fix worked.
Trail reads your Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, OpenCode and Factory Droid history. It groups each sequence of work, finds failures repeated across separate sessions, and writes the fix where agents will read it.

```bash
npx @useorgx/trail
```

- **Local.** Reads each client's own history on your machine, read-only: Claude Code, Codex (including its structured command, MCP and file-change records), Cursor (editor and agent), GitHub Copilot in VS Code, Gemini CLI, OpenCode and Factory Droid. Windsurf keeps its history encrypted, so it isn't read. Nothing is uploaded unless you run `trail sync`.
- **Fast.** ~3,300 sessions (38 GB) in about 40 seconds; after that, only new work is read.
- **Zero dependencies.** Small enough to read before you run it.

## What you can do

| | |
|---|---|
| `trail` | read new work, then open the explorer |
| `trail goals` | see each piece of work, its detours, how it ended, and where the agent changed course (`--json`) |
| `trail receipts` | one [Agent Work Receipt](https://github.com/useorgx/agent-work-receipt) (v0.2) per piece of work: what was asked, whether each acceptance criterion was met and on what evidence, what was delivered, what checked it (`<id>`, `--json`, `--export file`). Each receipt also carries the review layer (`extensions['org.orgx.review/v1']`): every criterion quoted from the person's words with the message it came from, four kinds of proof per criterion (reviewed, tested, shown, seen live), the episodes of the work with stable ids tied to commits, and which layers of the record exist. OrgX renders it as the Work Receipt Review |
| `trail workstreams` | pieces of work joined across sessions by a shared PR, branch, rarely touched files, a pasted id, or an explicit continuation; words alone never join (`<id>`, `--all`) |
| `trail search <q>` | search your receipts: ranked text plus exact filters such as `outcome:blocked type:fix repo:app pr:12 conf:<0.6 unmet:tests` |
| `trail review` / `trail label` | the questions about your own work only you can settle (did it get done, was a criterion met); answers win over every guess |
| `trail deepen` | get more reliable outcomes. With your approval, Jev (TypeSafe's decision model) reads each step and piece of work. Trail marks an outcome verified when both reads agree. Pay with OrgX credits after `trail connect`, or use your own OpenRouter key with `--key-file`. Trail shows a quote first and sends nothing until you confirm. |
| `trail walls` | find a wall: a failure your agents keep hitting in separate sessions. Each wall includes a fix (`--json` for agents). |
| `trail copy <id>` | copy a selected fix as a prompt, rule, or command |
| `trail adopt <id>` | write a selected fix into AGENTS.md / CLAUDE.md as a marked block (`trail unadopt <id>` removes it) |
| `trail guard install` | stop known repeat failures before they happen in don't-ask runs |
| `trail card` | create a shareable summary image and post text |
| `trail share <id>` | a public page for a fix, measured across everyone who adopted it |
| `trail experiments` | did your AGENTS.md / CLAUDE.md edits change agent behavior? (95% intervals) |
| `trail bench` | test whether a model would repeat known failures, with and without your rules |
| `trail mcp` | give your agents tools for reading trail data: `claude mcp add trail -- npx -y @useorgx/trail mcp` |
| `trail open` · `trail watch` | open the browser view on localhost · follow the live session |
| `trail connect` | sign in to OrgX through [`@useorgx/wizard`](https://www.npmjs.com/package/@useorgx/wizard); trail never handles your password or key |
| `trail credits` | the people whose work trail is built on |
| `trail sync` | send session outlines, never transcripts, to OrgX; `--dry-run` shows exactly what would be sent |
| `trail sync --receipts` | send Agent Work Receipts to your OrgX workspace, where they join your team's work, map to your initiatives, and become searchable by agents; opt in, `--dry-run` first. Also sends the judgments you made along the way (corrections, rejected tool calls, denials, rules you stated) so OrgX can turn them into precedents; they are kept locally in `~/.orgx/trail/precedent-candidates.jsonl` until then |

In the explorer, on a wall: `c` copies a prompt for your agent, `r` the rule, `x` the command, `a` adopts it.

## How it works

1. Trail reads each session into requests, agent messages, and tool calls. Reasoning and full messages go to a separate local file (`~/.orgx/trail/language`).
2. Trail records what each tool call did and whether it passed, failed, or was refused. It labels each message or reasoning step as a plan, hypothesis, evidence, decision, change of course, verification, completion claim, handoff, or blocker. Rules do this by default; Jev does it when you run `trail deepen`.
3. Trail groups the moves into a thread: one sequence of agent work. The explorer and repeated-failure checks use these sequences.
4. `trail goals` joins each request to its detours. It reports how the piece of work ended and points to the step that proves the result.

Against Codex labels for 58 unseen work sequences, trail found the right piece-of-work boundary 89% of the time. The shorter sequences alone reached 38%. It found the right outcome 47% of the time, compared with 10% from the shorter sequences. These are model labels, not human labels; the lab (`lab/`) is where that gets fixed.

## Verify this package

After installing trail in a project, run `npm audit signatures` to verify registry signatures and provenance for installed packages. The [npm package page](https://www.npmjs.com/package/@useorgx/trail) also shows a provenance badge for releases with a verified attestation.

Each release is built from a tagged commit by [`.github/workflows/publish.yml`](.github/workflows/publish.yml). The workflow requires a `vX.Y.Z` tag that matches `package.json`, runs the tests, and publishes through npm trusted publishing.

## How far to trust it

- **Facts** — denials, failures and ships — are read straight from the transcript.
- **Judgments** — intent, discoveries, whether a thread was dropped — are inferred, and the Quality tab says how well.
  "Dropped" comes from a small tree model (`src/model/abandon.json`); your own labels are the real test.
- **Effects** are compared like with like: same repo, same client, same permission mode. When the permission mode
  changed around a fix, trail says "confounded" instead of claiming a win.
- `trail bench` measures a model's **planned** first calls, not executed runs, and says so.

## Built on

Trail is built on other people's ideas. None of them endorse it; this is what we took from each. `trail credits` shows the longer version.

| Work | What trail took from it |
|---|---|
| [Clio: privacy-preserving insights into real-world AI use](https://www.anthropic.com/research/clio) · Alex Tamkin and the Clio team at Anthropic, 2024 | A fix’s public numbers appear only once at least 5 separate people have adopted it, and uploads carry counts, not words (thread titles only if you opt in with --with-titles). |
| [Error analysis for AI systems (open coding → axial coding → count → judge)](https://hamel.dev/blog/posts/evals-faq/why-is-error-analysis-so-important-in-llm-evals-and-how-is-it-performed.html) · Hamel Husain and Shreya Shankar, 2025 | The walls are failure types counted across real sessions, and trail’s classifier is checked against human labels in a labeling lab. (We wrote our codebook before our notes, which they warn against; the next labeling pass starts from notes.) |
| [Sniffly: a dashboard over your local Claude Code logs](https://github.com/chiphuyen/sniffly) · Chip Huyen, 2025 | Lead with one surprising number about your own agents, found locally. |
| [Docent: searching agent transcripts against a rubric, with cited evidence](https://transluce.org/docent/blog/introducing-docent) · Transluce, 2025 | Every adopted fix is reported as a measured before and after, not a claim. |
| [Measuring AGENTS.md: what five runs show that one doesn’t (AAIF)](https://aaif.io/blog/measuring-agents-md-what-five-runs-show-that-one-doesn-t) · Andrea Griffiths, 2026 | trail experiments reports intervals and says “no detectable change” when the interval spans zero. We learned the same lesson the hard way: our first before/after was confounded by a permission-mode switch. |
| [Measuring the impact of early-2025 AI on experienced open-source developer productivity](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) · Joel Becker, Nate Rush, Beth Barnes and David Rein (METR), 2025 | trail compares like with like (same client, same permission mode) and marks a result confounded instead of reporting it. |
| [AGENTS.md: a simple, open format for guiding coding agents](https://agents.md/) · The AGENTS.md contributors (now stewarded by the Agentic AI Foundation), 2025 | Fixes are written where agents already look, as a removable block in AGENTS.md or CLAUDE.md. |
| [Entire: agent checkpoints stored in git, next to the code](https://entire.io/) · Thomas Dohmke and the Entire team, 2026 | Lessons live in the repo, in files a team reviews like any other change. |
| [Agent Trace: an open, vendor-neutral spec for AI code attribution](https://agent-trace.dev/) · Cursor, 2026 | trail’s upload format (orgx-trail-threads/v1) is a short, versioned contract you can inspect with --dry-run; publishing it as an open spec is next. |
| [ccusage: token and cost analysis from local agent logs](https://github.com/ccusage/ccusage) · ryoppippi and the ccusage contributors, 2025 | npx, no account, nothing uploaded, a first answer in about 40 seconds. |
| [Portable Game Notation (PGN)](https://en.wikipedia.org/wiki/Portable_Game_Notation) · Steven J. Edwards, 1993 | Each thread is a move string (probe, run, change, check, ship, failed, denied) you can read at a glance and compare. |
| [Stigmergy: coordination through traces left in the environment](https://pubmed.ncbi.nlm.nih.gov/10633572/) · Pierre-Paul Grassé, 1959 | A wall one session hit becomes a trace the next session reads before it starts, instead of every session starting from zero. |

## Privacy

`trail privacy` shows what trail keeps, where, who can read it, and what each command sends, counted from the files.
Secrets are removed before anything is stored or sent, using gitleaks' 221 provider rules (plus OrgX and OpenRouter keys);
trail's folder is readable by you only. Nothing leaves the machine unless you run `trail sync` (counts and move strings;
`--with-titles` adds titles) or `trail deepen` (after a quote you confirm). For names, emails, phones and addresses too,
`trail privacy --pii on` masks outgoing text locally with [OpenAI Privacy Filter](https://github.com/openai/privacy-filter).

Claude Code deletes transcripts older than 30 days by default (`cleanupPeriodDays`); trail keeps its own outlines after that.

## Data

Everything lives in `~/.orgx/trail` (override with `TRAIL_HOME`). Delete that folder to forget it all.

Built by [OrgX](https://useorgx.com).
