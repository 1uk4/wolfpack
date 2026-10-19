/**
 * Task-create orchestrator — routes by kind, composes the three protocols.
 *
 * Sent to the LLM when the user triggers `/task new` (see work-system.ts).
 * The orchestrator asks what the user is creating, then takes the matching
 * path:
 *
 *   idea        → one-shot capture, done
 *   initiative  → ask goal + why, task_create, done
 *   task | issue | spike (one-off) → quick title + successCriteria + create
 *   feature     → full three-stage pipeline: grill → spec → tickets
 *
 * The three stage protocols are inlined verbatim so the LLM has them in
 * context without any additional tool calls.
 */

import { GRILLING_PROTOCOL } from "./grilling.js";
import { TO_SPEC_PROTOCOL } from "./to-spec.js";
import { TO_TICKETS_PROTOCOL } from "./to-tickets.js";

export { GRILLING_PROTOCOL, TO_SPEC_PROTOCOL, TO_TICKETS_PROTOCOL };

const DOMAIN_AND_PARENT = `## Domain and parent — pick carefully

Every work item belongs to exactly ONE domain. The domain names what the item is ABOUT, not who is doing it:
- **wolfpack** — changes to this codebase (CLI, agent, memory, kb, extensions), pack infra, agent prompts, developer docs
- **snapjack** — the Snapjack iOS/web app, its features, bugs, growth
- **personal** — the user's life: fitness, admin, finance, planning, non-work

Pick domain by SUBJECT. A fix to a Hal skill is **wolfpack** (code change), even though it's about fitness. An actual workout is **personal**.

partOf MUST point at a feature in the SAME domain, or omit partOf to land in that domain's Inbox. The system rejects cross-domain parenting.

Use \`ask_user_question\` when the right domain or feature is ambiguous.`;

const ROUTING = `## Routing

First, use \`ask_user_question\` to find out what the user is creating. The four paths:

- **Idea**: unformed; just capture title + 1-sentence description via \`task_create kind=idea\`. Done. Can be promoted to feature/initiative later.
- **Initiative**: a large goal. Ask for the goal (one sentence) + why it matters, and whether it is **standing**: it never completes and keeps gaining features (Fitness gets a new week every week; Admin keeps its category features open). \`task_create kind=initiative\`, with \`standing=true\` if so. Done. Features created under it later get the full pipeline each.
- **Task | issue | spike** (one-off under the current workspace): quick path — title + \`successCriteria\` + \`task_create\` under the bound workspace's feature. No grilling, no spec, no tickets.
- **Feature**: run the FULL three-stage pipeline below. Grill → spec → tickets.

If a response that started as "task" grows into something richer during the conversation, propose upgrading it to a feature and switch to the pipeline.`;

const PIPELINE_INTRO = `## The three-stage pipeline (features only)

Run these three protocols IN ORDER. Do not skip stages. Do not merge rounds across stages.

1. **GRILLING** — build the design tree in rounds until the frontier is empty and the user confirms shared understanding.
2. **TO-SPEC** — synthesise the grilling into a feature spec. Confirm test seams. Publish the feature at stage=approved with the spec as its body.
3. **TO-TICKETS** — break the spec into tracer-bullet tickets with blocking edges. Quiz the user. Publish each as a task under the feature with \`depends_on\` links in topological order.

Each stage's full protocol follows verbatim.

---

`;

export const NEW_WORK_PROMPT = `The user wants to create a new work item. Work items have this hierarchy:
- **Idea**: an unformed thought; captured now, promoted later.
- **Initiative**: a large goal with multiple features (e.g., "Dockerize Wolfpack").
- **Feature**: a capability to build; standalone or under an initiative.
- **Task | issue | spike**: a unit of work under a feature.

${DOMAIN_AND_PARENT}

${ROUTING}

${PIPELINE_INTRO}${GRILLING_PROTOCOL}

---

${TO_SPEC_PROTOCOL}

---

${TO_TICKETS_PROTOCOL}
`;
