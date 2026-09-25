# Trail codebook v1

One page a person or a model reads before labeling. Every label is decided from what the transcript shows,
never from what the reader guesses happened afterwards. When the log can't decide, say so (`unclear`), and
that is a correct answer.

A **thread** is one line of intent: the agent trying to get one thing done. It starts at an ask, a plan step,
or a moment the agent took up something new. It is shown to you as the events it owns.

## boundary — is this one thread?
- `right` — the events serve one intent. Small detours that serve it (reading a file, one retry) belong to it.
- `too_big` — two or more intents that a person would name separately got merged.
- `too_small` — this is only a piece of an intent that continues in another thread.
- `not_a_thread` — no intent: harness noise, a greeting, a single status line.

## origin — where did the intent come from?
- `asked` — a person asked for it in this session (including a scheduled task's standing ask).
- `plan` — the agent split an asked-for goal into this step itself.
- `found` — the agent **noticed a problem nobody asked about** (a bug, incident, leak, wrong data, broken tool)
  **and took it up**. The noticing must be visible: a remark, or work clearly aimed at the new problem.
- `recovery` — repeated failures of the agent's own actions (tests, commands, builds) that it worked through
  to get back to the asked-for work. Friction, not a discovery.
- `wall` — the agent's calls were refused by permissions or policy and it routed around or stopped.
- `scheduled` — a routine that ran on a timer with no live person.
  Precedence when two fit: `wall` > `recovery` > `found` > `plan` > `asked` > `scheduled`.

## status — how did it end, as far as the log shows?
- `done` — the intent was delivered: a ship (commit, PR, merge, deploy, publish), a check that passed after the
  change, or an answer/report that satisfies the ask. For read-only asks, the answer is the delivery.
- `dropped` — the agent stopped without delivering: it gave up, was blocked, or moved on and never came back.
- `parked` — explicitly left for later or waiting on a person ("needs your approval", "next session").
- `open` — still in progress when the transcript ends.
- `unclear` — the log genuinely can't tell.

## title — would you recognize it?
- `ok` if a person skimming a list would know what this thread was. Otherwise write a better one:
  plain words, what it was trying to do, at most 10 words.

## Rules for reviewers
- Quote the event number(s) that decided each label.
- Don't infer from later sessions or from your own knowledge of the project.
- Speed over polish: a fast `unclear` beats a slow guess.
