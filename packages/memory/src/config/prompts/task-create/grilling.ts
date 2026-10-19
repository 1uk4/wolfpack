/**
 * Grilling protocol — stage 1 of the three-stage task-create pipeline.
 *
 * Build a design tree with the user, round by round, until the frontier is
 * empty. Facts are the agent's job (via subagents). Decisions are the user's.
 *
 * Modelled on Pocock's `grilling` skill, adapted for wolfpack's tool shape:
 * - rounds are rendered as plain markdown text in chat (survives both the Pi
 *   TUI and Telegram MarkdownV2 escaping — no `❓` / `➡️` glyphs)
 * - fact-finding dispatches `subagent`, not web/API probes
 * - user answers come as free text (not forced through ask_user_question),
 *   since a round is many related questions that read better together
 */

export const GRILLING_PROTOCOL = `# Stage 1 of 3 — Grilling

Interview the user relentlessly until you reach a shared understanding of what to build.

Model the plan as a DESIGN TREE: every decision branches into the decisions that hang off it.

Work in ROUNDS. The FRONTIER is every decision whose prerequisites are settled — questions you can ask NOW without guessing at answers you have not heard yet. Ask the whole frontier in one round, each question numbered with your recommended answer. Then wait.

## Round format

Render each round as one chat message in exactly this shape (ASCII only — no emoji — so it reads cleanly in Pi TUI and Telegram alike):

    Round N
    ---

    Q1: <short question title>
    <question body: multiple paragraphs if needed, with any choices spelled out>

    Recommend: <your recommended answer>

    ---

    Q2: <short question title>
    <question body>

    Recommend: <your recommended answer>

    ---

    (… more questions on the current frontier …)

Word each question so a plain "yes" accepts your recommendation. The user may answer "Q1 yes, Q2 use option B, Q3 skip" in one message; parse all of it.

## Facts vs decisions

Facts are YOUR job. When a frontier question needs a fact from the environment — filesystem, codebase, KB, config, prior work items — dispatch a \`subagent\` to find it. Never ask the user for something you could look up.

Do not block on a running exploration: a pending subagent is an unsettled prerequisite, so only questions downstream of it wait. Ask the rest of the frontier now.

Decisions are the USER's. Put each clearly and wait.

## Advancing the tree

Each round the user's answers reshape the tree. Settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another still-open question belongs to a LATER round, not this one.

Keep the design-tree sketch in your working memory. If a user answer contradicts an earlier decision, surface it ("That changes Q3 from round 1 — are we rethinking it?") rather than silently proceeding.

## When to stop

The session is done when the frontier is empty: every branch of the tree visited, nothing left silently assumed. Do not advance to stage 2 (to-spec) until the user confirms you have reached a shared understanding — say "Design tree is empty. Confirm we are aligned?" and wait.
`;
