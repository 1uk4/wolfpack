# Model providers

wolfd and the VPS harness build ONE pi-ai model registry from the providers the configured tiers name.
Each tier in `models.json` carries `{ provider, model }` (`piModel` is `<provider>/<model>`):

```json
{ "tiers": {
    "main":  { "model": "claude-opus-5-5",   "piProvider": "claude-stateless", "piModel": "claude-stateless/claude-opus-5-5" },
    "smart": { "model": "claude-sonnet-5-5", "piProvider": "claude-stateless", "piModel": "claude-stateless/claude-sonnet-5-5" },
    "fast":  { "model": "claude-haiku-5-5",  "piProvider": "anthropic",     "piModel": "anthropic/claude-haiku-5-5" } } }
```

Naming: in config INPUT (`config.yaml` / `wolf.yaml` `models.<tier>.provider`) `provider` is the pi provider. In the resolved
`models.json`, `provider` is the ENGINE provider (`claude-stateless` → `claude-agent-sdk`) and `piProvider` is the pi provider.

Author it in `~/.wolfpack/config.yaml` (or `wolf.yaml`): `models: { fast: { provider: anthropic, model: claude-haiku-5-5 } }`.
A tier without `provider` takes the legacy `transport` default (`subscription` → claude-stateless, `api` → anthropic), so old
configs and old `models.json` files (no `piProvider`) keep working. Keys come from `~/.wolfpack/.env`.

Only the providers actually named are built: a config with no `claude-stateless` tier never loads it.

## Adding a provider (OpenRouter example)

1. One entry in `providers/index.ts`:

   ```ts
   import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"; // pi-ai's provider factory
   PROVIDER_FACTORIES.openrouter = () => ({ provider: openrouterProvider() }); // reads OPENROUTER_API_KEY
   ```

   Optional hooks on the handle: `forget(sessionId)` (a conversation ended) and `dispose()` (wolf shutdown).
   Requires a pi-ai provider module: pi-ai 1.4.0 ships `providers/openrouter` (checked in node_modules), so that import
   exists; other providers need their own module.
2. Config: `models: { main: { provider: openrouter, model: <openrouter model id> } }` and the key in `~/.wolfpack/.env`.

This is one map entry plus config for the main and subagent (pi-durable) paths. Engine steps (memory, consolidation,
KB sweep, librarian) read `smart` / `fast` through the engine adapters, which exist only for anthropic and
the Agent SDK providers: `resolveModelTable` refuses any other provider on those two tiers, so only `main` can use a new provider today.

A den may hold stored model refs to providers a wolf no longer uses; those register lookup-only (resolvable, never served).

Subagent and memory paths do not require thinking or prompt caching: thinking is only passed when a tier sets it.

## `claude-stateless` (the subscription provider)

`claude-stateless` (`providers/claude-stateless.ts`) is the default Max-subscription provider for every tier. Each model
round is one short-lived Agent SDK query over a resumable session file (no parked child). It needs
`CLAUDE_CODE_OAUTH_TOKEN`. State lives in a state dir next to the den, NOT in it (the den is Syncthing-synced on VPS wolves):
`<dirname(WOLF_DEN)>/claude-stateless/<basename(WOLF_DEN)>/` holds `sessions/` (session files, the fixed CLI cwd) and
`debug.log` (JSON lines, always on). wolfd sets `WOLF_DEN`; the factory throws without it. The model table is pi-ai's
anthropic catalog (no dated ids, zero cost, 1M context only for ids measured to serve it), built in `claude-stateless.ts`.

Engine steps (memory, consolidation, KB sweep, librarian) reach it through the `claude-agent-sdk` adapter.

**The retired `claude-bridge` provider (pi-claude-bridge durable-core) is gone.** Old `models.json` files that say
`"piProvider": "claude-bridge"` / `"piModel": "claude-bridge/<model>"`, and `provider: claude-bridge` in config, are aliased to
`claude-stateless` when the table is loaded (one log line; regenerate with `wolfpack sync` to drop it). Stored conversation
refs `claude-bridge/<model>` still resolve (a lookup-only entry in `LOOKUP_MODELS`).

## Provider plug-ins

A provider (and its engine adapter) can plug in from outside the repo. A plug-in is a folder
`<plugins dir>/<id>/` (default `<WOLFPACK_HOME>/plugins`, override `WOLFPACK_PLUGINS_DIR`) whose `package.json` has:

```json
{ "wolfpack": { "apiVersion": 1, "entry": "./dist/index.js", "requiredEnv": ["MY_TOKEN"],
                "providers": ["my-provider"], "engineProviders": ["my-provider"] } }
```

The entry's default export is `{ apiVersion: 1, createProvider?(ctx), createEngineAdapter?({ env, config }), models?(ctx) }`
(types `PluginModule` / `PluginContext`, exported from `@wolfpack/harness`). `ctx.env` holds only the names in `requiredEnv`.

Enable it in wolf.yaml: `plugins: [my-provider]` (the folder name). A folder alone never runs code. `loadPlugins()` runs once at
wolfd startup, before the model table is resolved, and registers through `registerProviderFactory` / `registerAdapter`, the
same registries the built-ins use. A wrong `apiVersion`, a missing `requiredEnv` variable, an id that clashes with a built-in
or another plug-in, or an entry that is missing or fails to import stops startup with a message naming the plug-in. No fallback.

**Trust.** Enabling a plug-in means trusting it like any code you install. It runs inside the wolf's process, outside any sandbox. `ctx.env` is what wolfpack hands it, not a security boundary. `WOLFPACK_PLUGINS_DIR` decides where code is loaded from; the entry and folder must resolve inside that folder (symlinks are followed, then checked). A plug-in needs its own provider id: built-in and legacy ids (`anthropic`, `claude-stateless`, `claude-bridge`) are taken. In the Mac app, `claude-stateless` is a stub. Plug-in tiers are checked when the wolf starts, not by `wolfpack sync` or `wolf-config` in the CLI. Engine plug-ins serve steps that run in the wolf process (memory, consolidation and KB sweep run on the wolfd main thread through the memory extension, not in a worker or child process), because the adapter registry lives on `globalThis`; a step moved to a worker thread or child process would not see them.
