# orgx trail

See what your coding agents actually did. Trail reads your Claude Code and Codex history into
**threads of work**, finds the **walls** your agents keep rediscovering, and writes the fix where they'll read it.

```bash
npx @useorgx/trail
```

- **Local.** Reads `~/.claude/projects` and `~/.codex/sessions` on your machine. Nothing is uploaded. No model is called.
- **Fast.** 3,307 sessions (37.6 GB) in about 40 seconds on a laptop; after that, only new work is read (well under a second).
- **Zero dependencies.** Small enough to read before you run it.

## Commands

| | |
|---|---|
| `trail` | read new work, then open the explorer |
| `trail explore` | tabs: Overview · Walls · Threads · Sessions · Quality |
| `trail watch` | follow the session being written right now |
| `trail open` | the ledger view in your browser, served from 127.0.0.1 only |
| `trail summary` | the numbers as JSON |
| `trail unadopt <id>` | remove a fix trail wrote into CLAUDE.md / AGENTS.md |

In the explorer: `←/→` tabs · `↑/↓` move · `enter` open · `/` search · `a` adopt a wall's fix · `t` label uncertain threads · `q` quit.

## What the marks mean

`○` asked · `◇` found along the way · `↺` recovered from repeated failures · `⊘` permission wall · `⏲` scheduled
`·` probe · `━` change · `✓` check · `▲` ship · `✗` failed · `⊘` denied · `⟲` backtrack

## How far to trust it

Denials, failures and ships are read directly from the transcript. Intent, discoveries and whether a thread was
dropped are inferred, and the Quality tab says how well. The "dropped" call comes from a small tree model
(`src/model/abandon.json`) trained on model-labeled threads: F1 0.84 against those labels. Your own labels
(`t` in the explorer) are the real test, and they stay in `~/.orgx/trail/labels.jsonl`.

## Data

Everything trail learns lives in `~/.orgx/trail` (override with `TRAIL_HOME`). Delete that folder to forget it all.

Built by [OrgX](https://useorgx.com).
