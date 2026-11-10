# Wolfpack Console

The control plane for wolfpack agents — a Next.js app (web + Electron desktop) built on an in-house harness shell (third-party credit: see [NOTICE](../../NOTICE)). This package is the app; the Electron wrapper lives in [`apps/desktop`](../desktop).

## What's here

The generic harness shell:

- **Chat** — session view with the `session-core` state machine, sidebar, composer, keyboard system, streaming markdown (Streamdown), the tool-card registry, and a plain assistant agent (BYOK) so a turn streams end to end.
- **Events** — the server event bus + SSE (`server-events`, `events-stream`), turn runs/liveness, steer and dismiss routes, the jobs registry/context and activity dock.
- **Settings** — BYOK key store, model slots, appearance, prompt overrides, compaction.
- **Graph rendering** — `graph-view`, `graph-canvas`, `layout`, and the dagre DAG diagram (`plan-block`). Currently **inert**: nothing writes the ledgers and the view is unrouted; they are kept for the wolfpack knowledge graph and quest map.
- **Electron shell + packaging** (in `apps/desktop`).

The original teaching domain (teacher/prober/practice agents, plan tree, phases, extraction pipeline, demo/visual/pdf/research sub-agents) has been removed.

## Develop

See the repo-root [`docs/`](../../docs) (architecture, development guide, decisions). Keyboard shortcuts: [`docs/keyboard.md`](docs/keyboard.md). Desktop builds: [`docs/desktop-release.md`](docs/desktop-release.md).

```bash
npm run dev      # http://localhost:3000
npm run build
npm test        # whole suite (CI, or you); runs scripts/test.sh
```

Agents run console tests only as `wolfpack test run apps/console/tests/<file>` (shared queue, 120 s per file), never in a loop and never with `npx tsx --test` directly.

Licensed AGPL-3.0 (see [NOTICE](../../NOTICE), [LICENSE](../../LICENSE) and [docs/provenance/learnharness.md](../../docs/provenance/learnharness.md)).

## Hub relay mode (default with a hub)

With `WOLFPACK_HUB_URL` set (plus a token: `WOLFPACK_HUB_TOKEN`, or the browser's paired token) and no `WOLFPACK_API_URL`, the console uses **relay mode**: chat, streams, memory, KB and work all go through the hub, which tunnels wolf requests to the wolf's host over its worker link. An unpaired browser now gets the hub-auth 401 (and is sent to `/pair`) instead of mock threads plus hub work reads. `WOLFPACK_HUB_RELAY=0` restores the old behaviour; `WOLFPACK_HUB_RELAY=1` forces relay even when `WOLFPACK_API_URL` is set. Direct mode (`WOLFPACK_API_URL`) is unchanged. Request bodies through the relay are capped at 2 MB. See `packages/protocol/README.md` (Console relay).
