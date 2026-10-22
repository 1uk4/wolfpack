# Wolfpack Factory — Task System

> The **Factory** is the live-work layer of the knowledge base: typed **WorkItems**
> organized into initiatives, features and tasks, assigned to wolves, updated as you
> work, and **graduated into the Library** (curated KB entries) when they ship.
> It runs in the pi coding-agent CLI through the `wolfpack-memory` extension.
> Roadmap: `docs/roadmap.md`. KB substrate: `docs/kb-design.md`. The `/task new`
> flow: `docs/factory-wizard-design.md`.

## Principles
1. **One substrate, two layers.** Library entries (durable) and Factory work items
   (live, staged) share domains, ids and event sourcing.
2. **Determinism at the core.** Ids, dates and stage transitions are code. A work
   item is human/agent-authored prose plus typed state; no LLM is needed to make one.
3. **Optional depth.** The same type holds a three-level dev feature or a one-line
   personal todo; add structure only when it helps.
4. **Make illegal states unrepresentable.** Branded ids, enum stages and kinds;
   every ledger event is validated before it is written.

---

## Two orthogonal axes
1. **Work tree** — `partOf`: *vertical* decomposition, enforced on create and move
   (`placementError` in `kb/schema/work.ts`):
   ```
   initiative            → contains only features         (parent: none)
   feature               → contains task / issue / spike   (parent: initiative, or none = standalone)
   task · issue · spike  → bindable work units             (parent: a feature, required)
   idea                  → standalone, not bindable
   ```
   Features and initiatives are **workspaces**; only tasks, issues and spikes can be
   bound. A work unit created with no parent is filed in its domain's **Inbox**: a
   feature flagged `container: true`, created on first use, that never ships or
   graduates. **Moving** (`work.moved`, `moveWork`, the `task_move` tool, `m` in
   `/task`) re-parents an item under the same rules — that is how Inbox triage works.
   **Dependencies** (`dependsOn`, `dependencyError`) stay in scope: a task may depend
   only on a task in the same feature, a feature only on a feature under the same
   initiative; never across initiatives, never cyclic. `A blocks B` is stored as
   `B depends_on A`; `work.unlinked` removes a link.
2. **Area** — a field: *horizontal* grouping within a domain (`marketing`,
   `engineering`, …).

```
domain: snapjack                 ← hard boundary (vs personal, wolfpack)
├─ area: marketing
│   └ initiative "Q2 launch push"
│       └ feature  "referral program"
│           └ task "wire referral codes"   successCriteria: "code redeems → credit applied"
└─ area: engineering
    └ task "upgrade push-notif SDK"

domain: personal                 ← no areas; bare tasks
└─ task "call dentist"
```

- **Domain** is the hard boundary and maps to a KB domain.
- **Area** is set on create; personal work usually leaves it unset.

---

## The WorkItem (`packages/kb/src/schema/work.ts`)
```ts
WorkId           work-<domain>-<7id>
WorkItem {
  id, nodeType: "work"
  kind            "idea" | "initiative" | "feature" | "task" | "issue" | "spike"
  domain          DomainId
  area            Slug | null
  title           string
  summary         string | null      // ≤140 chars; set on task completion / graduation
  stage           Stage              // idea → plan → feasibility → approved → in_build
                                     //   → shipped → live → archived
  assignee        WolfId             // owner | hal | <autonomous wolf>
  successCriteria string | null      // required before a task leaves "plan"
  partOf          WorkId | null      // the work tree (null = root)
  dependsOn       WorkId[]           // work → work
  blocks          WorkId[]
  graduated       IsoDate | null     // date it graduated (no KB entry id is stored)
  container       boolean            // true only for the per-domain Inbox
  log             { at, text }[]
  created, updated
}
```
The plan/notes prose lives in the markdown body; frontmatter holds the state.
`isComplete(item)` (shipped, live or archived) is the shared "done" check.

## Event sourcing
State is a pure fold (`foldWork`) over an append-only ledger. Each op in
`client/work-ops.ts` builds an event, `appendWorkLedger` validates it (nothing is
written if it is invalid), and the item's `.md` file is re-rendered.

```
work.created · work.staged · work.assigned · work.criteria · work.area
work.retitled · work.deleted · work.noted · work.linked · work.unlinked
work.moved · work.graduated
work.bound · work.unbound · work.summarized
```

## Storage
```
<den>/kb/ledger/work-events.jsonl           work ledger (source of truth)
<kbBase>/domains/<domain>/work/<WorkId>.md  rendered item (frontmatter + body)
<den>/factory/active-task.json              this wolf's bound task
```

---

## Assignment
`assignee` is a wolf id with per-wolf meaning:
- **`owner`** — hands-on development in the pi CLI.
- **`hal`** — things you physically do; Hal tracks and reminds over Telegram.
- **autonomous wolves (future)** — a queue of items assigned to them in an
  actionable stage (`approved`, `in_build`).

