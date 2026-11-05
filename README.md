# Wolfpack

Wolfpack is a multi-agent system: a pack of long-lived AI agents ("wolves") with persistent memory and a shared knowledge base, working on a shared work ledger. Today's pack is **hal** (personal agent, 24/7 on a VPS), **dewey** (knowledge-base librarian, 24/7 on a VPS) and **1uk4** (personal working agent, on the Mac).

> **Status: active rewrite on branch `console`.** `main` runs the production pack (pi TUI, Telegram bridge, dashboard, Syncthing). This branch replaces that front end with **Wolfpack Console**, a Next.js + Electron app over pi-durable wolves. The console currently runs against a mock client only; no daemon exists yet. See [docs/vision.md](docs/vision.md) and [docs/architecture.md](docs/architecture.md).

## Monorepo map

npm workspaces (`packages/*`, `apps/*`), orchestrated by turbo.

| Path | Package | What it is |
|---|---|---|
| `apps/console` | `@wolfpack/console` | Next.js app (browser + served web): chat shell, sidebar, settings, keyboard system. Third-party credit: see [NOTICE](NOTICE), [LICENSE](LICENSE) and [docs/provenance/learnharness.md](docs/provenance/learnharness.md). |
| `apps/desktop` | `@wolfpack/desktop` | Thin Electron shell that spawns the console server on 127.0.0.1. |
| `packages/client` | `@wolfpack/client` | `ConsoleClient` interface, event/thread types, `MockConsoleClient` + fixture. |
| `packages/harness` | `@wolfpack/harness` | Wolf runtime: extensions, lifecycle, sweep worker, adapters. |
| `packages/memory` | `@wolfpack/memory` | Session memory, observer, den, consolidation. |
| `packages/kb` | `@wolfpack/kb` | Knowledge-base tooling. |
| `packages/engine` | `@wolfpack/engine` | Zod schemas, LLM adapter, pipeline utilities. |
| `packages/agent` | `@wolfpack/agent` | Legacy VPS management HTTP API (to be retired at cutover). |
| `packages/cli` | `@wolfpack/cli` | `wolfpack` CLI: hosts, wolf provisioning, management. |
| `extensions/` | | Legacy pi extensions (memory, subagents, telegram). |
| `infra/` | | Legacy Ansible roles and inventory. |

## Quickstart

```bash
npm install
npm run dev        # console at http://localhost:3000, backed by MockConsoleClient
npm run verify     # turbo: build, typecheck, lint, test across all workspaces
```

Desktop (run in your own terminal; starts the console on :3210, then opens Electron):

```bash
npm run dev -w @wolfpack/desktop
```

`npm run dev` does not start Electron. Packages have no linter yet (`lint` is a no-op there). The console test script (`apps/console/scripts/test.sh`) excludes known-failing files; see the TODO in it.

## Live vs dev stack

- **Live** (headless workerd + wolfd for `~/wolves/local`, port 7141, run from the runtime checkout `~/wolves/local/runtime/wolfpack`) is a launchd agent `com.wolfpack.stack`: starts at login, restarts on crash, `caffeinate -is`, sources `~/.wolfpack/.env` (`$WOLFPACK_HOME`) at start, logs to `~/wolves/local/logs/stack.log`.
  `npm run stack -- start|stop|restart|status|logs [-f] [-n N]|uninstall`. `restart` is a graceful SIGTERM + relaunch and kills every in-flight turn, including the caller's. `start` refuses if something else (e.g. a hand-started workerd) holds :7141: kill it first. After `npm run runtime:update` run `npm run stack -- restart`.
- **Dev**: `npm run dev:stack [-- --app console|none]` runs workerd (:7151) and the console (:3220) from the *current* checkout against a sandbox folder (`DEV_WOLVES_DIR`, default `~/wolves/dev-sandbox`; ports `DEV_WORKERD_PORT`, `DEV_CONSOLE_PORT`) with `HOME=<sandbox>/.home` and no inherited `WOLF_*`/`WOLFPACK_*` vars. First run scaffolds one minimal wolf and copies a `models.json` (no secrets); a model reply needs your Claude login or keys in `~/.wolfpack/.env`. It refuses any path touching `~/wolves/local` (symlink or case aliases too) and the live ports, and Ctrl-C stops every process.

Legacy CLI commands (`wolfpack add wolf`, `launch`, `sync`, ...) still work from `main`'s tooling: `npm run build && npm run install:cli`.

## Docs

- [docs/vision.md](docs/vision.md): goal, core model, milestone 1, branch policy.
- [docs/architecture.md](docs/architecture.md): what is built vs planned.
- [docs/decisions/](docs/decisions/): architecture decision records.
- [docs/development.md](docs/development.md): contributor guide and docs rules.
- Console-specific: [keyboard shortcuts](apps/console/docs/keyboard.md), [desktop release](apps/console/docs/desktop-release.md).
- Legacy operations (CLI reference, `wolf.yaml`, install, Tailscale/Syncthing health): see the [README on `main`](https://github.com/1uk4/wolfpack/blob/main/README.md) — those systems run production until cutover.
