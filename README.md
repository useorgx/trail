# orgx trail

See what your coding agents actually did, stop them relearning the same walls, and prove the fix worked.
Reads your Claude Code and Codex history into **threads of work**, finds the **walls** they keep rediscovering,
and writes the fix where they'll read it.

```bash
npx @useorgx/trail
```

- **Local.** Reads `~/.claude/projects` and `~/.codex/sessions` on your machine. Nothing is uploaded unless you run `trail sync`.
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
| `trail sync` | send thread outlines (never transcripts) to OrgX; `--dry-run` shows exactly what would be sent |

In the explorer, on a wall: `c` copies a prompt for your agent, `r` the rule, `x` the command, `a` adopts it.

## How far to trust it

- **Facts** — denials, failures and ships — are read straight from the transcript.
- **Judgments** — intent, discoveries, whether a thread was dropped — are inferred, and the Quality tab says how well.
  "Dropped" comes from a small tree model (`src/model/abandon.json`); your own labels are the real test.
- **Effects** are compared like with like: same repo, same client, same permission mode. When the permission mode
  changed around a fix, trail says "confounded" instead of claiming a win.
- `trail bench` measures a model's **planned** first calls, not executed runs, and says so.

## Data

Everything lives in `~/.orgx/trail` (override with `TRAIL_HOME`). Delete that folder to forget it all.

Built by [OrgX](https://useorgx.com).
