# Wolfpack Console

The control plane for wolfpack agents — a Next.js app (web + Electron desktop) built on the harness shell converted from LearnHarness. This package is the app; the Electron wrapper lives in [`apps/desktop`](../desktop).

## What's here

The generic harness shell:

- **Chat** — session view with the `session-core` state machine, sidebar, composer, keyboard system, streaming markdown (Streamdown), the tool-card registry, and a plain assistant agent (BYOK) so a turn streams end to end.
- **Events** — the server event bus + SSE (`server-events`, `events-stream`), turn runs/liveness, steer and dismiss routes, the jobs registry/context and activity dock.
- **Settings** — BYOK key store, model slots, appearance, prompt overrides, compaction.
- **Graph rendering** — `graph-view`, `graph-canvas`, `layout`, and the dagre DAG diagram (`plan-block`). Currently **inert**: nothing writes the ledgers and the view is unrouted; they are kept for the wolfpack knowledge graph and quest map.
- **Electron shell + packaging** (in `apps/desktop`).

The learnharness teaching domain (teacher/prober/practice agents, plan tree, phases, extraction pipeline, demo/visual/pdf/research sub-agents) has been removed.

## Develop

See [`docs/development.md`](docs/development.md) (commands, layout) and [`docs/architecture.md`](docs/architecture.md) (layers, the import law). Keyboard shortcuts: [`docs/keyboard.md`](docs/keyboard.md). Engine notes: [`docs/pi-engine-swap.md`](docs/pi-engine-swap.md). Desktop builds: [`docs/desktop-release.md`](docs/desktop-release.md).

```bash
npm run dev      # http://localhost:3000
npm run build
npm test
```

Licensed AGPL-3.0 (see the repo-level ATTRIBUTION).
