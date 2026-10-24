# Vision

*Living summary; the work-item system holds the full history.* Source: initiative `work-wolfpack-Lu9c0ij`.

## Goal: visibility

Wolfpack Console replaces the whole front end (pi TUI, Telegram bridge, vis-network dashboard, Syncthing mesh) with one harness. The goal is visibility: agents render structure as they work (plans, task graphs, decisions, observations) so the operator can reshape the work while it happens.

Personal use first, built to production standard. Single operator now; the protocol carries identity so per-wolf multi-user access can be added later (designed in, not built).

## The one tree

Pack → hosts → wolves → threads. Every wolf has the same structure:

- **Home thread:** ad-hoc requests and processes such as planning. Unbound, so observations go den topics → contributions → Dewey → KB.
- **Feature threads:** one conversation per feature, bound to it. Observations go to the feature's `## Record` → graduation → KB.
- **Task subagents:** child conversations started by a feature thread. They don't bind and don't record memory.
- **Process threads:** background work (consolidation, sweeps), shown as job threads.

The work tree, the thread tree and the memory-routing tree are one tree. The sidebar switches context across every wolf and thread on every host. The home screen is the wolfpack memory knowledge graph.

## Milestone 1: the vertical slice

One thin slice across features 1, 2, 3 and 6:

1. Scaffold live: console in browser + Electron, chat against a mock client. (done)
2. Chat-only protocol: submit / abort / event envelope.
3. workerd direct mode: one durable wolf, submit/stream/steer/abort/reconnect proven headless (spike first).
4. One real chat window: mock swapped for the SDK against local workerd, plus a minimal ask card.

Done when a real conversation with a durable 1uk4 in the console replaces one pi TUI session. No hub, no Work API, no cards beyond ask.

## Branch policy: two buckets

Every ticket is sorted at grilling time.

- **Master-safe groundwork** (lands on `main`, TUI keeps working): `packages/protocol`, client extraction from the CLI, durable extension ports, per-conversation binding, the claim operation, small KB and identity fixes.
- **Divergent work** (branch only): `apps/console`, `apps/desktop`, the hubd/workerd split, Syncthing removal, route retirement.

Production fixes land once; the branch stays mostly additive until cutover, when `console` becomes `main`.

## Data-compatibility guarantees

The work ledger, KB markdown, den layout and `wolf.yaml` are stable formats. Development runs a local hub on a copy of production data. Cutover is moving the hub to its production VPS. Dev wolves run in sandbox mode: all outward writes (Work endpoint, contributions inbox, den) are redirected to the dev hub's copies, so test output never reaches the live ledger, inbox or KB.

## Feature order

1 Console scaffold, 2 Protocol and client SDK, 3 Worker daemon and durable wolf runtime, 4 Hub daemon (registry, Work API, claim), 5 Hub ↔ worker link, auth, KB distribution, 6 Chat and thread navigation, 7 Interaction cards and structured output, 8 Subagents and worktree isolation, 9 Memory visibility and knowledge-graph home, 10 Planning and work views, 11 Cutover.
