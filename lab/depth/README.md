# Depth: what trail misses by reading tools, not reasoning

Question (2026-09-26): trail reads tool calls and a clipped slice of agent text. Does reading the reasoning
(Claude thinking, Codex reasoning summaries) change what we learn, and at what cost?

## What exists and what trail reads (40 recent Claude + 40 Codex sessions, `coverage.mjs`, `retention.mjs`)

| | Claude Code | Codex |
|---|---|---|
| Agent language trail keeps | 22% (300K of 1.36M chars) | 29% (102K of 350K) |
| Reasoning trail reads | 0 of 638K chars of thinking | 0 of 163K chars of reasoning summaries |
| Readable reasoning | 33% of thinking blocks have text | raw reasoning always encrypted; 39% of items carry a summary |

Backtracks are counted only right after a failed call (`classify.mjs` BACK_SAY needs `recentErrs`).

## Pilot (60 threads, Sonnet labels, `pilot.mjs` → `score.mjs`, $2.17)

Each thread labelled from trail's view (A) and from A + full text + reasoning (C); C labelled twice for the noise
floor. The reference is a model reading, not human gold: these numbers measure information loss, not truth.

| vs. the deep read | Trail rules | Model on trail's view | Deep read again (ceiling) |
|---|---|---|---|
| Backtrack recall | 57% (population-weighted; 67% in sample) | 82% | 87% |
| Backtrack precision | 100% | 97% | 95% |
| Status agreement | 22% | 78% | 83% |

- Deep-read backtracks by trigger: evidence 36, error 29, reasoning 11, human 1. The rule can only see "error" (38%).
- Where reasoning exists (35 threads): deep read finds a backtrack in 86%, trail's view 69%.
- Status gap is partly definitional: trail's "outcome" needs proof (PR, ship); the model counts an answered question
  as done (25 of 60 threads trail left open or uncertain, the model called done).
- Insight specificity, blind pairwise (`judge.mjs`, 60 pairs): deep 29, shallow 25, same 6. No detectable difference.
- Cost: reasoning extraction is a 4.5 s separate pass over 753 MB (5.1 s for trail's own read); in the same pass,
  near zero. About 10 KB per session to keep it. Labels ~$0.036/thread with Sonnet.

**Reading:** the largest loss is interpretation (rules vs. a model on the same data), not missing text. Reasoning
adds a smaller, real gain on backtracks where it exists, and no measurable gain on insight specificity.

## Plan

1. **Keep the reasoning** in the same read pass: Claude visible thinking, Codex reasoning summaries, full assistant
   text, stored per session in a side file (`reasoning/<id>.jsonl`), not in the session record the explorer loads.
2. **Backtracks from evidence and reasoning, not only errors.** A detector for course changes ("actually",
   "turns out", "the real cause", a replaced hypothesis) over messages and reasoning, with or without a failure.
   Gate: recall ≥ 80% at precision ≥ 90% against the deep read, then against human labels.
3. **Rules decide what they're sure of; a model decides the rest.** Status and backtracks for uncertain threads
   ("outcome?" is 53% of all threads) go to Haiku with the deep view; distil its labels into a small local model so
   full-history runs stay free and fast. Gate: status agreement ≥ 75% with ≤ 1 s per 100 threads locally.
4. **Split "done" into proven and answered** so the status disagreement stops being a definition fight.
5. **Human gold set:** 100 threads in `lab/serve.mjs`, stratified by client and reasoning presence, notes first.
   Re-score steps 2–4 against it; ship only what beats the rules there.
6. **Re-test insight specificity** after 2–3: if deep-view insights still don't beat shallow ones blind, don't pay
   for them in the default path.
