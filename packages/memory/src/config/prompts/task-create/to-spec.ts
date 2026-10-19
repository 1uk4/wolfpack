/**
 * To-spec protocol — stage 2 of the three-stage task-create pipeline.
 *
 * Takes the design tree from grilling (stage 1) and synthesises a feature
 * spec. Does NOT re-interview the user. Confirms test seams once, then
 * publishes the spec as the feature's body at stage=approved.
 *
 * Modelled on Pocock's `to-spec` skill. The template below becomes the
 * feature body VERBATIM — this is also what graduation will lift into the
 * KB entry (via preserve_body), so write it as the record you'd want months
 * from now.
 */

export const TO_SPEC_PROTOCOL = `# Stage 2 of 3 — To-spec

The grilling is settled. Synthesise what you heard into a feature spec.

Do NOT interview the user again. Fill the gaps you still have with \`subagent\` scouting — never with "actually, one more question".

## Process

1. **Scout the codebase.** Dispatch a \`subagent\` to confirm the current state in the area the feature touches. It should surface:
   - Existing modules and their interfaces
   - Prior art for similar work
   - ADRs or KB entries in \`~/wolves/knowledge/base/domains/<domain>/\` that constrain the design
   Use the domain's vocabulary from the KB throughout the spec.

2. **Pick test seams.** Sketch where this feature will be tested. The rules:
   - Prefer EXISTING seams to new ones.
   - Use the HIGHEST seam possible — closer to user behaviour, fewer implementation details leaked into tests.
   - If a new seam is needed, propose it at the HIGHEST point you can.
   - Fewer seams = better. Ideal = one.

   Then confirm the seams with the user in a single short message, e.g.
   "Test seams I'd use: <X> (existing), <Y> (new, highest point). Confirm?" and wait for yes/edits. This is the only user interaction in stage 2.

3. **Write the spec.** Follow the template exactly. The spec IS the feature body — once written, you \`task_create\` the feature and \`task_update\` its body to this markdown.

4. **Publish the feature:**
   \`\`\`
   id = task_create kind=feature domain=<...> title=<...>
   task_update <id> body=<the spec markdown>
   task_stage <id> approved
   \`\`\`
   stage=approved signals: the spec is settled, implementation is pending (tasks under it will be stage=plan).

## Spec template (verbatim — this becomes the feature body)

\`\`\`markdown
# <feature title>

## Problem Statement

The problem the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Format:

1. As a <actor>, I want <feature>, so that <benefit>

Example:
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending.

Be extensive. Cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions, including:

- Modules built or modified (names, not paths)
- Interfaces being added or changed
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions
- Technical clarifications the user gave during grilling

Do NOT include specific file paths or code snippets. They go stale fast.

Exception: if a prototype produced a snippet that encodes a decision more
precisely than prose can (state machine, reducer, schema, type shape), inline
it in the relevant decision and note briefly that it came from a prototype.
Trim to the decision-rich parts, not a working demo.

## Testing Decisions

- What makes a good test here (test external behaviour, not implementation details).
- Which modules will be tested.
- The test seams (from the step above).
- Prior art in the codebase (similar types of tests we modelled this after).

## Out of Scope

What this spec explicitly does NOT include. Call out the things a reasonable
reader might assume are in scope but are not.

## Notes

Context the above misses. Open questions that did not block consensus during
grilling (they can block individual tickets later without blocking the spec).

## Delivered

<!-- rollup:children -->
<!-- /rollup:children -->
\`\`\`

Copy the \`## Delivered\` section exactly, markers included, and leave it empty. The work system fills it as each ticket ships, and its presence is what makes the feature graduate into the KB verbatim (spec + what was delivered) instead of being rewritten by an LLM.

## Boundary with stage 3

The spec is now the feature body. The feature is at stage=approved. Hand off to stage 3 (to-tickets) with the feature's id — do NOT create any task-level work items in stage 2.
`;