## The pi surface (`extensions/wolfpack-memory/work-system.ts`)
- **`/task`** opens a two-pane workspace browser (`memory/src/work/selector.ts`
  holds the pure navigation reducer). Left: the Inbox, initiatives (collapsed;
  `l`/`Enter` expands, `h` collapses) with their features, standalone features.
  `l`/`Enter` on a feature lists its tasks on the right (open first) and moves
  focus there; `j`/`k` move, `h` goes back. **`Space` binds** the focused task;
  opening an `in_build` feature auto-binds its first open, unblocked task only when
  nothing is bound. Tasks (and an initiative's features) are ordered by dependency,
  each waiting item drawn under its prerequisite (`└▸`, `+N` for more); with the
  cursor on an item its prerequisites show ▲ and dependents ▼. Also `n` new
  (wizard), `m` move, `D` depend (valid targets only; picking an existing one
  removes it), `x` delete, `g` graduate a shipped feature.
- **Binding** a task injects an `<active_task>` block into the system prompt
  (title, stage, `done_when`, a read-only **workspace** header — feature, its
  initiative, its done-when, progress and open tasks — then the working
  document, recent log and stage guidance) and advances its ancestors to
  `in_build`. File changes are tracked while bound.
- **The session workspace** (the bound task's feature, or the last feature opened
  in `/task`) survives unbinding: a `<workspace>` block stays in the prompt and
  `task_create` still files new tasks there.
- **Agent tools:** `task_create` (a work unit defaults into the bound task's
  feature, else the Inbox), `task_query`, `task_update` (working document),
  `task_note`, `task_stage`, `task_link`, `task_unlink`, `task_move`, `task_done` (ship the bound
  task and bind the next open task in the same feature).
- **Ship policy:** `task_done` asks *"📦 Mark '…' as shipped?"* (showing the
  success criteria) before shipping; **No** leaves the task where it is and tells
  the agent to ask what's missing. A wolf with `WOLFPACK_TASK_SHIP=auto` in its
  `.env`, or a session with no UI attached, ships without asking, so agent loops
  can finish tasks on their own (`memory/src/work/ship-policy.ts`). **`/task auto`**
  (or `a` in the panel) toggles this for the session: the widget shows
  ⚡ auto-ship, and the agent is told to ship each task itself and continue with
  the next one in the feature. Graduating the feature always stays a manual `g`.
- **Stage detection** suggests other transitions at the end of each turn, e.g. a
  feature whose child tasks are all done. Tasks are not guessed done from their
  notes; that is `task_done`'s job.

## Completion and graduation
1. **Task ships** → it is folded into its feature's `## Outcomes` section (its
   `## Rollup` section verbatim, else one line "<title>, shipped <date>"; Totals
   are summed when the feature declares them). The rest of the document is untouched.
   While the work is bound, what the sessions learn is kept in the feature's `## Record`.
2. **Feature ready** → once every task under a feature is complete, `task_done`
   leaves the session **bound to the feature** (`⛓ <feature> · ready to graduate`;
   follow-up talk still goes to its Record) and `/task` marks it 🎓 *ready*.
   A lone Inbox task stays bound to itself the same way. Nothing graduates automatically.
3. **Graduate with `g`** (pi) or `task_graduate` (Hal, two steps) → the item's plan
   (document minus Record/Outcomes), Record, Outcomes, tasks and its initiative's
   title and goal are **distilled** (the same distill step as den topics, with a
   graduation framing) into contributions: current-state updates for the subjects
   the work affected, decision entries, and ONE initiative-level contribution under
   the stable topic `work-<domain>-<initiativeId>`. A **preview** (titles,
   summaries, History lines, Totals warnings) is shown first; nothing is sent until
   the owner confirms. Then the contributions are written to the wolf's ops inbox
   (`work-<domain>-<id>`, `…~<slug>` splits), the `graduated` date is recorded and
   the item and its tasks are **archived** (history kept). Cancel = nothing changes.
   A task/issue/spike in the Inbox graduates alone; an initiative graduates when all
   its features have.
4. **Dewey's sweep** routes each contribution like any other: by alias, else by the
   subject check. There are no owned or special entries. History lines of graduated
   work end with `(work-<domain>-<id>)`; that is the only place a work id may appear.
5. **Link-back**: for each work contribution it commits, the sweep queues a note
   `KB: created|updated <entry>` on the work item (posted to the Work API; retried
   while it is unreachable), so the archived item records which entries it touched.

---

## Known gaps
- **Area is not inherited or carried over.** Children don't inherit the parent's
  area (the schema comment says they should), and graduation doesn't set the
  entry's `subsystem` facet from it.
- **Task summaries ignore observations.** Work sessions have an observations
  list, but nothing feeds it (`addWorkObservation` has no caller).
- **Work files land in the receive-only mirror** on wolves, so they never reach
  the VPS host (the ledger in the den is unaffected).
- Several helpers in `memory/src/work/` (`processWorkEvent`,
  `processGraduationQueue`, file-pattern detection) are written but not wired.
