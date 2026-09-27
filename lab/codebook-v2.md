# Trail labeling codebook · form v2

Label only what the frozen evidence shows. Event references are the numbers in brackets; `[r]` lines explain
reasoning but are not events. Prefer `unclear` to an inference the transcript cannot support.

## Segmentation

`starts_here` means this item begins a complete piece of work at its current first owned event. Example: event 14
asks for a release note and the following events draft and deliver it, so the item `starts_here`.

`merge_prev` means this item is a continuation of the preceding thread, not a new piece of work. Example: the prior
thread edits a parser and this item only runs that parser's tests, so it should `merge_prev`.

`merge_next` means the work starts here but continues in the next thread. Example: this item diagnoses a failing
build and the next item applies the resulting fix, so it should `merge_next`.

`split_at` means a new, separately nameable piece of work begins inside this item; record every event where one
begins. Example: events 20–27 fix login, then event 28 starts an unrelated billing audit, so use `split_at: [28]`.

`noise` means the item contains no piece of work. Example: a greeting followed by harness status with no goal is
`noise`.

## Outcome

`shipped_checked` means the goal was changed or shipped and the evidence shows a relevant check passed afterward.
Example: event 41 applies the patch and event 46 shows its targeted test passing, so the outcome is
`shipped_checked` at event 46.

`shipped_unchecked` means the change was delivered without a visible relevant check after it. Example: event 19
creates a commit, but no test or inspection follows, so the outcome is `shipped_unchecked` at event 19.

`answered` means the goal was informational and the agent supplied the requested answer or report. Example: event
12 gives the requested root-cause summary, so the outcome is `answered` at event 12.

`handed_back` means progress now waits on the person for an answer, approval, credential, or manual action. Example:
event 33 asks the person to approve production access before work can continue, so the outcome is `handed_back` at
event 33.

`continued_elsewhere` means the evidence explicitly moves the same goal to another thread, session, agent, or
system; an outcome event is optional because the destination may only be described in context. Example: the agent
says the migration will continue in a linked task, so the outcome is `continued_elsewhere`.

`abandoned` means the agent stopped pursuing the goal without shipping, answering, or handing back a concrete next
step; record both the stopping event and one reason below. Example: event 52 says the approach will not be pursued,
so the outcome is `abandoned` at event 52.

`blocked_wall` means a permission, policy, environment, authentication, or resource wall prevented the goal and no
workaround completed it. Example: event 17 shows the required write denied and the agent stops, so the outcome is
`blocked_wall` at event 17.

`unclear` means the evidence cannot determine what happened to the goal; no outcome event is required. Example: the
captured transcript ends after inspection with no delivery or explicit stop, so the outcome is `unclear`.

### Abandoned reason

`gave_up` means the agent explicitly stopped trying despite the goal still being relevant. Example: after several
failed approaches it says it cannot complete the task and stops, so the reason is `gave_up`.

`superseded` means another solution or completed change made this goal unnecessary. Example: the agent drops a
planned workaround after finding the upstream fix already landed, so the reason is `superseded`.

`person_redirected` means the person changed or cancelled the goal. Example: the person says “skip the migration and
fix signup instead,” so the migration's reason is `person_redirected`.

`out_of_scope` means the agent identifies the goal as outside the authorized or requested scope and leaves it. Example:
an unrelated production cleanup is noticed but explicitly excluded from the task, so the reason is `out_of_scope`.

## Backtracks

A backtrack is a real replacement of an approach or belief. Each item records the event where the replacement is
visible, the `from` approach or belief dropped, the `to` replacement, and one trigger; a retry of the same thing is
not a backtrack. Example: after a second identical test run the agent changes nothing, so record no backtrack.

`error` means a failed action caused the replacement. Example: a build rejects the first API and the agent switches
to a supported API, so the trigger is `error`.

`evidence` means an observation or result disproved the earlier path without itself being an action failure. Example:
a config read shows the flag is already enabled, so the agent investigates routing instead; the trigger is `evidence`.

`reasoning` means analysis alone produced the new approach or belief. Example: the agent realizes two writes can race
and replaces the design before running it, so the trigger is `reasoning`.

`person` means the person's instruction or correction caused the replacement. Example: the person rejects a modal
and asks for an inline control, so the trigger is `person`.

## Lesson

`reusable: yes` means the evidence supports a concise rule that could prevent or shorten similar work later; write
one line and optionally link a named wall or `new`. Example: repeated port conflicts show “check whether the dev
server is already running before starting another,” so the lesson is reusable and links wall `port`.

`reusable: no` means the events contain no rule worth carrying to another run. Example: a one-off copy edit succeeds
directly and teaches nothing beyond the task, so the lesson is not reusable.

For a reusable lesson, a named wall links it to an existing wall in `src/walls.mjs`; `new` says the lesson describes
a recurring wall not in that registry. Example: an unseen provider quota repeatedly blocks work, so choose `new`.

## Origin

`asked` means a person requested the goal in this session, including a standing ask launched manually. Example: “add
CSV export” directly starts the work, so the origin is `asked`.

`plan` means the agent created this separately nameable step while decomposing an asked-for goal. Example: during a
release task the agent starts a distinct compatibility audit it planned, so the origin is `plan`.

`found` means the agent noticed an unrequested problem and took it up. Example: while reading logs it discovers a
cross-tenant cache bug and begins fixing it, so the origin is `found`.

`recovery` means repeated failures in the agent's own work caused a detour to restore progress. Example: after its
build commands repeatedly fail, it repairs the local dependency state, so the origin is `recovery`.

`wall` means permissions or policy refused the agent's calls and it routed around or stopped. Example: a sandbox
denies the required write and the agent moves the work into an allowed directory, so the origin is `wall`.

`scheduled` means a timer launched the routine with no live person's ask. Example: the nightly trail digest runs on
its cadence, so the origin is `scheduled`.

## Title and note

`keep` means the predicted title already names the goal clearly in at most ten words. Example: “Repair OAuth token
refresh” is recognizable, so keep it.

`rename` means the predicted title is vague or wrong; replace it with plain words naming the goal in at most ten
words. Example: rename “Continue work” to “Repair OAuth token refresh.”

`note` is optional context about a hard judgment or a missing codebook rule. Example: “Outcome is unclear because
the final tool result was elided.”
