# Wolfpack Factory — Task System Design (Phase 1)

> The **Factory** is the live-work layer of the knowledge base: typed **WorkItems**
> organized into projects/features/tasks, assigned to wolves, that update as you work and
> **graduate into the Library** (durable KB entries). This spec is file-first and runs in
> the pi coding-agent CLI today. Roadmap context: `docs/roadmap.md`. KB substrate:
> `docs/kb-design.md`.

## Status legend
- ✅ built · 🟡 vocab/primitive exists, node to build · ⬜ to build

## What already exists (we are wiring the layer it was designed for)

- ✅ **Vocabularies** in `packages/engine/src/config/vocab.ts`:
  - `NODE_TYPES = ["reference", "work"]` — Library vs Factory.
  - `WORK_KINDS = ["idea","initiative","feature","task","issue","spike"]`.
  - `STAGES = ["idea","plan","feasibility","approved","in_build","shipped","live","archived"]`.
  - `RELATION_KINDS` includes the Factory edges: `references` (work→context),
    `graduated_from` (entry←work), `blocks` (work→work), plus `part_of`, `depends_on`.
- ✅ **Event store** `packages/engine/.../ledger/event-log.ts` — its header already names
  *"the new factory (WorkItem stage machine)"* as an intended consumer. Append-only JSONL
  + pure `fold` → live state. This is the stage machine's backbone.
- ✅ **Library side** fully typed/wired: `Entry`, `assembleEntry`, routing, sweep.
- ✅ **Id + path conventions**: `ids.ts` (`kb-<domain>-<shortId>`, `shortId`, `now`),
  `paths.ts` (`entriesDir = kbBase/domains/<domain>/entries`).
- 🟡 **WorkItem node type** — only the vocab exists; the typed node, storage, assembler,
  and commands are **to build**.

---

## Principles (inherited from the KB)

1. **One substrate, two layers.** Library (`reference`) = durable context. Factory
   (`work`) = live, staged. Same storage, same event-sourcing, same propagation.
2. **Determinism at the core.** Ids, dates, stage transitions, hashes, link resolution =
   code. The WorkItem is *human/agent-authored prose + typed state* — no LLM is required
   to produce one (unlike an Entry).
3. **Built around how 1uk4 works, with optional depth.** The same type handles a 3-level
   dev feature and a one-line personal todo. You add structure only when you want it.
4. **Make illegal states unrepresentable.** Branded ids, enum stages, a discriminated
   kind — the compiler is the source of truth for a WorkItem's shape.

---

## The two orthogonal axes

The core design decision: **work decomposition and project-area are independent.**

1. **Work tree** — the `part_of` relation. *Vertical* decomposition:
   `initiative → feature → task`. How work breaks down.
2. **Area** — a field. *Horizontal* grouping within a domain: `marketing`, `analysis`,
   `engineering`. Which system it belongs to.

```
domain: snapjack                 ← hard boundary (vs personal, wolfpack)
├─ area: marketing
│   └ initiative "Q2 launch push"          (part_of tree)
│       └ feature  "referral program"
│           └ task "wire referral codes"   success_criteria: "code redeems → credit applied"
├─ area: analysis
│   └ initiative "retention model v2"
│       └ task "pull cohort export"        assignee: 1uk4
└─ area: engineering
    └ task "upgrade push-notif SDK"        assignee: hal (1uk4 physically does it)

domain: personal                 ← no areas; bare tasks
└─ task "call dentist"           assignee: hal
```

- **Domain** = the hard boundary (`personal` | `snapjack` | `wolfpack` | …). Maps to a KB
  domain, so propagation and read-access already flow per-domain.
- **Area inherits from the parent.** Set it once on the initiative; children inherit;
  override only when needed. You never re-type "marketing" on every task.
- **Personal/light work** simply sets no area and stays a flat list of bare `task`s.

### Continuity to the Library
`area` is deliberately the Factory counterpart of the Library's `subsystem` facet
(`FACET_KEYS = ["subsystem","surface","layer","lifecycle"]`). When a WorkItem **graduates**
to an Entry, its `area` becomes the entry's `subsystem` facet — the grouping survives the
jump from Factory to Library. Marketing *work* files into marketing *knowledge*.

---

## The WorkItem (typed node to build)

Lives at `packages/kb/src/schema/work.ts` (sibling of `knowledge.ts`).

```ts
WorkId          work-<domain>-<shortId>     // branded, mirrors EntryId
WorkItem {
  id            WorkId
  nodeType      "work"
  kind          "idea" | "initiative" | "feature" | "task" | "issue" | "spike"
  domain        DomainId                    // personal | snapjack | wolfpack   (hard boundary)
  area          Slug | null                 // marketing | analysis | …  (inherits from part_of parent)
  title         string
  stage         Stage                       // idea → … → archived  (event-sourced)
  assignee      WolfId                       // 1uk4 | hal | <autonomous wolf>
  success_criteria  string | null           // the done-condition (NEW; required for kind:"task")
  part_of       WorkId | null               // the work tree (nullable = root)
  references    EntryId[]                    // work → Library context it used
  depends_on    WorkId[]                     // work → work
  blocks        WorkId[]                     // work → work
  graduated_to  EntryId[]                    // entries born from this work
  created       IsoDate
  updated       IsoDate
  // body (markdown file): plan (iterable) + notes + append-only activity log
}
```

