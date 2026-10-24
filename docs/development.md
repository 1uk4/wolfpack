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
