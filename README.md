# orgx trail

See what your coding agents actually did, stop them relearning the same walls, and prove the fix worked.
Reads your Claude Code, Codex, OpenCode and Cursor history into **threads of work**, finds the **walls** they keep rediscovering,
and writes the fix where they'll read it.

```bash
npx @useorgx/trail
```

- **Local.** Reads `~/.claude/projects`, `~/.codex/sessions`, OpenCode's database and Cursor's chat stores, read-only, on your machine. Nothing is uploaded unless you run `trail sync`.
- **Fast.** ~3,300 sessions (38 GB) in about 40 seconds; after that, only new work is read.
- **Zero dependencies.** Small enough to read before you run it.

## What you can do

| | |
|---|---|
| `trail` | read new work, then open the explorer (overview · walls · threads · sessions · quality) |
| `trail walls` | the walls your agents keep hitting, each with a fix (`--json` for agents) |
| `trail copy <id>` | copy a fix: a prompt your agent can act on (default), the rule, or the command |
| `trail adopt <id>` | write the fix into AGENTS.md / CLAUDE.md as a marked block (`trail unadopt <id>` removes it) |
| `trail guard install` | prevention: in don't-ask runs, stop a known wall before the agent walks into it |
| `trail card` | your trail as a shareable image and post text |
| `trail share <id>` | a public page for a fix, measured across everyone who adopted it |
| `trail experiments` | did your AGENTS.md / CLAUDE.md edits change agent behavior? (95% intervals) |
| `trail bench` | would a model walk into your known walls, with and without your rules? |
| `trail mcp` | trail as tools for your agents: `claude mcp add trail -- npx -y @useorgx/trail mcp` |
| `trail open` · `trail watch` | ledger view in your browser (localhost) · follow the live session |
| `trail connect` | sign in to OrgX through [`@useorgx/wizard`](https://www.npmjs.com/package/@useorgx/wizard); trail never handles your password or key |
| `trail credits` | the people whose work trail is built on |
| `trail sync` | send thread outlines (never transcripts) to OrgX; `--dry-run` shows exactly what would be sent |

In the explorer, on a wall: `c` copies a prompt for your agent, `r` the rule, `x` the command, `a` adopts it.

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

## Data

Everything lives in `~/.orgx/trail` (override with `TRAIL_HOME`). Delete that folder to forget it all.

Built by [OrgX](https://useorgx.com).