Notes:
- `success_criteria` is the one genuinely new field. **Required when `kind === "task"`**
  (every job has a done-condition); optional on higher-level items.
- `stage` is a superset. Dev features walk the full machine; personal items live in a
  subset (`plan → in_build → shipped`). One enum, used to the depth needed.
- `assignee` semantics differ by wolf (see below) — the field is the same.

---

## Stage machine (event-sourced)

State is a **fold over an append-only event log**, reusing `event-log.ts`. Transitions are
new events, never in-place mutation — replayable, auditable, and ready to move behind the
Phase 2 API unchanged.

```
events (append-only JSONL)                  fold → live WorkItem state
  work.created   { id, kind, domain, ... }
  work.staged    { id, from, to }           stage transitions
  work.assigned  { id, assignee }
  work.noted     { id, text }               activity log entries
  work.linked    { id, entryId, rel }       references / graduated_to
  work.criteria  { id, success_criteria }
```

Stage path (dev): `idea → plan → feasibility → approved → in_build → shipped → live → archived`.
Stage path (personal/light): `plan → in_build → shipped`.

---

## Assignment & the wolf queue

`assignee` is a wolf id, and it means subtly different things per wolf — the model honors
all three:

- **`1uk4`** — hands-on development. Items you pull up in your pi CLI session.
- **`hal`** — things you must *physically do*. Hal does not execute them; he is your
  **mobile KB relay**: when you are away he surfaces what is assigned to him (over
  Telegram), reminds/tracks, and reads/writes the KB on your behalf. `assignee: hal` =
  "real-world action Hal tracks," not "Hal runs code."
- **autonomous wolves (future)** — a wolf's **queue** is simply
  `WorkItems where assignee == me AND stage is actionable` (`approved` | `in_build`).
  "Wolves in loops" drain that queue, advancing stages until empty.

This generalizes the den's current flat `tasks/inbox.md → active.md → done.md`: the Factory
is the structured, typed, propagating version of those lists.

---

## Session binding — the `/task` pi extension (file-first)

A small pi extension provides the hands-on surface:

- `/task new` — create a WorkItem (kind, domain, area, title, success_criteria, part_of).
- `/task use <id>` — **bind this session** to a WorkItem. It renders into the system
  prompt as a section: *"Active: `<title>` — success: `<criteria>` — stage: `in_build`"* so
  the agent always knows the current job and its done-condition.
- `/task plan` — open/iterate the plan body (stays in `plan`; each revision logged).
- `/task break` — spawn `task` children (`part_of`), each prompting for `success_criteria`.
- `/task stage <next>` — advance the stage machine.
- `/task note <text>` — append to the activity log.
- `/task ls [--mine] [--area <a>] [--tree <id>]` — view by queue, area, or tree.
- `/task done <id>` — advance to `shipped` and trigger graduation.

As a bound session runs, progress appends to the item and KB entries it touches are linked
via `references`.

---

## Graduation → the Library (propagation)

When work ships, its learnings flow into durable KB entries through the **existing**
promote → inbox → sweep pipeline — no new ingestion path:

1. `/task done` (or stage → `shipped`) emits the WorkItem's summary + notes as a
   contribution into the wolf's **ops inbox** (`opsRoot/inbox/<wolf>`), tagged with the
   work's `domain` and `area`.
2. Dewey's automated **sweep** routes/produces it into an `Entry` as today.
3. The resulting entry links back via `graduated_from`; the WorkItem records
   `graduated_to`. The work's `area` becomes the entry's `subsystem` facet.

The Factory feeds the Library; the Library compounds. This is the loop the KB design
named as its goal: *"Lived sessions and shipped work graduate back into the Library."*

---

## File layout (file-first; moves behind the Phase 2 API unchanged)

```
knowledge/base/domains/<domain>/
  entries/        ✅ Library entries (reference)
  work/           ⬜ Factory WorkItems (one <WorkId>.md each; frontmatter + body)
  _registry.md    ✅ topic registry (rides the domain's Syncthing share)
  INDEX.md        ✅ entry index
<den-local>/kb/ledger/events.jsonl   ✅ event store (stage transitions appended here)
```

A WorkItem file is Obsidian-native: YAML frontmatter for structured state, a markdown body
with `## Plan`, `## Notes`, and an append-only `## Log`. The local pi CLI reads/writes these
directly today; Phase 2 puts the identical files behind `resolve`/`contribute`-style
endpoints with no data-model change.

---

## Build order (Phase 1)

1. ⬜ `schema/work.ts` — `WorkId`, `WorkItem`, the event union, a pure `foldWork` reducer.
2. ⬜ Storage — `work/` read/write + ledger append, mirroring `client/resolve.ts` style.
3. ⬜ CLI/engine ops — create / stage / assign / note / link / list (pure functions over
   the event log).
4. ⬜ `/task` pi extension — session binding + system-prompt section + the commands above.
5. ⬜ Graduation hook — emit contribution to the ops inbox on `shipped`.
6. ⬜ Seed 1uk4's real projects (snapjack areas, wolfpack, personal) and start using it.
