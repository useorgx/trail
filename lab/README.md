# trail lab: getting to 100% on a real person's labels, without cheating

The target is exact agreement with **your** judgment on threads the system has never been tuned on.
Everything here exists to make that number honest.

## The loop

```
sample → jury → you label → eval (dev) → error analysis → one change → eval (dev) → … → eval (test, rare, logged)
```

1. **Sample** `node lab/sample.mjs --n 120` draws threads stratified by client, origin, status and model uncertainty,
   and freezes the evidence you'll see (`~/.orgx/trail/lab/evidence/`).
2. **Jury** `node lab/jury.mjs` has Haiku, Sonnet and Opus label every thread against `codebook.md`, citing event numbers.
   The jury proposes. It is never gold.
3. **Label** `node lab/serve.mjs` opens the bench: keyboard-only, jury majority prefilled, about 1 in 10 items a
   hidden blind repeat of something you already labeled.
4. **Eval** `node lab/eval.mjs --labeler trail` scores any labeler on dev. `--labeler jury:opus|jury:sonnet|jury:haiku|jury:majority`
   scores the models the same way. Every run is appended to `experiments.jsonl` with the code version.
5. **Change one thing.** A rule, a feature, a codebook sentence, a prompt, a model. Re-run dev. Keep it only if dev improves
   and nothing else regresses.
6. **Test** `node lab/eval.mjs --split test --reason "why this counts"` only at milestones. Every access is logged
   in `test-access.jsonl`, and test results are aggregate-only.

## Rules that keep it honest

- **Split by session, fixed forever.** `sha256(session id + salt)`; about 35% of sessions are test. All threads of a
  session land on the same side, so near-duplicates can't leak across.
- **Evidence is frozen at sampling.** A label refers to exactly what the labeler saw, even if transcripts change.
- **Features come from the transcript only.** Nothing derived from labels, jury output or file names that encode them.
- **Test is sealed.** No per-thread test errors are written anywhere. Agents doing error analysis read
  `errors-*-dev.json` only.
- **Codebook changes are versioned.** When a label disagreement is really an unclear definition, fix the codebook and
  relabel the affected items; never relabel to match the model.
- **Anchoring is measured, not assumed.** Prefilled labels record their prefill; blind repeats and `--blind` sessions
  show how much the jury's suggestion moves you.

## What "100%" can mean

- **The ceiling is your own consistency.** Blind repeats measure how often you agree with yourself. If that's 96%
  on status, 100% against you is noise-fitting; the fix is a sharper codebook, not a smarter model.
- **Small test sets can't prove 100%.** 48 test threads at 100% still leaves a 95% lower bound near 93%. The claim
  gets stronger as labels accumulate. Aim for 300+ test threads before quoting a number externally.
- **Report per field and per client.** Origin, status and boundary fail differently; Codex and Claude Code fail differently.

## The experiment ledger

Each line of `experiments.jsonl`: time, labeler, split, git sha (+dirty), n, accuracy per field, confusion pairs,
and your self-consistency. Plot it and you have the learning curve; diff two lines and you know what a change bought.
