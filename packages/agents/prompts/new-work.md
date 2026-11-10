The user wants to create a new work item. Work items have this hierarchy:
- **Idea**: an unformed thought; captured now, promoted later.
- **Initiative**: a large goal with multiple features (e.g., "Dockerize Wolfpack").
- **Feature**: a capability to build; standalone or under an initiative.
- **Task | issue | spike**: a unit of work under a feature.

## Domain and parent — pick carefully

Every work item belongs to exactly ONE domain. The domain names what the item is ABOUT, not who is doing it:
{{domains}}

Pick domain by SUBJECT. A change to a tool or skill is a code change in the domain that owns that code, even when the tool is about something else (e.g. a billing skill's bug fix belongs with the code, not with billing). Doing the activity itself belongs to the domain of that activity.

partOf MUST point at a feature in the SAME domain, or omit partOf to land in that domain's Inbox. The system rejects cross-domain parenting.

Use `ask` when the right domain or feature is ambiguous.

## Routing

First, use `ask` to find out what the user is creating. The four paths:

- **Idea**: unformed; just capture title + 1-sentence description via `task_create kind=idea`. Done. Can be promoted to feature/initiative later.
- **Initiative**: a large goal. Ask for the goal (one sentence) + why it matters, and whether it is **standing**: it never completes and keeps gaining features (Releases gets a new sprint every sprint; Admin keeps its category features open). `task_create kind=initiative`, with `standing=true` if so. Done. Features created under it later get the full pipeline each.
- **Task | issue | spike** (one-off under the current workspace): quick path — title + `successCriteria` + `task_create` under the bound workspace's feature. No grilling, no spec, no tickets.
- **Feature**: run the FULL three-stage pipeline below. Grill → spec → tickets.

If a response that started as "task" grows into something richer during the conversation, propose upgrading it to a feature and switch to the pipeline.

## The three-stage pipeline (features only)

Run these three protocols IN ORDER. Do not skip stages. Do not merge rounds across stages.

1. **GRILLING** — build the design tree in rounds until the frontier is empty and the user confirms shared understanding.
2. **TO-SPEC** — synthesise the grilling into a feature spec. Confirm test seams. Publish the feature at stage=approved with the spec as its body.
3. **TO-TICKETS** — break the spec into tracer-bullet tickets with blocking edges. Quiz the user. Publish each as a task under the feature with `depends_on` links in topological order.

Each stage's full protocol follows verbatim.

---

{{grilling}}

---

{{toSpec}}

---

{{toTickets}}
