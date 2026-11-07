# Development

## Layout

See the monorepo map in the [root README](../README.md). Workspaces are `packages/*` and `apps/*`. Design context: [architecture.md](architecture.md).

## Commands

Run from the repo root (turbo):

| Command | Does |
|---|---|
| `pnpm install` | Install all workspaces (`--frozen-lockfile` to match the lock exactly). |
| `pnpm dev` | Console dev server on http://localhost:3000 (mock-backed). No Electron. |
| `pnpm --filter @wolfpack/desktop dev` | Console on :3210, then Electron. Run in your own terminal. |
| `pnpm verify` | `turbo run build typecheck lint test`, cached, all workspaces. Run before committing. |
| `pnpm build` | `tsc --build` (legacy root build). A bare root `tsc --build` leaves `packages/hubd/dist/cli.js` without its exec bit: run `pnpm --filter @wolfpack/hubd build` to restore it, or use `node dist/cli.js`. |
| `pnpm exec vitest run` | Root vitest run for the packages. |
| `wolfpack test related <files>` | How agents run tests: queued per host, capped, cached. See [testing](testing.md#the-test-runner-wolfpack-test). |

Packages have no linter yet (`lint` is a no-op echo). The console lints with eslint, including its import-law rules.

## Package manager: pnpm for dev and CI, npm for the release

- **Dev and CI use pnpm** (`packageManager` in `package.json` pins the version). One content-addressed store (`~/Library/pnpm/store` on the Mac) is linked into every worktree, so a second worktree installs in seconds and costs tens of MB. Get pnpm with `corepack enable` (plain `corepack enable` only shims pnpm and yarn, so npm keeps working; `corepack enable npm` makes npm refuse this repo, so don't, or set `COREPACK_ENABLE_STRICT=0`).
- **The release images still install with npm** from `package-lock.json` until work-wolfpack-hFNgvt7 moves them. So both lockfiles are committed and must agree. After changing any `package.json` run `npm install --package-lock-only --ignore-scripts` **and** `pnpm install --lockfile-only`. `pnpm check:lockfiles` (and CI) fails when `package-lock.json` is not what npm would write, or when the two locks resolve different versions. The one name difference is expected: the git dependency is `pi-claude-bridge-stateless` in npm and `pi-claude-bridge` in pnpm.
- **Strict layout.** pnpm only lets a package import what it declares (`hoist: false`), so a missing dependency fails at install/build instead of working by accident. `pnpm check:deps` lists undeclared imports. `extensions/*` are not workspaces: the root `devDependencies` declare what they import.
- **Turbo cache is shared.** Root scripts run turbo through `scripts/turbo.mjs`, which points every checkout at `~/.cache/wolfpack/turbo` (override with `TURBO_CACHE_DIR`; CI sets none). Use `pnpm turbo ...` or `node scripts/turbo.mjs ...`; a bare `turbo` or `npx turbo` uses the checkout's own cache.
- **pnpm-only dev scripts:** `pnpm dev`, `pnpm verify`, `pnpm stack`, `pnpm dev:stack`, `pnpm runtime:update`, `pnpm check:deps`, `pnpm check:lockfiles`. `runtime:update` and `wolfpack pr` use pnpm only when the checkout being deployed has `pnpm-lock.yaml` and pnpm is installed; otherwise they run the old npm commands.
- **Stale `extensions/*/node_modules` trap.** An old npm-era checkout can keep `extensions/*/node_modules` that mask a dependency the root no longer declares (this hid `tldts` and `typebox` once). Check in a fresh clone (or delete those folders) before trusting a green run.

## Run against a real wolf

The console defaults to the mock. Set `WOLFPACK_API_URL` to point its server-side client at a wolf's `/v1` (an `HttpConsoleClient`):

```sh
# 1. a wolf (needs `pnpm --filter @wolfpack/harness build`, ANTHROPIC_API_KEY for an api table, and WOLFPACK_MODELS_FILE)
set -a; . ~/.wolfpack/.env; set +a
WOLFPACK_MODELS_FILE=/path/to/models.json node packages/harness/dist/bin/wolfd.js --config /path/to/wolf.yaml --port 3141
# 2. the console against it
WOLFPACK_API_URL=http://127.0.0.1:3141 pnpm dev
```

A minimal `wolf.yaml` is `name: <wolf>` plus `workspace: <dir>`; use a scratch dir, not a real wolf's. Unset `WOLFPACK_API_URL` to go back to the mock. A stale-cursor snapshot from the wolf is logged server-side, not forwarded to the browser (full snapshot UX is planned).

Set `WOLFPACK_HUB_URL` (and `WOLFPACK_HUB_TOKEN`, a console token from `hubd pair`; the old `WOLFPACK_HUB_KEY` is no longer read) to read work (the Work view lists and records) from a hubd instead of the wolf; unset = unchanged. It works with or without `WOLFPACK_API_URL`.

**Subscription variant (no API key).** A models file with `"transport": "subscription"` (tiers `provider: "claude-agent-sdk"`, `piModel: "claude-stateless/<model>"`) makes wolfd build the claude-stateless provider (`pi-claude-bridge-stateless`, a git dep on the 1uk4 fork) and bill turns to your Claude subscription through your local Claude Code login. No `ANTHROPIC_API_KEY` is needed or used (the provider strips it from the `claude` child; there is no fallback onto the key). Skip the `.env` step:

```sh
WOLFPACK_MODELS_FILE=/path/to/models.subscription.json node packages/harness/dist/bin/wolfd.js --config /path/to/wolf.yaml --port 3141
```

Live proof (tagged, never in CI): `WOLFD_LIVE=1 pnpm --filter @wolfpack/harness test -- wolfd.subscription.live` runs a chat turn and a `read` tool turn against a real subscription wolf with the key removed from its env. To go back to the API key, point `WOLFPACK_MODELS_FILE` at an `api` table.

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

## models.json is generated from wolf.yaml `models:`

When a **local** wolf's `wolf.yaml` has a `models:` block, wolfd regenerates the `models.json` beside it at start
(pack `models:` < wolf.yaml), only when the content differs, atomically, keeping the file's mode. Hand edits to that
file are overwritten (one log line says so). No `models:` block, a `WOLFPACK_MODELS_FILE` handover, a VPS wolf (its
table is shipped by `wolfpack sync`) or an undetectable location: the file is left alone. A local wolf is one whose
dir is `<wolvesRoot>/local/<name>`.
