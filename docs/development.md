# Development

## Layout

See the monorepo map in the [root README](../README.md). Workspaces are `packages/*` and `apps/*`. Design context: [architecture.md](architecture.md).

## Commands

Run from the repo root (turbo):

| Command | Does |
|---|---|
| `npm install` | Install all workspaces. |
| `npm run dev` | Console dev server on http://localhost:3000 (mock-backed). No Electron. |
| `npm run dev -w @wolfpack/desktop` | Console on :3210, then Electron. Run in your own terminal. |
| `npm run verify` | `turbo run build typecheck lint test`, cached, all workspaces. Run before committing. |
| `npm run build` | `tsc --build` (legacy root build). |
| `npx vitest run` | Root vitest run for the packages. |

Packages have no linter yet (`lint` is a no-op echo). The console lints with eslint, including its import-law rules.

## Run against a real wolf

The console defaults to the mock. Set `WOLFPACK_API_URL` to point its server-side client at a wolf's `/v1` (an `HttpConsoleClient`):

```sh
# 1. a wolf (needs `npm run build -w @wolfpack/harness`, ANTHROPIC_API_KEY for an api table, and WOLFPACK_MODELS_FILE)
set -a; . ~/.wolfpack/.env; set +a
WOLFPACK_MODELS_FILE=/path/to/models.json node packages/harness/dist/bin/wolfd.js --config /path/to/wolf.yaml --port 3141
# 2. the console against it
WOLFPACK_API_URL=http://127.0.0.1:3141 npm run dev
```

A minimal `wolf.yaml` is `name: <wolf>` plus `workspace: <dir>`; use a scratch dir, not a real wolf's. Unset `WOLFPACK_API_URL` to go back to the mock. A stale-cursor snapshot from the wolf is logged server-side, not forwarded to the browser (full snapshot UX is planned).

**Subscription variant (no API key).** A models file with `"transport": "subscription"` (tiers `provider: "claude-agent-sdk"`, `piModel: "claude-bridge/<model>"`) makes wolfd build the pi-claude-bridge provider (`pi-claude-bridge/core`, a git dep on the 1uk4 fork) and bill turns to your Claude subscription through your local Claude Code login. No `ANTHROPIC_API_KEY` is needed or used (the bridge strips it from the `claude` child; there is no fallback onto the key). Skip the `.env` step:

```sh
WOLFPACK_MODELS_FILE=/path/to/models.subscription.json node packages/harness/dist/bin/wolfd.js --config /path/to/wolf.yaml --port 3141
```

Live proof (tagged, never in CI): `WOLFD_LIVE=1 npm test -w @wolfpack/harness -- wolfd.subscription.live` runs a chat turn and a `read` tool turn against a real subscription wolf with the key removed from its env. To go back to the API key, point `WOLFPACK_MODELS_FILE` at an `api` table.

## Test seams

- **Console suite:** `apps/console/scripts/test.sh` runs `tsx --test` over `tests/*.test.{ts,tsx}`. Deterministic, no LLM, no network. It excludes known-failing files (TODO in the script).
- **Packages:** vitest (`packages/*/src/**/*.test.ts`).
- **The ConsoleClient mock seam:** `packages/client` owns the `ConsoleClient` interface and `MockConsoleClient` with a fixed fixture (one wolf, one home thread, one scripted turn with a tool call). View-model tests (thread-adapter, session-core) and the thread API handlers (`src/server/thread-api.ts`) are tested against the mock. Test behaviour through this seam, not component internals. The mock is a permanent fixture, not throwaway data.
- No browser e2e yet; Electron has a smoke script under `apps/desktop/scripts`.

## Docs rules

1. **Docs move with the code.** A change that alters documented behaviour updates the docs in the same commit.
2. **Feature-ship includes a docs pass.** Before a feature is marked shipped: move its items from *Planned* to *Built* in `architecture.md`, and update `vision.md` if the plan changed.
3. **ADRs are append-only; `architecture.md` is current state only.** Decisions go in `docs/decisions/` (see its README) and are never rewritten. `architecture.md` describes what exists now, with unbuilt work clearly marked *Planned*.

`docs/vision.md` is a living summary; the work-item system holds the full history.
