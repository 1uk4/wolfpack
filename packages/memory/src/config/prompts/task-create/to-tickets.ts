/**
 * To-tickets protocol — stage 3 of the three-stage task-create pipeline.
 *
 * Breaks the spec from stage 2 into tracer-bullet tickets with blocking
 * edges, quizzes the user, and publishes each ticket as a wolfpack task
 * under the feature. Depends_on edges are set via task_link.
 *
 * Modelled on Pocock's `to-tickets` skill, adapted for wolfpack's work
 * model (feature → tasks, depends_on native).
 */

export const TO_TICKETS_PROTOCOL = `# Stage 3 of 3 — To-tickets

The spec is the feature body. Break it into TICKETS: tracer-bullet vertical slices, each declaring the tickets that BLOCK it.

## Rules for a vertical slice

- Each ticket cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer.
- A completed ticket is demoable or verifiable on its own.
- Each ticket is sized to fit in a single fresh context window.
- Any prefactoring that makes the implementation easier should be done first (its own ticket).

Give each ticket its BLOCKING EDGES: the tickets that must complete before it can start. A ticket with no blockers can start immediately.

## Wide refactors are the exception

A WIDE REFACTOR is one mechanical change (rename a column, retype a shared symbol) whose BLAST RADIUS fans across the whole codebase. A single edit breaks thousands of call sites at once and no vertical slice can land green.

Do not force it into a tracer bullet. Sequence it as EXPAND → MIGRATE → CONTRACT:

1. EXPAND: add the new form beside the old so nothing breaks. One ticket.
2. MIGRATE: convert call sites in batches sized by blast radius (per package, per directory). Each batch is its own ticket, blocked by the expand. CI stays green batch to batch because the old form still exists.
3. CONTRACT: delete the old form once no caller remains. One ticket, blocked by every migrate batch.

When even the batches cannot stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket; green is promised only there.

## Quiz the user

Before publishing, present the proposed breakdown as a numbered list in one chat message. For each ticket show:

    N. <short title>
       Blocked by: <ticket numbers from this list, or "none">
       Delivers: <one line — the end-to-end behaviour this ticket makes work>

Then ask three questions:
- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate (new round of the list) until the user approves.

## Publish

Publish in TOPOLOGICAL ORDER (blockers first) so each ticket's blocking edges can reference ids that already exist:

    for ticket in topological_order(tickets):
      result = task_create(
        kind="task",
        domain=<feature.domain>,
        partOf=<feature.id>,
        title=<ticket.title>,
        successCriteria=<ticket.delivers>,
      )
      for blocker in ticket.blockers:
        task_link(id=result.id, rel="depends_on", target=blocker.id)

All tickets land at stage=plan (default). The feature at stage=approved + tickets at stage=plan is the right shape: "spec signed off, work queued, nothing started yet". Tasks advance to in_build when a wolf binds and starts work.

Avoid specific file paths or code snippets in titles and successCriteria — they go stale fast. Exception (same as the spec): a prototype-produced snippet that encodes a decision more precisely than prose.

## Done

Report back to the user: feature id + stage, list of ticket ids with their blocker ids, and (if any) the expand-contract sequence you used. The user can then press 'g' on the feature in /task to graduate it when the work is done.
`;
